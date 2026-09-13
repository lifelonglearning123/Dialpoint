// Spike helper: copy the platform credentials this app shares with Signal
// into ./.env.local without ever printing them. Run once.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SRC = "C:/python/Signal/voice-retell-elevenlabs/.env.local";
const DST = ".env.local";
const KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RETELL_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "STRIPE_SECRET_KEY",
];

const src = readFileSync(SRC, "utf8").replace(/^\uFEFF/, "");
const found = {};
for (const raw of src.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (KEYS.includes(m[1])) found[m[1]] = v;
}

const existing = existsSync(DST) ? readFileSync(DST, "utf8") : "";
const lines = existing ? existing.split(/\r?\n/).filter(Boolean) : [];
// Only replace keys that were actually found in the source; never drop a key
// the destination already has (a MISSING source value must not erase it).
const out = lines.filter((l) => !Object.keys(found).some((k) => l.startsWith(k + "=")));
for (const k of KEYS) if (found[k]) out.push(`${k}=${found[k]}`);
writeFileSync(DST, out.join("\n") + "\n");

for (const k of KEYS) console.log(k.padEnd(32), found[k] ? `copied (len ${found[k].length})` : "MISSING");
