-- One row per leg: merge "accepted" into the row that survives, drop the duplicates left by concurrent status callbacks, then enforce it.
UPDATE "tb"."call_legs" l SET "accepted" = true WHERE NOT l."accepted" AND EXISTS (SELECT 1 FROM "tb"."call_legs" o WHERE o."call_id" = l."call_id" AND o."twilio_call_sid" = l."twilio_call_sid" AND o."accepted");--> statement-breakpoint
DELETE FROM "tb"."call_legs" WHERE "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "call_id", "twilio_call_sid" ORDER BY ("ended_at" IS NULL), "started_at", "id") AS rn FROM "tb"."call_legs" WHERE "twilio_call_sid" IS NOT NULL) d WHERE d.rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "tb_call_legs_call_sid_unique" ON "tb"."call_legs" USING btree ("call_id","twilio_call_sid");
