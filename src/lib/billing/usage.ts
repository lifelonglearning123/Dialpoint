import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions, usageLedger, type usageMeter } from "@/db/schema";
import { meterEventNames } from "./plans";
import { forAccount, stripe } from "./stripe";
import { getSubscription, subscriptionAllowsNumbers } from "./subscription";

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

/**
 * Send unpushed ledger rows to Stripe as meter events on the agency's
 * connected account. Rows for clients without a live subscription stay
 * unpushed (they bill once the customer subscribes). The ledger row id is the
 * event identifier so a re-run after a crash cannot double-count.
 */
export async function pushUsageToStripe(limit = 500) {
  const rows = await db.query.usageLedger.findMany({ where: isNull(usageLedger.pushedAt), orderBy: (u, { asc }) => [asc(u.occurredAt)], limit });
  let pushed = 0;
  let skipped = 0;
  const subCache = new Map<string, Awaited<ReturnType<typeof getSubscription>> | null>();
  const planCache = new Map<string, typeof plans.$inferSelect | null>();
  const s = stripe();

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
    const eventName = row.meter === "freephone_inbound" ? names.freephone : row.meter === "voicemail_transcribe" ? names.voicemail : names.minutes;
    if (row.meter === "voicemail_transcribe" && !plan.stripeVoicemailMeterId) {
      // Plan does not charge for transcription: mark as pushed so it never blocks the queue.
      await db.update(usageLedger).set({ pushedAt: new Date(), stripeMeterEventId: "not-billed" }).where(eq(usageLedger.id, row.id));
      continue;
    }
    try {
      const ev = await s.billing.meterEvents.create(
        {
          event_name: eventName,
          payload: { stripe_customer_id: sub.stripeCustomerId, value: String(row.quantity) },
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
  return { scanned: rows.length, pushed, skipped };
}

export type UsageSummary = {
  periodStart: Date;
  periodEnd: Date;
  minutes: { forward: number; inbound: number; softphone: number; pooled: number };
  freephoneMinutes: number;
  transcriptions: number;
  includedMinutes: number;
  overageMinutes: number;
  /** Projected usage charge for the period so far, in pence. */
  projectedPence: number;
  /** Fixed fee for the period: number fee × active numbers. */
  fixedPence: number;
};

/** Minutes by meter for a period, with the plan's allowance applied. */
export async function usageSummary(clientId: string, plan: typeof plans.$inferSelect | null, activeNumbers: number, period?: { start: Date; end: Date }): Promise<UsageSummary> {
  const sub = await getSubscription(clientId);
  const now = new Date();
  const periodStart = period?.start ?? sub?.currentPeriodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = period?.end ?? sub?.currentPeriodEnd ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const rows = await db
    .select({ meter: usageLedger.meter, total: sql<number>`coalesce(sum(${usageLedger.quantity}), 0)::int` })
    .from(usageLedger)
    .where(and(eq(usageLedger.clientId, clientId), gte(usageLedger.occurredAt, periodStart), lt(usageLedger.occurredAt, periodEnd)))
    .groupBy(usageLedger.meter);
  const by = (m: UsageMeter) => rows.find((r) => r.meter === m)?.total ?? 0;

  const minutes = { forward: by("forward"), inbound: by("inbound"), softphone: by("softphone"), pooled: 0 };
  minutes.pooled = minutes.forward + minutes.inbound + minutes.softphone;
  const freephoneMinutes = by("freephone_inbound");
  const transcriptions = by("voicemail_transcribe");
  const includedMinutes = plan?.includedMinutes ?? 0;
  const overageMinutes = Math.max(0, minutes.pooled - includedMinutes);
  const projectedPence = plan
    ? overageMinutes * plan.perMinutePence + freephoneMinutes * plan.freephoneInboundPence + transcriptions * plan.voicemailTranscribePence
    : 0;
  const fixedPence = plan ? plan.numberMonthlyPence * Math.max(activeNumbers, sub ? 1 : 0) : 0;

  return { periodStart, periodEnd, minutes, freephoneMinutes, transcriptions, includedMinutes, overageMinutes, projectedPence, fixedPence };
}

export { subscriptions };
