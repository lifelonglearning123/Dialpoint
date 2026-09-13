import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { callLegs } from "@/db/schema";
import { findCallBySid } from "@/lib/routing/calls";
import { readTrace } from "@/lib/spike/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Development only: route trace for a call (`?call=<Twilio CallSid>`), engine or spike. */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const sid = req.nextUrl.searchParams.get("call");
  if (sid) {
    const call = await findCallBySid(sid);
    if (call) {
      const legs = await db.query.callLegs.findMany({ where: eq(callLegs.callId, call.id) });
      return NextResponse.json({
        call: { id: call.id, outcome: call.outcome, from: call.fromE164, to: call.toE164, duration: call.durationSeconds },
        trace: call.routeTrace,
        legs,
      });
    }
  }
  return NextResponse.json(readTrace(sid ?? undefined));
}
