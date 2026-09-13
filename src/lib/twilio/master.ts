import { eq } from "drizzle-orm";
import twilio from "twilio";
import { db } from "@/db/client";
import { twilioAccounts } from "@/db/schema";
import { env } from "@/env";
import { decryptCredential, encryptCredential } from "@/lib/crypto/credentials";

/**
 * Twilio topology: ONE master account (Chao's, env TWILIO_ACCOUNT_SID) and one
 * SUBACCOUNT per customer (public.clients row), created the first time that
 * customer buys a number. Everything that belongs to the customer (numbers,
 * regulatory bundles, addresses, recordings, spend) lives in their subaccount,
 * so per-customer cost is read straight from Twilio and non-payment is a
 * single `status: suspended` on the subaccount.
 */
export type TwilioClient = ReturnType<typeof twilio>;

export type SubaccountCreds = { accountSid: string; authToken: string };

export function masterCreds(): SubaccountCreds {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("Twilio master account is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).");
  }
  return { accountSid: sid, authToken: token };
}

export function masterClient(): TwilioClient {
  const c = masterCreds();
  return twilio(c.accountSid, c.authToken);
}

/** Subaccount credentials for a client, or null if none has been created yet. */
export async function subaccountCreds(clientId: string): Promise<SubaccountCreds | null> {
  const row = await db.query.twilioAccounts.findFirst({ where: eq(twilioAccounts.clientId, clientId) });
  if (!row) return null;
  return { accountSid: row.subaccountSid, authToken: decryptCredential(row.authTokenEnc) };
}

/** Twilio client bound to the client's subaccount. Throws if none exists. */
export async function subaccountClient(clientId: string): Promise<TwilioClient> {
  const creds = await subaccountCreds(clientId);
  if (!creds) throw new Error("This business has no Twilio subaccount yet.");
  return twilio(creds.accountSid, creds.authToken);
}

/**
 * Create the client's subaccount once. Idempotent: a second call returns the
 * existing one. Friendly name carries the client id so the Twilio console is
 * searchable by our ids.
 */
export async function ensureSubaccount(clientId: string, clientName: string): Promise<{ client: TwilioClient; creds: SubaccountCreds; created: boolean }> {
  const existing = await subaccountCreds(clientId);
  if (existing) return { client: twilio(existing.accountSid, existing.authToken), creds: existing, created: false };

  const master = masterClient();
  const friendlyName = `client:${clientId} ${clientName}`.slice(0, 64);
  const sub = await master.api.v2010.accounts.create({ friendlyName });
  const creds = { accountSid: sub.sid, authToken: sub.authToken };

  await db
    .insert(twilioAccounts)
    .values({ clientId, subaccountSid: sub.sid, authTokenEnc: encryptCredential(sub.authToken), status: "active" })
    .onConflictDoNothing();

  return { client: twilio(creds.accountSid, creds.authToken), creds, created: true };
}

/** Non-payment action: calls stop, numbers are kept. Reversible with resumeSubaccount. */
export async function suspendSubaccount(clientId: string) {
  const creds = await subaccountCreds(clientId);
  if (!creds) return;
  await masterClient().api.v2010.accounts(creds.accountSid).update({ status: "suspended" });
  await db.update(twilioAccounts).set({ status: "suspended" }).where(eq(twilioAccounts.clientId, clientId));
}

export async function resumeSubaccount(clientId: string) {
  const creds = await subaccountCreds(clientId);
  if (!creds) return;
  await masterClient().api.v2010.accounts(creds.accountSid).update({ status: "active" });
  await db.update(twilioAccounts).set({ status: "active" }).where(eq(twilioAccounts.clientId, clientId));
}

/** Public https origin Twilio can reach for this deployment's webhooks. */
export function publicBaseUrl(): string {
  const base = env.PUBLIC_BASE_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (!base || !base.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must be an https origin Twilio can reach (tunnel in dev, Vercel URL in prod).");
  }
  return base.replace(/\/$/, "");
}
