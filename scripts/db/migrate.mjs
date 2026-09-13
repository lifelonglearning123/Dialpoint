// Apply this app's pending `tb` migrations to the shared Supabase database.
//   node scripts/db/migrate.mjs
// Idempotent: reads drizzle/meta/_journal.json, skips entries already in
// tb.__migrations, applies the rest statement by statement in one transaction.
// Only ever touches objects inside the `tb` schema (see drizzle.config.ts).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));

await sql`create schema if not exists tb`;
await sql`create table if not exists tb.__migrations (id serial primary key, hash text not null, created_at bigint)`;
const done = new Set((await sql`select hash from tb.__migrations`).map((r) => r.hash));

let applied = 0;
for (const entry of journal.entries) {
  const file = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
  const hash = createHash("sha256").update(file).digest("hex");
  if (done.has(hash)) continue;
  const stmts = file
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^CREATE SCHEMA "tb";$/, 'CREATE SCHEMA IF NOT EXISTS "tb";'));
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
    await tx`insert into tb.__migrations (hash, created_at) values (${hash}, ${entry.when})`;
  });
  console.log(`applied ${entry.tag} (${stmts.length} statements)`);
  applied++;
}
const tables = await sql`select table_name from information_schema.tables where table_schema = 'tb' order by 1`;
console.log(applied ? "" : "nothing to apply;", "tb tables:", tables.map((t) => t.table_name).join(", "));
await sql.end();
