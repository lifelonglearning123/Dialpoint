import { NextRequest } from "next/server";
import { pick, trace } from "@/lib/spike/trace";
import { hangup, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "RecordingUrl", "RecordingSid", "RecordingDuration", "Digits"]);
  trace(p.CallSid ?? "?", "voicemail_recorded", p);
  return xml(hangup());
}
