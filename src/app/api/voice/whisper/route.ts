import { NextRequest } from "next/server";
import { pick, trace } from "@/lib/spike/trace";
import { whisper, xml } from "@/lib/spike/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Played to the human leg the moment they pick up. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, ["CallSid", "ParentCallSid", "To", "CallStatus"]);
  trace(p.ParentCallSid ?? p.CallSid ?? "?", "whisper", p);
  return xml(whisper(req.nextUrl.searchParams.get("biz") ?? "the business", req.nextUrl.searchParams.get("why") ?? undefined));
}
