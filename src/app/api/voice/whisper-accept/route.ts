import { NextRequest } from "next/server";
import { pick, trace } from "@/lib/spike/trace";
import { whisperAccept, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "ParentCallSid", "Digits"]);
  trace(p.ParentCallSid ?? p.CallSid ?? "?", p.Digits === "1" ? "human_accepted" : "human_declined", p);
  return xml(whisperAccept(p.Digits));
}
