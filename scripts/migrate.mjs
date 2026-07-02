// Apply migrate.sql to the database in DATABASE_URL. Usage:
//   DATABASE_URL='postgresql://user:pass@host:5432/mapportal?sslmode=require' npm run migrate
// Idempotent (all DDL is `if not exists`). Also runnable in AWS CloudShell.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { pgConfigFromEnv } from "./pg-config.mjs";

if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  console.error("DATABASE_URL (or PGHOST/PGPASSWORD/…) is not set. Refusing to run.");
  process.exit(1);
}

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrate.sql"),
  "utf8"
);

const client = new pg.Client(pgConfigFromEnv());

try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "select tablename from pg_tables where schemaname = 'public' order by tablename"
  );
  console.log("Migration applied. Tables:", rows.map((r) => r.tablename).join(", "));
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
