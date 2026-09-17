"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { requireClientAccess, requireManage, requireSession } from "@/lib/auth";
import { confirmCheckout, ensureSubscription } from "@/lib/billing/subscription";
import { currentClient } from "@/lib/clients";
import { approvedBundleFor, purchaseNumber, releaseNumber, reserveNumber, searchNumbers, type AvailableNumber, type NumberType } from "@/lib/twilio/numbers";
import { getBusinessProfile, registerType, registrableTypeFor, registrationStatus } from "@/lib/twilio/business";
import type { EndUserType, EvaluationFailure } from "@/lib/twilio/regulatory";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const TYPES: NumberType[] = ["local", "national", "tollfree", "mobile"];

function asType(v: unknown): NumberType {
  const t = String(v ?? "");
  if (!(TYPES as string[]).includes(t)) throw new Error("Choose a number type.");
  return t as NumberType;
}

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

async function ctx() {
  const { session, client } = await currentClient();
  if (!client) throw new Error("No business selected.");
  return { session, client };
}

/** Step 1: search Twilio inventory. `contains` is a digit pattern like 4420* (London). */
export async function searchNumbersAction(formData: FormData): Promise<Result<AvailableNumber[]>> {
  try {
    const { client } = await ctx();
    const type = asType(formData.get("type"));
    const raw = String(formData.get("contains") ?? "").trim();
    // Accept "020", "0207", "01865", "020 7946" and normalise to a Twilio contains pattern.
    const digits = raw.replace(/\D/g, "");
    let contains: string | undefined;
    if (digits) {
      const national = digits.startsWith("0") ? digits.slice(1) : digits.startsWith("44") ? digits.slice(2) : digits;
      contains = `44${national}*`;
    }
    const locality = String(formData.get("locality") ?? "").trim() || undefined;
    const data = await searchNumbers({ clientId: client.id, type, contains, locality: type === "local" ? locality : undefined, limit: 10 });
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

export type ReserveOutcome = {
  numberId: string;
  /** true = an approved registration existed and the number is now live. */
  active: boolean;
  endUserType: EndUserType;
  /** Set when the client has no card on file yet: the browser must visit Stripe first. */
  checkoutUrl?: string;
  /** No business details saved yet: send the customer to /app/business once. */
  needsProfile?: boolean;
  /** The Ofcom registration attempted from the stored details for this type. */
  registration?: { submitted: boolean; failures: EvaluationFailure[]; bundleId: string | null };
};

/** Absolute origin of the current request (127.0.0.1 in dev, the agency's host in prod). */
async function requestOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3410";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * After the number is reserved: either buy it now (registered type) or return
 * the Ofcom form. Both paths first require a subscription with a card on file
 * (Phase 3): with none, the caller gets a Stripe Checkout URL and comes back to
 * /app/numbers/new?checkout=success&numberId=… which calls resumeAfterCheckout.
 */
async function continueAfterReserve(clientId: string, numberId: string, type: NumberType, endUserType: EndUserType, email: string): Promise<ReserveOutcome> {
  const origin = await requestOrigin();
  const gate = await ensureSubscription(clientId, {
    successUrl: `${origin}/app/numbers/new?checkout=success&numberId=${numberId}&endUserType=${endUserType}`,
    cancelUrl: `${origin}/app/numbers/new?checkout=cancel&numberId=${numberId}`,
    email,
    pendingType: type,
  });
  if (!gate.ok) return { numberId, active: false, endUserType, checkoutUrl: gate.checkoutUrl };

  if (await approvedBundleFor(clientId, type)) {
    await purchaseNumber(numberId);
    revalidatePath("/app");
    revalidatePath("/app/numbers");
    return { numberId, active: true, endUserType };
  }

  // Not registered for this type yet: register from the stored business details
  // (entered once under /app/business). Nothing is asked for here.
  const profile = await getBusinessProfile(clientId);
  if (!profile) {
    revalidatePath("/app/numbers");
    return { numberId, active: false, endUserType, needsProfile: true };
  }
  const already = await registrationStatus(clientId);
  const current = already.find((r) => r.type === registrableTypeFor(type));
  if (current && (current.state === "pending-review" || current.state === "in-review")) {
    revalidatePath("/app/numbers");
    return { numberId, active: false, endUserType: profile.endUserType as EndUserType, registration: { submitted: true, failures: [], bundleId: current.bundleId } };
  }
  const reg = await registerType(clientId, type);
  revalidatePath("/app/numbers");
  revalidatePath("/app/business");
  return {
    numberId,
    active: false,
    endUserType: profile.endUserType as EndUserType,
    registration: { submitted: reg.status === "pending-review" || reg.status === "in-review", failures: reg.failures, bundleId: reg.bundleId },
  };
}

/** Step 1 → 2: hold the number, then card on file → buy or Ofcom form. */
export async function reserveNumberAction(formData: FormData): Promise<Result<ReserveOutcome>> {
  try {
    const { session, client } = await ctx();
    requireManage(session);
    const type = asType(formData.get("type"));
    const e164 = String(formData.get("e164") ?? "");
    if (!/^\+44\d{9,10}$/.test(e164)) throw new Error("That doesn't look like a UK number.");
    const locality = String(formData.get("locality") ?? "") || null;
    const endUserType = (String(formData.get("endUserType") ?? "business") === "individual" ? "individual" : "business") as EndUserType;

    const row = await reserveNumber({ clientId: client.id, agencyId: session.agencyId, e164, type, locality });
    return { ok: true, data: await continueAfterReserve(client.id, row.id, type, endUserType, session.email) };
  } catch (e) {
    return fail(e);
  }
}

/** Browser is back from Stripe Checkout: confirm payment, then carry on where reserve left off. */
export async function resumeAfterCheckout(numberId: string, endUserType: EndUserType): Promise<ReserveOutcome & { e164: string; type: NumberType; locality: string | null }> {
  const { session, client } = await ctx();
  const row = await db.query.numbers.findFirst({ where: and(eq(numbers.id, numberId), eq(numbers.clientId, client.id)) });
  if (!row) throw new Error("Number not found.");
  const paid = await confirmCheckout(client.id);
  if (!paid) throw new Error("Payment was not completed. Try again to add a card.");
  const outcome = row.status === "active" ? { numberId, active: true, endUserType } : await continueAfterReserve(client.id, row.id, row.type, endUserType, session.email);
  return { ...outcome, e164: row.e164, type: row.type, locality: row.locality };
}

export async function releaseNumberAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  requireManage(session);
  const numberId = String(formData.get("numberId") ?? "");
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  await requireClientAccess(session, row.clientId);
  await releaseNumber(numberId);
  revalidatePath("/app");
  revalidatePath("/app/numbers");
}

export async function updateNumberLabelAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  requireManage(session);
  const numberId = String(formData.get("numberId") ?? "");
  const label = String(formData.get("label") ?? "").trim().slice(0, 60) || null;
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  await requireClientAccess(session, row.clientId);
  await db.update(numbers).set({ label }).where(and(eq(numbers.id, numberId), eq(numbers.clientId, row.clientId)));
  revalidatePath(`/app/numbers/${numberId}`);
  revalidatePath("/app/numbers");
  revalidatePath("/app");
}

/** Retry the purchase of a reserved number (e.g. after approval arrived while offline). */
export async function activateNumberAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  requireManage(session);
  const numberId = String(formData.get("numberId") ?? "");
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  await requireClientAccess(session, row.clientId);
  await purchaseNumber(numberId);
  revalidatePath(`/app/numbers/${numberId}`);
  revalidatePath("/app/numbers");
  revalidatePath("/app");
}
