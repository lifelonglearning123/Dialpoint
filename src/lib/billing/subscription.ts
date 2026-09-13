import { and, count, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { numbers, plans, subscriptions } from "@/db/schema";
import { agencies, clients } from "@/db/shared";
import { defaultPlanFor, publishPlan } from "./plans";
import { forAccount, stripe } from "./stripe";

export type Subscription = typeof subscriptions.$inferSelect;

async function clientContext(clientId: string) {
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.name,
      billingEmail: clients.billingEmail,
      agencyId: clients.agencyId,
      stripeAccountId: agencies.stripeAccountId,
      platformFeeBps: agencies.platformFeeBps,
      chargesEnabled: agencies.stripeChargesEnabled,
    })
    .from(clients)
    .innerJoin(agencies, eq(clients.agencyId, agencies.id))
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) throw new Error("Client not found.");
  if (!row.stripeAccountId) throw new Error("Your agency has not connected Stripe yet, so numbers cannot be billed. Ask them to connect it.");
  return row;
}

export async function activeNumberCount(clientId: string) {
  const [r] = await db.select({ n: count() }).from(numbers).where(and(eq(numbers.clientId, clientId), eq(numbers.status, "active")));
  return r?.n ?? 0;
}

export async function getSubscription(clientId: string) {
  return db.query.subscriptions.findFirst({ where: eq(subscriptions.clientId, clientId) });
}

/** true when the client may hold numbers: paid up, or in Stripe's retry window. */
export function subscriptionAllowsNumbers(sub: Subscription | null | undefined) {
  return !!sub && (sub.state === "active" || sub.state === "past_due");
}

/**
 * Guarantee a paying subscription before anything is bought. Returns
 * `{ok:true}` when one exists, otherwise a Stripe Checkout URL the browser must
 * visit: subscription mode, card required and saved, licensed line for the
 * number fee (quantity = active numbers, at least 1) plus the metered lines.
 * The customer and subscription live on the agency's connected account; the
 * platform fee (agencies.platform_fee_bps) is taken per invoice.
 */
export async function ensureSubscription(
  clientId: string,
  opts: { successUrl: string; cancelUrl: string; email: string },
): Promise<{ ok: true; subscription: Subscription } | { ok: false; checkoutUrl: string }> {
  const existing = await getSubscription(clientId);
  if (subscriptionAllowsNumbers(existing)) return { ok: true, subscription: existing! };

  const ctx = await clientContext(clientId);
  let plan = existing ? await db.query.plans.findFirst({ where: eq(plans.id, existing.planId) }) : await defaultPlanFor(ctx.agencyId);
  if (!plan) throw new Error("Your agency has not set up a price plan yet.");
  if (!plan.publishedAt || !plan.stripeNumberPriceId || !plan.stripeUsagePriceId || !plan.stripeFreephonePriceId) plan = await publishPlan(plan.id);

  const s = stripe();
  const acct = forAccount(ctx.stripeAccountId!);

  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await s.customers.create(
      { email: ctx.billingEmail ?? opts.email, name: ctx.name, metadata: { tb_client_id: clientId, agency_id: ctx.agencyId } },
      acct,
    );
    customerId = customer.id;
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: plan.stripeNumberPriceId!, quantity: Math.max(1, await activeNumberCount(clientId)) },
    { price: plan.stripeUsagePriceId! },
    { price: plan.stripeFreephonePriceId! },
  ];
  if (plan.stripeVoicemailPriceId) lineItems.push({ price: plan.stripeVoicemailPriceId });

  const session = await s.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      payment_method_collection: "always",
      line_items: lineItems,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      allow_promotion_codes: false,
      subscription_data: {
        metadata: { tb_client_id: clientId, tb_plan_id: plan.id },
        ...(ctx.platformFeeBps > 0 ? { application_fee_percent: ctx.platformFeeBps / 100 } : {}),
      },
      metadata: { tb_client_id: clientId, tb_plan_id: plan.id },
    },
    acct,
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");

  await db
    .insert(subscriptions)
    .values({
      clientId,
      planId: plan.id,
      stripeAccountId: ctx.stripeAccountId!,
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
      state: "incomplete",
    })
    .onConflictDoUpdate({
      target: subscriptions.clientId,
      set: { planId: plan.id, stripeCustomerId: customerId, stripeCheckoutSessionId: session.id, updatedAt: new Date() },
    });

  return { ok: false, checkoutUrl: session.url };
}

