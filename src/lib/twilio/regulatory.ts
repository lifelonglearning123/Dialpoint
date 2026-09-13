import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { regulatoryBundles, type bundleStatus } from "@/db/schema";
import { clients } from "@/db/shared";
import { ensureSubaccount, publicBaseUrl, subaccountCreds, type SubaccountCreds } from "./master";
import { activateReservedNumbers, regulationTypeFor, type NumberType } from "./numbers";

/**
 * Ofcom KYC through Twilio's Regulatory Compliance API, per CUSTOMER
 * subaccount (bundles cannot be shared across accounts). Object graph, in
 * creation order:
 *
 *   Address ─> SupportingDocument ─┐
 *   EndUser ───────────────────────┼─> ItemAssignment ─> Bundle ─> Evaluation ─> submit
 *   (uploaded ID, individuals only)┘
 *
 * Nothing submits implicitly: createBundle leaves it in `draft`, submitBundle
 * is the explicit one-way step that starts Twilio's human review.
 * Ported from Signal's src/lib/twilio/regulatory.ts (agency-level there).
 */
const NUMBERS_API = "https://numbers.twilio.com/v2/RegulatoryCompliance";
const NUMBERS_UPLOAD_API = "https://numbers-upload.twilio.com/v2/RegulatoryCompliance";
const API_2010 = "https://api.twilio.com/2010-04-01";
const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export type EndUserType = "individual" | "business";
export type BundleStatus = (typeof bundleStatus.enumValues)[number];

export interface FieldSpec {
  name: string;
  label: string;
  description: string;
  acceptedValues: string[];
}
export interface AcceptedDocument {
  name: string;
  type: string;
  fields: string[];
  isAddressBacked: boolean;
}
export interface DocumentRequirement {
  name: string;
  requirementName: string;
  acceptedDocuments: AcceptedDocument[];
}
export interface RegulationSpec {
  regulationSid: string;
  friendlyName: string;
  isoCountry: string;
  numberType: string;
  endUserType: EndUserType;
  endUserFields: FieldSpec[];
  endUserRequirementName: string;
  documents: DocumentRequirement[];
  documentsFreeOfUploads: boolean;
}
export interface AddressInput {
  customerName: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  isoCountry: string;
}
export interface EvaluationFailure {
  field: string;
  label: string;
  reason: string;
}
export interface EvaluationResult {
  compliant: boolean;
  failures: EvaluationFailure[];
  evaluationSid: string;
}

function authHeader(c: SubaccountCreds) {
  return "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
}

async function call<T>(c: SubaccountCreds, method: "GET" | "POST", url: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(c), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.code === "number" ? ` (${body.code})` : "";
    const message = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new Error(`Twilio${code}: ${message}`);
  }
  return body as T;
}

/** Twilio lists accepted values inside prose: "...following values: [YES, NO]". */
function parseAcceptedValues(description: string): string[] {
  const match = description.match(/following values\s*:\s*\[?([^.\]]+)\]?/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/[[\]]/g, ""))
    .filter((s) => s.length > 0 && !s.includes(" "));
}

export function toE164(raw: string, isoCountry = "GB"): string {
  const trimmed = raw.trim().replace(/[\s()-]/g, "");
  if (!trimmed || trimmed.startsWith("+")) return trimmed;
  const code = { GB: "44", US: "1" }[isoCountry.toUpperCase()];
  if (!code) return trimmed;
  if (trimmed.startsWith("00")) return `+${trimmed.slice(2)}`;
  if (trimmed.startsWith("0") && code !== "1") return `+${code}${trimmed.slice(1)}`;
  if (trimmed.startsWith(code)) return `+${trimmed}`;
  return `+${code}${trimmed}`;
}

async function credsFor(clientId: string): Promise<SubaccountCreds> {
  const creds = await subaccountCreds(clientId);
  if (creds) return creds;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { name: true } });
  const { creds: created } = await ensureSubaccount(clientId, client?.name ?? "client");
  return created;
}

/* ---------------------------------------------------------------------------
 * 1. What does this number type need? (read-only, master creds are enough)
 * ------------------------------------------------------------------------- */
