import { and, eq } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import twilio from "twilio";
import { db } from "@/db/client";
import { calls, numbers, twilioAccounts } from "@/db/schema";
import { masterCreds, subaccountCreds } from "@/lib/twilio/master";
import { registerAi } from "./ai";
import { appendTrace, createCall, finalizeCall, findCallBySid, markLegAccepted, recordLeg, type LegKind } from "./calls";
import { callerTag, contextForCall, lookupNumber } from "./context";
import { ivrOptionPath, nextPath, signCursor, stepAt, verifyCursor, type Cursor } from "./engine";
import { executeStep, executeTransfer, resumeRun, startRun, type RunState } from "./run";
import { scheduleState } from "./schedule";
import { reportCallToSignal } from "@/lib/signal/report";
import { storeCallRecording } from "./recordings";
import { dialRetell, hangup, VoiceResponse, voicemail, withNotice, xml } from "./twiml";
import { storeVoicemail, transcribeVoicemail } from "./voicemail";
import { verifyTwilio } from "./verify";

type P = Record<string, string>;
type Handled = Response | null;

const ENDED = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/* ----------------------------------------------------------------------- */

/** Inbound call to a number we own. Null = not ours (caller falls back to the spike). */
export async function handleInbound(req: NextRequest, form: FormData, p: P): Promise<Handled> {
  // Outbound from the browser softphone: Twilio posts to the TwiML App with
  // From=client:user:<profileId>. Caller id is the business's first active number.
  if (p.From?.startsWith("client:") && p.To && p.AccountSid) {
    const acct = await db.query.twilioAccounts.findFirst({ where: eq(twilioAccounts.subaccountSid, p.AccountSid) });
    if (!acct) return null;
    const own = await db.query.numbers.findFirst({ where: and(eq(numbers.clientId, acct.clientId), eq(numbers.status, "active")) });
    if (!own) return xml(hangup("This business has no active number to call from."));
    const r = new VoiceResponse();
    r.dial({ callerId: own.e164 }).number(p.To);
    return xml(r);
  }

  const ctx = await lookupNumber(p.To ?? "");
  if (!ctx) return null;
  if (!(await verifyTwilio(req, form, ctx.client.id))) return new Response("forbidden", { status: 403 });

  const [tag, schedule] = await Promise.all([
    callerTag(ctx.client.id, p.From ?? ""),
    scheduleState({ now: new Date(), hours: ctx.client.businessHours, timezone: ctx.client.timezone, closures: ctx.closures }),
  ]);
  const call = await createCall({
    clientId: ctx.client.id,
    numberId: ctx.number.id,
    policyId: ctx.policyRow?.id ?? null,
    twilioCallSid: p.CallSid,
    from: p.From ?? "",
    to: p.To ?? "",
    callerName: tag.name,
  });
  await appendTrace(call.id, "inbound", { from: p.From ?? "", schedule, caller: tag.tag, template: ctx.policy.template ?? "custom" });
  const state = startRun({
    ctx,
    callId: call.id,
    twilioCallSid: p.CallSid,
    from: p.From ?? "",
    to: p.To ?? "",
    callerName: tag.name,
    evalCtx: { schedule, caller: tag.tag },
  });
  await appendTrace(call.id, "rule_selected", { rule: String(state.ruleIndex), steps: state.steps.map((s) => s.type).join(" → ") });
  const first = await executeStep(state, "0");
  // The notice answers the call, so never in front of a <Reject> (blocked caller).
  if (ctx.policy.record && ctx.policy.announceRecording && state.steps[0]?.type !== "reject") {
    await appendTrace(call.id, "recording_notice", {});
    return xml(withNotice(first, "This call may be recorded."));
  }
  return xml(first);
}

