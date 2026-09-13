import { NextRequest } from "next/server";
import { verifyCursor } from "@/lib/routing/engine";
import { handleAfterStep } from "@/lib/routing/handlers";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";
import { spikeAfterDial } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kept for the Phase 0 test line; engine calls carry a cursor and behave like /after-step. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, FORM_KEYS);
  const cursor = verifyCursor(req.nextUrl.searchParams.get("k"));
  if (cursor) return handleAfterStep(req, form, p, cursor);
  return spikeAfterDial(p);
}
