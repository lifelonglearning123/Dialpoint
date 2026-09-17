/**
 * Client-safe constants for the business/Ofcom UI. No server imports here: the
 * buy flow and Business form are client components and must not pull the
 * Twilio SDK into the browser bundle.
 */
/** Every UK number type has its own Twilio regulation; a Local bundle does NOT cover 03 numbers (Twilio error 21649). */
export const REGISTRABLE_TYPES = ["local", "national", "mobile", "tollfree"] as const;
export type RegistrableType = (typeof REGISTRABLE_TYPES)[number];

/** Human labels for Twilio's field machine names (shared by the Business page and the buy flow). */
export const FIELD_LABELS: Record<string, string> = {
  business_name: "Business name",
  business_registration_number: "Companies House number",
  business_registration_authority: "Registration authority",
  business_identity: "Who uses the number",
  business_type: "Business type",
  business_industry: "Industry",
  website_url: "Website",
  first_name: "First name",
  last_name: "Last name",
  authorized_representative_first_name: "Authorised representative: first name",
  authorized_representative_last_name: "Authorised representative: last name",
  authorized_representative_email: "Authorised representative: email",
  authorized_representative_phone_number: "Authorised representative: phone",
  authorized_representative_job_position: "Authorised representative: job title",
  is_subassigned: "Is the number for someone else?",
  phone_number: "Contact phone number",
  email: "Contact email",
  comments: "Notes for the reviewer (optional)",
  identity_document: "Proof of identity",
};

export const FIELD_DEFAULTS: Record<string, string> = {
  business_registration_authority: "UK:CRN",
  business_identity: "DIRECT_CUSTOMER",
  is_subassigned: "NO",
};

export const TYPE_TITLES: Record<RegistrableType, string> = {
  local: "Local (01 / 02)",
  national: "National (03)",
  mobile: "Mobile (07)",
  tollfree: "Freephone (0800)",
};
