# Map Portal — AWS Deployment Handoff

Living status doc for the AWS hosting effort. Pairs with [AWS_SETUP_RUNBOOK.md](AWS_SETUP_RUNBOOK.md)
(the click-by-click browser-agent runbook). **Last updated:** 2026-07-01.

---

## 1. What we're doing

Hosting the Map Portal (Next.js 16 SSR app) on AWS so its parcel maps can be embedded — as a
copy-paste `<iframe>` snippet — into **any** website (not just WordPress). One portal, many
developments, each served at `/embed/{slug}`.

### Decisions locked
| Area | Choice | Notes |
|---|---|---|
| Compute | **AWS Amplify Hosting** (Next.js SSR / Web Compute) | App Runner ruled out. |
| Database | **Amazon RDS for PostgreSQL** | `db.t4g.micro`, cost-first. |
| Region | **us-west-2** (Oregon) | |
| Media | **External URLs only** | No S3; `image_url`/`video_url` are text. |
| Embedding | **Publicly frameable, multi-site** | Do **not** lock `frame-ancestors`; operators paste the snippet anywhere. |

---

## 2. AWS resources provisioned

- **RDS:** `map-portal-db` — PostgreSQL 16.14, db.t4g.micro, gp3 20 GiB, single-AZ, public,
  encryption on, 7-day backups.
  - Endpoint: `map-portal-db.chu640iaq0jy.us-west-2.rds.amazonaws.com:5432`
  - DB `mapportal`, user `postgres`
  - Master creds secret: `arn:aws:secretsmanager:us-west-2:819743510456:secret:rds!db-ed6cb342-6be3-4444-9b58-148b3ffd7cb7-pi8taN`
  - TLS enforced: parameter group `map-portal-pg16-ssl` with `rds.force_ssl=1`.
  - Security group `map-portal-db-sg`: inbound 5432 from `0.0.0.0/0` (auth + TLS gated — the
    documented tradeoff for Amplify SSR, which runs outside the VPC).
- **Amplify app:** `SiteView`, App ID `d1fccqopge5j62`, region us-west-2.
  - Default URL: `https://main.d1fccqopge5j62.amplifyapp.com`
  - Connected to GitHub `main`, auto-builds on push.

---

## 3. Repo / code state

**GitHub:** https://github.com/rickyferrel/SiteView (branch `main`)

Commits (newest first):
- `3ac5b35` — Lazy-load PGlite so prod SSR doesn't OOM ← **the fix Amplify must build**
- `7eb4910` — Parse DB password literally (special chars work, no URL-encoding)
- `788d96a` — AWS-deploy-ready: pg/RDS backend, migrate tooling, amplify.yml
- `f81306c` — Initial commit

Key implementation facts:
- [src/lib/db.ts](src/lib/db.ts) is env-aware: uses `pg` when `DATABASE_URL` **or** `PGHOST` is
  set (prod/RDS), else PGlite (local dev). Same `query()`/`queryOne()` surface.
- **Password is parsed literally** — paste it verbatim in env vars, never URL-encode it.
- **PGlite is imported lazily** (only on the local path); the prod `pg` path never loads the WASM
  engine. This was the OOM cause.
- Schema: [migrate.sql](migrate.sql) (plain SQL) + `npm run migrate` ([scripts/migrate.mjs](scripts/migrate.mjs)).
- Build: [amplify.yml](amplify.yml) pins Node 24.
- Embed CSP is optional, driven by `EMBED_FRAME_ANCESTORS` in [next.config.ts](next.config.ts) —
  **leave unset** for multi-site embedding.
- The portal's Preview page has a **"Copy snippet"** button that emits the `<iframe>` for any site.

---

## 4. Status — where we are

- ✅ Phase 0–2: region, RDS, TLS, security group — done.
- ✅ Phase 4: **schema migrated to RDS** (all six tables live), verified by a real app-code
  connection over TLS. **Skip CloudShell.**
