# Multi-site build plan

How to turn the portal from single-development (Summit Creek only) into a true
multi-development operator tool: create new sites, acquire their parcels by
address + selection, and switch between them — without disturbing Summit Creek.

Status: **plan only, not yet built.** Nothing in this doc has been implemented.

---

## 0. Where we start

**Already multi-site (the data layer):**
- Every table keys on `development_id`, so the DB holds many developments side by
  side ([src/lib/schema.ts](src/lib/schema.ts)).
- The API is parameterized by slug: `/api/dev/[slug]/…`; the public map is
  `/embed/[slug]`. Summit Creek is just one slug.
- A second site is purely additive and cannot affect Summit Creek's data.

**Pinned to Summit Creek (the gaps to close):**
1. The portal reads a hardcoded `DEV_SLUG = "summit-creek"`
   ([src/lib/const.ts](src/lib/const.ts)) on every page. The nav "client switcher"
   chip is intentionally inert — a placeholder for this work.
2. No "create a development" flow exists. Summit Creek's record was inserted by
   [src/lib/seed.ts](src/lib/seed.ts).
3. No parcel-acquisition UI. Summit Creek's importer is hardwired to its specific
   Mapbox tileset; new sites need the address → select → import flow below.

---

## 1. Parcel data source (confirmed working)

New sites get parcel geometry from the **same Utah ArcGIS service** the portal
already uses ([src/lib/arcgis.ts](src/lib/arcgis.ts)):

```
https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/Parcels_Utah/FeatureServer/0/query
```

Verified live: **283,472** parcels statewide; **637** inside the Summit Creek
bounding box. The service is queried with a spatial filter (envelope/bbox or a
`PARCEL_ID IN (…)` list) so we only ever pull the parcels in view — never the
whole state. `PARCEL_ID` is the join key across the whole system.

⚠️ **Utah only.** Those 283k parcels are all in-state. A development **inside
Utah** is fully covered by this endpoint. A site **outside Utah** needs a
different county/state ArcGIS service wired in (a per-source adapter) — out of
scope until we actually take on a non-Utah client.

---

## 2. Core routing decision (resolve before building)

The portal needs a notion of "current development." Two options:

- **URL-based (recommended):** move portal pages under a slug segment —
  `/d/[slug]`, `/d/[slug]/lots`, `/d/[slug]/design`, `/d/[slug]/preview`. Slug
  lives in the URL → shareable, bookmarkable; the switcher is just navigation.
- **Cookie-based (lighter):** keep flat routes; the switcher writes an "active
  development" cookie and a `useActiveDev()` hook replaces the constant. Less
  routing churn, but the active site lives in a cookie, not the URL.

**Recommendation: URL-based.** `DEV_SLUG` stays only as the default for the `/`
redirect.

---

## 3. The build, in three pieces

### Piece 1 — Create a development

- **Repo** ([src/lib/repo.ts](src/lib/repo.ts)): add `createDevelopment(input)` —
  inserts the `developments` row (slug, name, Mapbox token/style, initial view,
  `map_appearance` default) and seeds a **default status** so the map always has a
  fallback color. Mirrors the insert pattern in [src/lib/seed.ts](src/lib/seed.ts).
- **API:** new `src/app/api/dev/route.ts` with `GET` (list all developments — the
  switcher needs this) and `POST` (create). Slug uniqueness is already enforced by
  the DB; return 409 on a duplicate.
- **UI:** a "New development" form — name → auto-slug, Mapbox token/style, initial
  camera. After create, redirect into the new site's empty **Add parcels** screen
  (Piece 2).

### Piece 2 — Acquire parcels: address → fly → select → auto-import

The acquisition flow for a new (or existing) site:

1. **Enter an address** → geocode → map flies there.
2. **Parcels light up** at that location (fetched live from the Utah ArcGIS
   service for the current viewport).
3. **Select the parcels** that belong to the development — **both** tools:
   - **Click-to-toggle** a single parcel (click again to deselect).
   - **Drag-box** to grab a cluster at once.
   A running **"N parcels selected"** counter shows progress; pan to another part
   of the site and keep adding. A "Clear selection" control resets.
4. **Confirm → auto-import.** On confirm, the selected parcels are imported
   immediately (no separate review step) into the development with the default
   status.