export async function getRegulationSpec(
  isoCountry: string,
  numberType: NumberType,
  endUserType: EndUserType = "business",
  creds?: SubaccountCreds,
): Promise<RegulationSpec | null> {
  const { masterCreds } = await import("./master");
  const c = creds ?? masterCreds();
  const regType = regulationTypeFor(numberType);
  const url =
    `${NUMBERS_API}/Regulations?IsoCountry=${encodeURIComponent(isoCountry)}` +
    `&NumberType=${encodeURIComponent(regType)}&EndUserType=${encodeURIComponent(endUserType)}`;
  const body = await call<{ results?: Array<Record<string, unknown>> }>(c, "GET", url);
  const reg = body.results?.[0];
  if (!reg) return null;

  const req = reg.requirements as {
    end_user?: Array<Record<string, unknown>>;
    supporting_document?: Array<Array<Record<string, unknown>>>;
  };
  const endUser = req?.end_user?.[0];
  const detailed = (endUser?.detailed_fields as Array<Record<string, unknown>> | undefined) ?? [];
  const endUserFields: FieldSpec[] = detailed.length
    ? detailed.map((f) => {
        const description = String(f.description ?? "");
        return { name: String(f.machine_name), label: String(f.friendly_name ?? f.machine_name), description, acceptedValues: parseAcceptedValues(description) };
      })
    : ((endUser?.fields as string[] | undefined) ?? []).map((name) => ({ name, label: name, description: "", acceptedValues: [] }));

  const documents: DocumentRequirement[] = [];
  for (const group of req?.supporting_document ?? []) {
    for (const doc of group) {
      const accepted = ((doc.accepted_documents as Array<Record<string, unknown>> | undefined) ?? []).map((t) => {
        const fields = (t.fields as string[] | undefined) ?? [];
        return { name: String(t.name), type: String(t.type), fields, isAddressBacked: fields.includes("address_sids") };
      });
      documents.push({ name: String(doc.name), requirementName: String(doc.requirement_name), acceptedDocuments: accepted });
    }
  }

  return {
    regulationSid: String(reg.sid),
    friendlyName: String(reg.friendly_name),
    isoCountry: String(reg.iso_country ?? isoCountry),
    numberType: String(reg.number_type ?? regType),
    endUserType,
    endUserFields,
    endUserRequirementName: String(endUser?.requirement_name ?? "end_user_info"),
    documents,
    documentsFreeOfUploads: documents.every((d) => d.acceptedDocuments.some((a) => a.isAddressBacked)),
  };
}

