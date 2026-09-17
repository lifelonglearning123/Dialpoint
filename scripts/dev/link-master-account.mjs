// Link a client (the agency's own business) to the MASTER Twilio account and
// mirror the master account's approved Ofcom registrations into
// tb.regulatory_bundles for it, so it can buy numbers without re-registering.
//
//   node scripts/dev/link-master-account.mjs "<client name or id>"
//
// Idempotent: re-running updates nothing that already matches. Only ever
// touches rows for the named client.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import twilio from "twilio";

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/dev/link-master-account.mjs "<client name or id>"');
  process.exit(1);
}
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CREDENTIALS_ENCRYPTION_KEY, DATABASE_URL } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !CREDENTIALS_ENCRYPTION_KEY || !DATABASE_URL) {
  console.error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CREDENTIALS_ENCRYPTION_KEY and DATABASE_URL must be set");
  process.exit(1);
}

// Same format as src/lib/crypto/credentials.ts: v1:<iv>:<tag>:<ciphertext>, base64, AES-256-GCM.
function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(CREDENTIALS_ENCRYPTION_KEY, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
const isUuid = /^[0-9a-f-]{36}$/i.test(arg);
const [client] = isUuid ? await sql`select id, name from public.clients where id = ${arg}` : await sql`select id, name from public.clients where name = ${arg}`;
if (!client) {
  console.error(`no client matches "${arg}"`);
  await sql.end();
  process.exit(1);
}
console.log(`client: ${client.name} (${client.id})`);

// 1. Twilio account row → the master account.
const existing = await sql`select subaccount_sid from tb.twilio_accounts where client_id = ${client.id}`;
if (existing.length && existing[0].subaccount_sid !== TWILIO_ACCOUNT_SID) {
  console.error(`client already has a different Twilio account (${existing[0].subaccount_sid}); refusing to overwrite`);
  await sql.end();
  process.exit(1);
}
if (!existing.length) {
  await sql`insert into tb.twilio_accounts (client_id, subaccount_sid, auth_token_enc, status) values (${client.id}, ${TWILIO_ACCOUNT_SID}, ${encrypt(TWILIO_AUTH_TOKEN)}, 'active')`;
  console.log(`linked to master account ${TWILIO_ACCOUNT_SID.slice(0, 8)}…`);
} else {
  console.log("already linked to the master account");
}

// 2. Mirror approved bundles.
const tw = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const bundles = (await tw.numbers.v2.regulatoryCompliance.bundles.list({ limit: 100 })).filter((b) => b.status === "twilio-approved");
const addresses = await tw.addresses.list({ limit: 100 });
const numbers = await tw.incomingPhoneNumbers.list({ limit: 200 });
const typeMap = { local: "local", mobile: "mobile", "toll-free": "tollfree", national: "national" };

for (const b of bundles) {
  const reg = await tw.numbers.v2.regulatoryCompliance.regulations(b.regulationSid).fetch();
  if (reg.isoCountry !== "GB") continue;
  const numberType = typeMap[reg.numberType];
  if (!numberType) continue;
  const items = await tw.numbers.v2.regulatoryCompliance.bundles(b.sid).itemAssignments.list({ limit: 50 });
  const endUserSid = items.map((i) => i.objectSid).find((s) => s.startsWith("IT")) ?? null;
  const documentSids = items.map((i) => i.objectSid).filter((s) => s.startsWith("RD"));
  // The address is not part of the bundle in Twilio; pick the validated one the
  // bundle's numbers use, else the one named like the bundle, else any validated.
  const usedByNumber = numbers.find((n) => n.bundleSid === b.sid && n.addressSid)?.addressSid;
  const address =
    addresses.find((a) => a.sid === usedByNumber && a.validated) ?? addresses.find((a) => a.friendlyName === b.friendlyName && a.validated) ?? addresses.find((a) => a.validated);
  if (!endUserSid || !address) {
    console.log(`skip ${b.sid} (${numberType}): missing end user or validated address`);
    continue;
  }
  const [row] = await sql`select id, status from tb.regulatory_bundles where client_id = ${client.id} and bundle_sid = ${b.sid}`;
  if (row) {
    console.log(`${numberType}: ${b.sid} already mirrored (${row.status})`);
    continue;
  }
  await sql`insert into tb.regulatory_bundles (client_id, iso_country, number_type, end_user_type, bundle_sid, regulation_sid, end_user_sid, address_sid, document_sids, status, submitted, submitted_at, decided_at)
    values (${client.id}, 'GB', ${numberType}, ${reg.endUserType}, ${b.sid}, ${b.regulationSid}, ${endUserSid}, ${address.sid}, ${documentSids}, 'twilio-approved', ${sql.json({ source: "master account", friendlyName: b.friendlyName })}, now(), now())`;
  console.log(`${numberType}: mirrored ${b.sid} "${b.friendlyName}" with address ${address.sid} (${address.street}, ${address.postalCode})`);
}
await sql.end();
