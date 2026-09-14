CREATE TABLE "tb"."business_profiles" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"end_user_type" text DEFAULT 'business' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"address" jsonb,
	"contact_email" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tb"."business_profiles" ADD CONSTRAINT "business_profiles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tb"."business_profiles" ADD CONSTRAINT "business_profiles_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;