- ✅ Phase 5: Amplify app created and deployed; atlas page renders.
- 🔧 Phase 6: `/api/dev` returned 500 → `Runtime.OutOfMemory` (PGlite WASM loading in the Lambda).
  - Lazy-load fix `3ac5b35` deployed (verified live) but `/api/dev` **still 500s** with the same
    slow OOM-shaped timing (~8–9 s), even with the `PG*` console vars set.
  - **Root cause found (2026-07-01):** Amplify console env vars exist only at **build** time —
    the SSR Lambda runtime never sees them. At runtime `PGHOST` is undefined, so `db.ts` takes
    the local-dev branch and *deliberately* lazy-loads PGlite → OOM. The `3ac5b35` fix was
    correct but couldn't matter.
  - **Fix:** [scripts/write-env.mjs](scripts/write-env.mjs) (called from [amplify.yml](amplify.yml)
    before `next build`) persists the server-side vars into `.env.production`, which the Next
    server loads at boot. Values are single-quoted with `$` escaped — Next's env loader
    (dotenv-expand) otherwise expands `$WORD` inside values (verified empirically; the naive
    `env | grep >> .env.production` pattern from AWS docs would corrupt this password).
    Round-trip tested locally against the real `@next/env`. Awaiting commit + push + rebuild.
  - **Do NOT bump SSR compute memory** — at 2 GB the PGlite path could *succeed*, silently
    serving an ephemeral throwaway DB from the Lambda instead of RDS.

---

## 5. Immediate next steps (Claude Chrome)

Console env vars are already set correctly (keep them — the build now copies them into the
runtime). After the `write-env` commit is pushed, Amplify auto-builds `main`. Then:

1. **Watch the new build** (Amplify → the app → `main` branch). In the build log, confirm the
   line `write-env: persisted N var(s) to .env.production: PGHOST, ...` appears before
   `npm run build`.
2. **Re-test** `https://main.d1fccqopge5j62.amplifyapp.com/api/dev` → expect **HTTP 200 `[]`**,
   fast (<1 s warm). If a REPORT log is handy, `Max Memory Used` should now be far under 1024 MB.
3. If it *still* 500s, capture the actual Lambda error log line — it is now a real DB/network
   error (auth, security group, TLS), **not** memory. Do not bump SSR compute memory (see §4).

## 6. After the app is green

- Create the **Summit Creek** development from the atlas UI (**/** → New) — the Mapbox token
  prefills from `NEXT_PUBLIC_MAPBOX_TOKEN`. Then import parcels. `/embed/summit-creek` then renders.
- Use the Preview page's **Copy snippet** to embed on any site.

## 7. Phase 7 — custom domain (needs owner input)

- Need: desired subdomain (e.g. `map.example.com`) and DNS location (Route 53 or external).
- Amplify → Hosting → Custom domains → Add domain; approve Route 53 records or hand external DNS
  records to the owner. ACM cert auto-issues.

---

## 8. Open items for the owner

- **Subdomain + DNS host** for Phase 7.
- **`EMBED_FRAME_ANCESTORS`** intentionally left unset (multi-site embedding). Set it later only if
  you want to restrict which domains may embed (space-separated allowlist).
- Consider scoping/URL-restricting the public `pk.` Mapbox token in the Mapbox account.

## 9. Reference — env vars the app reads

| Var | Purpose | Where |
|---|---|---|
| `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`/`PGPASSWORD` | RDS connection (preferred) | Amplify |
| `DATABASE_URL` | Alt single-string RDS connection (password verbatim, no encoding) | Amplify (or local `.env.local`) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Public Mapbox `pk.` token (required for map render) | Amplify + local `.env.local` |
| `EMBED_FRAME_ANCESTORS` | Optional iframe origin allowlist; unset = frameable anywhere | Amplify (optional) |
| `PGSSL_REJECT_UNAUTHORIZED` | `1` to verify the RDS cert chain (needs CA); default off | optional |
| `PGPOOL_MAX` | pg pool size (default 2, sized for Lambda SSR) | optional |
| `PGLITE_DIR` | Local PGlite data dir (must be outside project tree) | local only |
