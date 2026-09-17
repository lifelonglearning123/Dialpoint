/**
 * Pure pricing rules shared by the plan editor (client component), the
 * server actions and the Stripe publisher. No database or Stripe imports.
 *
 * A plan is three things the customer sees as separate invoice lines:
 *   1. Twilio's monthly number charge, per number type, passed through.
 *   2. The agency's monthly hosting charge per number (where the margin is).
 *   3. Twilio usage per minute (plus 0800 inbound and optional transcription).
 * On top of the total, a card-processing surcharge (default 3%) is applied as
 * a percentage line on every invoice.
 */

export const NUMBER_TYPES = ["local", "national", "tollfree", "mobile"] as const;
export type NumberTypeKey = (typeof NUMBER_TYPES)[number];

export const NUMBER_TYPE_LABELS: Record<NumberTypeKey, string> = {
  local: "Local (01/02)",
  national: "National (03)",
  tollfree: "Freephone (0800)",
  mobile: "Mobile (07)",
};

export const CURRENCIES = ["GBP", "USD", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function asCurrency(v: unknown): Currency {
  const c = String(v ?? "").toUpperCase();
  return (CURRENCIES as readonly string[]).includes(c) ? (c as Currency) : "GBP";
}

/** Per-type monthly amounts in minor units (pence / cents). */
export type CarrierMonthly = Record<NumberTypeKey, number>;

/**
 * Wholesale cost. Twilio list prices on the master account (GBP, 2026-09):
 * local £3.50/mo, national 03 £3.50, 0800 £2.70, mobile £2.50; forwarded leg
 * to a UK mobile ≈3.05p/min (landline 1.58p) + inbound 1p/min; 0800 inbound
 * 7.98p/min. A plan below these loses money on every customer, so the editor
 * refuses it.
 */
export const TWILIO_GBP = {
  carrierMonthly: { local: 350, national: 350, tollfree: 270, mobile: 250 } as CarrierMonthly,
  perMinutePence: 4, // forward to mobile 3.05p + inbound 1p, rounded
  freephoneInboundPence: 9, // 7.98p + margin
} as const;

/**
 * GBP → plan-currency multipliers used ONLY for the floor check. Deliberately
 * above market so a plan priced in USD/EUR stays above Twilio's GBP cost when
 * the exchange rate moves. Edit here when rates drift.
 */
export const FLOOR_RATES: Record<Currency, number> = { GBP: 1, USD: 1.45, EUR: 1.25 };

export type Floor = { carrierMonthly: CarrierMonthly; perMinute: number; freephoneInbound: number };

export function floorFor(currency: string): Floor {
  const rate = FLOOR_RATES[asCurrency(currency)] ?? 1;
  const up = (gbp: number) => Math.ceil(gbp * rate);
  return {
    carrierMonthly: {
      local: up(TWILIO_GBP.carrierMonthly.local),
      national: up(TWILIO_GBP.carrierMonthly.national),
      tollfree: up(TWILIO_GBP.carrierMonthly.tollfree),
      mobile: up(TWILIO_GBP.carrierMonthly.mobile),
    },
    perMinute: up(TWILIO_GBP.perMinutePence),
    freephoneInbound: up(TWILIO_GBP.freephoneInboundPence),
  };
}

/** The fields the floor check needs; a `plans` row satisfies it. */
export type PlanPricing = {
  currency: string;
  carrierMonthlyPence: CarrierMonthly;
  hostingMonthlyPence: number;
  includedMinutes: number;
  perMinutePence: number;
  freephoneInboundPence: number;
  surchargeBps: number;
};

export function wholesaleFloor(plan: PlanPricing) {
  const floor = floorFor(plan.currency);
  const cur = plan.currency;
  const problems: string[] = [];
  for (const t of NUMBER_TYPES) {
    const amount = plan.carrierMonthlyPence?.[t] ?? 0;
    if (amount < floor.carrierMonthly[t]) {
      problems.push(`Twilio number charge for ${NUMBER_TYPE_LABELS[t]} must be at least ${formatMinor(floor.carrierMonthly[t], cur)} (Twilio's monthly cost).`);
    }
  }
  if (plan.perMinutePence < floor.perMinute) {
    problems.push(`Usage per minute must be at least ${formatRate(floor.perMinute, cur)} (forwarding to a UK mobile costs about 3p a minute plus 1p inbound).`);
  }
  if (plan.freephoneInboundPence < floor.freephoneInbound) {
    problems.push(`0800 inbound must be at least ${formatRate(floor.freephoneInbound, cur)} a minute (Twilio charges 7.98p).`);
  }
  // Included minutes are paid for by the hosting charge: every included minute
  // costs carrier time, so hosting must cover them.
  const minutesCost = plan.includedMinutes * floor.perMinute;
  if (plan.hostingMonthlyPence < minutesCost) {
    const maxIncluded = Math.max(0, Math.floor(plan.hostingMonthlyPence / floor.perMinute));
    problems.push(`At ${formatMinor(plan.hostingMonthlyPence, cur)} hosting a month only ${maxIncluded} included minutes are covered (each costs about ${formatRate(floor.perMinute, cur)} of carrier time).`);
  }
  if (plan.surchargeBps < 0 || plan.surchargeBps > 2000) {
    problems.push("The card processing surcharge must be between 0% and 20%.");
  }
  return { ok: problems.length === 0, problems };
}

/** Cheapest "per number per month" a customer can pay on this plan: hosting + the cheapest carrier charge. */
export function fromMonthly(plan: Pick<PlanPricing, "carrierMonthlyPence" | "hostingMonthlyPence">) {
  const carriers = NUMBER_TYPES.map((t) => plan.carrierMonthlyPence?.[t] ?? 0);
  return plan.hostingMonthlyPence + Math.min(...carriers);
}

/** Percentage surcharge on an amount, rounded to the nearest minor unit. */
export function surchargeOn(amountMinor: number, surchargeBps: number) {
  return Math.round((amountMinor * surchargeBps) / 10000);
}

export function surchargePercent(surchargeBps: number) {
  const pct = surchargeBps / 100;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0+$/, "");
}

const LOCALE: Record<Currency, string> = { GBP: "en-GB", USD: "en-US", EUR: "en-IE" };
const MINOR_SUFFIX: Record<Currency, string> = { GBP: "p", USD: "¢", EUR: "c" };
const SYMBOL: Record<Currency, string> = { GBP: "£", USD: "$", EUR: "€" };

/** £9.00 / $9.00 / €9.00 from minor units. */
export function formatMinor(amountMinor: number, currency = "GBP") {
  const c = asCurrency(currency);
  return new Intl.NumberFormat(LOCALE[c], { style: "currency", currency: c }).format(amountMinor / 100);
}

/** Small per-unit rates: 5p / 5¢ / 5c. Falls back to the full amount at or above one unit. */
export function formatRate(amountMinor: number, currency = "GBP") {
  const c = asCurrency(currency);
  if (amountMinor >= 100) return formatMinor(amountMinor, c);
  return `${amountMinor}${MINOR_SUFFIX[c]}`;
}

export function currencySymbol(currency = "GBP") {
  return SYMBOL[asCurrency(currency)];
}

/** Backwards-compatible name used across the app. */
export const formatPence = formatMinor;
