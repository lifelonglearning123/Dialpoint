import type { NextRequest } from "next/server";
import twilio from "twilio";
import { env } from "@/env";
import { masterCreds, subaccountCreds } from "@/lib/twilio/master";
import { baseUrl } from "./twiml";

/**
 * Twilio signs every webhook with the auth token of the account that owns the
 * number (the client's subaccount; the master for the Phase 0 test line).
 * Production rejects bad signatures; development only warns, so a tunnel URL
 * mismatch cannot silently kill a test call.
 */
export async function verifyTwilio(req: NextRequest, form: FormData, clientId: string | null): Promise<boolean> {
  const signature = req.headers.get("x-twilio-signature");
  const isProd = process.env.NODE_ENV === "production";
  if (!signature) {
    if (isProd) return false;
    return true; // local simulation
  }
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === "string") params[k] = v;
  });
  const fullUrl = baseUrl() + req.nextUrl.pathname + req.nextUrl.search;

  const tokens: string[] = [];
  if (clientId) {
    const sub = await subaccountCreds(clientId).catch(() => null);
    if (sub) tokens.push(sub.authToken);
  }
  try {
    tokens.push(masterCreds().authToken);
  } catch {
    /* master not configured */
  }
  const ok = tokens.some((t) => twilio.validateRequest(t, signature, fullUrl, params));
  if (!ok && !isProd) console.warn(`[voice] Twilio signature did not validate for ${req.nextUrl.pathname} (dev: allowing)`);
  return ok || !isProd;
}

export function readForm(form: FormData, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = form.get(k);
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

export const FORM_KEYS = [
  "CallSid",
  "ParentCallSid",
  "From",
  "To",
  "CallStatus",
  "Direction",
  "CallDuration",
  "DialCallStatus",
  "DialCallSid",
  "DialCallDuration",
  "DialBridged",
  "DialSipResponseCode",
  "Digits",
  "SipResponseCode",
  "RecordingSid",
  "RecordingUrl",
  "RecordingStatus",
  "RecordingDuration",
];

export function isProdEnv() {
  return process.env.NODE_ENV === "production";
}

export function publicBase() {
  return env.PUBLIC_BASE_URL ?? env.NEXT_PUBLIC_APP_URL;
}
