// Phase 0 spike configuration. Everything comes from .env.local; nothing here is
// the production tenancy model, it just proves the call flow end to end.

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const spike = {
  /** Public https base, e.g. the cloudflared quick-tunnel URL. */
  baseUrl: () => need("PUBLIC_BASE_URL").replace(/\/$/, ""),
  /** Business name spoken in the whisper and passed to the AI. */
  businessName: () => process.env.SPIKE_BUSINESS_NAME ?? "the spike test line",
  /** The human target: Chao's mobile in E.164. */
  humanNumber: () => need("SPIKE_HUMAN_NUMBER"),
  /** Softphone identity that also rings on ring_humans. */
  clientIdentity: () => process.env.SPIKE_CLIENT_IDENTITY ?? "spike-softphone",
  /** Seconds to ring humans before overflowing to the AI. */
  ringSeconds: () => Number(process.env.SPIKE_RING_SECONDS ?? 20),
  /** Retell agent to hand the call to (an existing Signal agent). */
  retellAgentId: () => need("SPIKE_RETELL_AGENT_ID"),
  retellApiKey: () => need("RETELL_API_KEY"),
  retellSipHost: () => process.env.RETELL_SIP_HOST ?? "sip.retellai.com",
  twilio: () => ({ sid: need("TWILIO_ACCOUNT_SID"), token: need("TWILIO_AUTH_TOKEN") }),
  /** Optional: subaccount used for the test number; falls back to master. */
  subaccountSid: () => process.env.SPIKE_SUBACCOUNT_SID,
  subaccountToken: () => process.env.SPIKE_SUBACCOUNT_TOKEN,
  /** Twilio API key pair for minting Voice SDK tokens (softphone). */
  apiKey: () => ({ sid: process.env.TWILIO_API_KEY_SID, secret: process.env.TWILIO_API_KEY_SECRET }),
  twimlAppSid: () => process.env.TWILIO_TWIML_APP_SID,
};
