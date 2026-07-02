@AGENTS.md

# Map Portal

Portal that is the **single source of truth** for 3D Mapbox parcel maps. The user edits
lots/statuses/colors/fields here, previews, and publishes; the public 3D map embedded in
their WordPress site (as one `<iframe>`) updates. Built as a working vertical slice for the
**Summit Creek** development. Full design in [PLAN.md](PLAN.md); run/setup in [README.md](README.md).

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
- No local Postgres/Docker here: local dev uses **PGlite** (Postgres-in-WASM). For production,
  swap `src/lib/db.ts` for a Supabase/`postgres` client with the same `query(text, params)`
  signature — the SQL in `src/lib/schema.ts` is unchanged.
- **Schema changes need a dev-server restart.** `SCHEMA_SQL` runs once at DB init, not on
  hot-reload — after editing `schema.ts` (e.g. a new `alter table … add column if not exists`),
  restart `npm run dev` or existing data dirs won't migrate (queries 500 on the missing column).

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

## External references

Mapbox account `tbelliston45`; style `cmmv7xrgt002g01s6ef6l96o1`; lot tileset
`tbelliston45.tw32i6178auc` (source-layer `0ad4a14650082dcc6f0e`). ArcGIS: `Parcels_Utah_LIR`
FeatureServer/0 on `services1.arcgis.com/99lidPhWCzftIe9K` (UGRC/gis.utah.gov). LIR = the
county assessor's "Land Information Records" parcels: same geometry + `PARCEL_ID` as the plain
`Parcels_Utah` layer, but carries `PARCEL_ACRES`, `TOTAL_MKT_VALUE`/`LAND_MKT_VALUE`,
`SUBDIV_NAME`, `PROP_CLASS`, `BUILT_YR`, `BLDG_SQFT` — so a picked parcel shows acres + value.
It's per-county (this is Utah County) and omits `OWNERNAME`; other counties = `Parcels_<County>_LIR`.
