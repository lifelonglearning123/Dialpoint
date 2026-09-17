import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions, usageLedger, type usageMeter } from "@/db/schema";
import { subaccountClient } from "@/lib/twilio/master";
import { meterEventNames } from "./plans";
import { NUMBER_TYPES, surchargeOn } from "./pricing";
import { forAccount, stripe } from "./stripe";
import { getSubscription, subscriptionAllowsNumbers, totalCount, type NumberCounts } from "./subscription";

export type UsageMeter = (typeof usageMeter.enumValues)[number];

/**
 * One ledger row per billable leg or event. Idempotent on (source_sid, meter):
 * Twilio retries status callbacks and the same leg must never bill twice.
 * Minutes are rounded UP per leg, the way carriers bill.
 */
export async function recordUsage(input: {
  clientId: string;
  callId?: string | null;
  sourceSid: string;
  meter: UsageMeter;
  seconds?: number;
  count?: number;
  occurredAt?: Date;
}) {
  const quantity = input.count ?? Math.ceil((input.seconds ?? 0) / 60);
  if (quantity <= 0) return null;
  const [row] = await db
    .insert(usageLedger)
    .values({
      clientId: input.clientId,
      callId: input.callId ?? null,
      sourceSid: input.sourceSid,
      meter: input.meter,
      quantity,
      seconds: input.seconds ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Twilio's price string ("-0.03050", in the account currency) → hundredths of a penny (305). */
export function costHundredthsFrom(price: string | null | undefined): number | null {
  if (price == null || price === "") return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) * 10000);
}

/**
 * Fill in Twilio's actual charge for call legs that do not have one yet.
 * Twilio prices a call shortly after it completes (usually within minutes,
 * occasionally longer), so legs younger than five minutes wait for the next
 * run, and a leg stays unpriced until Twilio says what it cost: nothing is
 * estimated. Transcriptions are not Twilio legs and are skipped.
 */
export async function priceUnpricedUsage(limit = 200) {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const rows = await db.query.usageLedger.findMany({
    where: and(isNull(usageLedger.pricedAt), lt(usageLedger.occurredAt, cutoff), ne(usageLedger.meter, "voicemail_transcribe")),
    orderBy: (u, { asc }) => [asc(u.occurredAt)],
    limit,
  });
  let priced = 0;
  let waiting = 0;
  let failed = 0;
  const clients = new Map<string, Awaited<ReturnType<typeof subaccountClient>>>();
  for (const row of rows) {
    try {
      let tw = clients.get(row.clientId);
      if (!tw) {
        tw = await subaccountClient(row.clientId);
        clients.set(row.clientId, tw);
      }
      const call = await tw.calls(row.sourceSid).fetch();
      const cost = costHundredthsFrom(call.price);
      if (cost === null) {
        waiting++;
        continue;
      }
      await db
        .update(usageLedger)
        .set({ costHundredths: cost, priceUnit: (call.priceUnit ?? "").toUpperCase() || null, pricedAt: new Date() })
        .where(eq(usageLedger.id, row.id));
      priced++;
    } catch (e) {
      failed++;
      console.error(`[usage] price lookup failed for ${row.sourceSid}:`, (e as Error).message);
    }
  }
  return { scanned: rows.length, priced, waiting, failed };
}

/**
 * Send unpushed ledger rows to Stripe as meter events on the agency's
 * connected account. Rows for clients without a live subscription stay
 * unpushed (they bill once the customer subscribes). On a pass-through plan a
 * call leg is sent as Twilio's cost in hundredths of a penny and is HELD until
 * Twilio has priced it. The ledger row id is the event identifier so a re-run
 * after a crash cannot double-count.
 */
export async function pushUsageToStripe(limit = 500) {
  const rows = await db.query.usageLedger.findMany({ where: isNull(usageLedger.pushedAt), orderBy: (u, { asc }) => [asc(u.occurredAt)], limit });
  let pushed = 0;
  let skipped = 0;
  let held = 0;
  const subCache = new Map<string, Awaited<ReturnType<typeof getSubscription>> | null>();
  const planCache = new Map<string, typeof plans.$inferSelect | null>();
  const s = stripe();
  const markPushed = (id: string, marker: string) => db.update(usageLedger).set({ pushedAt: new Date(), stripeMeterEventId: marker }).where(eq(usageLedger.id, id));

  for (const row of rows) {
    let sub = subCache.get(row.clientId);
    if (sub === undefined) {
      sub = (await getSubscription(row.clientId)) ?? null;
      subCache.set(row.clientId, sub);
    }
    if (!sub || !subscriptionAllowsNumbers(sub) || !sub.stripeSubscriptionId) {
      skipped++;
      continue;
    }
    let plan = planCache.get(sub.planId);
    if (plan === undefined) {
      plan = (await db.query.plans.findFirst({ where: eq(plans.id, sub.planId) })) ?? null;
      planCache.set(sub.planId, plan);
    }
    if (!plan) {
      skipped++;
      continue;
    }
    const names = meterEventNames(plan);

    let eventName: string;
    let value: number;
    if (row.meter === "voicemail_transcribe") {
      if (!plan.stripeVoicemailMeterId) {
        // Plan does not charge for transcription: mark as pushed so it never blocks the queue.
        await markPushed(row.id, "not-billed");
        continue;
      }
      eventName = names.voicemail;
      value = row.quantity;
    } else if (plan.usageMode === "passthrough") {
      if (!plan.stripeCostMeterId) {
        skipped++;
        continue;
      }
      if (row.costHundredths == null) {
        held++; // Twilio has not priced this leg yet
        continue;
      }
      if (row.priceUnit && row.priceUnit !== plan.currency.toUpperCase()) {
        console.error(`[usage] ${row.sourceSid} priced in ${row.priceUnit} but plan ${plan.id} bills in ${plan.currency}; not pushed`);
        skipped++;
        continue;
      }
      if (row.costHundredths === 0) {
        await markPushed(row.id, "zero-cost");
        continue;
      }
      eventName = names.cost;
      value = row.costHundredths;
    } else {
      eventName = row.meter === "freephone_inbound" ? names.freephone : names.minutes;
      value = row.quantity;
    }

    try {
      const ev = await s.billing.meterEvents.create(
        {
          event_name: eventName,
          payload: { stripe_customer_id: sub.stripeCustomerId, value: String(value) },
          identifier: row.id,
          timestamp: Math.floor(row.occurredAt.getTime() / 1000),
        },
        forAccount(sub.stripeAccountId),
      );
      await db.update(usageLedger).set({ pushedAt: new Date(), stripeMeterEventId: ev.identifier }).where(eq(usageLedger.id, row.id));
      pushed++;
    } catch (e) {
      // Stripe rejects events older than ~35 days or with a duplicate identifier; log and move on.
      console.error(`[usage] meter event failed for ${row.id}:`, (e as Error).message);
      skipped++;
    }
  }
  return { scanned: rows.length, pushed, skipped, held };
}

export type UsageSummary = {
  periodStart: Date;
  periodEnd: Date;
  minutes: { forward: number; inbound: number; softphone: number; pooled: number };
  freephoneMinutes: number;
  transcriptions: number;
  includedMinutes: number;
  overageMinutes: number;
  /** Pass-through plans: Twilio's charges so far in minor units, and legs Twilio has not priced yet. */
  passthrough: boolean;
  twilioCostPence: number;
  unpricedLegs: number;
  /** Projected usage charge for the period so far, in minor units. */
  projectedPence: number;
  /** Twilio's monthly number charges: Σ carrier[type] × active numbers of that type. */
  carrierPence: number;
  /** Hosting charge × active numbers (at least 1 while subscribed). */
  hostingPence: number;
  /** carrierPence + hostingPence. */
  fixedPence: number;
  /** Card processing surcharge on fixed + projected. */
  surchargePence: number;
};

/** Minutes by meter for a period, with the plan's allowance applied. */
export async function usageSummary(clientId: string, plan: typeof plans.$inferSelect | null, active: NumberCounts, period?: { start: Date; end: Date }): Promise<UsageSummary> {
  const sub = await getSubscription(clientId);
  const now = new Date();
  const periodStart = period?.start ?? sub?.currentPeriodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = period?.end ?? sub?.currentPeriodEnd ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const inPeriod = and(eq(usageLedger.clientId, clientId), gte(usageLedger.occurredAt, periodStart), lt(usageLedger.occurredAt, periodEnd));

  const rows = await db
    .select({ meter: usageLedger.meter, total: sql<number>`coalesce(sum(${usageLedger.quantity}), 0)::int` })
    .from(usageLedger)
    .where(inPeriod)
    .groupBy(usageLedger.meter);
  const by = (m: UsageMeter) => rows.find((r) => r.meter === m)?.total ?? 0;

  const minutes = { forward: by("forward"), inbound: by("inbound"), softphone: by("softphone"), pooled: 0 };
  minutes.pooled = minutes.forward + minutes.inbound + minutes.softphone;
  const freephoneMinutes = by("freephone_inbound");
  const transcriptions = by("voicemail_transcribe");
  const passthrough = plan?.usageMode === "passthrough";
  const includedMinutes = passthrough ? 0 : (plan?.includedMinutes ?? 0);
  const overageMinutes = Math.max(0, minutes.pooled - includedMinutes);

  let twilioCostPence = 0;
  let unpricedLegs = 0;
  if (passthrough) {
    const [c] = await db
      .select({
        hundredths: sql<number>`coalesce(sum(${usageLedger.costHundredths}), 0)::int`,
        unpriced: sql<number>`count(*) filter (where ${usageLedger.costHundredths} is null)::int`,
      })
      .from(usageLedger)
      .where(and(inPeriod, ne(usageLedger.meter, "voicemail_transcribe")));
    twilioCostPence = Math.round((c?.hundredths ?? 0) / 100);
    unpricedLegs = c?.unpriced ?? 0;
  }

  const projectedPence = plan
    ? (passthrough ? twilioCostPence : overageMinutes * plan.perMinutePence + freephoneMinutes * plan.freephoneInboundPence) + transcriptions * plan.voicemailTranscribePence
    : 0;
  const carrierPence = plan ? NUMBER_TYPES.reduce((sum, t) => sum + (plan.carrierMonthlyPence[t] ?? 0) * (active[t] ?? 0), 0) : 0;
  const hostingPence = plan ? plan.hostingMonthlyPence * Math.max(totalCount(active), sub ? 1 : 0) : 0;
  const fixedPence = carrierPence + hostingPence;
  const surchargePence = plan ? surchargeOn(fixedPence + projectedPence, plan.surchargeBps) : 0;

  return {
    periodStart,
    periodEnd,
    minutes,
    freephoneMinutes,
    transcriptions,
    includedMinutes,
    overageMinutes,
    passthrough,
    twilioCostPence,
    unpricedLegs,
    projectedPence,
    carrierPence,
    hostingPence,
    fixedPence,
    surchargePence,
  };
}

export { subscriptions };