async function stateFromCursor(req: NextRequest, form: FormData, cursor: Cursor): Promise<{ state: RunState } | { error: Response }> {
  const loaded = await contextForCall(cursor.c);
  if (!loaded) return { error: xml(hangup()) };
  if (!(await verifyTwilio(req, form, loaded.ctx.client.id))) return { error: new Response("forbidden", { status: 403 }) };
  const schedule = await scheduleState({ now: new Date(), hours: loaded.ctx.client.businessHours, timezone: loaded.ctx.client.timezone, closures: loaded.ctx.closures });
  const tag = await callerTag(loaded.ctx.client.id, loaded.call.fromE164);
  const state = resumeRun(
    {
      ctx: loaded.ctx,
      callId: loaded.call.id,
      twilioCallSid: loaded.call.twilioCallSid,
      from: loaded.call.fromE164,
      to: loaded.call.toE164,
      callerName: loaded.call.callerName,
      evalCtx: { schedule, caller: tag.tag },
    },
    cursor,
  );
  return { state };
}

async function advance(state: RunState, path: string) {
  const np = nextPath(state.steps, path);
  return xml(np ? await executeStep(state, np) : hangup("Sorry, we couldn't take your call. Please try again later."));
}

/** <Dial>/<Gather>/<Record> action for the step at the cursor. */
export async function handleAfterStep(req: NextRequest, form: FormData, p: P, cursor: Cursor): Promise<Response> {
  const r = await stateFromCursor(req, form, cursor);
  if ("error" in r) return r.error;
  const { state } = r;
  if (cursor.p === "transfer") return handleAfterTransfer(req, form, p, cursor);
  const step = stepAt(state.steps, cursor.p);
  if (!step) return xml(hangup());
  await appendTrace(state.callId, `after_${step.type}`, { path: cursor.p, dialStatus: p.DialCallStatus ?? "", bridged: p.DialBridged ?? "", digits: p.Digits ?? "" });

  switch (step.type) {
    case "ring_humans":
    case "forward_raw":
      if (p.DialBridged === "true") {
        // Bridged means a person had the call. A plain forward has no press-1
        // to mark the leg accepted, so mark it here or the log would say missed.
        if (p.DialCallSid) await markLegAccepted(p.DialCallSid);
        await appendTrace(state.callId, "human_conversation_ended", { duration: p.DialCallDuration ?? "" });
        return xml(hangup());
      }
      return advance(state, cursor.p);
    case "ai": {
      // After an AI-initiated transfer Twilio still fires this action for the
      // dropped SIP leg and ignores the reply; do nothing but record it.
      const trace = (await findCallBySid(state.twilioCallSid))?.routeTrace ?? [];
      const lastAi = trace.map((t) => t.step).lastIndexOf("ai_registered");
      const redirected = trace.slice(lastAi).some((t) => t.step === "retell_transfer_redirected");
      if (redirected) {
        await appendTrace(state.callId, "ai_leg_ended_by_transfer", {});
        return xml(hangup());
      }
      if (p.DialCallStatus === "completed") {
        await appendTrace(state.callId, "ai_conversation_ended", { duration: p.DialCallDuration ?? "" });
        return xml(hangup());
      }
      return advance(state, cursor.p);
    }
    case "ivr": {
      const digit = p.Digits;
      if (digit && step.options[digit]) {
        await appendTrace(state.callId, "ivr_choice", { digit });
        return xml(await executeStep(state, ivrOptionPath(cursor.p, digit)));
      }
      return xml(await executeStep(state, cursor.p, (cursor.a ?? 0) + 1));
    }
    case "voicemail":
    case "reject":
      return xml(hangup());
  }
}

/** <Dial action> after a re-registered AI leg (post failed transfer): done → hang up, else voicemail. */
export async function handleAfterAi(req: NextRequest, form: FormData, p: P, cursor: Cursor): Promise<Response> {
  const r = await stateFromCursor(req, form, cursor);
  if ("error" in r) return r.error;
  const { state } = r;
  await appendTrace(state.callId, "after_ai", { dialStatus: p.DialCallStatus ?? "", sip: p.DialSipResponseCode ?? "" });
  if (p.DialCallStatus === "completed") return xml(hangup());
  return xml(voicemail({ cursor: signCursor({ c: state.callId, r: state.ruleIndex, p: "voicemail" }), businessName: state.ctx.client.name }));
}

