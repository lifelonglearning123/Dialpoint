import { NextRequest } from "next/server";
import { spike } from "@/lib/spike/config";
import { pick, trace } from "@/lib/spike/trace";
import { ringHumans, VoiceResponse, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Twilio Voice webhook for the test number. Spike policy = template 1,
 * "You first, AI backup": ring_humans -> ai -> voicemail.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "From", "To", "CallStatus", "Direction"]);
  trace(p.CallSid ?? "?", "inbound", p);

  // Outbound from the browser softphone (Twilio hits the TwiML App URL with
  // From=client:<identity>). Dial the requested number showing the test line as
  // caller ID. Spike-only convenience so Chao can call the line from Chrome.
  if (p.From?.startsWith("client:") && p.To) {
    trace(p.CallSid ?? "?", "softphone_outbound", { to: p.To });
    const r = new VoiceResponse();
    r.dial({ callerId: process.env.SPIKE_NUMBER ?? "" }).number(p.To);
    return xml(r);
  }
  // Never forward a call back to the phone it came from (the owner ringing
  // their own line would only reach their own voicemail).
  const human = spike.humanNumber();
  if (p.From === human) trace(p.CallSid ?? "?", "skip_target_is_caller", { target: human });
  return xml(
    ringHumans({
      businessName: spike.businessName(),
      humanNumber: p.From === human ? "" : human,
      clientIdentity: spike.clientIdentity(),
      ringSeconds: spike.ringSeconds(),
      // Show the caller's number to the human (Twilio allows the original caller
      // ID on forwarded legs) so the mobile shows who is calling.
      callerId: p.From ?? p.To ?? "",
    }),
  );
}
