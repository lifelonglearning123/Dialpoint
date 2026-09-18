CREATE TABLE "tb"."call_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"recording_sid" text NOT NULL,
	"recording_url" text NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tb"."call_recordings" ADD CONSTRAINT "call_recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "tb"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."call_recordings" ADD CONSTRAINT "call_recordings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tb_call_recordings_call_idx" ON "tb"."call_recordings" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tb_call_recordings_sid_unique" ON "tb"."call_recordings" USING btree ("recording_sid");
