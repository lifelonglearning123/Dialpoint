CREATE SCHEMA "tb";
--> statement-breakpoint
CREATE TYPE "tb"."bundle_status" AS ENUM('draft', 'pending-review', 'in-review', 'twilio-rejected', 'twilio-approved', 'provisionally-approved');--> statement-breakpoint
CREATE TYPE "tb"."call_outcome" AS ENUM('human', 'ai', 'voicemail', 'missed', 'blocked', 'in_progress');--> statement-breakpoint
CREATE TYPE "tb"."contact_tag" AS ENUM('vip', 'blocked', 'known');--> statement-breakpoint
CREATE TYPE "tb"."leg_kind" AS ENUM('human_pstn', 'human_client', 'ai', 'voicemail', 'ivr');--> statement-breakpoint
CREATE TYPE "tb"."number_status" AS ENUM('reserved', 'verifying', 'active', 'suspended', 'released');--> statement-breakpoint
CREATE TYPE "tb"."number_type" AS ENUM('local', 'national', 'tollfree', 'mobile');--> statement-breakpoint
CREATE TYPE "tb"."target_kind" AS ENUM('pstn', 'client');--> statement-breakpoint
CREATE TABLE "tb"."agency_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"host" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."call_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"twilio_call_sid" text,
	"kind" "tb"."leg_kind" NOT NULL,
	"target" text,
	"status" text,
	"accepted" boolean DEFAULT false NOT NULL,
	"duration_seconds" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tb"."calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"number_id" uuid,
	"twilio_call_sid" text NOT NULL,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"caller_name" text,
	"outcome" "tb"."call_outcome" DEFAULT 'in_progress' NOT NULL,
	"policy_id" uuid,
	"route_trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retell_call_id" text,
	"ai_summary" text,
	"transcript_url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "tb"."closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"date" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"name" text,
	"tag" "tb"."contact_tag" DEFAULT 'known' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."human_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "tb"."target_kind" NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"profile_id" uuid,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"type" "tb"."number_type" NOT NULL,
	"locality" text,
	"status" "tb"."number_status" DEFAULT 'reserved' NOT NULL,
	"twilio_sid" text,
	"bundle_id" uuid,
	"address_sid" text,
	"label" text,
	"activated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."regulatory_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"iso_country" text DEFAULT 'GB' NOT NULL,
	"number_type" "tb"."number_type" NOT NULL,
	"end_user_type" text DEFAULT 'business' NOT NULL,
	"bundle_sid" text NOT NULL,
	"regulation_sid" text NOT NULL,
	"end_user_sid" text NOT NULL,
	"address_sid" text,
	"document_sids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "tb"."bundle_status" DEFAULT 'draft' NOT NULL,
	"submitted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."routing_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"template" text NOT NULL,
	"policy" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."twilio_accounts" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"subaccount_sid" text NOT NULL,
	"auth_token_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"twiml_app_sid" text,
	"api_key_sid" text,
	"api_key_secret_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."voicemails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"recording_sid" text NOT NULL,
	"recording_url" text NOT NULL,
	"duration_seconds" integer,
	"transcript" text,
	"summary" text,
	"transcribed_at" timestamp with time zone,
	"listened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tb"."agency_domains" ADD CONSTRAINT "agency_domains_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."call_legs" ADD CONSTRAINT "call_legs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "tb"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."calls" ADD CONSTRAINT "calls_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."calls" ADD CONSTRAINT "calls_number_id_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "tb"."numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."calls" ADD CONSTRAINT "calls_policy_id_routing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "tb"."routing_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."closures" ADD CONSTRAINT "closures_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."human_targets" ADD CONSTRAINT "human_targets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."human_targets" ADD CONSTRAINT "human_targets_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."numbers" ADD CONSTRAINT "numbers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."numbers" ADD CONSTRAINT "numbers_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."numbers" ADD CONSTRAINT "numbers_bundle_id_regulatory_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "tb"."regulatory_bundles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."regulatory_bundles" ADD CONSTRAINT "regulatory_bundles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."routing_policies" ADD CONSTRAINT "routing_policies_number_id_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "tb"."numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."routing_policies" ADD CONSTRAINT "routing_policies_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."twilio_accounts" ADD CONSTRAINT "twilio_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."voicemails" ADD CONSTRAINT "voicemails_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "tb"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."voicemails" ADD CONSTRAINT "voicemails_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tb_agency_domains_host_unique" ON "tb"."agency_domains" USING btree ("host");--> statement-breakpoint
CREATE INDEX "tb_call_legs_call_idx" ON "tb"."call_legs" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "tb_calls_client_started_idx" ON "tb"."calls" USING btree ("client_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_calls_twilio_sid_unique" ON "tb"."calls" USING btree ("twilio_call_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_closures_client_date_unique" ON "tb"."closures" USING btree ("client_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_contacts_client_e164_unique" ON "tb"."contacts" USING btree ("client_id","e164");--> statement-breakpoint
CREATE INDEX "tb_human_targets_client_idx" ON "tb"."human_targets" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tb_numbers_client_idx" ON "tb"."numbers" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_numbers_e164_live_unique" ON "tb"."numbers" USING btree ("e164") WHERE "tb"."numbers"."status" <> 'released';--> statement-breakpoint
CREATE INDEX "tb_regulatory_bundles_client_idx" ON "tb"."regulatory_bundles" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_regulatory_bundles_sid_unique" ON "tb"."regulatory_bundles" USING btree ("bundle_sid");--> statement-breakpoint
CREATE INDEX "tb_routing_policies_number_idx" ON "tb"."routing_policies" USING btree ("number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_routing_policies_one_active" ON "tb"."routing_policies" USING btree ("number_id") WHERE "tb"."routing_policies"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "tb_twilio_accounts_sid_unique" ON "tb"."twilio_accounts" USING btree ("subaccount_sid");--> statement-breakpoint
CREATE INDEX "tb_voicemails_client_idx" ON "tb"."voicemails" USING btree ("client_id","created_at");