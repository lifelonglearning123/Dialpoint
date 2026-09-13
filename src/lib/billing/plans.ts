import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { agencies } from "@/db/shared";
import { forAccount, stripe } from "./stripe";

export type Plan = typeof plans.$inferSelect;

/**
 * Wholesale floor. Twilio list prices on the master account (GBP, 2026-09):
 * local £3.50/mo, mobile £2.50, 0800 £2.70; forwarded leg to a UK mobile
 * ≈3.05p/min (landline 1.58p); inbound 1p/min on local/mobile; 0800 inbound
 * 7.98p/min. A plan below these loses Chao money on every customer, so the
 * editor refuses it.
 */
export const WHOLESALE = {
  numberMonthlyPence: 400, // covers the dearest number type (local £3.50) + margin
  perMinutePence: 4, // forward to mobile 3.05p + inbound 1p, rounded
  freephoneInboundPence: 9, // 7.98p + margin
} as const;

export function wholesaleFloor(plan: Pick<Plan, "numberMonthlyPence" | "perMinutePence" | "freephoneInboundPence" | "includedMinutes">) {
  const problems: string[] = [];
  if (plan.numberMonthlyPence < WHOLESALE.numberMonthlyPence) {
    problems.push(`Monthly fee per number must be at least £${(WHOLESALE.numberMonthlyPence / 100).toFixed(2)} (Twilio charges up to £3.50 per number).`);
  }
  if (plan.perMinutePence < WHOLESALE.perMinutePence) {
    problems.push(`Per-minute overage must be at least ${WHOLESALE.perMinutePence}p (forwarding to a UK mobile costs about 3p a minute).`);
  }
  if (plan.freephoneInboundPence < WHOLESALE.freephoneInboundPence) {
    problems.push(`0800 inbound must be at least ${WHOLESALE.freephoneInboundPence}p a minute (Twilio charges 7.98p).`);
  }
  // Included minutes are paid for by the number fee: every included minute
  // costs ~4p of carrier time, so the fee must cover them.
  const minutesCost = plan.includedMinutes * WHOLESALE.perMinutePence;
  if (plan.numberMonthlyPence - WHOLESALE.numberMonthlyPence < minutesCost) {
    const maxIncluded = Math.max(0, Math.floor((plan.numberMonthlyPence - WHOLESALE.numberMonthlyPence) / WHOLESALE.perMinutePence));
    problems.push(`At £${(plan.numberMonthlyPence / 100).toFixed(2)} a month the fee only covers ${maxIncluded} included minutes (each costs about ${WHOLESALE.perMinutePence}p of carrier time).`);
  }
  return { ok: problems.length === 0, problems };
}

async function agencyStripeAccount(agencyId: string) {
  const [a] = await db.select({ stripeAccountId: agencies.stripeAccountId, name: agencies.name }).from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!a?.stripeAccountId) throw new Error("This agency has not connected Stripe yet. Connect it in the Signal dashboard first.");
  return { account: a.stripeAccountId, name: a.name };
}

/**
 * Create the Stripe objects for a plan on the agency's connected account:
 * one Product, a licensed monthly Price (the number fee), Billing Meters for
 * minutes / 0800 minutes / transcriptions and a metered Price on each.
 * Idempotent: any id already stored is reused, so re-publishing only fills gaps.
 *
 * Price changes after publishing create NEW prices (Stripe prices are
 * immutable); existing subscriptions keep the old price until moved, which is
 * deliberate: a plan edit never silently re-prices a live customer.
 */
