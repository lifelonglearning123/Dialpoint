import { NextRequest, NextResponse } from "next/server";
import { syncBundleStatus } from "@/lib/twilio/regulatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Twilio posts here when a regulatory bundle changes status (StatusCallback set
 * at bundle creation). Bundle StatusCallbacks are not signed, so the only trust
 * is "we know this bundle": unknown SIDs are ignored and the status is re-read
 * from Twilio rather than taken from the post body.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const bundleSid = String(form?.get("BundleSid") ?? "");
  if (!/^BU[0-9a-f]{32}$/i.test(bundleSid)) return NextResponse.json({ ok: false }, { status: 400 });
  const result = await syncBundleStatus(bundleSid);
  if (!result) return NextResponse.json({ ok: false, reason: "unknown bundle" }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
