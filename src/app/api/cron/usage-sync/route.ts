import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { pushUsageToStripe } from "@/lib/billing/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Hourly: send new usage ledger rows to Stripe Billing Meters. */
export async function GET(req: NextRequest) {
  const secret = env.CRON_SECRET;
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || given !== secret) return NextResponse.json({ ok: false }, { status: 401 });
  const result = await pushUsageToStripe(500);
  return NextResponse.json({ ok: true, ...result });
}
