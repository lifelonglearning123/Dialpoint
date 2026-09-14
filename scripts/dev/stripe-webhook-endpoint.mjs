// Register (or update) this app's Stripe Connect webhook endpoint on the platform
// account and store its signing secret in STRIPE_WEBHOOK_SECRET.
//   node scripts/dev/stripe-webhook-endpoint.mjs            -> uses PUBLIC_BASE_URL from .env.local
//   node scripts/dev/stripe-webhook-endpoint.mjs https://numbers.example.com   -> explicit origin (production)
// Safe to re-run: an existing endpoint for the same URL is reused (Stripe only
// reveals the secret at creation, so a reused endpoint keeps the stored secret).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";
import Stripe from "stripe";

const origin = (process.argv[2] ?? process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
if (!origin.startsWith("https://")) throw new Error("Need an https origin (PUBLIC_BASE_URL or argv[2]).");
const url = `${origin}/api/webhooks/stripe`;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"];

const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter((e) => e.url === url);
let endpoint;
let secret = null;
if (existing.length) {
  endpoint = await stripe.webhookEndpoints.update(existing[0].id, { enabled_events: EVENTS, disabled: false });
  console.log("reusing endpoint", endpoint.id, "for", url, "(secret unchanged; keep the one already in .env.local)");
} else {
  endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, connect: true, description: "telephone-buying app (Connect events)" });
  secret = endpoint.secret;
  console.log("created endpoint", endpoint.id, "for", url);
}

if (secret) {
  const lines = readFileSync(".env.local", "utf8").split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith("STRIPE_WEBHOOK_SECRET="));
  lines.push(`STRIPE_WEBHOOK_SECRET=${secret}`);
  writeFileSync(".env.local", lines.join("\n") + "\n");
  console.log("STRIPE_WEBHOOK_SECRET written to .env.local");
}
console.log("events:", EVENTS.join(", "));
