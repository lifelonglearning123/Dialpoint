// Dev helper: forward Stripe (Connect) webhooks to the local app using the
// platform key from .env.local, and write the CLI's signing secret to
// STRIPE_WEBHOOK_SECRET. Runs detached; log in %TMP%/stripe-listen.log.
//   node scripts/dev/stripe-listen.mjs
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const exe = join(
  homedir(),
  "AppData",
  "Local",
  "Microsoft",
  "WinGet",
  "Packages",
  "Stripe.StripeCli_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "stripe.exe",
);
if (!existsSync(exe)) throw new Error("stripe.exe not found at " + exe);
const target = process.env.LOCAL_APP_URL ?? "http://127.0.0.1:3410";
const logPath = join(process.env.TMP ?? ".", "stripe-listen.log");
const log = openSync(logPath, "w");
const child = spawn(
  exe,
  ["listen", "--live", "--api-key", process.env.STRIPE_SECRET_KEY, "--forward-connect-to", `${target}/api/webhooks/stripe`, "--forward-to", `${target}/api/webhooks/stripe`],
  { detached: true, stdio: ["ignore", log, log], windowsHide: true },
);
child.unref();
console.log("stripe listen pid", child.pid, "log", logPath);

// Poll the log for the signing secret and persist it.
const started = Date.now();
const timer = setInterval(() => {
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const m = text.match(/whsec_[A-Za-z0-9]+/);
  if (m) {
    const lines = readFileSync(".env.local", "utf8").split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith("STRIPE_WEBHOOK_SECRET="));
    lines.push(`STRIPE_WEBHOOK_SECRET=${m[0]}`);
    writeFileSync(".env.local", lines.join("\n") + "\n");
    console.log("STRIPE_WEBHOOK_SECRET written to .env.local");
    clearInterval(timer);
    process.exit(0);
  }
  if (/error/i.test(text) || Date.now() - started > 90_000) {
    console.log("no secret; log says:", text.replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_[redacted]").slice(-400));
    clearInterval(timer);
    process.exit(1);
  }
}, 1000);
