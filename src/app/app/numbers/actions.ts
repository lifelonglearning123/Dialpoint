"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { numbers } from "@/db/schema";
import { requireClientAccess, requireSession } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { approvedBundleFor, purchaseNumber, releaseNumber, reserveNumber, searchNumbers, type AvailableNumber, type NumberType } from "@/lib/twilio/numbers";
import { createBundle, evaluateBundle, getRegulationSpec, submitBundle, type EndUserType, type EvaluationFailure, type RegulationSpec } from "@/lib/twilio/regulatory";

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
  /** When not active: the regulation form to render. */
  spec: RegulationSpec | null;
  endUserType: EndUserType;
};

/** Step 1 → 2: hold the number; buy straight away if this client is already registered for the type. */
export async function reserveNumberAction(formData: FormData): Promise<Result<ReserveOutcome>> {
  try {
    const { session, client } = await ctx();
    const type = asType(formData.get("type"));
    const e164 = String(formData.get("e164") ?? "");
    if (!/^\+44\d{9,10}$/.test(e164)) throw new Error("That doesn't look like a UK number.");
    const locality = String(formData.get("locality") ?? "") || null;
    const endUserType = (String(formData.get("endUserType") ?? "business") === "individual" ? "individual" : "business") as EndUserType;

    const row = await reserveNumber({ clientId: client.id, agencyId: session.agencyId, e164, type, locality });

    if (await approvedBundleFor(client.id, type)) {
      await purchaseNumber(row.id);
      revalidatePath("/app");
      revalidatePath("/app/numbers");
      return { ok: true, data: { numberId: row.id, active: true, spec: null, endUserType } };
    }
    const spec = await getRegulationSpec("GB", type, endUserType);
    if (!spec) throw new Error(`Twilio has no ${endUserType} regulation for GB ${type}.`);
    revalidatePath("/app/numbers");
    return { ok: true, data: { numberId: row.id, active: false, spec, endUserType } };
  } catch (e) {
    return fail(e);
  }
}

/** Fetch the form spec for a type (used when switching business/individual). */
export async function regulationSpecAction(type: string, endUserType: string): Promise<Result<RegulationSpec>> {
  try {
    await ctx();
    const spec = await getRegulationSpec("GB", asType(type), endUserType === "individual" ? "individual" : "business");
    if (!spec) throw new Error("No regulation found.");
    return { ok: true, data: spec };
  } catch (e) {
    return fail(e);
  }
}

export type KycOutcome = {
  bundleId: string;
  compliant: boolean;
  failures: EvaluationFailure[];
  /** Set when compliant and submitted in the same step. */
  submittedStatus?: string;
};

/**
 * Step 2: build the regulatory bundle from the form, evaluate, and if it
 * passes submit it for review immediately (the customer already clicked
 * "Submit registration"). Failures come back inline for correction.
 * FormData keys: type, endUserType, contact_email, friendly_name, address_*
 * (customer_name, street, city, region, postal_code), identity_document (file,
 * individuals), and one key per regulation field (its machine name).
 */
export async function submitKycAction(formData: FormData): Promise<Result<KycOutcome>> {
  try {
    const { session, client } = await ctx();
    const type = asType(formData.get("type"));
    const endUserType = (String(formData.get("endUserType") ?? "business") === "individual" ? "individual" : "business") as EndUserType;
    const spec = await getRegulationSpec("GB", type, endUserType);
    if (!spec) throw new Error("No regulation found.");

    const endUserAttributes: Record<string, string> = {};
    for (const f of spec.endUserFields) {
      const v = String(formData.get(f.name) ?? "").trim();
      if (v) endUserAttributes[f.name] = v;
    }
    const address = {
      customerName: String(formData.get("address_customer_name") ?? "").trim(),
      street: String(formData.get("address_street") ?? "").trim(),
      city: String(formData.get("address_city") ?? "").trim(),
      region: String(formData.get("address_region") ?? "").trim(),
      postalCode: String(formData.get("address_postal_code") ?? "").trim(),
      isoCountry: "GB",
    };
    for (const [k, v] of Object.entries(address)) if (!v) throw new Error(`Address: ${k.replace(/([A-Z])/g, " $1").toLowerCase()} is required.`);

    const email = String(formData.get("contact_email") ?? session.email).trim();
    const friendlyName = String(formData.get("friendly_name") ?? "").trim() || endUserAttributes.business_name || address.customerName || client.name;

    const file = formData.get("identity_document");
    const identityDocument = file instanceof File && file.size > 0 ? { file, type: String(formData.get("identity_document_type") ?? "passport") } : undefined;

    const result = await createBundle({ clientId: client.id, numberType: type, endUserType, email, friendlyName, endUserAttributes, address, identityDocument });

    if (!result.evaluation.compliant) {
      return { ok: true, data: { bundleId: result.bundleId, compliant: false, failures: result.evaluation.failures } };
    }
    const submitted = await submitBundle(result.bundleId);
    revalidatePath("/app/numbers");
    return { ok: true, data: { bundleId: result.bundleId, compliant: true, failures: [], submittedStatus: submitted.status } };
  } catch (e) {
    return fail(e);
  }
}

/** Re-check a draft after Twilio's evaluation flagged something. */
export async function evaluateBundleAction(bundleId: string): Promise<Result<{ compliant: boolean; failures: EvaluationFailure[] }>> {
  try {
    await ctx();
    const r = await evaluateBundle(bundleId);
    return { ok: true, data: { compliant: r.compliant, failures: r.failures } };
  } catch (e) {
    return fail(e);
  }
}

export async function submitBundleAction(bundleId: string, force = false): Promise<Result<{ status: string }>> {
  try {
    await ctx();
    const r = await submitBundle(bundleId, { force });
    revalidatePath("/app/numbers");
    return { ok: true, data: r };
  } catch (e) {
    return fail(e);
  }
}

export async function releaseNumberAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
  const numberId = String(formData.get("numberId") ?? "");
  const row = await db.query.numbers.findFirst({ where: eq(numbers.id, numberId) });
  if (!row) throw new Error("Number not found.");
  await requireClientAccess(session, row.clientId);
  await purchaseNumber(numberId);
  revalidatePath(`/app/numbers/${numberId}`);
  revalidatePath("/app/numbers");
  revalidatePath("/app");
}
