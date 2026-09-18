import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { callLegs, callRecordings, calls, routingPolicies, voicemails } from "@/db/schema";
import { env } from "@/env";
import { parsePolicy } from "@/lib/routing/policy";
import { url } from "@/lib/routing/twiml";

/**
 * Every call Signal would not otherwise see goes into its call log.
 *
 * Calls the AI answers already reach Signal through its Retell webhook. The
 * rest — a person answered, voicemail, missed, blocked — are reported to
 * Signal's `POST /api/partner/phone/call` once they are over, with a
 * time-limited link to the recording. Signal shows them, transcribes the
 * conversations, writes them to the client's CRM, and does NOT bill them:
 * this app bills its own minutes.
 *
 * A call is reported once it has everything it will get: the recording of an
 * answered call on a number that records, and a voicemail's transcript. Each
 * of those events tries again (handlers.ts, voicemail.ts); after SETTLE_MS the
 * hourly cron sends whatever there is. `tb.calls.signal_reported_at` makes it
 * once only.
 */

const SETTLE_MS = 2 * 60 * 1000;
/** Signal retries a recording for 48 hours; the link outlives that. */
const LINK_TTL_SECONDS = 3 * 24 * 60 * 60;
const SWEEP_WINDOW_MS = 48 * 60 * 60 * 1000;

export function signalConfigured(): boolean {
  return !!(env.SIGNAL_PARTNER_URL && env.SIGNAL_PARTNER_SECRET);
}

/* ---------------------------------------------------------- recording links */

function linkKey(): Buffer {
  const secret = env.ROUTING_SIGNING_SECRET ?? env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("ROUTING_SIGNING_SECRET (or CREDENTIALS_ENCRYPTION_KEY) must be set to sign recording links");
  return createHmac("sha256", "tb-recording-link").update(secret).digest();
}

function linkSignature(id: string, exp: number): string {
  return createHmac("sha256", linkKey()).update(`${id}.${exp}`).digest("base64url");
}

/** Public, expiring link to one recording (a call recording or a voicemail) for Signal to fetch. */
export function recordingLink(id: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  return url(`/api/partner/recordings/${id}`, { exp: String(exp), sig: linkSignature(id, exp) });
}

export function verifyRecordingLink(id: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  const e = Number(exp);
  if (!sig || !Number.isInteger(e) || e < Math.floor(now / 1000)) return false;
  const expected = linkSignature(id, e);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/* ----------------------------------------------------------------- reports */

export type ReportResult = "sent" | "skipped" | "waiting" | "failed";

/**
 * Report one finished call to Signal, if it is one Signal should have and it
 * is ready. `settle` sends even when a recording or transcript never came.
 */
export async function reportCallToSignal(callId: string, opts: { settle?: boolean } = {}): Promise<ReportResult> {
  if (!signalConfigured()) return "skipped";
  const call = await db.query.calls.findFirst({ where: eq(calls.id, callId) });
  if (!call || call.signalReportedAt || !call.endedAt) return "skipped";
  if (call.outcome === "ai" || call.outcome === "in_progress") return "skipped";
  const settled = opts.settle || Date.now() - call.endedAt.getTime() > SETTLE_MS;

  let answeredBy: string | null = null;
  let recordingUrl: string | null = null;
  let transcript: string | null = null;
  let summary: string | null = null;

  if (call.outcome === "human") {
    const [legs, rec, policyRow] = await Promise.all([
      db.query.callLegs.findMany({ where: and(eq(callLegs.callId, call.id), eq(callLegs.accepted, true)) }),
      db.query.callRecordings.findFirst({ where: eq(callRecordings.callId, call.id), orderBy: [desc(callRecordings.createdAt)] }),
      call.policyId ? db.query.routingPolicies.findFirst({ where: eq(routingPolicies.id, call.policyId) }) : null,
    ]);
    const leg = legs.find((l) => l.kind === "human_pstn") ?? legs[0];
    answeredBy = leg ? (leg.kind === "human_client" ? "the browser softphone" : leg.target) : null;
    let records = false;
    try {
      records = policyRow ? parsePolicy(policyRow.policy).record === true : false;
    } catch {
      records = false;
    }
    if (rec) recordingUrl = recordingLink(rec.id);
    else if (records && !settled) return "waiting";
  }

  if (call.outcome === "voicemail") {
    const vm = await db.query.voicemails.findFirst({ where: eq(voicemails.callId, call.id) });
    if ((!vm || !vm.transcript) && !settled) return "waiting";
    if (vm) {
      recordingUrl = recordingLink(vm.id);
      transcript = vm.transcript;
      summary = vm.summary;
    }
  }

  const body = {
    clientId: call.clientId,
    callSid: call.twilioCallSid,
    startedAt: call.startedAt.toISOString(),
    durationSeconds: call.durationSeconds ?? 0,
    fromNumber: call.fromE164,
    toNumber: call.toE164,
    outcome: call.outcome,
    answeredBy,
    callerName: call.callerName,
    recordingUrl,
    transcript,
    summary,
  };
  let error: string | null = null;
  try {
    const res = await fetch(`${env.SIGNAL_PARTNER_URL!.replace(/\/$/, "")}/api/partner/phone/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SIGNAL_PARTNER_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) error = `${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    error = String(e).slice(0, 200);
  }
  await db
    .update(calls)
    .set(error ? { signalReportError: error } : { signalReportedAt: new Date(), signalReportError: null })
    .where(eq(calls.id, call.id));
  if (error) console.error(`[signal] report failed for call ${call.id}: ${error}`);
  return error ? "failed" : "sent";
}

/** Hourly backstop: send every recent, settled call that has not been reported yet. */
export async function reportPendingCalls(limit = 50): Promise<{ scanned: number; sent: number }> {
  if (!signalConfigured()) return { scanned: 0, sent: 0 };
  const now = Date.now();
  const rows = await db
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        isNull(calls.signalReportedAt),
        notInArray(calls.outcome, ["ai", "in_progress"]),
        lt(calls.endedAt, new Date(now - SETTLE_MS)),
        gt(calls.startedAt, new Date(now - SWEEP_WINDOW_MS)),
      ),
    )
    .limit(limit);
  let sent = 0;
  for (const r of rows) if ((await reportCallToSignal(r.id, { settle: true })) === "sent") sent++;
  return { scanned: rows.length, sent };
}
