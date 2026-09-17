import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { businessProfiles, regulatoryBundles } from "@/db/schema";
import { clients } from "@/db/shared";
import type { NumberType } from "./numbers";
import {
  createBundle,
  getRegulationSpec,
  submitBundle,
  validateEndUserAttributes,
  type AddressInput,
  type BundleStatus,
  type EndUserType,
  type EvaluationFailure,
} from "./regulatory";

/**
 * The business's legal details, entered ONCE (Settings → Business details),
 * and the Ofcom registrations (Twilio bundles) built from them per number
 * type. The buy flow never asks for these again: it registers the type from
 * the stored profile when needed.
 */

/** Types that carry their own Twilio regulation. 03 numbers use the local one. */
export { REGISTRABLE_TYPES, type RegistrableType } from "./business-labels";
import { REGISTRABLE_TYPES, type RegistrableType } from "./business-labels";

export function registrableTypeFor(type: NumberType): RegistrableType {
  return type === "national" ? "local" : type;
}

/** The inverse: which number types a registration of this type unlocks. */
export function typesCoveredBy(type: NumberType): NumberType[] {
  return type === "local" ? ["local", "national"] : [type];
}

export type BusinessProfile = typeof businessProfiles.$inferSelect;

export async function getBusinessProfile(clientId: string): Promise<BusinessProfile | null> {
  return (await db.query.businessProfiles.findFirst({ where: eq(businessProfiles.clientId, clientId) })) ?? null;
}

export async function saveBusinessProfile(
  clientId: string,
  input: { endUserType: EndUserType; attributes: Record<string, string>; address: AddressInput; contactEmail: string; updatedBy: string | null },
): Promise<BusinessProfile> {
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.attributes)) {
    const t = String(v ?? "").trim();
    if (t) attributes[k] = t;
  }
  const values = {
    endUserType: input.endUserType,
    attributes,
    address: { ...input.address, isoCountry: input.address.isoCountry || "GB" },
    contactEmail: input.contactEmail.trim() || null,
    updatedBy: input.updatedBy,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(businessProfiles)
    .values({ clientId, ...values })
    .onConflictDoUpdate({ target: businessProfiles.clientId, set: values })
    .returning();
  return row;
}

export type RegistrationState = "not_registered" | "draft" | "pending-review" | "in-review" | "twilio-approved" | "provisionally-approved" | "twilio-rejected";

export type TypeRegistration = {
  type: RegistrableType;
  state: RegistrationState;
  bundleId: string | null;
  failureReason: string | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
};

/** Latest registration per registrable type (newest bundle row wins). */
export async function registrationStatus(clientId: string): Promise<TypeRegistration[]> {
  const rows = await db.query.regulatoryBundles.findMany({
    where: and(eq(regulatoryBundles.clientId, clientId), inArray(regulatoryBundles.numberType, [...REGISTRABLE_TYPES])),
    orderBy: [desc(regulatoryBundles.createdAt)],
  });
  return REGISTRABLE_TYPES.map((type) => {
    // An approved bundle beats a newer draft/rejected attempt: approval is what unlocks purchases.
    const ofType = rows.filter((r) => r.numberType === type);
    const latest = ofType.find((r) => r.status === "twilio-approved") ?? ofType[0];
    return {
      type,
      state: (latest?.status as BundleStatus | undefined) ?? "not_registered",
      bundleId: latest?.id ?? null,
      failureReason: latest?.failureReason ?? null,
      submittedAt: latest?.submittedAt ?? null,
      decidedAt: latest?.decidedAt ?? null,
    };
  });
}

export type RegisterResult = {
  bundleId: string | null;
  compliant: boolean;
  failures: EvaluationFailure[];
  /** Bundle status after this call: pending-review when submitted, draft when not. */
  status: RegistrationState;
};

