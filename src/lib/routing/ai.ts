import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { calls } from "@/db/schema";
import { agencies, clients } from "@/db/shared";
import { env } from "@/env";
import { decryptCredentialOrNull } from "@/lib/crypto/credentials";
import type { CallContext } from "./context";

/**
 * Retell key for a client's agents: the agency's own Retell workspace when it
 * has one (agencies.retell_api_key_enc, where Signal builds its agents), else
 * the platform key.
 */
async function retellKey(clientId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ enc: agencies.retellApiKeyEnc })
    .from(clients)
    .innerJoin(agencies, eq(agencies.id, clients.agencyId))
    .where(eq(clients.id, clientId));
  return decryptCredentialOrNull(row?.enc) ?? env.RETELL_API_KEY;
}

/**
 * Hand a live call to the AI receptionist.
 *
 * TEMPORARY: talks to Retell directly, with the agent chosen on the number's
 * routing (`agentId`, falling back to the older policy-wide `aiAgentId`). The
 * production contract is Signal's `POST /api/partner/voice/register`
 * (PLAN.md §6), which will replace the body of this one function; nothing
 * else in the engine knows about Retell.
 */
export async function registerAi(opts: {
  ctx: CallContext;
  agentId?: string;
  callId: string;
  twilioCallSid: string;
  from: string;
  to: string;
  reason: "overflow" | "after_hours" | "ai_first" | "transfer_failed" | "ivr";
  callerName: string | null;
}): Promise<{ retellCallId: string; sipUri: string; agentId: string }> {
  const agentId = opts.agentId ?? opts.ctx.policy.aiAgentId;
  if (!agentId) throw new Error("No AI receptionist is linked to this number yet.");
  const key = await retellKey(opts.ctx.client.id);
  if (!key) throw new Error("No Retell API key for this agency, and RETELL_API_KEY is not configured.");

  const transferNumber = opts.ctx.targets.find((t) => t.enabled && t.kind === "pstn")?.value ?? "";

  const res = await fetch("https://api.retellai.com/v2/register-phone-call", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      from_number: opts.from,
      to_number: opts.to,
      direction: "inbound",
      metadata: { source: "telephone-buying", twilio_call_sid: opts.twilioCallSid, call_id: opts.callId, reason: opts.reason },
      retell_llm_dynamic_variables: {
        business_name: opts.ctx.client.name,
        caller_number: opts.from,
        caller_name: opts.callerName ?? "",
        transfer_number: transferNumber,
        reason: opts.reason,
      },
    }),
  });
  if (!res.ok) throw new Error(`Retell register failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { call_id: string };
  await db.update(calls).set({ retellCallId: data.call_id }).where(eq(calls.id, opts.callId));
  return { retellCallId: data.call_id, sipUri: `sip:${data.call_id}@${env.RETELL_SIP_HOST ?? "sip.retellai.com"}`, agentId };
}
