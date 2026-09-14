"use server";

import { revalidatePath } from "next/cache";
import { requireManage } from "@/lib/auth";
import { currentClient } from "@/lib/clients";
import { getBusinessProfile, registerType, saveBusinessProfile, type RegisterResult } from "@/lib/twilio/business";
import type { NumberType } from "@/lib/twilio/numbers";
import { getRegulationSpec, type EndUserType, type RegulationSpec } from "@/lib/twilio/regulatory";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

async function ctx() {
  const { session, client } = await currentClient();
  if (!client) throw new Error("No business selected.");
  requireManage(session);
  return { session, client };
}

/** Field list for the chosen owner type (business vs sole trader). */
export async function businessSpecAction(endUserType: string): Promise<Result<RegulationSpec>> {
  try {
    await ctx();
    const spec = await getRegulationSpec("GB", "local", endUserType === "individual" ? "individual" : "business");
    if (!spec) throw new Error("No regulation found.");
    return { ok: true, data: spec };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Save the business's legal details. FormData: endUserType, contact_email,
 * address_customer_name/street/city/region/postal_code, and one key per
 * regulation field (its machine name), sent as `attr:<name>`.
 */
export async function saveBusinessAction(formData: FormData): Promise<Result<{ saved: true }>> {
  try {
    const { session, client } = await ctx();
    const endUserType = (String(formData.get("endUserType") ?? "business") === "individual" ? "individual" : "business") as EndUserType;
    const attributes: Record<string, string> = {};
    for (const [k, v] of formData.entries()) {
      if (k.startsWith("attr:") && typeof v === "string") attributes[k.slice(5)] = v.trim();
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
    if (/\bp\.?o\.?\s*box\b/i.test(address.street)) throw new Error("Ofcom does not accept PO boxes; use the business's street address.");
    const contactEmail = String(formData.get("contact_email") ?? "").trim() || session.email;

    await saveBusinessProfile(client.id, { endUserType, attributes, address, contactEmail, updatedBy: session.profileId });
    revalidatePath("/app/business");
    revalidatePath("/app/numbers/new");
    return { ok: true, data: { saved: true } };
  } catch (e) {
    return fail(e);
  }
}

/** Register (or re-submit) one number type from the stored details. FormData: type, force?, identity_document?, identity_document_type? */
export async function registerTypeAction(formData: FormData): Promise<Result<RegisterResult>> {
  try {
    const { client } = await ctx();
    const type = String(formData.get("type") ?? "") as NumberType;
    if (!["local", "mobile", "tollfree", "national"].includes(type)) throw new Error("Choose a number type.");
    const file = formData.get("identity_document");
    const identityDocument = file instanceof File && file.size > 0 ? { file, type: String(formData.get("identity_document_type") ?? "passport") } : undefined;
    const force = formData.get("force") === "1";
    const result = await registerType(client.id, type, { force, identityDocument });
    revalidatePath("/app/business");
    revalidatePath("/app/numbers");
    revalidatePath("/app/numbers/new");
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}

export async function hasBusinessProfileAction(): Promise<boolean> {
  const { client } = await currentClient();
  return !!client && !!(await getBusinessProfile(client.id));
}
