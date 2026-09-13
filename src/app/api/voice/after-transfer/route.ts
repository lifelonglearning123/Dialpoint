import { NextRequest } from "next/server";
import { verifyCursor } from "@/lib/routing/engine";
import { handleAfterTransfer } from "@/lib/routing/handlers";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";
import { spikeAfterTransfer } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, FORM_KEYS);
  const cursor = verifyCursor(req.nextUrl.searchParams.get("k"));
  if (cursor) return handleAfterTransfer(req, form, p, cursor);
  return spikeAfterTransfer(p);
}
