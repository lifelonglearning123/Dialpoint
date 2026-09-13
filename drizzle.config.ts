import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env.local" });

// Only the `tb` schema is managed here. Signal's public tables (src/db/shared.ts)
// are mirrored for typing and must never be touched by this app's migrations.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://placeholder@localhost:5432/placeholder" },
  schemaFilter: ["tb"],
  migrations: { schema: "tb", table: "__migrations" },
  strict: true,
  verbose: true,
});
