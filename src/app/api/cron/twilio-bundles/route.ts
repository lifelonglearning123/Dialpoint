import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { pendingBundles, syncBundleStatus } from "@/lib/twilio/regulatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backstop for missed StatusCallbacks: re-sync every bundle still under review. */
export async function GET(req: NextRequest) {
  const secret = env.CRON_SECRET;
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || given !== secret) return NextResponse.json({ ok: false }, { status: 401 });

  const pending = await pendingBundles();
  const results: Array<{ bundleSid: string; status?: string; activated?: number; error?: string }> = [];
  for (const b of pending) {
    try {
      const r = await syncBundleStatus(b.bundleSid);
      results.push({ bundleSid: b.bundleSid, status: r?.status, activated: r?.activated });
    } catch (e) {
      results.push({ bundleSid: b.bundleSid, error: String((e as Error).message) });
    }
  }
  return NextResponse.json({ ok: true, checked: pending.length, results });
}