**Decisions (LOCKED):**
- Selection tools: **both** click-to-toggle and drag-box.
- Address input: **Mapbox Search Box API** with type-ahead suggestions.
- Confirm step: **auto-import on confirm** (no review screen).

**What to build vs. reuse:**

| Step | Build | Reuse |
|---|---|---|
| Address → coordinates | `src/lib/geocode.ts` helper using the Mapbox **Search Box API** (`/search/searchbox/v1/suggest` → `/retrieve`, with a session token) for type-ahead; `map.flyTo(center)` on retrieve. Geocoding v6 `/search/geocode/v6/forward` is the simpler fallback. | The Mapbox token already in the development record |
| Show parcels to pick | A `ParcelPicker` component: fetch parcels for the current viewport, render as a clickable GeoJSON layer | `fetchArcgisByBbox` already does the viewport fetch; [src/components/MapView.tsx](src/components/MapView.tsx) already renders a clickable parcel layer — reuse both patterns |
| Track selection | Selection state = `Set<PARCEL_ID>`; highlight selected vs. unselected; click-toggle; drag-box; counter; clear | — |
| Commit the picks | `importByParcelIds(slug, ids)` in repo (thin wrapper) | `fetchArcgisByParcelIds(ids)` already pulls clean geometry by id; we can even upsert the shapes already rendered in the picker |

**Where it lives:** a standalone **"Add parcels"** screen, not buried inside the
create form — so it's reusable for adding/removing parcels on an *existing* site
later (e.g. a development expands).

### Piece 3 — Switcher + slug-aware portal

- Make the nav chip real: [src/components/PortalNav.tsx](src/components/PortalNav.tsx)
  `ClientSwitcher` → a dropdown fed by `GET /api/dev`, with a "+ New development"
  entry.
- Swap `DEV_SLUG` → slug-from-route in the four portal pages (mechanical):
  [Overview](src/app/(portal)/page.tsx), [Lots](src/app/(portal)/lots/page.tsx),
  [Map Design](src/app/(portal)/design/page.tsx),
  [Preview & Publish](src/app/(portal)/preview/page.tsx).
- Keep `DEV_SLUG` as the default for the `/` redirect.

---

## 4. Guardrails (bake in during the build)

- **Min-zoom gate:** only fetch/enable parcels once zoomed into a neighborhood
  (e.g. zoom ≥ 15), so each ArcGIS request stays in the hundreds — never 283k.
- **Debounced viewport loads** on map idle, with simple bbox/tile caching so
  panning back doesn't re-fetch.
- **PARCEL_ID is the join key** — selection stores IDs, so it dedupes cleanly and
  matches the rest of the system.
- **Empty states:** a new site with no parcels shows "No parcels yet → Add
  parcels"; block Publish when a site is empty.

---

## 5. Suggested order of operations

1. `createDevelopment` repo fn + `GET/POST /api/dev` route. *(backend; cannot
   touch Summit Creek)*
2. Switcher dropdown wired to `GET /api/dev` (read-only first — lists Summit Creek).
3. Slug-aware route refactor (URL-based) + `/` redirect.
4. "New development" form → `POST /api/dev` → redirect to Add parcels.
5. **Add parcels screen:** Mapbox Search Box address bar → fly → `ParcelPicker`
   (click + drag-box select, counter) → confirm → `importByParcelIds` (auto).
6. Polish: empty states, publish-guard-when-empty, "add more parcels later" entry
   on an existing site.

---

## 6. Decisions still open (resolve before/along the way)

- **Routing:** URL-based (`/d/[slug]`) vs cookie-based. *(Recommend URL-based.)*
- **Mapbox token:** reuse the shared agency token per site (each can still have
  its own style URL), or per-site tokens?
- **Auth:** multi-site makes a login gate matter more — who can create/publish
  which sites? Currently the mutation routes are open.
- **Non-Utah sites:** stay within Utah ArcGIS coverage for now, or build a
  pluggable parcel source? *(Only needed when a non-Utah client appears.)*

---

## 7. Effort

- **Backend** (create / list / import-by-ids): small — most plumbing exists.
- **Switcher + slug-aware pages:** small-to-medium, mostly mechanical swaps.
- **New-development form:** small.
- **Add-parcels screen (address search + selection map):** the main piece —
  geocoding type-ahead and the click/drag-box selection layer are the real work.
  Everything it sits on (ArcGIS fetch both directions, the clickable parcel
  layer, the Mapbox token) already exists.
