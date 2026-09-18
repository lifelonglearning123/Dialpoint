// Point the app at a new tunnel address: writes PUBLIC_BASE_URL into
// .env.local, then re-points every live number's call and status webhooks
// (and each softphone TwiML App) at it. Run after every `npm run spike:tunnel`,
// because a quick tunnel gets a new address each time it starts.
//
//   node scripts/dev/point-tunnel.mjs https://xxxx.trycloudflare.com
//
// Restart `npm run dev` afterwards so the app builds its callback URLs from
// the new address.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import { readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import postgres from "postgres";
import twilio from "twilio";

let base;
try {
  const u = new URL(process.argv[2] ?? "");
  if (u.protocol !== "https:") throw new Error();
  base = u.origin;
} catch {
  console.error("usage: node scripts/dev/point-tunnel.mjs https://xxxx.trycloudflare.com");
  process.exit(1);
}

const envFile = ".env.local";
const text = readFileSync(envFile, "utf8");
const line = `PUBLIC_BASE_URL=${base}`;
writeFileSync(envFile, /^PUBLIC_BASE_URL=.*$/m.test(text) ? text.replace(/^PUBLIC_BASE_URL=.*$/m, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
console.log(`.env.local: ${line}`);

// Same format as src/lib/crypto/credentials.ts: v1:<iv>:<tag>:<ciphertext>, base64, AES-256-GCM.
function decrypt(enc) {
  const [, iv, tag, ct] = enc.split(":");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, "hex"), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const accounts = await sql`select client_id, subaccount_sid, auth_token_enc, twiml_app_sid from tb.twilio_accounts`;
const live = await sql`select client_id, e164, twilio_sid from tb.numbers where twilio_sid is not null and status <> 'released'`;
let failed = 0;

for (const acct of accounts) {
  const tw = twilio(acct.subaccount_sid, decrypt(acct.auth_token_enc));
  // Same settings as repointNumber in src/lib/twilio/numbers.ts.
  for (const n of live.filter((x) => x.client_id === acct.client_id)) {
    try {
      await tw.incomingPhoneNumbers(n.twilio_sid).update({
        voiceUrl: `${base}/api/voice/inbound`,
        voiceMethod: "POST",
        statusCallback: `${base}/api/voice/status?leg=parent`,
        statusCallbackMethod: "POST",
      });
      console.log(`number ${n.e164}: pointed at ${base}`);
    } catch (e) {
      failed++;
      console.error(`number ${n.e164}: FAILED, ${e.message}`);
    }
  }
  if (acct.twiml_app_sid) {
    try {
      await tw.applications(acct.twiml_app_sid).update({ voiceUrl: `${base}/api/voice/inbound`, voiceMethod: "POST" });
      console.log(`softphone app for client ${acct.client_id}: pointed at ${base}`);
    } catch (e) {
      failed++;
      console.error(`softphone app for client ${acct.client_id}: FAILED, ${e.message}`);
    }
  }
}
await sql.end();
console.log(failed ? `\n${failed} update(s) failed; see above.` : "\nDone. Now restart `npm run dev` (Ctrl+C, then npm run dev again).");
process.exit(failed ? 1 : 0);
