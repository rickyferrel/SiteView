// Amplify Hosting exposes console env vars at BUILD time only — the SSR
// compute (Lambda) runtime does not inherit them. Without this step the
// runtime sees no PGHOST/DATABASE_URL, so src/lib/db.ts falls back to the
// PGlite path and OOMs the Lambda loading the WASM engine. Run during the
// Amplify build (before `next build`) to persist the server-side vars into
// .env.production, which the Next server loads at boot.
//
// Values are single-quoted with `$` escaped as `\$`: Next's env loader
// (dotenv-expand) expands `$WORD` inside values — even quoted ones — which
// would corrupt passwords. A value containing a literal single quote is not
// representable this way, so we fail loudly rather than write a broken file.
import { appendFileSync } from "node:fs";

const KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "DATABASE_URL",
  "PGSSL_REJECT_UNAUTHORIZED",
  "PGPOOL_MAX",
  "EMBED_FRAME_ANCESTORS",
];

const lines = [];
for (const key of KEYS) {
  const value = process.env[key];
  if (value == null || value === "") continue;
  if (value.includes("'")) {
    throw new Error(`${key} contains a single quote, which .env.production cannot represent — change the value`);
  }
  lines.push(`${key}='${value.replaceAll("$", "\\$")}'`);
}

if (lines.length > 0) {
  appendFileSync(".env.production", lines.join("\n") + "\n");
}
console.log(`write-env: persisted ${lines.length} var(s) to .env.production: ${lines.map((l) => l.split("=")[0]).join(", ") || "(none)"}`);
