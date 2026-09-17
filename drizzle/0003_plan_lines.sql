ALTER TABLE "tb"."plans" DROP COLUMN "number_monthly_pence";--> statement-breakpoint
ALTER TABLE "tb"."plans" DROP COLUMN "stripe_product_id";--> statement-breakpoint
ALTER TABLE "tb"."plans" DROP COLUMN "stripe_number_price_id";--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "carrier_monthly_pence" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "hosting_monthly_pence" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "surcharge_bps" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_product_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_carrier_price_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_hosting_price_id" text;--> statement-breakpoint
ALTER TABLE "tb"."plans" ADD COLUMN "stripe_surcharge_tax_rate_id" text;--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" DROP COLUMN "licensed_item_id";--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" ADD COLUMN "hosting_item_id" text;--> statement-breakpoint
ALTER TABLE "tb"."subscriptions" ADD COLUMN "carrier_item_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;
