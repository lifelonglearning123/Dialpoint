import { and, eq } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db/client";
import { plans, type PriceRole } from "@/db/schema";
import { agencies } from "@/db/shared";
import { NUMBER_TYPES, NUMBER_TYPE_LABELS, wholesaleFloor } from "./pricing";
import { forAccount, stripe } from "./stripe";

// Pure pricing helpers live in ./pricing (no db/Stripe imports, safe for client
// components); re-exported here so server code keeps one import.
export { floorFor, formatMinor, formatPence, formatRate, fromMonthly, surchargeOn, surchargePercent, wholesaleFloor, NUMBER_TYPES, NUMBER_TYPE_LABELS, TWILIO_GBP } from "./pricing";

export type Plan = typeof plans.$inferSelect;

async function agencyStripeAccount(agencyId: string) {
  const [a] = await db.select({ stripeAccountId: agencies.stripeAccountId, name: agencies.name }).from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!a?.stripeAccountId) throw new Error("This agency has not connected Stripe yet. Connect it in the Signal dashboard first.");
  return { account: a.stripeAccountId, name: a.name };
}

const METER_CUSTOMER = { type: "by_id", event_payload_key: "stripe_customer_id" } as const;
const METER_VALUE = { event_payload_key: "value" } as const;

/**
 * Create the Stripe objects for a plan on the agency's connected account. One
 * Product per invoice line so the customer's invoice itemises exactly what was
 * agreed: "Twilio monthly number charge — Local", "<Agency> monthly hosting
 * charge", "Twilio usage charge", and so on. Then:
 *   - a licensed monthly Price per number type (the Twilio charge),
 *   - a licensed monthly Price for hosting,
 *   - usage: flat plans get Billing Meters + metered Prices for minutes and
 *     0800 minutes; pass-through plans get ONE meter whose value is Twilio's
 *     cost in hundredths of a penny, priced at 0.01p a unit, so the invoice
 *     line is Twilio's charge to the penny,
 *   - a metered Price for voicemail transcriptions when charged,
 *   - a TaxRate carrying the card-processing surcharge percentage.
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
  const { account, name: agencyName } = await agencyStripeAccount(plan.agencyId);
  const s = stripe();
  const opts = forAccount(account);
  const currency = plan.currency.toLowerCase();
  const names = meterEventNames(plan);
  const passthrough = plan.usageMode === "passthrough";

  const productIds: Partial<Record<PriceRole, string>> = { ...plan.stripeProductIds };
  const productFor = async (role: PriceRole, productName: string) => {
    const existing = productIds[role];
    if (existing) return existing;
    const product = await s.products.create({ name: productName, metadata: { tb_plan_id: plan.id, tb_role: role } }, opts);
    productIds[role] = product.id;
    return product.id;
  };
  const licensed = { interval: "month", usage_type: "licensed" } as const;
  const metered = (meter: string) => ({ interval: "month", usage_type: "metered", meter }) as const;

  // 1. Twilio's monthly number charge: one licensed price per number type.
  const carrierPriceIds = { ...plan.stripeCarrierPriceIds };
  for (const t of NUMBER_TYPES) {
    const amount = plan.carrierMonthlyPence[t] ?? 0;
    const current = carrierPriceIds[t];
    if (current && (await priceAmount(s, opts, current)) === amount) continue;
    const product = await productFor(`carrier:${t}`, `Twilio monthly number charge — ${NUMBER_TYPE_LABELS[t]}`);
    carrierPriceIds[t] = (
      await s.prices.create(
        { product, currency, unit_amount: amount, recurring: licensed, nickname: `${plan.name} Twilio ${t}`, metadata: { tb_plan_id: plan.id, tb_role: `carrier:${t}` } },
        opts,
      )
    ).id;
  }

  // 2. The agency's monthly hosting charge per number.
  let hostingPriceId = plan.stripeHostingPriceId;
  if (!hostingPriceId || (await priceAmount(s, opts, hostingPriceId)) !== plan.hostingMonthlyPence) {
    const product = await productFor("hosting", `${agencyName} monthly hosting charge`);
    hostingPriceId = (
      await s.prices.create(
        { product, currency, unit_amount: plan.hostingMonthlyPence, recurring: licensed, nickname: `${plan.name} hosting`, metadata: { tb_plan_id: plan.id, tb_role: "hosting" } },
        opts,
      )
    ).id;
  }

  // 3. Usage.
  let usageMeterId = plan.stripeUsageMeterId;
  let usagePriceId = plan.stripeUsagePriceId;
  let freephoneMeterId = plan.stripeFreephoneMeterId;
  let freephonePriceId = plan.stripeFreephonePriceId;
  let costMeterId = plan.stripeCostMeterId;
  let costPriceId = plan.stripeCostPriceId;

  if (passthrough) {
    // 3p. Twilio's charge, passed through: value = cost in hundredths of a penny.
    if (!costMeterId) {
      const meter = await s.billing.meters.create(
        { display_name: `${plan.name} Twilio call charges (0.01p units)`, event_name: names.cost, default_aggregation: { formula: "sum" }, customer_mapping: METER_CUSTOMER, value_settings: METER_VALUE },
        opts,
      );
      costMeterId = meter.id;
    }
    if (!costPriceId) {
      costPriceId = (
        await s.prices.create(
          {
            product: await productFor("cost", "Twilio call charges — at cost"),
            currency,
            unit_amount_decimal: Stripe.Decimal.from("0.01"), // 0.01p per unit; meter value is cost in hundredths of a penny
            recurring: metered(costMeterId),
            nickname: `${plan.name} Twilio call charges at cost`,
            metadata: { tb_plan_id: plan.id, tb_role: "cost" },
          },
          opts,
        )
      ).id;
    }
  } else {
    // 3a. Minutes meter: forwarded + inbound + softphone minutes share one pool and
    // one allowance, so they are one meter with graduated tiers.
    if (!usageMeterId) {
      const meter = await s.billing.meters.create(
        { display_name: `${plan.name} minutes`, event_name: names.minutes, default_aggregation: { formula: "sum" }, customer_mapping: METER_CUSTOMER, value_settings: METER_VALUE },
        opts,
      );
      usageMeterId = meter.id;
    }
    if (!usagePriceId || !(await tiersMatch(s, opts, usagePriceId, plan.includedMinutes, plan.perMinutePence))) {
      usagePriceId = (
        await s.prices.create(
          {
            product: await productFor("usage", "Twilio usage charge — per minute"),
            currency,
            recurring: metered(usageMeterId),
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
    }

    // 3b. 0800 inbound: no allowance, flat per minute.
    if (!freephoneMeterId) {
      const meter = await s.billing.meters.create(
        { display_name: `${plan.name} 0800 inbound minutes`, event_name: names.freephone, default_aggregation: { formula: "sum" }, customer_mapping: METER_CUSTOMER, value_settings: METER_VALUE },
        opts,
      );
      freephoneMeterId = meter.id;
    }
    if (!freephonePriceId || (await priceAmount(s, opts, freephonePriceId)) !== plan.freephoneInboundPence) {
      freephonePriceId = (
        await s.prices.create(
          {
            product: await productFor("freephone", "Twilio usage charge — 0800 inbound per minute"),
            currency,
            unit_amount: plan.freephoneInboundPence,
            recurring: metered(freephoneMeterId),
            nickname: `${plan.name} 0800 inbound`,
            metadata: { tb_plan_id: plan.id, tb_role: "freephone" },
          },
          opts,
        )
      ).id;
    }
  }

  // 3c. Voicemail transcription, only when the plan charges for it (not a Twilio cost, so the same in both modes).
  let voicemailMeterId = plan.stripeVoicemailMeterId;
  let voicemailPriceId = plan.stripeVoicemailPriceId;
  if (plan.voicemailTranscribePence > 0) {
    if (!voicemailMeterId) {
      const meter = await s.billing.meters.create(
        { display_name: `${plan.name} voicemail transcriptions`, event_name: names.voicemail, default_aggregation: { formula: "sum" }, customer_mapping: METER_CUSTOMER, value_settings: METER_VALUE },
        opts,
      );
      voicemailMeterId = meter.id;
    }
    if (!voicemailPriceId || (await priceAmount(s, opts, voicemailPriceId)) !== plan.voicemailTranscribePence) {
      voicemailPriceId = (
        await s.prices.create(
          {
            product: await productFor("voicemail", "Voicemail transcription"),
            currency,
            unit_amount: plan.voicemailTranscribePence,
            recurring: metered(voicemailMeterId),
            nickname: `${plan.name} voicemail transcription`,
            metadata: { tb_plan_id: plan.id, tb_role: "voicemail" },
          },
          opts,
        )
      ).id;
    }
  }

  // 4. Card processing surcharge: a percentage line on every invoice. Stripe
  // models percentage add-ons as TaxRates (exclusive, so it is added on top);
  // the percentage is immutable, so a change creates a new rate.
  let surchargeTaxRateId = plan.stripeSurchargeTaxRateId;
  if (plan.surchargeBps > 0) {
    const percentage = plan.surchargeBps / 100;
    if (!surchargeTaxRateId || (await taxRatePercentage(s, opts, surchargeTaxRateId)) !== percentage) {
      surchargeTaxRateId = (
        await s.taxRates.create(
          {
            display_name: "Card processing surcharge",
            percentage,
            inclusive: false,
            description: `${percentage}% card processing surcharge`,
            metadata: { tb_plan_id: plan.id, tb_role: "surcharge" },
          },
          opts,
        )
      ).id;
    }
  } else {
    surchargeTaxRateId = null;
  }

  const [updated] = await db
    .update(plans)
    .set({
      stripeProductIds: productIds,
      stripeCarrierPriceIds: carrierPriceIds,
      stripeHostingPriceId: hostingPriceId,
      stripeUsageMeterId: usageMeterId,
      stripeUsagePriceId: usagePriceId,
      stripeFreephoneMeterId: freephoneMeterId,
      stripeFreephonePriceId: freephonePriceId,
      stripeCostMeterId: costMeterId,
      stripeCostPriceId: costPriceId,
      stripeVoicemailMeterId: voicemailMeterId,
      stripeVoicemailPriceId: voicemailPriceId,
      stripeSurchargeTaxRateId: surchargeTaxRateId,
      publishedAt: new Date(),
    })
    .where(eq(plans.id, plan.id))
    .returning();
  return updated;
}

/** True when every Stripe object the checkout needs exists for this plan. */
export function planFullyPublished(plan: Plan) {
  const usageReady = plan.usageMode === "passthrough" ? !!plan.stripeCostPriceId : !!plan.stripeUsagePriceId && !!plan.stripeFreephonePriceId;
  return (
    !!plan.publishedAt &&
    !!plan.stripeHostingPriceId &&
    usageReady &&
    NUMBER_TYPES.every((t) => !!plan.stripeCarrierPriceIds[t]) &&
    (plan.surchargeBps === 0 || !!plan.stripeSurchargeTaxRateId) &&
    (plan.voicemailTranscribePence === 0 || !!plan.stripeVoicemailPriceId)
  );
}

async function priceAmount(s: Stripe, opts: Stripe.RequestOptions, priceId: string): Promise<number | null> {
  try {
    const p = await s.prices.retrieve(priceId, {}, opts);
    return p.unit_amount ?? null;
  } catch {
    return null;
  }
}

async function taxRatePercentage(s: Stripe, opts: Stripe.RequestOptions, taxRateId: string): Promise<number | null> {
  try {
    const r = await s.taxRates.retrieve(taxRateId, {}, opts);
    return r.active ? r.percentage : null;
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
export function meterEventNames(plan: Pick<Plan, "id">) {
  const suffix = plan.id.slice(0, 8);
  return {
    minutes: `tb_minutes_${suffix}`,
    freephone: `tb_freephone_minutes_${suffix}`,
    voicemail: `tb_voicemail_${suffix}`,
    cost: `tb_cost_${suffix}`,
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
