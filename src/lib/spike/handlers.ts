/**
 * Phase 0 spike behaviour, kept verbatim for numbers this app does not own
 * (the test line +44 20 4652 7858 on the master account, see SPIKE.md). The
 * real engine (src/lib/routing) takes over as soon as a number exists in
 * tb.numbers; every /api/voice route falls back here when it does not.
 */
import twilio from "twilio";
import { spike } from "./config";
import { registerRetellCall } from "./retell";
import { trace } from "./trace";
import { dialRetell, hangup, ringHumans, voicemail, VoiceResponse, whisper, whisperAccept, xml } from "./twiml";

type P = Record<string, string>;

export function spikeInbound(p: P) {
  trace(p.CallSid ?? "?", "inbound", p);
  if (p.From?.startsWith("client:") && p.To) {
    trace(p.CallSid ?? "?", "softphone_outbound", { to: p.To });
    const r = new VoiceResponse();
    r.dial({ callerId: process.env.SPIKE_NUMBER ?? "" }).number(p.To);
    return xml(r);
  }
  const human = spike.humanNumber();
  if (p.From === human) trace(p.CallSid ?? "?", "skip_target_is_caller", { target: human });
  return xml(
    ringHumans({
      businessName: spike.businessName(),
      humanNumber: p.From === human ? "" : human,
      clientIdentity: spike.clientIdentity(),
      ringSeconds: spike.ringSeconds(),
      callerId: p.From ?? p.To ?? "",
    }),
  );
}

export function spikeWhisper(biz: string | null, why: string | null) {
  return xml(whisper(biz ?? "the business", why ?? undefined));
}

export function spikeWhisperAccept(p: P) {
  trace(p.ParentCallSid ?? p.CallSid ?? "?", p.Digits === "1" ? "human_accepted" : "human_declined", p);
  return xml(whisperAccept(p.Digits));
}

async function spikeAi(p: P, reason: "overflow" | "transfer_failed") {
  const callSid = p.CallSid ?? "?";
  try {
    const { callId, sipUri } = await registerRetellCall({
      from: p.From ?? "",
      to: p.To ?? "",
      reason,
      twilioCallSid: callSid,
      vars: { business_name: spike.businessName(), caller_number: p.From ?? "", transfer_number: spike.humanNumber(), reason },
    });
    trace(callSid, reason === "overflow" ? "ai_registered" : "ai_reregistered_after_failed_transfer", { retellCallId: callId, sipUri });
    return xml(dialRetell(callId, spike.retellSipHost()));
  } catch (e) {
    trace(callSid, "ai_register_failed", { error: String(e) });
    return xml(voicemail(spike.businessName()));
  }
}

export async function spikeAfterDial(p: P) {
  const callSid = p.CallSid ?? "?";
  trace(callSid, "after_ring_humans", p);
  if (p.DialBridged === "true") {
    trace(callSid, "human_conversation_ended", { duration: p.DialCallDuration ?? "" });
    return xml(hangup());
  }
  return spikeAi(p, "overflow");
}

export function spikeAfterAi(p: P) {
  trace(p.CallSid ?? "?", "after_ai", p);
  if (p.DialCallStatus === "completed") return xml(hangup());
  return xml(voicemail(spike.businessName()));
}

export async function spikeAfterTransfer(p: P) {
  const callSid = p.CallSid ?? "?";
  trace(callSid, "after_transfer", p);
  if (p.DialBridged === "true") {
    trace(callSid, "transfer_conversation_ended", { duration: p.DialCallDuration ?? "" });
    return xml(hangup());
  }
  return spikeAi(p, "transfer_failed");
}

export function spikeAfterVoicemail(p: P) {
  trace(p.CallSid ?? "?", "voicemail_recorded", p);
  return xml(hangup());
}

export function spikeStatus(p: P, leg: string) {
  trace(p.ParentCallSid ?? p.CallSid ?? "?", `status:${leg}`, p);
}

/** Retell custom tool for the spike agent: redirect the parent call to the mobile. */
export async function spikeRetellTransfer(twilioCallSid: string, callerNumber: string): Promise<string> {
  trace(twilioCallSid, "retell_transfer_requested", {});
  const twiml = ringHumans({
    businessName: spike.businessName(),
    humanNumber: spike.humanNumber(),
    clientIdentity: spike.clientIdentity(),
    ringSeconds: spike.ringSeconds(),
    callerId: callerNumber || spike.humanNumber(),
    why: "transfer",
  }).toString();
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const { sid, token } = spike.twilio();
    await twilio(sid, token).calls(twilioCallSid).update({ twiml });
    trace(twilioCallSid, "retell_transfer_redirected", {});
    return "Transferring the caller now. Do not say anything else.";
  } catch (e) {
    trace(twilioCallSid, "retell_transfer_failed", { error: String(e) });
    return "Transfer failed. Apologise and take a message.";
  }
}