export async function publishPlan(planId: string) {
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan) throw new Error("Plan not found.");
  const floor = wholesaleFloor(plan);
  if (!floor.ok) throw new Error(floor.problems.join(" "));
  const { account } = await agencyStripeAccount(plan.agencyId);
  const s = stripe();
  const opts = forAccount(account);
  const currency = plan.currency.toLowerCase();
  const suffix = plan.id.slice(0, 8);

  let productId = plan.stripeProductId;
  if (!productId) {
    const product = await s.products.create(
      { name: `${plan.name} — phone number`, description: plan.description ?? undefined, metadata: { tb_plan_id: plan.id } },
      opts,
    );
    productId = product.id;
  }

  const needsNewNumberPrice = !plan.stripeNumberPriceId || (await priceAmount(s, opts, plan.stripeNumberPriceId)) !== plan.numberMonthlyPence;
  const numberPriceId = needsNewNumberPrice
    ? (
        await s.prices.create(
          {
            product: productId,
            currency,
            unit_amount: plan.numberMonthlyPence,
            recurring: { interval: "month", usage_type: "licensed" },
            nickname: `${plan.name} number fee`,
            metadata: { tb_plan_id: plan.id, tb_role: "number" },
          },
          opts,
        )
      ).id
    : plan.stripeNumberPriceId!;

  // Minutes meter: forwarded + inbound + softphone minutes share one pool and
  // one allowance, so they are one meter with graduated tiers.
  let usageMeterId = plan.stripeUsageMeterId;
  if (!usageMeterId) {
    const meter = await s.billing.meters.create(
      {
        display_name: `${plan.name} minutes`,
        event_name: `tb_minutes_${suffix}`,
        default_aggregation: { formula: "sum" },
        customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
        value_settings: { event_payload_key: "value" },
      },
      opts,
    );
    usageMeterId = meter.id;
  }
  const usagePriceId =
    plan.stripeUsagePriceId && (await tiersMatch(s, opts, plan.stripeUsagePriceId, plan.includedMinutes, plan.perMinutePence))
      ? plan.stripeUsagePriceId
      : (
          await s.prices.create(
            {
              product: productId,
              currency,
              recurring: { interval: "month", usage_type: "metered", meter: usageMeterId },
              billing_scheme: "tiered",
              tiers_mode: "graduated",
              tiers:
                plan.includedMinutes > 0
                  ? [
                      { up_to: plan.includedMinutes, unit_amount: 0 },
                      { up_to: "inf", unit_amount: plan.perMinutePence },
                    ]
                  : [{ up_to: "inf", unit_amount: plan.perMinutePence }],
              nickname: `${plan.name} minutes (${plan.includedMinutes} included)`,
              metadata: { tb_plan_id: plan.id, tb_role: "usage" },
            },
            opts,
          )
        ).id;

  // 0800 inbound: no allowance, flat per minute.
  let freephoneMeterId = plan.stripeFreephoneMeterId;
  if (!freephoneMeterId) {
    const meter = await s.billing.meters.create(
      {
        display_name: `${plan.name} 0800 inbound minutes`,
        event_name: `tb_freephone_minutes_${suffix}`,
        default_aggregation: { formula: "sum" },
        customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
        value_settings: { event_payload_key: "value" },
      },
      opts,
    );
    freephoneMeterId = meter.id;
  }
  const freephonePriceId =
    plan.stripeFreephonePriceId && (await priceAmount(s, opts, plan.stripeFreephonePriceId)) === plan.freephoneInboundPence
      ? plan.stripeFreephonePriceId
      : (
          await s.prices.create(
            {
              product: productId,
              currency,
              unit_amount: plan.freephoneInboundPence,
              recurring: { interval: "month", usage_type: "metered", meter: freephoneMeterId },
              nickname: `${plan.name} 0800 inbound`,
              metadata: { tb_plan_id: plan.id, tb_role: "freephone" },
            },
            opts,
          )
        ).id;

  // Voicemail transcription, only when the plan charges for it.
  let voicemailMeterId = plan.stripeVoicemailMeterId;
  let voicemailPriceId = plan.stripeVoicemailPriceId;
  if (plan.voicemailTranscribePence > 0) {
    if (!voicemailMeterId) {
      const meter = await s.billing.meters.create(
        {
          display_name: `${plan.name} voicemail transcriptions`,
          event_name: `tb_voicemail_${suffix}`,
          default_aggregation: { formula: "sum" },
          customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
          value_settings: { event_payload_key: "value" },
        },
        opts,
      );
      voicemailMeterId = meter.id;
    }
    if (!voicemailPriceId || (await priceAmount(s, opts, voicemailPriceId)) !== plan.voicemailTranscribePence) {
      voicemailPriceId = (
        await s.prices.create(
          {
            product: productId,
            currency,
            unit_amount: plan.voicemailTranscribePence,
            recurring: { interval: "month", usage_type: "metered", meter: voicemailMeterId },
            nickname: `${plan.name} voicemail transcription`,
            metadata: { tb_plan_id: plan.id, tb_role: "voicemail" },
          },
          opts,
        )
      ).id;
    }
  }

  const [updated] = await db
    .update(plans)
    .set({
      stripeProductId: productId,
      stripeNumberPriceId: numberPriceId,
      stripeUsageMeterId: usageMeterId,
      stripeUsagePriceId: usagePriceId,
      stripeFreephoneMeterId: freephoneMeterId,
      stripeFreephonePriceId: freephonePriceId,
      stripeVoicemailMeterId: voicemailMeterId,
      stripeVoicemailPriceId: voicemailPriceId,
      publishedAt: new Date(),
    })
    .where(eq(plans.id, plan.id))
    .returning();
  return updated;
}

async function priceAmount(s: Stripe, opts: Stripe.RequestOptions, priceId: string): Promise<number | null> {
  try {
    const p = await s.prices.retrieve(priceId, {}, opts);
    return p.unit_amount ?? null;
  } catch {
    return null;
  }
}

async function tiersMatch(s: Stripe, opts: Stripe.RequestOptions, priceId: string, included: number, perMinute: number): Promise<boolean> {
  try {
    const p = await s.prices.retrieve(priceId, { expand: ["tiers"] }, opts);
    const tiers = p.tiers ?? [];
    if (included > 0) return tiers.length === 2 && tiers[0].up_to === included && tiers[0].unit_amount === 0 && tiers[1].unit_amount === perMinute;
    return tiers.length === 1 && tiers[0].unit_amount === perMinute;
  } catch {
    return false;
  }
}

/** Meter event names for a published plan (what the cron sends). */
export function meterEventNames(plan: Plan) {
  const suffix = plan.id.slice(0, 8);
  return {
    minutes: `tb_minutes_${suffix}`,
    freephone: `tb_freephone_minutes_${suffix}`,
    voicemail: `tb_voicemail_${suffix}`,
  };
}

/** The plan a new customer of this agency signs up to: the default, else the newest active. */
export async function defaultPlanFor(agencyId: string) {
  const rows = await db.query.plans.findMany({
    where: and(eq(plans.agencyId, agencyId), eq(plans.active, true)),
    orderBy: (p, { desc }) => [desc(p.isDefault), desc(p.createdAt)],
  });
  return rows[0] ?? null;
}

export function formatPence(pence: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
}
