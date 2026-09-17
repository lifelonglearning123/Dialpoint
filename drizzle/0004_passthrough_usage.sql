CREATE TYPE "tb"."usage_mode" AS ENUM('flat', 'passthrough');--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "usage_mode" "tb"."usage_mode" DEFAULT 'flat' NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_cost_meter_id" text;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_cost_price_id" text;--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" ADD COLUMN "cost_item_id" text;--> statement-breakpoint
ALTER TABLE "tb"."usage_ledger" ADD COLUMN "cost_hundredths" integer;--> statement-breakpoint
ALTER TABLE "tb"."usage_ledger" ADD COLUMN "price_unit" text;--> statement-breakpoint
ALTER TABLE "tb"."usage_ledger" ADD COLUMN "priced_at" timestamp with time zone;
