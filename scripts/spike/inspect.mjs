// Spike step 1: read-only inspection of the Twilio master account and Retell agents.
// Prints no credentials.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import twilio from "twilio";

const sid = process.env.TWILIO_ACCOUNT_SID;
const tok = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !tok) throw new Error("Twilio creds missing from .env.local");
const client = twilio(sid, tok);

const acct = await client.api.v2010.accounts(sid).fetch();
console.log("== master account:", acct.friendlyName, acct.status, acct.type);

const subs = await client.api.v2010.accounts.list({ limit: 50 });
console.log("== subaccounts:", subs.length - 1);
for (const a of subs) if (a.sid !== sid) console.log("  ", a.sid.slice(0, 10), a.friendlyName, a.status);

const nums = await client.incomingPhoneNumbers.list({ limit: 200 });
const gb = nums.filter((n) => n.phoneNumber.startsWith("+44"));
console.log("== UK numbers owned on master:", gb.length, "of", nums.length);
for (const n of gb)
  console.log("  ", n.phoneNumber, "|", n.friendlyName, "| trunk", n.trunkSid ?? "-", "| voiceUrl", (n.voiceUrl || "-").slice(0, 60), "| bundle", n.bundleSid ?? "-");

const bundles = await client.numbers.v2.regulatoryCompliance.bundles.list({ limit: 50 });
console.log("== regulatory bundles on master:", bundles.length);
for (const b of bundles) console.log("  ", b.sid.slice(0, 10), b.friendlyName, "|", b.status, "| reg", b.regulationSid, "| validUntil", b.validUntil ?? "-");

const regs = await client.numbers.v2.regulatoryCompliance.regulations.list({ isoCountry: "GB", limit: 30 });
console.log("== GB regulations:");
for (const r of regs) console.log("  ", r.sid, r.numberType, r.endUserType, "|", r.friendlyName);

for (const type of ["local", "mobile", "tollFree", "national", "sharedCost"]) {
  try {
    const list = await client.availablePhoneNumbers("GB")[type].list({ limit: 3 });
    console.log(`== GB ${type}:`, list.map((n) => `${n.phoneNumber} ${n.locality ?? ""}`).join(", ") || "(none)");
  } catch (e) {
    console.log(`== GB ${type}: ERROR ${e.status ?? ""} ${e.message}`);
  }
}
try {
  const l03 = await client.availablePhoneNumbers("GB").local.list({ contains: "443*", limit: 3 });
  console.log("== GB local contains 443*:", l03.map((n) => n.phoneNumber).join(", ") || "(none)");
} catch (e) {
  console.log("== GB local contains 443*: ERROR", e.message);
}
try {
  const lon = await client.availablePhoneNumbers("GB").local.list({ contains: "4420*", limit: 3 });
  console.log("== GB local London 4420*:", lon.map((n) => `${n.phoneNumber} ${n.locality ?? ""}`).join(", ") || "(none)");
} catch (e) {
  console.log("== GB local London: ERROR", e.message);
}

const key = process.env.RETELL_API_KEY;
if (key) {
  const r = await fetch("https://api.retellai.com/list-agents", { headers: { Authorization: `Bearer ${key}` } });
  const agents = await r.json();
  console.log("== Retell agents:", Array.isArray(agents) ? agents.length : agents);
  if (Array.isArray(agents))
    for (const a of agents.slice(0, 40)) console.log("  ", a.agent_id, "|", a.agent_name, "|", a.language ?? "-");
} else console.log("== Retell: no key");