/** <Dial action> after the AI asked us to ring the humans. */
export async function handleAfterTransfer(req: NextRequest, form: FormData, p: P, cursor: Cursor): Promise<Response> {
  const r = await stateFromCursor(req, form, cursor);
  if ("error" in r) return r.error;
  const { state } = r;
  await appendTrace(state.callId, "after_transfer", { dialStatus: p.DialCallStatus ?? "", bridged: p.DialBridged ?? "" });
  if (p.DialBridged === "true") {
    await appendTrace(state.callId, "transfer_conversation_ended", { duration: p.DialCallDuration ?? "" });
    return xml(hangup());
  }
  try {
    // Back to the agent that was on the call before it asked for the transfer.
    const trace = (await findCallBySid(state.twilioCallSid))?.routeTrace ?? [];
    const lastAgent = trace.findLast((t) => t.step === "ai_registered")?.data.agentId;
    const { retellCallId, sipUri } = await registerAi({
      ctx: state.ctx,
      agentId: lastAgent || undefined,
      callId: state.callId,
      twilioCallSid: state.twilioCallSid,
      from: state.from,
      to: state.to,
      reason: "transfer_failed",
      callerName: state.callerName,
    });
    await appendTrace(state.callId, "ai_reregistered_after_failed_transfer", { retellCallId });
    const cursor = signCursor({ c: state.callId, r: state.ruleIndex, p: "ai_retry" });
    return xml(dialRetell({ cursor, sipUri, afterPath: "/api/voice/after-ai", record: state.ctx.policy.record }));
  } catch (e) {
    await appendTrace(state.callId, "ai_register_failed", { error: String(e).slice(0, 200) });
    return xml(voicemail({ cursor: signCursor({ c: state.callId, r: state.ruleIndex, p: "voicemail" }), businessName: state.ctx.client.name }));
  }
}

/** Retell custom tool "transfer_to_human". Null = call unknown to the engine. */
export async function handleRetellTransfer(twilioCallSid: string): Promise<string | null> {
  const call = await findCallBySid(twilioCallSid);
  if (!call) return null;
  const loaded = await contextForCall(call.id);
  if (!loaded) return "Transfer failed. Apologise and take a message.";
  await appendTrace(call.id, "retell_transfer_requested", {});
  const state = startRun({
    ctx: loaded.ctx,
    callId: call.id,
    twilioCallSid,
    from: call.fromE164,
    to: call.toE164,
    callerName: call.callerName,
    evalCtx: { schedule: "in_hours", caller: "unknown" },
  });
  const twiml = await executeTransfer(state);
  if (!twiml) {
    await appendTrace(call.id, "retell_transfer_failed", { error: "no_targets" });
    return "There is nobody available to transfer to. Apologise and take a message.";
  }
  // Let the agent finish "one moment" before the redirect cuts its leg.
  await new Promise((res) => setTimeout(res, 2500));
  try {
    const creds = (await subaccountCreds(loaded.ctx.client.id)) ?? masterCreds();
    await twilio(creds.accountSid, creds.authToken).calls(twilioCallSid).update({ twiml: twiml.toString() });
    await appendTrace(call.id, "retell_transfer_redirected", {});
    return "Transferring the caller now. Do not say anything else.";
  } catch (e) {
    await appendTrace(call.id, "retell_transfer_failed", { error: String(e).slice(0, 200) });
    return "Transfer failed. Apologise and take a message.";
  }
}

export async function handleWhisperAccept(p: P): Promise<void> {
  if (p.Digits === "1" && p.CallSid) await markLegAccepted(p.CallSid);
  const parent = p.ParentCallSid ? await findCallBySid(p.ParentCallSid) : null;
  if (parent) await appendTrace(parent.id, p.Digits === "1" ? "human_accepted" : "human_declined", { leg: p.CallSid ?? "" });
}

