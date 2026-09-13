import { NextRequest, NextResponse } from "next/server";
import { handleRetellTransfer } from "@/lib/routing/handlers";
import { spikeRetellTransfer } from "@/lib/spike/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retell custom tool "transfer_to_human". Twilio owns the parent call, so we
 * redirect it to ring the humans (Retell cannot dial out on SIP-delivered calls).
 * Production: Signal's agents call Signal, Signal calls /api/partner/transfer.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    call?: { call_id?: string; metadata?: Record<string, string>; from_number?: string; retell_llm_dynamic_variables?: Record<string, string> };
    name?: string;
  };
  const sid = body.call?.metadata?.twilio_call_sid;
  if (!sid) return NextResponse.json({ result: "Transfer failed: no call reference. Apologise and take a message." });
  const caller = body.call?.retell_llm_dynamic_variables?.caller_number ?? body.call?.from_number ?? "";
  const result = (await handleRetellTransfer(sid)) ?? (await spikeRetellTransfer(sid, caller));
  return NextResponse.json({ result });
}
