import { NextRequest } from "next/server";
import { verifyCursor } from "@/lib/routing/engine";
import { handleAfterStep } from "@/lib/routing/handlers";
import { hangup, xml } from "@/lib/routing/twiml";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generic <Dial>/<Gather>/<Record> action: continue the routing policy from the signed cursor. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, FORM_KEYS);
  const cursor = verifyCursor(req.nextUrl.searchParams.get("k"));
  if (!cursor) return xml(hangup());
  return handleAfterStep(req, form, p, cursor);
}
