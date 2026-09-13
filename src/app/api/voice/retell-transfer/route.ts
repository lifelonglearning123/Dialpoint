import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { spike } from "@/lib/spike/config";
import { trace } from "@/lib/spike/trace";
import { ringHumans } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retell custom tool "transfer_to_human". Retell cannot dial out on a call that
 * arrived over SIP from our Twilio number, but Twilio still owns the parent call,
 * so we redirect that call to ring_humans. The AI leg is dropped by the redirect;
 * if nobody accepts, /api/voice/after-transfer brings the AI back.
 *
 * In production this endpoint lives in Signal's partner contract: Signal's agent
 * calls Signal, Signal calls us with {call_ref}, we redirect.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    call?: { call_id?: string; metadata?: Record<string, string>; from_number?: string; retell_llm_dynamic_variables?: Record<string, string> };
    name?: string;
    args?: Record<string, string>;
  };
  const twilioCallSid = body.call?.metadata?.twilio_call_sid;
  const callerNumber = body.call?.retell_llm_dynamic_variables?.caller_number ?? body.call?.from_number ?? "";
  trace(twilioCallSid ?? "?", "retell_transfer_requested", { retellCallId: body.call?.call_id ?? "", tool: body.name ?? "" });

  if (!twilioCallSid) {
    return NextResponse.json({ result: "Transfer failed: no call reference. Apologise and take a message." });
  }

  const twiml = ringHumans({
    businessName: spike.businessName(),
    humanNumber: spike.humanNumber(),
    clientIdentity: spike.clientIdentity(),
    ringSeconds: spike.ringSeconds(),
    callerId: callerNumber || spike.humanNumber(),
    why: "transfer",
  }).toString();

  // Let the agent finish saying "one moment" before the redirect cuts its leg.
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const { sid, token } = spike.twilio();
    await twilio(sid, token).calls(twilioCallSid).update({ twiml });
    trace(twilioCallSid, "retell_transfer_redirected", {});
    return NextResponse.json({ result: "Transferring the caller now. Do not say anything else." });
  } catch (e) {
    trace(twilioCallSid, "retell_transfer_failed", { error: String(e) });
    return NextResponse.json({ result: "Transfer failed. Apologise and take a message." });
  }
}
