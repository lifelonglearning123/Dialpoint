CREATE TYPE "tb"."subscription_state" AS ENUM('incomplete', 'active', 'past_due', 'unpaid', 'cancelled');--> statement-breakpoint
CREATE TYPE "tb"."usage_meter" AS ENUM('forward', 'inbound', 'softphone', 'freephone_inbound', 'voicemail_transcribe');--> statement-breakpoint
CREATE TABLE "tb"."plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"number_monthly_pence" integer NOT NULL,
	"included_minutes" integer DEFAULT 0 NOT NULL,
	"per_minute_pence" integer NOT NULL,
	"freephone_inbound_pence" integer DEFAULT 12 NOT NULL,
	"voicemail_transcribe_pence" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"stripe_product_id" text,
	"stripe_number_price_id" text,
	"stripe_usage_price_id" text,
	"stripe_freephone_price_id" text,
	"stripe_usage_meter_id" text,
	"stripe_freephone_meter_id" text,
	"stripe_voicemail_price_id" text,
	"stripe_voicemail_meter_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."subscriptions" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"stripe_account_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_checkout_session_id" text,
	"licensed_item_id" text,
	"usage_item_id" text,
	"freephone_item_id" text,
	"voicemail_item_id" text,
	"state" "tb"."subscription_state" DEFAULT 'incomplete' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tb"."usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"call_id" uuid,
	"source_sid" text NOT NULL,
	"meter" "tb"."usage_meter" NOT NULL,
	"quantity" integer NOT NULL,
	"seconds" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_meter_event_id" text,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD CONSTRAINT "plans_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" ADD CONSTRAINT "subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "tb"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."usage_ledger" ADD CONSTRAINT "usage_ledger_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."usage_ledger" ADD CONSTRAINT "usage_ledger_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "tb"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tb_plans_agency_idx" ON "tb"."plans" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_subscriptions_stripe_sub_unique" ON "tb"."subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_usage_ledger_source_meter_unique" ON "tb"."usage_ledger" USING btree ("source_sid","meter");--> statement-breakpoint
CREATE INDEX "tb_usage_ledger_client_occurred_idx" ON "tb"."usage_ledger" USING btree ("client_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tb_usage_ledger_unpushed_idx" ON "tb"."usage_ledger" USING btree ("pushed_at");