export function validateEndUserAttributes(spec: RegulationSpec, values: Record<string, unknown>) {
  const missing: FieldSpec[] = [];
  const invalid: Array<{ field: FieldSpec; value: string }> = [];
  for (const field of spec.endUserFields) {
    const raw = values[field.name];
    const value = raw == null ? "" : String(raw).trim();
    if (!value) {
      if (field.name !== "comments") missing.push(field);
      continue;
    }
    if (field.acceptedValues.length > 0 && !field.acceptedValues.some((v) => v.toLowerCase() === value.toLowerCase())) {
      invalid.push({ field, value });
    }
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/* ---------------------------------------------------------------------------
 * 2. Build the bundle (draft)
 * ------------------------------------------------------------------------- */
function addressKey(parts: (string | undefined)[]) {
  return parts.map((p) => (p ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")).join("|");
}

/** Reuse an identical validated address in the subaccount rather than adding a duplicate. */
export async function findOrCreateAddress(c: SubaccountCreds, address: AddressInput, friendlyName: string): Promise<string> {
  const want = addressKey([address.street, address.city, address.postalCode, address.isoCountry]);
  const listed = await call<{ addresses?: Array<Record<string, unknown>> }>(
    c,
    "GET",
    `${API_2010}/Accounts/${encodeURIComponent(c.accountSid)}/Addresses.json?PageSize=50`,
  ).catch(() => ({ addresses: [] }));
  for (const a of listed.addresses ?? []) {
    if (addressKey([String(a.street ?? ""), String(a.city ?? ""), String(a.postal_code ?? ""), String(a.iso_country ?? "")]) === want) return String(a.sid);
  }
  const created = await call<{ sid: string }>(c, "POST", `${API_2010}/Accounts/${encodeURIComponent(c.accountSid)}/Addresses.json`, {
    CustomerName: address.customerName,
    Street: address.street,
    City: address.city,
    Region: address.region,
    PostalCode: address.postalCode,
    IsoCountry: address.isoCountry,
    FriendlyName: `${friendlyName} — regulatory address`,
  });
  return created.sid;
}

async function uploadSupportingDocument(
  c: SubaccountCreds,
  opts: { friendlyName: string; type: string; attributes: Record<string, unknown>; file: File },
): Promise<string> {
  if (opts.file.size > DOCUMENT_MAX_BYTES) throw new Error(`That file is ${(opts.file.size / 1024 / 1024).toFixed(1)}MB; the limit is 5MB.`);
  const form = new FormData();
  form.set("FriendlyName", opts.friendlyName);
  form.set("Type", opts.type);
  form.set("Attributes", JSON.stringify(opts.attributes));
  form.set("File", opts.file, opts.file.name || "document");
  const res = await fetch(`${NUMBERS_UPLOAD_API}/SupportingDocuments`, { method: "POST", headers: { Authorization: authHeader(c) }, body: form });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio${typeof body.code === "number" ? ` (${body.code})` : ""}: ${typeof body.message === "string" ? body.message : `HTTP ${res.status}`}`);
  return String(body.sid);
}

function normaliseAttributes(attrs: Record<string, string | boolean>, isoCountry: string) {
  const out: Record<string, string | boolean> = { ...attrs };
  if (typeof out.phone_number === "string" && out.phone_number) out.phone_number = toE164(out.phone_number, isoCountry);
  for (const k of Object.keys(out)) {
    // Twilio's GB enums are uppercase; a lowercase "yes" reads as unspecified.
    if (/^(is_subassigned|business_identity|business_type|business_registration_authority)$/.test(k) && typeof out[k] === "string") {
      out[k] = (out[k] as string).toUpperCase();
    }
  }
  return out;
}

export interface CreateBundleInput {
  clientId: string;
  numberType: NumberType;
  endUserType?: EndUserType;
  isoCountry?: string;
  /** Contact for Twilio's review correspondence. */
  email: string;
  friendlyName: string;
  endUserAttributes: Record<string, string | boolean>;
  address: AddressInput;
  /** Individuals (sole traders) must upload proof of identity. */
  identityDocument?: { file: File; type: string };
}

export interface CreateBundleResult {
  bundleId: string;
  bundleSid: string;
  evaluation: EvaluationResult;
}

/**
 * Create Address → EndUser → SupportingDocument(s) → Bundle → ItemAssignments,
 * evaluate, and persist as a draft row in tb.regulatory_bundles. Reuses an
 * existing draft of the same type for this client (updates the EndUser) so a
 * customer correcting a field does not leave orphaned objects in Twilio.
 */
export async function createBundle(input: CreateBundleInput): Promise<CreateBundleResult> {
  const isoCountry = (input.isoCountry ?? "GB").toUpperCase();
  const endUserType = input.endUserType ?? "business";
  const c = await credsFor(input.clientId);

  const spec = await getRegulationSpec(isoCountry, input.numberType, endUserType, c);
  if (!spec) throw new Error(`Twilio has no ${endUserType} regulation for ${isoCountry} ${input.numberType}.`);
  if (!spec.documentsFreeOfUploads && !input.identityDocument) {
    throw new Error(`${spec.friendlyName} needs proof of identity: attach a passport or government-issued ID.`);
  }
  const attrs = normaliseAttributes(input.endUserAttributes, isoCountry);
  const check = validateEndUserAttributes(spec, attrs);
  if (!check.ok) {
    const parts = [...check.missing.map((f) => `${f.label} is required`), ...check.invalid.map((i) => `${i.field.label}: "${i.value}" is not one of ${i.field.acceptedValues.join(", ")}`)];
    throw new Error(parts.join("; "));
  }

  // Resume an existing draft for this type rather than building a second graph.
  const draft = await db.query.regulatoryBundles.findFirst({
    where: and(eq(regulatoryBundles.clientId, input.clientId), eq(regulatoryBundles.numberType, input.numberType), eq(regulatoryBundles.status, "draft")),
  });
  if (draft) {
    await call(c, "POST", `${NUMBERS_API}/EndUsers/${encodeURIComponent(draft.endUserSid)}`, { Attributes: JSON.stringify(attrs) });
    const evaluation = await evaluateBundleSid(c, draft.bundleSid);
    await db
      .update(regulatoryBundles)
      .set({ submitted: stringify(attrs, input.address, input.email), failureReason: evaluation.compliant ? null : evaluation.failures.map((f) => `${f.label}: ${f.reason}`).join("; ") })
      .where(eq(regulatoryBundles.id, draft.id));
    return { bundleId: draft.id, bundleSid: draft.bundleSid, evaluation };
  }

  const addressSid = await findOrCreateAddress(c, { ...input.address, isoCountry }, input.friendlyName);

  const endUser = await call<{ sid: string }>(c, "POST", `${NUMBERS_API}/EndUsers`, {
    FriendlyName: input.friendlyName,
    Type: endUserType,
    Attributes: JSON.stringify(attrs),
  });

  // One document per requirement; address-backed where allowed, uploaded ID otherwise.
  const documentSids: string[] = [];
  const usedTypes = new Set<string>();
  for (const requirement of spec.documents) {
    const backed = requirement.acceptedDocuments.find((d) => d.isAddressBacked && !usedTypes.has(d.type));
    if (backed) {
      usedTypes.add(backed.type);
      const doc = await call<{ sid: string }>(c, "POST", `${NUMBERS_API}/SupportingDocuments`, {
        FriendlyName: `${input.friendlyName} — ${requirement.name}`,
        Type: backed.type,
        Attributes: JSON.stringify({ address_sids: [addressSid] }),
      });
      documentSids.push(doc.sid);
      continue;
    }
    if (!input.identityDocument) throw new Error(`${requirement.name} needs a document upload, but none was provided.`);
    const accepted =
      requirement.acceptedDocuments.find((d) => d.type === input.identityDocument?.type && !usedTypes.has(d.type)) ??
      requirement.acceptedDocuments.find((d) => !usedTypes.has(d.type));
    if (!accepted) throw new Error(`No document type left to satisfy ${requirement.name}.`);
    usedTypes.add(accepted.type);
    const attributes: Record<string, unknown> = {};
    for (const field of accepted.fields) if (attrs[field] !== undefined) attributes[field] = attrs[field];
    documentSids.push(
      await uploadSupportingDocument(c, { friendlyName: `${input.friendlyName} — ${requirement.name}`, type: accepted.type, attributes, file: input.identityDocument.file }),
    );
  }

  const statusCallback = safeBase() ? `${safeBase()}/api/webhooks/twilio-regulatory` : undefined;
  const bundle = await call<{ sid: string }>(c, "POST", `${NUMBERS_API}/Bundles`, {
    FriendlyName: `${input.friendlyName} — ${isoCountry} ${regulationTypeFor(input.numberType)}`,
    Email: input.email,
    RegulationSid: spec.regulationSid,
    ...(statusCallback ? { StatusCallback: statusCallback } : {}),
  });
  for (const objectSid of [endUser.sid, ...documentSids]) {
    await call(c, "POST", `${NUMBERS_API}/Bundles/${encodeURIComponent(bundle.sid)}/ItemAssignments`, { ObjectSid: objectSid });
  }
  const evaluation = await evaluateBundleSid(c, bundle.sid);

  const [row] = await db
    .insert(regulatoryBundles)
    .values({
      clientId: input.clientId,
      isoCountry,
      numberType: input.numberType,
      endUserType,
      bundleSid: bundle.sid,
      regulationSid: spec.regulationSid,
      endUserSid: endUser.sid,
      addressSid,
      documentSids,
      status: "draft",
      submitted: stringify(attrs, input.address, input.email),
      failureReason: evaluation.compliant ? null : evaluation.failures.map((f) => `${f.label}: ${f.reason}`).join("; "),
    })
    .returning();

  return { bundleId: row.id, bundleSid: bundle.sid, evaluation };
}

function safeBase(): string | null {
  try {
    return publicBaseUrl();
  } catch {
    return null;
  }
}

function stringify(attrs: Record<string, string | boolean>, address: AddressInput, email: string): Record<string, string> {
  const out: Record<string, string> = { contact_email: email };
  for (const [k, v] of Object.entries(attrs)) out[k] = String(v);
  out.address_customer_name = address.customerName;
  out.address_street = address.street;
  out.address_city = address.city;
  out.address_region = address.region;
  out.address_postal_code = address.postalCode;
  return out;
}

/* ---------------------------------------------------------------------------
 * 3. Evaluate (dry run against the regulation)
 * ------------------------------------------------------------------------- */
async function evaluateBundleSid(c: SubaccountCreds, bundleSid: string): Promise<EvaluationResult> {
  const body = await call<{ sid: string; status: string; results?: Array<Record<string, unknown>> }>(
    c,
    "POST",
    `${NUMBERS_API}/Bundles/${encodeURIComponent(bundleSid)}/Evaluations`,
  );
  const failures: EvaluationFailure[] = [];
  for (const r of body.results ?? []) {
    if (r.passed === true || String(r.passed) === "true") continue;
    const invalid = (r.invalid as Array<Record<string, unknown>> | undefined) ?? [];
    if (invalid.length === 0) {
      failures.push({ field: String(r.requirement_name ?? ""), label: String(r.requirement_friendly_name ?? r.friendly_name ?? "Requirement"), reason: String(r.failure_reason ?? "This requirement isn't met yet.") });
      continue;
    }
    for (const f of invalid) {
      failures.push({ field: String(f.object_field ?? ""), label: String(f.friendly_name ?? f.object_field ?? "Field"), reason: String(f.failure_reason ?? "Invalid value.") });
    }
  }
  return { compliant: body.status === "compliant" && failures.length === 0, failures, evaluationSid: body.sid };
}

export async function evaluateBundle(bundleId: string): Promise<EvaluationResult> {
  const row = await db.query.regulatoryBundles.findFirst({ where: eq(regulatoryBundles.id, bundleId) });
  if (!row) throw new Error("Registration not found.");
  const c = await credsFor(row.clientId);
  return evaluateBundleSid(c, row.bundleSid);
}

/* ---------------------------------------------------------------------------
 * 4. Submit (deliberate, one-way) and 5. Sync
 * ------------------------------------------------------------------------- */
export async function submitBundle(bundleId: string, opts: { force?: boolean } = {}): Promise<{ status: BundleStatus }> {
  const row = await db.query.regulatoryBundles.findFirst({ where: eq(regulatoryBundles.id, bundleId) });
  if (!row) throw new Error("Registration not found.");
  const c = await credsFor(row.clientId);
  if (!opts.force) {
    const evaluation = await evaluateBundleSid(c, row.bundleSid);
    if (!evaluation.compliant) {
      throw new Error(`Registration isn't complete yet: ${evaluation.failures.map((f) => `${f.label}: ${f.reason}`).join("; ")}`);
    }
  }
  const body = await call<{ status: string }>(c, "POST", `${NUMBERS_API}/Bundles/${encodeURIComponent(row.bundleSid)}`, { Status: "pending-review" });
  const status = toStatus(body.status);
  await db.update(regulatoryBundles).set({ status, submittedAt: new Date(), failureReason: null }).where(eq(regulatoryBundles.id, bundleId));
  return { status };
}

function toStatus(s: string): BundleStatus {
  const known: BundleStatus[] = ["draft", "pending-review", "in-review", "twilio-rejected", "twilio-approved", "provisionally-approved"];
  return (known as string[]).includes(s) ? (s as BundleStatus) : "in-review";
}

/**
 * Pull the bundle's status from Twilio and mirror it. On approval, buy every
 * number the customer reserved for that type. Safe to call repeatedly (webhook
 * and cron both use it).
 */
export async function syncBundleStatus(bundleSid: string): Promise<{ status: BundleStatus; activated: number } | null> {
  const row = await db.query.regulatoryBundles.findFirst({ where: eq(regulatoryBundles.bundleSid, bundleSid) });
  if (!row) return null;
  const c = await credsFor(row.clientId);
  const body = await call<Record<string, unknown>>(c, "GET", `${NUMBERS_API}/Bundles/${encodeURIComponent(bundleSid)}`);
  const status = toStatus(String(body.status));
  const decided = status === "twilio-approved" || status === "twilio-rejected" || status === "provisionally-approved";
  await db
    .update(regulatoryBundles)
    .set({
      status,
      decidedAt: decided && !row.decidedAt ? new Date() : row.decidedAt,
      failureReason: status === "twilio-rejected" ? String(body.status_callback ?? body.failure_reason ?? "Rejected by Twilio; see the email from Twilio for the reason.") : row.failureReason,
    })
    .where(eq(regulatoryBundles.id, row.id));

  let activated = 0;
  if (status === "twilio-approved") {
    const results = await activateReservedNumbers(row.clientId, row.numberType);
    activated = results.filter((r) => r.ok).length;
  }
  return { status, activated };
}

/** Every bundle still waiting on Twilio, for the cron. */
export async function pendingBundles() {
  return db.query.regulatoryBundles.findMany({ where: inArray(regulatoryBundles.status, ["pending-review", "in-review"]) });
}

/** Registrations for a client, newest first. */
export async function bundlesFor(clientId: string) {
  return db.query.regulatoryBundles.findMany({ where: eq(regulatoryBundles.clientId, clientId), orderBy: (b, { desc }) => [desc(b.createdAt)] });
}
