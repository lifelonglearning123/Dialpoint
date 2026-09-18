/**
 * Signal's tables that this app READS (and, for clients/memberships, inserts
 * rows into with the same shape Signal uses). They live in the `public`
 * schema and are owned by Signal's Drizzle migrations: this file mirrors only
 * the columns this app touches and is excluded from drizzle-kit
 * (drizzle.config.ts filters to the `tb` schema), so nothing here can ever
 * generate a migration against Signal's tables.
 *
 * Column sources: C:\python\Signal\voice-retell-elevenlabs\src\db\schema.ts
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
});

export const userRole = pgEnum("user_role", [
  "super_admin",
  "agency_staff",
  "client_admin",
  "client_user",
]);
export type Role = (typeof userRole.enumValues)[number];

export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "past_due",
  "cancelled",
  "unpaid",
  "trialing",
  "unknown",
]);

export const agencies = pgTable(
  "agencies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    subscriptionStatus: subscriptionStatus("subscription_status").notNull().default("active"),
    stripeAccountId: text("stripe_account_id"),
    stripeChargesEnabled: boolean("stripe_charges_enabled").notNull().default(false),
    platformFeeBps: integer("platform_fee_bps").notNull().default(0),
    useDirectCharges: boolean("use_direct_charges").notNull().default(false),
    /** Signal's own workspace host (signal.<domain>). This app's hosts live in tb.agency_domains. */
    customDomain: text("custom_domain"),
    customDomainVerified: boolean("custom_domain_verified").notNull().default(false),
    businessWebsite: text("business_website"),
    brandLogoUrl: text("brand_logo_url"),
    brandFaviconUrl: text("brand_favicon_url"),
    brandPrimaryColor: text("brand_primary_color"),
    locale: text("locale").notNull().default("en-GB"),
    ownerEmail: text("owner_email"),
    fromEmail: text("from_email"),
    fromName: text("from_name"),
    clientCurrency: text("client_currency").notNull().default("GBP"),
    ghlApiKeyEnc: text("ghl_api_key_enc"),
    ghlLocationId: text("ghl_location_id"),
    ghlFromEmail: text("ghl_from_email"),
    /** The agency's own Retell workspace, when it has one; its AI agents live there. */
    retellApiKeyEnc: text("retell_api_key_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agencies_slug_unique").on(t.slug)],
);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Europe/London"),
    businessHours: jsonb("business_hours")
      .$type<Record<string, { start: string; end: string }>>()
      .notNull()
      .default({}),
    active: boolean("active").notNull().default(true),
    billingEmail: text("billing_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clients_agency_id_idx").on(t.agencyId)],
);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    fullName: text("full_name"),
    phone: text("phone"),
    role: userRole("role").notNull().default("client_user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("profiles_user_agency_unique").on(t.userId, t.agencyId)],
);

export const clientMemberships = pgTable(
  "client_memberships",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("client_memberships_profile_client_unique").on(t.profileId, t.clientId)],
);

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: userRole("role").notNull(),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
  invitedBy: uuid("invited_by").references(() => profiles.id, { onDelete: "set null" }),
  token: text("token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
});

/**
 * AI agents built in Signal, one row per agent per client. Read only: the
 * routing editor offers a client's active Retell agents. `platform` is a
 * Signal enum (retell | elevenlabs | ghl), mirrored as text.
 */
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  platformAgentId: text("platform_agent_id").notNull(),
  name: text("name").notNull(),
  phoneNumber: text("phone_number"),
  active: boolean("active").notNull().default(true),
});