/** Read the subscription's items and map them to our columns by price role. */
export async function linkStripeSubscription(clientId: string, stripeSubscriptionId: string) {
  const sub = await getSubscription(clientId);
  if (!sub) throw new Error("No subscription row for client.");
  const s = stripe();
  const acct = forAccount(sub.stripeAccountId);
  const ss = await s.subscriptions.retrieve(stripeSubscriptionId, { expand: ["items.data.price"] }, acct);
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
  const itemFor = (priceId: string | null | undefined) => (priceId ? ss.items.data.find((i) => i.price.id === priceId)?.id ?? null : null);
  // Period dates moved to the item level in recent API versions; read the first item.
  const first = ss.items.data[0];
  await db
    .update(subscriptions)
    .set({
      stripeSubscriptionId: ss.id,
      licensedItemId: itemFor(plan?.stripeNumberPriceId),
      usageItemId: itemFor(plan?.stripeUsagePriceId),
      freephoneItemId: itemFor(plan?.stripeFreephonePriceId),
      voicemailItemId: itemFor(plan?.stripeVoicemailPriceId),
      state: mapState(ss.status),
      currentPeriodStart: first ? new Date(first.current_period_start * 1000) : null,
      currentPeriodEnd: first ? new Date(first.current_period_end * 1000) : null,
      cancelAtPeriodEnd: ss.cancel_at_period_end,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.clientId, clientId));
}

export function mapState(status: Stripe.Subscription.Status): Subscription["state"] {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      return "incomplete";
  }
}

/**
 * Called when the browser returns from Checkout. The webhook usually arrives
 * first, but not always, so confirm the session directly and link it. Returns
 * true when the customer now has a live subscription.
 */
export async function confirmCheckout(clientId: string): Promise<boolean> {
  const sub = await getSubscription(clientId);
  if (!sub) return false;
  if (subscriptionAllowsNumbers(sub)) return true;
  if (!sub.stripeCheckoutSessionId) return false;
  const session = await stripe().checkout.sessions.retrieve(sub.stripeCheckoutSessionId, {}, forAccount(sub.stripeAccountId));
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (session.status !== "complete" || !subId) return false;
  await linkStripeSubscription(clientId, subId);
  return subscriptionAllowsNumbers(await getSubscription(clientId));
}

/** Licensed quantity = active numbers; prorated so mid-month changes bill fairly. */
export async function syncActiveNumberQuantity(clientId: string) {
  const sub = await getSubscription(clientId);
  if (!sub?.stripeSubscriptionId || !sub.licensedItemId) return;
  const qty = Math.max(1, await activeNumberCount(clientId));
  await stripe().subscriptionItems.update(sub.licensedItemId, { quantity: qty, proration_behavior: "create_prorations" }, forAccount(sub.stripeAccountId));
}

/** Stripe-hosted billing portal (card changes, invoices, cancel). */
export async function portalUrl(clientId: string, returnUrl: string) {
  const sub = await getSubscription(clientId);
  if (!sub) throw new Error("No billing account yet.");
  const session = await stripe().billingPortal.sessions.create({ customer: sub.stripeCustomerId, return_url: returnUrl }, forAccount(sub.stripeAccountId));
  return session.url;
}

export async function cancelAtPeriodEnd(clientId: string) {
  const sub = await getSubscription(clientId);
  if (!sub?.stripeSubscriptionId) throw new Error("No subscription to cancel.");
  await stripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true }, forAccount(sub.stripeAccountId));
  await db.update(subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: new Date() }).where(eq(subscriptions.clientId, clientId));
}

/** Last invoices for the billing page. */
export async function recentInvoices(clientId: string, limit = 12) {
  const sub = await getSubscription(clientId);
  if (!sub) return [];
  const list = await stripe().invoices.list({ customer: sub.stripeCustomerId, limit }, forAccount(sub.stripeAccountId));
  return list.data.map((inv) => ({
    id: inv.id,
    number: inv.number,
    createdAt: new Date(inv.created * 1000),
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency.toUpperCase(),
    status: inv.status ?? "draft",
    url: inv.hosted_invoice_url ?? null,
  }));
}
