ALTER TABLE "tb"."calls" ADD COLUMN "signal_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tb"."calls" ADD COLUMN "signal_report_error" text;
