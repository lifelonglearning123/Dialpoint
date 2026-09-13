import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { numbers, stripeEvents, subscriptions } from "@/db/schema";
import { env } from "@/env";
import { linkStripeSubscription, mapState } from "@/lib/billing/subscription";
import { stripe } from "@/lib/billing/stripe";
import { resumeSubaccount, suspendSubaccount } from "@/lib/twilio/master";
import { releaseNumber } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe CONNECT webhook: one endpoint receives events from every agency's
 * connected account (`event.account`). Register it in the platform Stripe
 * dashboard as a Connect endpoint listening to:
 *   checkout.session.completed, customer.subscription.updated,
 *   customer.subscription.deleted, invoice.paid, invoice.payment_failed
 * with STRIPE_WEBHOOK_SECRET set to its signing secret.
 */
export async function POST(req: NextRequest) {
  if (!env.STRIPE_WEBHOOK_SECRET) return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET not set" }, { status: 500 });
  const sig = req.headers.get("stripe-signature") ?? "";
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return NextResponse.json({ error: `bad signature: ${(e as Error).message}` }, { status: 400 });
  }

  // Idempotency: Stripe retries until it gets a 2xx.
  const [fresh] = await db.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const clientId = session.metadata?.tb_client_id;
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (clientId && subId) await linkStripeSubscription(clientId, subId);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const ss = event.data.object;
        const row = await db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeSubscriptionId, ss.id) });
        if (!row) break;
        const next = mapState(ss.status);
        const first = ss.items.data[0];
        await db
          .update(subscriptions)
          .set({
            state: next,
            cancelAtPeriodEnd: ss.cancel_at_period_end,
            currentPeriodStart: first ? new Date(first.current_period_start * 1000) : row.currentPeriodStart,
            currentPeriodEnd: first ? new Date(first.current_period_end * 1000) : row.currentPeriodEnd,
            pastDueSince: next === "past_due" ? (row.pastDueSince ?? new Date()) : next === "active" ? null : row.pastDueSince,
            suspendedAt: next === "unpaid" ? (row.suspendedAt ?? new Date()) : next === "active" ? null : row.suspendedAt,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.clientId, row.clientId));
        if (next === "unpaid" && row.state !== "unpaid") await suspendClient(row.clientId);
        if (next === "active" && (row.state === "unpaid" || row.state === "past_due")) await resumeClient(row.clientId);
        if (next === "cancelled" && row.state !== "cancelled") await releaseClientNumbers(row.clientId);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const row = await subscriptionForInvoice(inv);
        if (!row) break;
        if (row.state === "active") {
          await db.update(subscriptions).set({ state: "past_due", pastDueSince: row.pastDueSince ?? new Date(), updatedAt: new Date() }).where(eq(subscriptions.clientId, row.clientId));
        }
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        const row = await subscriptionForInvoice(inv);
        if (!row) break;
        if (row.state === "past_due" || row.state === "unpaid") {
          await db.update(subscriptions).set({ state: "active", pastDueSince: null, suspendedAt: null, updatedAt: new Date() }).where(eq(subscriptions.clientId, row.clientId));
          if (row.state === "unpaid") await resumeClient(row.clientId);
        }
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error(`[stripe webhook] ${event.type} failed`, e);
    // Let Stripe retry; drop the dedupe row so the retry is processed.
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

async function subscriptionForInvoice(inv: Stripe.Invoice) {
  const customer = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  if (!customer) return null;
  return db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeCustomerId, customer) });
}

/** Non-payment after Stripe's retry window: calls stop, numbers are kept. */
async function suspendClient(clientId: string) {
  await suspendSubaccount(clientId);
  await db.update(numbers).set({ status: "suspended" }).where(and(eq(numbers.clientId, clientId), eq(numbers.status, "active")));
}

async function resumeClient(clientId: string) {
  await resumeSubaccount(clientId);
  await db.update(numbers).set({ status: "active" }).where(and(eq(numbers.clientId, clientId), eq(numbers.status, "suspended")));
}

/** Subscription ended (cancel at period end reached, or Stripe gave up): give the numbers back. */
async function releaseClientNumbers(clientId: string) {
  await resumeSubaccount(clientId).catch(() => undefined); // releasing needs an active subaccount
  const rows = await db.query.numbers.findMany({ where: and(eq(numbers.clientId, clientId), inArray(numbers.status, ["active", "suspended", "reserved"])) });
  for (const n of rows) {
    await releaseNumber(n.id).catch((e) => console.error(`[stripe webhook] release ${n.e164} failed`, e));
  }
}
