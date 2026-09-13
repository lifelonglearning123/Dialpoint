import { NextRequest } from "next/server";
import { spike } from "@/lib/spike/config";
import { pick, trace } from "@/lib/spike/trace";
import { hangup, voicemail, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** <Dial action> after the AI leg. If the SIP leg never connected, fall to voicemail. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "DialCallStatus", "DialCallSid", "DialCallDuration", "DialSipResponseCode"]);
  trace(p.CallSid ?? "?", "after_ai", p);
  if (p.DialCallStatus === "completed") return xml(hangup());
  return xml(voicemail(spike.businessName()));
}
