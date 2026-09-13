/**
 * This app's own tables, all in the Postgres schema `tb` on Signal's Supabase
 * project. Every row hangs off public.clients.id (the customer) and
 * public.agencies.id (the white-label agency). Shared tables are in shared.ts.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agencies, clients, profiles } from "./shared";

export const tb = pgSchema("tb");

export const numberType = tb.enum("number_type", ["local", "national", "tollfree", "mobile"]);
export const numberStatus = tb.enum("number_status", [
  "reserved", // chosen, not yet bought (bundle pending)
  "verifying", // bought/held, waiting on regulatory approval
  "active",
  "suspended", // non-payment: subaccount suspended, number kept
  "released",
]);
export const bundleStatus = tb.enum("bundle_status", [
  "draft",
  "pending-review",
  "in-review",
  "twilio-rejected",
  "twilio-approved",
  "provisionally-approved",
]);
export const targetKind = tb.enum("target_kind", ["pstn", "client"]);
export const contactTag = tb.enum("contact_tag", ["vip", "blocked", "known"]);
export const callOutcome = tb.enum("call_outcome", [
  "human", // a human accepted and spoke
  "ai", // the AI handled it
  "voicemail",
  "missed", // nobody and no fallback (should be rare)
  "blocked",
  "in_progress",
]);
export const legKind = tb.enum("leg_kind", ["human_pstn", "human_client", "ai", "voicemail", "ivr"]);

/** This app's hostnames per agency (Signal's custom_domain is Signal's own host). */
export const agencyDomains = tb.table(
  "agency_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tb_agency_domains_host_unique").on(t.host)],
);

/** One Twilio subaccount per customer, created at first purchase. */
export const twilioAccounts = tb.table(
  "twilio_accounts",
  {
    clientId: uuid("client_id")
      .primaryKey()
      .references(() => clients.id, { onDelete: "cascade" }),
    subaccountSid: text("subaccount_sid").notNull(),
    authTokenEnc: text("auth_token_enc").notNull(),
    status: text("status").notNull().default("active"), // active | suspended | closed
    /** TwiML App + API key for the browser softphone, created lazily. */
    twimlAppSid: text("twiml_app_sid"),
    apiKeySid: text("api_key_sid"),
    apiKeySecretEnc: text("api_key_secret_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tb_twilio_accounts_sid_unique").on(t.subaccountSid)],
);

export const regulatoryBundles = tb.table(
  "regulatory_bundles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    isoCountry: text("iso_country").notNull().default("GB"),
    numberType: numberType("number_type").notNull(),
    endUserType: text("end_user_type").notNull().default("business"),
    bundleSid: text("bundle_sid").notNull(),
    regulationSid: text("regulation_sid").notNull(),
    endUserSid: text("end_user_sid").notNull(),
    addressSid: text("address_sid"),
    documentSids: text("document_sids").array().notNull().default(sql`'{}'::text[]`),
    status: bundleStatus("status").notNull().default("draft"),
    /** What the customer typed; kept so a rejection can be corrected without retyping. */
    submitted: jsonb("submitted").$type<Record<string, string>>().notNull().default({}),
    failureReason: text("failure_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tb_regulatory_bundles_client_idx").on(t.clientId),
    uniqueIndex("tb_regulatory_bundles_sid_unique").on(t.bundleSid),
  ],
);

export const numbers = tb.table(
  "numbers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    e164: text("e164").notNull(),
    type: numberType("type").notNull(),
    locality: text("locality"),
    status: numberStatus("status").notNull().default("reserved"),
    /** Set once Twilio actually holds the number. */
    twilioSid: text("twilio_sid"),
    bundleId: uuid("bundle_id").references(() => regulatoryBundles.id, { onDelete: "set null" }),
    addressSid: text("address_sid"),
    label: text("label"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tb_numbers_client_idx").on(t.clientId),
    // A number can be re-bought by someone else after release, so uniqueness is
    // only among non-released rows.
    uniqueIndex("tb_numbers_e164_live_unique").on(t.e164).where(sql`${t.status} <> 'released'`),
  ],
);

/** Where humans answer. Ordered by priority; kind decides <Number> vs <Client>. */
export const humanTargets = tb.table(
  "human_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: targetKind("kind").notNull(),
    /** E.164 for pstn; the profile id for client (softphone identity = user:<profileId>). */
    value: text("value").notNull(),
    label: text("label").notNull(),
    profileId: uuid("profile_id").references(() => profiles.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tb_human_targets_client_idx").on(t.clientId)],
);

/**
 * Routing policy per number, versioned; exactly one active. `policy` is the
 * JSON evaluated on every inbound call (see src/lib/routing/policy.ts).
 */
export const routingPolicies = tb.table(
  "routing_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    numberId: uuid("number_id")
      .notNull()
      .references(() => numbers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    template: text("template").notNull(), // you_first | ai_reception | office_hours | front_desk | custom
    policy: jsonb("policy").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tb_routing_policies_number_idx").on(t.numberId),
    uniqueIndex("tb_routing_policies_one_active").on(t.numberId).where(sql`${t.active}`),
  ],
);

/** Weekly hours + closures per client. Hours live on clients.business_hours (Signal's), closures here. */
export const closures = tb.table(
  "closures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** ISO date, whole day. */
    date: text("date").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tb_closures_client_date_unique").on(t.clientId, t.date)],
);

export const contacts = tb.table(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    e164: text("e164").notNull(),
    name: text("name"),
    tag: contactTag("tag").notNull().default("known"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tb_contacts_client_e164_unique").on(t.clientId, t.e164)],
);

export const calls = tb.table(
  "calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    numberId: uuid("number_id").references(() => numbers.id, { onDelete: "set null" }),
    twilioCallSid: text("twilio_call_sid").notNull(),
    fromE164: text("from_e164").notNull(),
    toE164: text("to_e164").notNull(),
    callerName: text("caller_name"),
    outcome: callOutcome("outcome").notNull().default("in_progress"),
    policyId: uuid("policy_id").references(() => routingPolicies.id, { onDelete: "set null" }),
    /** Every rule evaluated and every leg outcome, in order. The "why did the AI answer" surface. */
    routeTrace: jsonb("route_trace").$type<Array<{ at: string; step: string; data: Record<string, string> }>>().notNull().default([]),
    retellCallId: text("retell_call_id"),
    aiSummary: text("ai_summary"),
    transcriptUrl: text("transcript_url"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
  },
  (t) => [
    index("tb_calls_client_started_idx").on(t.clientId, t.startedAt),
    uniqueIndex("tb_calls_twilio_sid_unique").on(t.twilioCallSid),
  ],
);

export const callLegs = tb.table(
  "call_legs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    twilioCallSid: text("twilio_call_sid"),
    kind: legKind("kind").notNull(),
    target: text("target"),
    status: text("status"), // Twilio CallStatus at completion
    accepted: boolean("accepted").notNull().default(false),
    durationSeconds: integer("duration_seconds"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("tb_call_legs_call_idx").on(t.callId)],
);

export const voicemails = tb.table(
  "voicemails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    recordingSid: text("recording_sid").notNull(),
    recordingUrl: text("recording_url").notNull(),
    durationSeconds: integer("duration_seconds"),
    transcript: text("transcript"),
    summary: text("summary"),
    transcribedAt: timestamp("transcribed_at", { withTimezone: true }),
    listenedAt: timestamp("listened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tb_voicemails_client_idx").on(t.clientId, t.createdAt)],
);
