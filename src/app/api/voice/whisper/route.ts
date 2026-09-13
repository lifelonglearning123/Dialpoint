import { NextRequest } from "next/server";
import { verifyCursor } from "@/lib/routing/engine";
import { whisper, xml } from "@/lib/routing/twiml";
import { spikeWhisper } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Played to the human leg the moment they pick up (press 1 to accept). */
export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const k = sp.get("k");
  if (k && verifyCursor(k)) return xml(whisper(sp.get("biz") ?? "the business", sp.get("why") ?? undefined, k));
  return spikeWhisper(sp.get("biz"), sp.get("why"));
}
