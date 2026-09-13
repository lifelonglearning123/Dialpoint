import { spike } from "./config";

/**
 * Spike-only: talks to Retell directly. In production this is Signal's
 * POST /api/partner/voice/register, which holds the Retell key and returns the SIP URI.
 */
export async function registerRetellCall(input: {
  from: string;
  to: string;
  reason: string;
  vars: Record<string, string>;
  twilioCallSid: string;
}): Promise<{ callId: string; sipUri: string }> {
  const res = await fetch("https://api.retellai.com/v2/register-phone-call", {
    method: "POST",
    headers: { Authorization: `Bearer ${spike.retellApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: spike.retellAgentId(),
      from_number: input.from,
      to_number: input.to,
      direction: "inbound",
      metadata: { reason: input.reason, source: "telephone-buying-spike", twilio_call_sid: input.twilioCallSid },
      retell_llm_dynamic_variables: input.vars,
    }),
  });
  if (!res.ok) throw new Error(`Retell register failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { call_id: string };
  return { callId: data.call_id, sipUri: `sip:${data.call_id}@${spike.retellSipHost()}` };
}
