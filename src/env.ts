import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Runtime environment. This app shares Signal's Supabase project (same
 * DATABASE_URL, same auth) and Chao's Twilio master account. Everything Twilio
 * or Retell-specific for the Phase 0 spike stays in src/lib/spike/config.ts.
 */
export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    /** Dev / bare-host fallback when the Host matches no tb.agency_domains row. */
    DEFAULT_AGENCY_SLUG: z.string().optional(),
    /** 32-byte hex, same key Signal uses (agencies.*_enc are readable by both). */
    CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    /** Twilio MASTER account. Subaccounts are created under it per client. */
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    /** Public https origin Twilio can reach (tunnel in dev, the Vercel URL in prod). */
    PUBLIC_BASE_URL: z.string().url().optional(),
    /** Shared secret for Signal → this app calls (transfer, call.ended, agent.status). */
    PARTNER_INBOUND_SECRET: z.string().optional(),
    /** Bearer for this app → Signal partner API. */
    SIGNAL_PARTNER_URL: z.string().url().optional(),
    SIGNAL_PARTNER_SECRET: z.string().optional(),
    /** Stripe platform key (same as Signal's); connected accounts via the Stripe-Account header. */
    STRIPE_SECRET_KEY: z.string().optional(),
    /** This app's own Connect webhook endpoint secret (events from connected accounts). */
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** Header x-cron-secret for /api/cron/* (Vercel Cron sends it via vercel.json). */
    CRON_SECRET: z.string().optional(),
    /** HMAC key for the signed routing cursor in Twilio action URLs (falls back to CREDENTIALS_ENCRYPTION_KEY). */
    ROUTING_SIGNING_SECRET: z.string().min(16).optional(),
    /** TEMPORARY until the Signal partner API: direct Retell access for the `ai` step. */
    RETELL_API_KEY: z.string().optional(),
    RETELL_SIP_HOST: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
    NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3410"),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    DEFAULT_AGENCY_SLUG: process.env.DEFAULT_AGENCY_SLUG,
    CREDENTIALS_ENCRYPTION_KEY: process.env.CREDENTIALS_ENCRYPTION_KEY,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    PARTNER_INBOUND_SECRET: process.env.PARTNER_INBOUND_SECRET,
    SIGNAL_PARTNER_URL: process.env.SIGNAL_PARTNER_URL,
    SIGNAL_PARTNER_SECRET: process.env.SIGNAL_PARTNER_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    ROUTING_SIGNING_SECRET: process.env.ROUTING_SIGNING_SECRET,
    RETELL_API_KEY: process.env.RETELL_API_KEY,
    RETELL_SIP_HOST: process.env.RETELL_SIP_HOST,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  emptyStringAsUndefined: true,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
