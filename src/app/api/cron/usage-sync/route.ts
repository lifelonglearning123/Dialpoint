import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { priceUnpricedUsage, pushUsageToStripe } from "@/lib/billing/usage";
import { reportPendingCalls } from "@/lib/signal/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Hourly: fetch Twilio's price for new call legs, then send usage to Stripe
 * Billing Meters. Also the backstop that reports finished calls to Signal's
 * call log when the event-time report was waiting or failed.
 */
export async function GET(req: NextRequest) {
  const secret = env.CRON_SECRET;
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || given !== secret) return NextResponse.json({ ok: false }, { status: 401 });
  const pricing = await priceUnpricedUsage(200);
  const result = await pushUsageToStripe(500);
  const signal = await reportPendingCalls().catch((e) => ({ error: String(e).slice(0, 200) }));
  return NextResponse.json({ ok: true, pricing, ...result, signal });
}
