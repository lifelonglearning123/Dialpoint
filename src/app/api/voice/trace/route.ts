import { NextRequest, NextResponse } from "next/server";
import { readTrace } from "@/lib/spike/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const callSid = req.nextUrl.searchParams.get("call") ?? undefined;
  return NextResponse.json(readTrace(callSid));
}
