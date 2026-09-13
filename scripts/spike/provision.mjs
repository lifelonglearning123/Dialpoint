// Spike step 2: provision the test setup on Chao's Twilio master account.
//   node scripts/spike/provision.mjs subaccount        -> create "spike" subaccount, print SID, write to .env.local
//   node scripts/spike/provision.mjs apikey            -> create API key + TwiML app for the softphone, write to .env.local
//   node scripts/spike/provision.mjs search [area]     -> list purchasable GB local numbers (default London 020)
//   node scripts/spike/provision.mjs buy +44XXXXXXXXXX -> buy that number and point its voice webhook at PUBLIC_BASE_URL
//   node scripts/spike/provision.mjs point             -> (re)point the test number at the current PUBLIC_BASE_URL
//   node scripts/spike/provision.mjs release           -> release the test number (stops the £3.50/mo)
// Uses the subaccount only when SPIKE_USE_SUBACCOUNT=1, else the master. Prints no secrets.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";
import twilio from "twilio";

const master = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const useSub = process.env.SPIKE_USE_SUBACCOUNT === "1";
const acctSid = useSub ? process.env.SPIKE_SUBACCOUNT_SID : process.env.TWILIO_ACCOUNT_SID;
const acctTok = useSub ? process.env.SPIKE_SUBACCOUNT_TOKEN : process.env.TWILIO_AUTH_TOKEN;
const client = twilio(acctSid, acctTok);
const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

function setEnv(pairs) {
  const path = ".env.local";
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const keys = Object.keys(pairs);
  const kept = lines.filter((l) => !keys.some((k) => l.startsWith(k + "=")));
  for (const k of keys) kept.push(`${k}=${pairs[k]}`);
  writeFileSync(path, kept.join("\n") + "\n");
  console.log("wrote to .env.local:", keys.join(", "));
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "subaccount") {
  const sub = await master.api.v2010.accounts.create({ friendlyName: "spike:telephone-buying" });
  console.log("subaccount created:", sub.sid, sub.status);
  setEnv({ SPIKE_SUBACCOUNT_SID: sub.sid, SPIKE_SUBACCOUNT_TOKEN: sub.authToken });
} else if (cmd === "apikey") {
  const key = await client.newKeys.create({ friendlyName: "spike softphone" });
  const app = await client.applications.create({
    friendlyName: "spike softphone app",
    voiceUrl: `${base}/api/voice/inbound`,
    voiceMethod: "POST",
  });
  console.log("api key:", key.sid, "twiml app:", app.sid);
  setEnv({ TWILIO_API_KEY_SID: key.sid, TWILIO_API_KEY_SECRET: key.secret, TWILIO_TWIML_APP_SID: app.sid });
} else if (cmd === "search") {
  const contains = arg ?? "4420*";
  const list = await client.availablePhoneNumbers("GB").local.list({ contains, voiceEnabled: true, limit: 10 });
  for (const n of list) console.log(n.phoneNumber, n.locality ?? "", n.capabilities);
  if (!list.length) console.log("(none)");
} else if (cmd === "buy") {
  if (!arg?.startsWith("+44")) throw new Error("pass the E.164 number to buy");
  if (!base) throw new Error("PUBLIC_BASE_URL not set");
  const bundles = await client.numbers.v2.regulatoryCompliance.bundles.list({ status: "twilio-approved", limit: 50 });
  const bundle = bundles.find((b) => /local|national|Local|National/.test(b.friendlyName ?? "")) ?? bundles[0];
  console.log("approved bundles on this account:", bundles.length, bundle ? `using ${bundle.sid} (${bundle.friendlyName})` : "NONE");
  const params = {
    phoneNumber: arg,
    friendlyName: "spike test line",
    voiceUrl: `${base}/api/voice/inbound`,
    voiceMethod: "POST",
    statusCallback: `${base}/api/voice/status?leg=parent`,
    statusCallbackMethod: "POST",
  };
  if (bundle) params.bundleSid = bundle.sid;
  // UK numbers also need a validated address on the account (error 21631).
  // Prefer the address already attached to an existing UK geographic number.
  const owned = await client.incomingPhoneNumbers.list({ limit: 200 });
  const fromOwned = owned.find((n) => /^\+44[12]/.test(n.phoneNumber) && n.addressSid)?.addressSid;
  const addresses = await client.addresses.list({ isoCountry: "GB", limit: 20 });
  const addr = addresses.find((a) => a.sid === fromOwned) ?? addresses.find((a) => a.validated) ?? addresses[0];
  console.log("GB addresses on account:", addresses.length, addr ? `using ${addr.sid} (${addr.customerName}, ${addr.city})` : "NONE");
  if (addr) params.addressSid = addr.sid;
  const n = await client.incomingPhoneNumbers.create(params);
  console.log("bought:", n.phoneNumber, n.sid, "status", n.status);
  setEnv({ SPIKE_NUMBER: n.phoneNumber, SPIKE_NUMBER_SID: n.sid });
} else if (cmd === "point") {
  if (!base) throw new Error("PUBLIC_BASE_URL not set");
  const n = await client.incomingPhoneNumbers(process.env.SPIKE_NUMBER_SID).update({
    voiceUrl: `${base}/api/voice/inbound`,
    voiceMethod: "POST",
    statusCallback: `${base}/api/voice/status?leg=parent`,
    statusCallbackMethod: "POST",
  });
  console.log("pointed", n.phoneNumber, "at", base);
  if (process.env.TWILIO_TWIML_APP_SID)
    await client.applications(process.env.TWILIO_TWIML_APP_SID).update({ voiceUrl: `${base}/api/voice/inbound` });
} else if (cmd === "release") {
  await client.incomingPhoneNumbers(process.env.SPIKE_NUMBER_SID).remove();
  console.log("released", process.env.SPIKE_NUMBER);
} else {
  console.log("commands: subaccount | apikey | search [contains] | buy +44... | point | release");
}