export async function handleAfterVoicemail(p: P, cursor: Cursor): Promise<Response> {
  await appendTrace(cursor.c, "voicemail_finished", { recordingSid: p.RecordingSid ?? "", duration: p.RecordingDuration ?? "" });
  return xml(hangup());
}

/** <Dial record> finished: keep the recording against the call its cursor names. */
async function handleCallRecording(req: NextRequest, form: FormData, p: P): Promise<Handled> {
  const cursor = verifyCursor(req.nextUrl.searchParams.get("k"));
  const call = cursor
    ? await db.query.calls.findFirst({ where: eq(calls.id, cursor.c) })
    : p.CallSid
      ? await findCallBySid(p.CallSid)
      : null;
  if (!call) return null;
  if (!(await verifyTwilio(req, form, call.clientId))) return new Response("forbidden", { status: 403 });
  if (p.RecordingSid && p.RecordingUrl && (p.RecordingStatus ?? "completed") === "completed") {
    await storeCallRecording({
      callId: call.id,
      clientId: call.clientId,
      recordingSid: p.RecordingSid,
      recordingUrl: p.RecordingUrl,
      durationSeconds: p.RecordingDuration ? Number(p.RecordingDuration) : null,
    });
    // The recording usually lands just after the call ends: now it can go to Signal.
    after(() => reportCallToSignal(call.id).then(() => undefined));
  }
  return new Response(null, { status: 204 });
}

const LEG_KINDS: Record<string, LegKind> = { human_pstn: "human_pstn", human_client: "human_client", ai: "ai" };

/** Status callbacks. Null = call unknown to the engine. */
export async function handleStatus(req: NextRequest, form: FormData, p: P, leg: string): Promise<Handled> {
  if (leg === "call_recording") return handleCallRecording(req, form, p);
  const parentSid = leg === "parent" || leg === "voicemail_recording" ? p.CallSid : (p.ParentCallSid ?? p.CallSid);
  if (!parentSid) return null;
  const call = await findCallBySid(parentSid);
  if (!call) return null;
  if (!(await verifyTwilio(req, form, call.clientId))) return new Response("forbidden", { status: 403 });

  if (leg === "voicemail_recording") {
    if (p.RecordingSid && p.RecordingUrl) {
      const vm = await storeVoicemail({
        callId: call.id,
        clientId: call.clientId,
        recordingSid: p.RecordingSid,
        recordingUrl: p.RecordingUrl,
        durationSeconds: p.RecordingDuration ? Number(p.RecordingDuration) : null,
      });
      after(() => transcribeVoicemail(vm.id));
    }
    return new Response(null, { status: 204 });
  }

  if (leg === "parent") {
    if (ENDED.has(p.CallStatus ?? "")) {
      await appendTrace(call.id, "call_ended", { status: p.CallStatus ?? "", duration: p.CallDuration ?? "" });
      await finalizeCall(parentSid, { status: p.CallStatus ?? "", durationSeconds: p.CallDuration ? Number(p.CallDuration) : undefined });
      // Missed and blocked calls are ready now; the rest wait for their recording or transcript.
      after(() => reportCallToSignal(call.id).then(() => undefined));
    }
    return new Response(null, { status: 204 });
  }

  const kind = LEG_KINDS[leg];
  if (kind && p.CallSid) {
    await recordLeg({
      callId: call.id,
      twilioCallSid: p.CallSid,
      kind,
      target: p.To ?? null,
      status: p.CallStatus ?? "unknown",
      durationSeconds: p.CallDuration ? Number(p.CallDuration) : undefined,
    });
    if (ENDED.has(p.CallStatus ?? "")) await appendTrace(call.id, `leg_${leg}_${p.CallStatus}`, { duration: p.CallDuration ?? "", sip: p.SipResponseCode ?? "" });
  }
  return new Response(null, { status: 204 });
}
