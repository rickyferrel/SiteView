import "server-only";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA_SQL } from "./schema";
import { seed } from "./seed";

// Two backends behind one `query(text, params)` interface:
//
//   • Production: a real Postgres (AWS RDS) via `pg`, selected when DATABASE_URL
//     is set. The schema/seed are applied out-of-band (see scripts/migrate.mjs
//     and migrate.sql / the AWS runbook), so this path never runs DDL on a cold
//     start — it just connects and queries.
//   • Local dev: file-backed PGlite (Postgres in WASM), no external services.
//     This path runs SCHEMA_SQL + seed() on first init.
//
// IMPORTANT (PGlite only): keep the data dir OUTSIDE the project tree. PGlite
// writes many files and the Next/webpack dev file-watcher chokes if it watches
// them.
const DATA_DIR = process.env.PGLITE_DIR ?? join(tmpdir(), "map-portal-pgdata");

// Shared query surface both backends implement.
type Db = {
  query<T>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
};

type GlobalWithDb = typeof globalThis & {
  __mapPortalDb?: Promise<Db>;
};
const g = globalThis as GlobalWithDb;

const usePostgres = !!(process.env.DATABASE_URL || process.env.PGHOST);

// Build a pg config that tolerates passwords with URL-reserved characters
// (@ : / ? # % …), which would otherwise break connectionString parsing. We
// split DATABASE_URL manually and pass the password as a literal field.
function pgConfig() {
  // RDS requires TLS (rds.force_ssl=1). We don't ship the RDS CA bundle, so we
  // encrypt without verifying the chain — acceptable for a locked-down single
  // tenant. Set PGSSL_REJECT_UNAUTHORIZED=1 (and provide a CA) to harden.
  const ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED === "1" };
  // Amplify SSR is Lambda-backed: keep the pool tiny so many warm containers
  // don't exhaust the micro instance's connection limit.
  const max = Number(process.env.PGPOOL_MAX ?? 2);
  const url = process.env.DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
  if (!url) return { ssl, max, idleTimeoutMillis: 30_000 }; // fall back to PG* env vars
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@]+):(.*)@([^:/?]+)(?::(\d+))?\/([^?]+)/i);
  if (!m) throw new Error("DATABASE_URL is not in postgres://user:password@host:port/database form");
  const [, user, password, host, port, database] = m;
  return { user, password, host, port: port ? Number(port) : 5432, database, ssl, max, idleTimeoutMillis: 30_000 };
}

async function initPostgres(): Promise<Db> {
  // Import lazily so the pg native/optional deps never enter the PGlite path.
  const { Pool } = await import("pg");
  const pool = new Pool(pgConfig());
  return {
    query: <T>(text: string, params: unknown[]) =>
      pool.query(text, params) as unknown as Promise<{ rows: T[] }>,
  };
}

async function initPglite(): Promise<Db> {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;
  await db.exec(SCHEMA_SQL);
  await seed(db);
  return { query: (text, params) => db.query(text, params) };
}

// Memoize across HMR reloads / warm Lambda invocations so we don't reopen the
// connection repeatedly. On failure, clear the cache so the next request retries
// instead of reusing a rejected promise.
function getDb(): Promise<Db> {
  if (!g.__mapPortalDb) {
    g.__mapPortalDb = (usePostgres ? initPostgres() : initPglite()).catch((e) => {
      g.__mapPortalDb = undefined;
      throw e;
    });
  }
  return g.__mapPortalDb;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
