// Watch one Ofcom registration (Twilio bundle) until Twilio decides, then
// mirror the decision into tb.regulatory_bundles. For local development, where
// the /api/cron/twilio-bundles job and Twilio's status callback cannot reach
// the app.
//
//   node scripts/dev/watch-bundle.mjs <BUNDLE_SID> [pollSeconds] [maxHours]
//
// Prints one line per poll only when something changes, then exits. It never
// buys a number: on approval, use "Activate now" in the app.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createDecipheriv } from "node:crypto";
import postgres from "postgres";
import twilio from "twilio";

const bundleSid = process.argv[2];
const pollSeconds = Number(process.argv[3] ?? 300);
const maxHours = Number(process.argv[4] ?? 20);
if (!bundleSid) {
  console.error("usage: node scripts/dev/watch-bundle.mjs <BUNDLE_SID> [pollSeconds] [maxHours]");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const [row] = await sql`select client_id, number_type, status from tb.regulatory_bundles where bundle_sid = ${bundleSid}`;
if (!row) {
  console.error(`no registration in the app with bundle ${bundleSid}`);
  await sql.end();
  process.exit(1);
}
const [acct] = await sql`select subaccount_sid, auth_token_enc from tb.twilio_accounts where client_id = ${row.client_id}`;
const [, iv, tag, ct] = acct.auth_token_enc.split(":");
const dec = createDecipheriv("aes-256-gcm", Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, "hex"), Buffer.from(iv, "base64"));
dec.setAuthTag(Buffer.from(tag, "base64"));
const tw = twilio(acct.subaccount_sid, Buffer.concat([dec.update(Buffer.from(ct, "base64")), dec.final()]).toString("utf8"));

const DECIDED = new Set(["twilio-approved", "twilio-rejected", "provisionally-approved"]);
const deadline = Date.now() + maxHours * 3600e3;
let last = row.status;
console.log(`watching ${row.number_type} registration ${bundleSid}, currently ${last}`);

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  let status;
  try {
    status = (await tw.numbers.v2.regulatoryCompliance.bundles(bundleSid).fetch()).status;
  } catch (e) {
    console.error(`poll failed (will retry): ${e.message}`);
    continue;
  }
  if (status === last) continue;
  last = status;
  const decided = DECIDED.has(status);
  await sql`update tb.regulatory_bundles set status = ${status}, decided_at = ${decided ? new Date() : null} where bundle_sid = ${bundleSid}`;
  console.log(`${new Date().toISOString()} ${row.number_type} registration is now ${status}`);
  if (decided) {
    console.log(status === "twilio-rejected" ? "REJECTED: see Twilio's email for the reason." : "APPROVED: the reserved number can be activated in the app.");
    break;
  }
}
await sql.end();
