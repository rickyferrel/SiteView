import "server-only";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA_SQL } from "./schema";
import { seed } from "./seed";

// File-backed PGlite (Postgres in WASM) for local dev — no external services.
// In production, swap this module for a Supabase/Postgres client exposing the
// same `query` signature; the SQL is identical.
//
// IMPORTANT: keep the data dir OUTSIDE the project tree. PGlite writes many
// files and the Next/Turbopack dev file-watcher chokes if it watches them.
const DATA_DIR = process.env.PGLITE_DIR ?? join(tmpdir(), "map-portal-pgdata");

type GlobalWithDb = typeof globalThis & {
  __mapPortalDb?: Promise<PGlite>;
};
const g = globalThis as GlobalWithDb;

async function init(): Promise<PGlite> {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new PGlite({ dataDir: DATA_DIR });
  await db.waitReady;
  await db.exec(SCHEMA_SQL);
  await seed(db);
  return db;
}

// Memoize across HMR reloads so we don't reopen the data dir repeatedly.
// On failure, clear the cache so the next request retries instead of reusing
// a rejected promise.
export function getDb(): Promise<PGlite> {
  if (!g.__mapPortalDb) {
    g.__mapPortalDb = init().catch((e) => {
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
