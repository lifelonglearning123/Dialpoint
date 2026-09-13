import { NextRequest, NextResponse } from "next/server";
import { pick, trace } from "@/lib/spike/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status callbacks for every leg; production writes these to tb.call_legs + usage_ledger. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = pick(form, [
    "CallSid", "ParentCallSid", "CallStatus", "CallDuration", "To", "From", "SipResponseCode",
    "RecordingSid", "RecordingUrl", "RecordingStatus", "RecordingDuration",
  ]);
  const leg = req.nextUrl.searchParams.get("leg") ?? "unknown";
  trace(p.ParentCallSid ?? p.CallSid ?? "?", `status:${leg}`, p);
  return new NextResponse(null, { status: 204 });
}
