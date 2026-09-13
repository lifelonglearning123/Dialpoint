import { NextRequest } from "next/server";
import { verifyCursor } from "@/lib/routing/engine";
import { handleWhisperAccept } from "@/lib/routing/handlers";
import { whisperAccept, xml } from "@/lib/routing/twiml";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";
import { spikeWhisperAccept } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, FORM_KEYS);
  if (verifyCursor(req.nextUrl.searchParams.get("k"))) {
    await handleWhisperAccept(p);
    return xml(whisperAccept(p.Digits));
  }
  return spikeWhisperAccept(p);
}
