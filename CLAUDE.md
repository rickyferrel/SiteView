@AGENTS.md

# Map Portal

Portal that is the **single source of truth** for 3D Mapbox parcel maps. The user edits
lots/statuses/colors/fields here, previews, and publishes; the public 3D map embedded in
any customer site (as one `<iframe>` — WordPress or anywhere) updates. Built as a working
vertical slice for the **Summit Creek** development, hosted on AWS (Amplify + RDS — see the
Production section below). Full design in [PLAN.md](PLAN.md); run/setup in [README.md](README.md).

## Architecture (the one mental model)

```
ArcGIS LIR (geom, value) ─┐
                          ├─ joined by PARCEL_ID ─► Portal DB ─► /embed/{slug}
Mapbox tileset (existing  ┘   (status/price/...      (draft +      reads draft|published:
 statuses, migrated once)      custom fields)         published)   GeoJSON + status config
```

- **Geometry + county assessor attributes** (acreage, market value, subdivision, class) come from
  the ArcGIS **LIR** parcel layer; **status / media / custom fields** — and the operator's final
  **price** — live in the DB. Import seeds `parcel_acres` and an editable `list_price` (the
  assessor's market value) so a picked lot shows data immediately. Everything joins on `PARCEL_ID`.
- The embed builds its `fill-color` from the **statuses** config, so colors/statuses/lots are
  all portal-controlled. Geometry is served as **GeoJSON** (no PostGIS; the spatial query is
  ArcGIS's job).
- **Draft vs published:** edits are draft; the in-portal preview reads draft; WordPress reads
  the latest **published** snapshot. Publish = snapshot draft → `publications`.
- **Opening view:** the embed opens at the development's `default_view` (center/zoom/pitch/
  bearing). When `view_locked` is true (operator hand-framed it) the embed uses that view
  exactly; otherwise it auto-fits the lot cluster (`lotClusterBounds` in `MapView.tsx`).
  Import auto-frames `default_view` only while unlocked, so a saved view is never clobbered.

## Running / dev gotchas (important)

- `npm run dev` is intentionally `next dev --webpack`. **Do not switch dev to Turbopack** —
  Next 16 + Node 24 Turbopack dev leaks async-hooks and crashes (`Map maximum size exceeded`).
  Turbopack **build** is fine. `npm run build && npm run start` is also stable.
- **PGlite data dir must stay OUTSIDE the project tree** (defaults to OS temp via `PGLITE_DIR`).
  Inside the tree, the dev file-watcher floods and crashes the same way.
- No local Postgres/Docker here: `src/lib/db.ts` is **env-aware** behind one `query(text, params)`
  surface — real Postgres via `pg` when `DATABASE_URL` **or** `PGHOST` is set (prod/RDS), else
  file-backed **PGlite** (Postgres-in-WASM) for local dev. **PGlite must stay lazily imported**
  (never statically): a static import loads the WASM engine into the prod Lambda and OOMs it.
- **Schema changes need a dev-server restart** — `SCHEMA_SQL` runs once at DB init, not on
  hot-reload — **and a mirror edit in `migrate.sql`**, which duplicates `schema.ts` by hand for
  prod (`npm run migrate` applies it to RDS). Editing one without the other silently forks
  dev vs prod schemas.

## Production (AWS)

- **Hosting:** AWS Amplify app `SiteView` (`d1fccqopge5j62`, us-west-2) serving Next SSR from
  GitHub `main` at `https://main.d1fccqopge5j62.amplifyapp.com`; DB is RDS Postgres
  `map-portal-db` (TLS forced). Endpoints/creds/status live in [HANDOFF.md](HANDOFF.md);
  click-by-click console steps in [AWS_SETUP_RUNBOOK.md](AWS_SETUP_RUNBOOK.md).
- **Pushing to `main` deploys production** (Amplify auto-builds every push). Don't push
  unverified work to `main`.
- **Amplify env vars exist only at build time** — the SSR Lambda runtime never sees console
  env vars. `scripts/write-env.mjs` (called from [amplify.yml](amplify.yml) before `next build`)
  persists the `PG*`/server vars into `.env.production`, which the Next server loads at boot.
  Without it, runtime `PGHOST` is undefined and db.ts silently falls back to PGlite → OOM.
- **Env values are single-quoted with `$` escaped** in that file because Next's env loader
  (dotenv-expand) expands `$WORD` inside values *even when quoted* — the stock AWS
  `env | grep >> .env.production` pattern corrupts passwords. DB password is pasted verbatim
  (never URL-encoded); it must not contain a single quote.
- **Known gap: no auth.** Portal pages and all write APIs (`POST/PATCH/DELETE`) are publicly
  reachable on the Amplify URL. Treat as pending work, not a design choice.

## Code map

| Area | Files |
|---|---|
| DB + schema + seed | `src/lib/db.ts`, `src/lib/schema.ts`, `src/lib/seed.ts` |
| Data acquisition | `src/lib/arcgis.ts` (ArcGIS **LIR** parcels + `parcelInfo()` assessor attrs; Mapbox tilequery enrichment) |
| Repo (reads/writes, import, publish) | `src/lib/repo.ts` (`createDevelopment`/`updateDevelopment`/`deleteDevelopment` for the CRUD flow) |
| API routes | `src/app/api/dev` (GET list, POST create), `src/app/api/dev/[slug]` (GET row, PATCH rename/re-point, DELETE cascade), `src/app/api/dev/[slug]/{config,parcels,import,publish,statuses,fields,filters,appearance,view}`, `src/app/api/{parcel,status,field,filter}/[id]` |
| Embed map | `src/app/embed/[slug]/page.tsx`, `src/components/MapView.tsx`, `src/app/embed/embed.css` |
| Portal UI | `src/app/(portal)/{page,new}` (root `page` is the **atlas** — the multi-site index of every development) + `src/app/(portal)/d/[slug]/{page,lots,design,preview,parcels,opening-view}` + `src/components/PortalNav.tsx` |
| Developments CRUD | atlas index `src/app/(portal)/page.tsx`, edit/delete in `src/components/DevSettingsModals.tsx` on the shared `src/components/Modal.tsx` shell (Escape/backdrop close, focus trap) |
| Parcel picker | `src/components/ParcelPicker.tsx` (add-a-development flow: pick parcels off satellite, hover card shows acres/value from LIR → `POST .../import`) |
| Opening view | `src/components/OpeningViewEditor.tsx` (hand-frame the embed's opening camera → `PATCH/DELETE .../view`); a step in the add-flow (`d/[slug]/opening-view`) and a section in Map Design |
| Types / shared | `src/lib/types.ts`, `src/lib/const.ts` (DEV_SLUG), `src/lib/client.ts`, `src/lib/http.ts` |
| Deploy / infra | `amplify.yml` (build; runs `scripts/write-env.mjs`), `migrate.sql` + `scripts/migrate.mjs` (RDS schema), `HANDOFF.md` (live deploy status), `AWS_SETUP_RUNBOOK.md` |

## Conventions

- DB modules use `import "server-only"`; route handlers set `export const runtime = "nodejs"`.
- Write `jsonb` params with `JSON.stringify(x)` and a `$n::jsonb` cast; read them via the
  `asObj()` guard in `repo.ts` (PGlite returns jsonb parsed, prod may differ).
- Parcel edits go through `updateParcel` (whitelisted columns + `properties` jsonb for custom
  fields). Geometry is GeoJSON in a `jsonb` column.
- Multi-dev is live: create/edit/delete developments from the atlas (`/`); `DEV_SLUG` (`src/lib/const.ts`)
  is only the seeded default (`summit-creek`), not a hard pin. Changing a dev's slug moves its public
  `/embed/{slug}` URL — the edit modal gates slug edits behind a warning; delete cascades all child rows.
- `@types/geojson` is referenced via `src/geojson.d.ts` so the global `GeoJSON.*` namespace resolves.

## Verifying changes

- Endpoints: `curl` `/api/dev/summit-creek/{config,parcels}?state=draft|published`; `POST .../import`
  migrates real data (hits network), `POST .../publish` snapshots.
- Visual: Playwright (installed) can screenshot `/embed/summit-creek` — launch chromium with
  `--use-angle=swiftshader` for WebGL, wait for `.mapboxgl-canvas` + ~9s for tiles/terrain.
- Prod smoke check: `curl https://main.d1fccqopge5j62.amplifyapp.com/api/dev` → fast `200`
  JSON array. A slow (~8s) empty-body 500 means the Lambda OOMed loading PGlite — i.e. the
  runtime didn't get the `PG*` env vars (see Production section).

## External references

GitHub repo `rickyferrel/SiteView`. Mapbox account `tbelliston45`; style `cmmv7xrgt002g01s6ef6l96o1`; lot tileset
`tbelliston45.tw32i6178auc` (source-layer `0ad4a14650082dcc6f0e`). ArcGIS: `Parcels_<County>_LIR`
FeatureServer/0 services on `services1.arcgis.com/99lidPhWCzftIe9K` (UGRC/gis.utah.gov). LIR = the
county assessor's "Land Information Records" parcels: same geometry + `PARCEL_ID` as the plain
`Parcels_Utah` layer, but carries `PARCEL_ACRES`, `TOTAL_MKT_VALUE`/`LAND_MKT_VALUE`,
`SUBDIV_NAME`, `PROP_CLASS`, `BUILT_YR`, `BLDG_SQFT` — so a picked parcel shows acres + value.
LIR is published per-county (29 services, identical schema) and omits `OWNERNAME`; `arcgis.ts`
resolves the county from the viewport via `Utah_County_Boundaries` (`countyForBbox`), the picker
stamps each parcel's `county`, and import queries that county's layer (default: Utah County).
`PARCEL_ID` is only unique within a county.
