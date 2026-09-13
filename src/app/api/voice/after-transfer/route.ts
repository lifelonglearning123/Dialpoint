import { NextRequest } from "next/server";
import { spike } from "@/lib/spike/config";
import { registerRetellCall } from "@/lib/spike/retell";
import { pick, trace } from "@/lib/spike/trace";
import { dialRetell, hangup, voicemail, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * <Dial action> after an AI-initiated transfer. Bridged = the human took it and
 * the conversation has ended. Otherwise bring the AI back with reason
 * "transfer_failed" so it takes a message; voicemail if that fails too.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "From", "To", "DialCallStatus", "DialCallSid", "DialCallDuration", "DialBridged"]);
  const callSid = p.CallSid ?? "?";
  trace(callSid, "after_transfer", p);

  if (p.DialBridged === "true") {
    trace(callSid, "transfer_conversation_ended", { duration: p.DialCallDuration ?? "" });
    return xml(hangup());
  }

  try {
    const { callId } = await registerRetellCall({
      from: p.From ?? "",
      to: p.To ?? "",
      reason: "transfer_failed",
      twilioCallSid: callSid,
      vars: {
        business_name: spike.businessName(),
        caller_number: p.From ?? "",
        transfer_number: spike.humanNumber(),
        reason: "transfer_failed",
      },
    });
    trace(callSid, "ai_reregistered_after_failed_transfer", { retellCallId: callId });
    return xml(dialRetell(callId, spike.retellSipHost()));
  } catch (e) {
    trace(callSid, "ai_register_failed", { error: String(e) });
    return xml(voicemail(spike.businessName()));
  }
}
