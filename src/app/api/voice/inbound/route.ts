import { NextRequest } from "next/server";
import { handleInbound } from "@/lib/routing/handlers";
import { FORM_KEYS, readForm } from "@/lib/routing/verify";
import { spikeInbound } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Twilio Voice webhook (voiceUrl) for every number, and the softphone TwiML App. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readForm(form, [...FORM_KEYS, "AccountSid"]);
  const handled = await handleInbound(req, form, p);
  return handled ?? spikeInbound(p);
}
