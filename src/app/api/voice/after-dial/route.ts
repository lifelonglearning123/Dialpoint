import { NextRequest } from "next/server";
import { spike } from "@/lib/spike/config";
import { registerRetellCall } from "@/lib/spike/retell";
import { pick, trace } from "@/lib/spike/trace";
import { dialRetell, hangup, voicemail, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * <Dial action> after ring_humans. DialCallStatus tells us what happened to the
 * human legs: completed = a human accepted and the conversation has now ended;
 * anything else (no-answer, busy, failed, canceled) = overflow to the AI.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "From", "To", "DialCallStatus", "DialCallSid", "DialCallDuration", "DialBridged"]);
  const callSid = p.CallSid ?? "?";
  trace(callSid, "after_ring_humans", p);

  // Only a *bridged* leg means a human accepted (pressed 1). A leg can be
  // "completed" without bridging when a voicemail answered and the whisper timed
  // out, and that must overflow to the AI, not end the call.
  if (p.DialBridged === "true") {
    trace(callSid, "human_conversation_ended", { duration: p.DialCallDuration ?? "" });
    return xml(hangup());
  }

  try {
    const { callId, sipUri } = await registerRetellCall({
      from: p.From ?? "",
      to: p.To ?? "",
      reason: "overflow",
      twilioCallSid: callSid,
      vars: {
        business_name: spike.businessName(),
        caller_number: p.From ?? "",
        transfer_number: spike.humanNumber(),
        reason: "overflow",
      },
    });
    trace(callSid, "ai_registered", { retellCallId: callId, sipUri });
    return xml(dialRetell(callId, spike.retellSipHost()));
  } catch (e) {
    trace(callSid, "ai_register_failed", { error: String(e) });
    return xml(voicemail(spike.businessName()));
  }
}
