import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { callLegs, calls, numbers } from "@/db/schema";
import { recordUsage } from "@/lib/billing/usage";

export type LegKind = (typeof callLegs.$inferInsert)["kind"];

/** Every webhook step appends here; the calls page shows it as "why did the AI answer". */
export async function appendTrace(callId: string, step: string, data: Record<string, string> = {}) {
  const ev = { at: new Date().toISOString(), step, data };
  console.log(`[voice] ${ev.at} ${callId.slice(0, 8)} ${step}`, JSON.stringify(data));
  await db
    .update(calls)
    .set({ routeTrace: sql`${calls.routeTrace} || ${JSON.stringify([ev])}::jsonb` })
    .where(eq(calls.id, callId));
}

export async function createCall(input: {
  clientId: string;
  numberId: string;
  policyId: string | null;
  twilioCallSid: string;
  from: string;
  to: string;
  callerName: string | null;
}) {
  const [row] = await db
    .insert(calls)
    .values({
      clientId: input.clientId,
      numberId: input.numberId,
      policyId: input.policyId,
      twilioCallSid: input.twilioCallSid,
      fromE164: input.from,
      toE164: input.to,
      callerName: input.callerName,
      outcome: "in_progress",
      routeTrace: [],
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  return (await db.query.calls.findFirst({ where: eq(calls.twilioCallSid, input.twilioCallSid) }))!;
}

export async function findCallBySid(twilioCallSid: string) {
  return db.query.calls.findFirst({ where: eq(calls.twilioCallSid, twilioCallSid) });
}

/** Status callback for a child leg: insert on first sight, update status/duration afterwards. */
export async function recordLeg(input: { callId: string; twilioCallSid: string; kind: LegKind; target: string | null; status: string; durationSeconds?: number }) {
  const existing = await db.query.callLegs.findFirst({ where: and(eq(callLegs.callId, input.callId), eq(callLegs.twilioCallSid, input.twilioCallSid)) });
  const ended = input.status === "completed" || input.status === "no-answer" || input.status === "busy" || input.status === "failed" || input.status === "canceled";
  if (!existing) {
    await db.insert(callLegs).values({
      callId: input.callId,
      twilioCallSid: input.twilioCallSid,
      kind: input.kind,
      target: input.target,
      status: input.status,
      durationSeconds: input.durationSeconds ?? null,
      endedAt: ended ? new Date() : null,
    });
    return;
  }
  await db
    .update(callLegs)
    .set({
      status: input.status,
      durationSeconds: input.durationSeconds ?? existing.durationSeconds,
      endedAt: ended ? new Date() : existing.endedAt,
      // A browser leg that connected counts as accepted (no whisper on <Client>).
      accepted: existing.accepted || (existing.kind === "human_client" && (input.status === "in-progress" || input.status === "answered")),
    })
    .where(eq(callLegs.id, existing.id));

  // Billing (Phase 3): a finished human leg is carrier time we pay for. The
  // ledger is idempotent on the leg SID, so Twilio's retries cannot double bill.
  if (ended && (input.durationSeconds ?? 0) > 0 && (input.kind === "human_pstn" || input.kind === "human_client")) {
    const call = await db.query.calls.findFirst({ where: eq(calls.id, input.callId), columns: { clientId: true } });
    if (call) {
      await recordUsage({
        clientId: call.clientId,
        callId: input.callId,
        sourceSid: input.twilioCallSid,
        meter: input.kind === "human_pstn" ? "forward" : "softphone",
        seconds: input.durationSeconds,
      }).catch((e) => console.error("[usage] leg", e));
    }
  }
}

/** The human pressed 1 on this leg. */
export async function markLegAccepted(legTwilioCallSid: string) {
  await db.update(callLegs).set({ accepted: true }).where(eq(callLegs.twilioCallSid, legTwilioCallSid));
}

/** Parent call finished: derive the outcome from the legs. */
export async function finalizeCall(twilioCallSid: string, opts: { durationSeconds?: number; status: string }) {
  const call = await findCallBySid(twilioCallSid);
  if (!call) return null;
  const legs = await db.query.callLegs.findMany({ where: eq(callLegs.callId, call.id) });
  const trace = call.routeTrace ?? [];
  let outcome: (typeof calls.$inferSelect)["outcome"];
  if (trace.some((t) => t.step === "rejected")) outcome = "blocked";
  else if (legs.some((l) => l.accepted && (l.kind === "human_pstn" || l.kind === "human_client"))) outcome = "human";
  else if (legs.some((l) => l.kind === "ai" && (l.durationSeconds ?? 0) > 0)) outcome = "ai";
  else if (legs.some((l) => l.kind === "voicemail") || trace.some((t) => t.step === "voicemail_recorded")) outcome = "voicemail";
  else outcome = "missed";
  const [updated] = await db
    .update(calls)
    .set({ outcome, endedAt: new Date(), durationSeconds: opts.durationSeconds ?? call.durationSeconds })
    .where(eq(calls.id, call.id))
    .returning();

  // Billing (Phase 3): the caller's own leg. Local/mobile inbound is cheap and
  // pooled with the allowance; 0800 inbound costs ~8p/min and is always billed.
  const seconds = opts.durationSeconds ?? call.durationSeconds ?? 0;
  if (seconds > 0 && call.numberId) {
    const num = await db.query.numbers.findFirst({ where: eq(numbers.id, call.numberId), columns: { type: true } });
    await recordUsage({
      clientId: call.clientId,
      callId: call.id,
      sourceSid: twilioCallSid,
      meter: num?.type === "tollfree" ? "freephone_inbound" : "inbound",
      seconds,
    }).catch((e) => console.error("[usage] parent", e));
  }
  return updated;
}
