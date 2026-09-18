import { NextRequest, NextResponse } from "next/server";
import { handleStatus } from "@/lib/routing/handlers";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";
import { spikeStatus } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status callbacks for the parent call, every child leg, voicemails and call recordings. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, FORM_KEYS);
  const leg = req.nextUrl.searchParams.get("leg") ?? "unknown";
  const handled = await handleStatus(req, form, p, leg);
  if (handled) return handled;
  spikeStatus(p, leg);
  return new NextResponse(null, { status: 204 });
}