/** Mirror of createBundle's normalisation so validation here matches what Twilio will see. */
function normalisedAttributes(attrs: Record<string, string>) {
  const out: Record<string, string> = { ...attrs };
  for (const k of Object.keys(out)) {
    if (/^(is_subassigned|business_identity|business_type|business_registration_authority)$/.test(k)) out[k] = out[k].toUpperCase();
  }
  return out;
}

/**
 * Register one number type for the client from its stored business profile:
 * validate against the regulation first (nothing is created if the profile is
 * missing a required field), then Address → EndUser → Documents → Bundle →
 * evaluate → submit for review when compliant (or when forced).
 */
export async function registerType(
  clientId: string,
  type: NumberType,
  opts: { force?: boolean; identityDocument?: { file: File; type: string } } = {},
): Promise<RegisterResult> {
  const regType = registrableTypeFor(type);

  // Idempotency: one live registration per client per type. A double-click,
  // a second tab or the buy flow re-running the gate must never create a
  // second bundle while one is already under review or approved. Guarded in
  // the database, not the button, so it holds across concurrent requests.
  const live = await db.query.regulatoryBundles.findFirst({
    where: and(
      eq(regulatoryBundles.clientId, clientId),
      eq(regulatoryBundles.numberType, regType),
      inArray(regulatoryBundles.status, ["pending-review", "in-review", "twilio-approved", "provisionally-approved"]),
    ),
    orderBy: [desc(regulatoryBundles.createdAt)],
  });
  if (live && !(opts.force && live.status !== "twilio-approved")) {
    return { bundleId: live.id, compliant: true, failures: [], status: live.status };
  }

  const profile = await getBusinessProfile(clientId);
  if (!profile) throw new Error("Add your business details first.");
  if (!profile.address) throw new Error("Add your business address first.");
  const endUserType = (profile.endUserType === "individual" ? "individual" : "business") as EndUserType;

  const spec = await getRegulationSpec("GB", regType, endUserType);
  if (!spec) throw new Error(`Twilio has no ${endUserType} regulation for GB ${regType}.`);
  const attrs = normalisedAttributes(profile.attributes);
  const check = validateEndUserAttributes(spec, attrs);
  if (!check.ok) {
    const failures: EvaluationFailure[] = [
      ...check.missing.map((f) => ({ field: f.name, label: f.label, reason: "Required for this number type; add it under Business details." })),
      ...check.invalid.map((i) => ({ field: i.field.name, label: i.field.label, reason: `"${i.value}" is not one of ${i.field.acceptedValues.join(", ")}.` })),
    ];
    return { bundleId: null, compliant: false, failures, status: "not_registered" };
  }
  if (!spec.documentsFreeOfUploads && !opts.identityDocument) {
    return {
      bundleId: null,
      compliant: false,
      failures: [{ field: "identity_document", label: "Proof of identity", reason: "Sole traders must upload a passport or government-issued ID to register." }],
      status: "not_registered",
    };
  }

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { name: true, billingEmail: true } });
  const friendlyName = attrs.business_name || profile.address.customerName || client?.name || "Business";
  const email = profile.contactEmail || client?.billingEmail || attrs.email || attrs.authorized_representative_email || "";
  if (!email) throw new Error("Add a contact email under Business details; Twilio sends review updates there.");

  const created = await createBundle({
    clientId,
    numberType: regType,
    endUserType,
    email,
    friendlyName,
    endUserAttributes: attrs,
    address: profile.address,
    identityDocument: opts.identityDocument,
  });

  if (!created.evaluation.compliant && !opts.force) {
    return { bundleId: created.bundleId, compliant: false, failures: created.evaluation.failures, status: "draft" };
  }
  const submitted = await submitBundle(created.bundleId, { force: opts.force });
  return { bundleId: created.bundleId, compliant: created.evaluation.compliant, failures: created.evaluation.failures, status: submitted.status };
}

export { FIELD_DEFAULTS, FIELD_LABELS, TYPE_TITLES } from "./business-labels";
