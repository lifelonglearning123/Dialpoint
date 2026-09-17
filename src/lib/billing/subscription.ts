import { and, count, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { numbers, plans, subscriptions } from "@/db/schema";
import { agencies, clients } from "@/db/shared";
import { defaultPlanFor, planFullyPublished, publishPlan } from "./plans";
import { NUMBER_TYPES, type NumberTypeKey } from "./pricing";
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

export type NumberCounts = Record<NumberTypeKey, number>;

export function emptyCounts(): NumberCounts {
  return { local: 0, national: 0, tollfree: 0, mobile: 0 };
}

export function totalCount(c: NumberCounts) {
  return NUMBER_TYPES.reduce((n, t) => n + (c[t] ?? 0), 0);
}

/** Active numbers per type: the licensed quantities on the subscription's carrier items. */
export async function activeNumberCountsByType(clientId: string): Promise<NumberCounts> {
  const rows = await db
    .select({ type: numbers.type, n: count() })
    .from(numbers)
    .where(and(eq(numbers.clientId, clientId), eq(numbers.status, "active")))
    .groupBy(numbers.type);
  const counts = emptyCounts();
  for (const r of rows) counts[r.type] = r.n;
  return counts;
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
 * visit: subscription mode, card required and saved, with one licensed line
 * for hosting (quantity = active numbers, at least 1), one licensed line per
 * number type held (the Twilio charge; the number being bought counts as 1),
 * the metered usage lines, and the card-processing surcharge as the
 * subscription's default tax rate so it lands on every invoice.
 * The customer and subscription live on the agency's connected account; the
 * platform fee (agencies.platform_fee_bps) is taken per invoice.
 */
export async function ensureSubscription(
  clientId: string,
  opts: { successUrl: string; cancelUrl: string; email: string; pendingType?: NumberTypeKey },
): Promise<{ ok: true; subscription: Subscription } | { ok: false; checkoutUrl: string }> {
  const existing = await getSubscription(clientId);
  if (subscriptionAllowsNumbers(existing)) return { ok: true, subscription: existing! };

  const ctx = await clientContext(clientId);
  let plan = existing ? await db.query.plans.findFirst({ where: eq(plans.id, existing.planId) }) : await defaultPlanFor(ctx.agencyId);
  if (!plan) throw new Error("Your agency has not set up a price plan yet.");
  if (!planFullyPublished(plan)) plan = await publishPlan(plan.id);

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

  const counts = await activeNumberCountsByType(clientId);
  if (opts.pendingType) counts[opts.pendingType] += 1; // the reserved number this checkout is for
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: plan.stripeHostingPriceId!, quantity: Math.max(1, totalCount(counts)) }];
  // Checkout refuses quantity 0, so only the types held now get a carrier line;
  // syncActiveNumberQuantity adds the others as numbers of new types go live.
  for (const t of NUMBER_TYPES) {
    if (counts[t] > 0) lineItems.push({ price: plan.stripeCarrierPriceIds[t]!, quantity: counts[t] });
  }
  lineItems.push({ price: plan.stripeUsagePriceId! }, { price: plan.stripeFreephonePriceId! });
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
        ...(plan.stripeSurchargeTaxRateId ? { default_tax_rates: [plan.stripeSurchargeTaxRateId] } : {}),
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
  const carrierItemIds: Partial<Record<NumberTypeKey, string>> = {};
  for (const t of NUMBER_TYPES) {
    const id = itemFor(plan?.stripeCarrierPriceIds[t]);
    if (id) carrierItemIds[t] = id;
  }
  await db
    .update(subscriptions)
    .set({
      stripeSubscriptionId: ss.id,
      hostingItemId: itemFor(plan?.stripeHostingPriceId),
      carrierItemIds,
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

/**
 * Licensed quantities follow the active numbers, prorated so mid-month changes
 * bill fairly: hosting = all active numbers (never below 1 while subscribed);
 * one carrier item per number type = active numbers of that type, created the
 * first time a type is held and removed when the last one of that type goes.
 */
export async function syncActiveNumberQuantity(clientId: string) {
  const sub = await getSubscription(clientId);
  if (!sub?.stripeSubscriptionId) return;
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
  if (!plan) return;
  const s = stripe();
  const acct = forAccount(sub.stripeAccountId);
  const prorate = { proration_behavior: "create_prorations" } as const;
  const counts = await activeNumberCountsByType(clientId);

  if (sub.hostingItemId) {
    await s.subscriptionItems.update(sub.hostingItemId, { quantity: Math.max(1, totalCount(counts)), ...prorate }, acct);
  }

  const itemIds = { ...sub.carrierItemIds };
  for (const t of NUMBER_TYPES) {
    const priceId = plan.stripeCarrierPriceIds[t];
    const itemId = itemIds[t];
    const qty = counts[t];
    if (itemId && qty > 0) {
      await s.subscriptionItems.update(itemId, { quantity: qty, ...prorate }, acct);
    } else if (itemId && qty === 0) {
      await s.subscriptionItems.del(itemId, prorate, acct);
      delete itemIds[t];
    } else if (!itemId && qty > 0 && priceId) {
      const item = await s.subscriptionItems.create({ subscription: sub.stripeSubscriptionId, price: priceId, quantity: qty, ...prorate }, acct);
      itemIds[t] = item.id;
    }
  }
  await db.update(subscriptions).set({ carrierItemIds: itemIds, updatedAt: new Date() }).where(eq(subscriptions.clientId, clientId));
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
