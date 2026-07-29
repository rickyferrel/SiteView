# Map Portal — Map Layers (image overlays + drawn shapes) Handoff

**Status: both passes are built and verified end to end. Pass 1 (image overlays) and Pass 2
(drawing — area / line / freehand) are complete.** The §9 checkpoint was cleared by Ricky, who
asked for the drawing work directly rather than reviewing the alignment UX first.

**Still not live in production:** `npm run migrate` has not been run against RDS, so `layers` and
`layer_assets` don't exist there. Reads degrade to "no layers" rather than 500ing (see `getLayers`
in repo.ts), so the portal works — layers just stay dormant until that migration runs.

**Written:** 2026-07-27. Pairs with [CLAUDE.md](CLAUDE.md) (architecture) and
[HANDOFF.md](HANDOFF.md) (AWS deploy status).

## What shipped in Pass 1

Everything in §3–§8 for `kind: "image"`, plus the `kind: "shape"` **data model, API validation and
renderer** (a shape layer posted to the API stores, publishes and draws correctly today) — only the
drawing *UI* is missing.

Verified against a running server, not by inspection:

- 18 API assertions — create, byte-identical `bytea` round-trip through PGlite, draft config,
  PATCH, malformed-corner and bad-MIME rejection, publish, published snapshot carries `asset_id`
  and **no** base64, reorder, and delete-leaves-the-asset.
- 18 pure-geometry assertions on `src/lib/layers.ts` (corner winding, opposite-corner pinning,
  aspect lock, rotation, validation).
- 15 real-DOM drag assertions in Playwright, each starting from a clean rectangle and measured in
  mercator: move / scale / aspect-lock / unlock / rotate / fine-tune all persist to the DB.
- Screenshots of the embed under-lots, over-lots (lot numbers stay legible), the visitor Layers
  menu on and off, published, and both editor modes.

### Three things that bit during the build (all fixed — don't reintroduce)

1. **`bytea` really does diverge between drivers.** §10 called this the most likely dev/prod split
   and it was right. Bytes now cross as **hex text** (`decode`/`encode`), which is identical on
   both. Don't "simplify" this back to a binary param.
2. **Pointer capture on a 14px SVG grip doesn't work.** The pointer leaves the grip instantly and
   the drag silently does nothing — scale, rotate and fine-tune all appeared dead. Drags listen on
   `window` now.
3. **Floating chrome ate the grips.** The bottom command bar (`z-30`, full width) swallowed the
   presses for any corner near the bottom of the editor. Chrome is now `pointer-events-none` except
   on its actual controls, grips render at `z-40` above it, and framing uses asymmetric padding.

### Deferred, knowingly

- Alpha detection samples a 256px thumbnail rather than the full image (a 4096² `getImageData`
  allocates ~67 MB, which is a real risk on a phone). It can miss sub-pixel edge alpha — invisible
  on a map overlay either way.
- A corner grip can still land under the command bar's glass panel itself; the operator pans or
  hits "Zoom to layer". Not worth more machinery.
- `layer_assets` has no garbage collection, on purpose (§3).

---

## 1. What we're building and why

Operators need to put **non-parcel features** on their maps — a golf course, a river, ponds, parks,
trails. Today the map can only render lot polygons from ArcGIS/GeoJSON, so any of this would have to
be hand-built as parcel geometry. That's unacceptable.

Two ways to get it on the map, both needed:

1. **Image overlay** — the developer's marketing site-plan render (a PNG/JPG) pinned onto the map so
   it lines up with the satellite imagery. This is the primary path. Ricky's reference screenshot is
   a full colored site plan — trees, streets, river, beaches, community park — with lot polygons and
   numbers drawn on top of it.
2. **Drawn shapes** — polygon / line / freehand, for when there's no render to pin. A wide blue line
   reads as a river; a polygon covers a pond or a green.

Explicit constraint from Ricky: *"I don't want to have to build the golf course by hand. same for
rivers."* The image overlay is what satisfies that; drawing is the fallback, not the main event.

**Out of scope — do not build:** text labels placed on the map. Asked and explicitly declined
("do not worry about text at all"). Labels are expected to be baked into the uploaded render.

---

## 2. Decisions locked

Every row below was asked and answered directly. Do not re-litigate these.

| Question | Decision |
|---|---|
| Where images are stored | **Postgres for now**, S3 later. Ricky: *"for now skip s3 and store in postgres but we will probably move to s3 later."* Build so the swap is contained. |
| Positioning UX | **Both modes** — move/scale/rotate by default, with a fine-tune toggle exposing 4 independent corner handles |
| Layers per map | **Many**, with a reorderable layer list, per-layer opacity and visibility |
| Visitor toggles | **Collapsed "Layers" button** in the embed, near the existing View Available chip |
| Drawing tools | **Polygon + line + freehand** (all three) |
| Stacking vs lots | **Per-layer above/below choice** (not always-beneath) |
| Portal location | **Section inside Map Design**, not a new nav page |
| Image sizing | **Handle it automatically** — browser-side downscale, Ricky doesn't know his file sizes |
| Map text labels | **Not building** |

### Deliberate design calls (mine, not asked — change freely if they get in the way)

- **Image bytes live in their own table**, not on the layer row and not in the publish snapshot.
  See §3 for why this matters more than it looks.
- **The editor forces a top-down view while positioning.** Unprojecting a dragged corner handle to a
  ground coordinate under both pitch and terrain is unreliable; flattening the camera during edit
  sidesteps it entirely. Operator exits edit mode to check the result in 3D.
- **Freehand is not a separate layer kind** — it's the same polygon/line geometry, captured on
  pointer-drag instead of click. One renderer, three input modes.

---

## 3. Data model

Two new tables. **Add to both [src/lib/schema.ts](src/lib/schema.ts) and
[migrate.sql](migrate.sql)** — CLAUDE.md is emphatic that editing one without the other silently
forks dev and prod schemas. New columns on existing tables go in as `alter table ... add column if
not exists` so existing PGlite data dirs migrate on boot, matching the pattern already there.

```sql
create table if not exists layer_assets (
  id           text primary key,
  mime         text not null,
  bytes        bytea not null,
  width        int not null,
  height       int not null,
  byte_size    int not null,
  created_at   timestamptz not null default now()
);

create table if not exists layers (
  id             text primary key,
  development_id text not null references developments(id) on delete cascade,
  kind           text not null,               -- 'image' | 'shape'
  name           text not null,
  sort_order     int  not null default 0,
  visible        boolean not null default true,
  opacity        real not null default 1.0,
  above_lots     boolean not null default false,
  visitor_toggle boolean not null default false,
  asset_id       text references layer_assets(id) on delete set null,  -- kind='image'
  corners        jsonb,                       -- kind='image': [[lng,lat] x4], TL,TR,BR,BL
  geometry       jsonb,                       -- kind='shape': GeoJSON LineString | Polygon
  style          jsonb not null default '{}'::jsonb,  -- kind='shape': color, width, fillOpacity
  created_at     timestamptz not null default now()
);
create index if not exists layers_dev on layers(development_id, sort_order);
```

### Why assets are a separate table

`publish()` in [src/lib/repo.ts:834](src/lib/repo.ts#L834) serializes the entire config into one
`publications.snapshot` jsonb blob. If image bytes rode along on the layer row, **every publish
would duplicate every overlay image into a new snapshot row.** A handful of 3 MB renders and a
few dozen publishes and the DB is in real trouble.

So: the snapshot carries layers with an `asset_id`; bytes are fetched separately from
`/api/asset/{id}` and cached hard (they're immutable — a re-upload mints a new asset id).

**Consequence to be aware of:** assets are referenced by past publications, so deleting a layer must
*not* delete its asset row. Leave orphaned assets in place — they're small and rare. Don't build
garbage collection.

**The S3 migration later touches exactly two things:** the `layer_assets` table and the
`/api/asset/{id}` route. Everything upstream reads an opaque asset id. Keep it that way.

---

## 4. Where layers flow through the app

Layers must ride the existing draft/published machinery, not a parallel one:

- `getDraftConfig()` ([repo.ts:271](src/lib/repo.ts#L271)) gains a `getLayers(dev.id)` in its
  `Promise.all` and returns `layers` on `MapConfig`.
- `MapConfig` in [src/lib/types.ts:205](src/lib/types.ts#L205) gains `layers: Layer[]`.
- `publish()` then snapshots layers for free — it already calls `getDraftConfig()`.
- `getConfig(slug, 'published')` reads them back out of the snapshot for free too.

That's the whole integration. No changes to the parcels path.

---

## 5. Rendering in MapView

Current layer stack in [src/components/MapView.tsx:213-255](src/components/MapView.tsx#L213-L255),
bottom to top: `FILL` → `LINE` → `LABEL` → `SEL_FILL` → `SEL_LINE`.

Insertion rules:
- `above_lots: false` → insert with `beforeId = FILL` (under everything parcel-related).
- `above_lots: true` → insert with `beforeId = LABEL`, **not** appended to the top. Lot numbers
  stay legible above an overlay; that's the whole point of them.

Per kind:
- **image** — a Mapbox `image` source. It takes exactly 4 corner coordinates and warps the texture
  between them, which is why transform mode and fine-tune mode can share one data shape.
  Drapes onto terrain natively. Control brightness/visibility via `raster-opacity`.
- **shape** — a `geojson` source with a `fill` layer (Polygon) or `line` layer (LineString), styled
  from the `style` jsonb.

Overlay layers are **non-interactive** — no click/hover handlers. The existing `click`/`mouseenter`
handlers are bound to `FILL` specifically, so lot clicks keep working under an above-lots overlay
without any extra work.

### Embed "Layers" button

Renders only if at least one layer has `visitor_toggle = true`. Collapsed button near the existing
View Available chip, opens a checklist. Toggling flips `setLayoutProperty(id, 'visibility', ...)`
client-side only — never writes to the DB. Style it against `src/app/embed/embed.css`.

---

## 6. Upload pipeline

The hard constraint: **Amplify's SSR Lambda caps request bodies around 6 MB.** CLAUDE.md already
documents this for GeoJSON import (which works around it with ~3 MB batches). An overlay image is
one indivisible blob, so batching isn't available — the file must be small enough before it's sent.

In the browser, before upload:
1. Decode to a canvas; downscale so the longest edge is ≤ 4096px.
2. **Preserve alpha** — re-encode as PNG if the image has any transparent pixel, JPEG q0.85 if fully
   opaque. Transparency is load-bearing here: a river cut out of a transparent PNG is a normal thing
   to upload, and flattening it onto white would ruin it.
3. Show original → final size in the UI.
4. If still over ~4 MB, **fail with a clear message**. The failure mode being avoided is the Lambda
   silently dropping an oversized body, which reads to the operator as "the upload just doesn't work."

Post to `POST /api/dev/[slug]/layers` as base64 in a JSON body (consistent with the rest of the API
surface; no multipart infrastructure exists in this repo and none is needed).

---

## 7. API routes

New, following the existing conventions in `src/app/api/dev/[slug]/`
(`export const runtime = "nodejs"`, zod-validated bodies, jsonb written as
`JSON.stringify(x)` with a `$n::jsonb` cast, read back through `asObj()`):

| Route | Verbs | Purpose |
|---|---|---|
| `/api/dev/[slug]/layers` | `GET`, `POST` | list; create (image upload or shape) |
| `/api/layer/[id]` | `PATCH`, `DELETE` | update corners/style/opacity/visibility/order; delete |
| `/api/layer/reorder` | `POST` | bulk `sort_order` write after a drag-reorder |
| `/api/asset/[id]` | `GET` | serve image bytes, immutable cache headers |

Repo functions in `repo.ts`: `getLayers`, `createLayer`, `updateLayer`, `deleteLayer`,
`reorderLayers`, `putAsset`, `getAsset`.

---

## 8. UI

**Map Design** ([src/app/(portal)/d/[slug]/design/page.tsx](src/app/(portal)/d/[slug]/design/page.tsx))
gets a Layers section. That file is already ~842 lines — **extract the section into
`src/components/LayersPanel.tsx`** rather than growing it further.

- Layer list: drag to reorder, thumbnail, name, visibility eye, opacity slider, above/below-lots
  toggle, "show toggle to visitors" switch, delete.
- "Add image layer" → file picker → downscale + preview → drops onto the map centered on the current
  view → enters positioning mode.
- "Draw shape" → polygon / line / freehand picker → draw on the map → color, width, fill opacity.

**Positioning editor** — `src/components/LayerEditor.tsx`. Follow the pattern in
[src/components/OpeningViewEditor.tsx](src/components/OpeningViewEditor.tsx), which already runs its
own Mapbox instance inside the portal. Two modes:
- *Transform* (default): drag body to move, corner to scale, handle to rotate; stays a rectangle.
- *Fine-tune*: 4 corners drag independently, correcting perspective in renders that weren't drawn
  straight-down.

Both write the same `corners` array. Flatten the camera to pitch 0 on entering edit mode.

---

## 9. Build order

Ship in two passes so the alignment UX gets confirmed before the drawing work is layered on top.

**Pass 1 — image overlays, end to end** — ✅ done
1. ✅ Schema in `schema.ts` + `migrate.sql`; `Layer` type in `types.ts`.
2. ✅ Repo functions; `layers` onto `MapConfig` via `getDraftConfig`.
3. ✅ API routes incl. `/api/asset/[id]`.
4. ✅ MapView rendering with above/below insertion.
5. ✅ Upload + downscale, `LayersPanel`, `LayerEditor` with both positioning modes.
6. ✅ Embed Layers button.
7. ✅ Checkpoint cleared — Ricky asked for the drawing work directly. Still worth doing on a real
   render: confirm alignment feels right. **And still required before any of this is live:**
   `npm run migrate` against RDS so prod gets `layers` + `layer_assets`.

**Pass 2 — drawing** — ✅ done
8. ✅ Area / line / freehand capture in `ShapeEditor.tsx`, on the same layer list and rendering
   path, behind a "Draw shape" menu in `LayersPanel`.
9. ✅ Style controls in the editor's command bar — presets plus a custom color, width for lines,
   fill opacity for areas.

### What Pass 2 added, and the calls made building it

- **`src/lib/shapes.ts`** — all the geometry, pure, mirroring how `layers.ts` serves the image
  editor. The working vertex list is **open** (no repeated closing point); `polygonFrom` closes it
  and `shapePoints` reopens it, so nothing in between special-cases the seam.
- **`useEditorMap`** — the flat-camera bootstrap, extracted out of `LayerEditor` and now shared.
  It was ~110 lines of duplicate otherwise, and the flat camera is the invariant *both* editors'
  pointer math depends on: two copies is one chance for one of them to quietly regain terrain.
- **Freehand decides area vs line by whether the stroke ends where it started** (within 28px).
  Not asked — a sketched pond is naturally a loop and a sketched river never is, and it's one
  control instead of a mode toggle. The hint text says so outright.
- **Freehand simplifies in screen pixels, before unprojecting** (Douglas–Peucker, 2px, iterative).
  In mercator the same stroke would keep wildly different detail depending on the zoom it was drawn
  at; 2px is below what a hand holds steady, so it only ever removes tremor.
- **A shape row is created only once it's drawn**, inverting the image flow. Forced: the create API
  needs valid geometry. The upside is an abandoned sketch leaves nothing behind.
- **`updateLayer` now merges `style`** (`style || $n::jsonb`) instead of replacing it, so a
  color-only patch doesn't blank width and fill. `validShapeGeometry` / `sanitizeShapeStyle` moved
  into `shapes.ts` and now guard both routes; the create route had the looser check.

Verified against a running server, not by inspection — 73 assertions:

- 29 pure-geometry assertions on `shapes.ts` (ring closing, the open/closed round-trip, vertex
  insert/move/remove with minimums enforced, midpoint indices including the wrap segment,
  simplify's endpoints/corners/20k-point stack safety, loop detection, validation rejects).
- 21 API assertions — create area + line, six malformed-geometry rejections, hostile style values
  clamped, geometry patch, **partial style patch leaves the other keys alone**, publish snapshot
  carries the geometry, draft edits don't touch the published copy, reorder, delete.
- 15 real-DOM browser assertions — clicking vertices, Enter closing an area, dragging a vertex
  (persisted, ring still closed, neighbours untouched), a midpoint drag inserting a vertex,
  alt-click removing one, a color preset saving without clobbering fill, double-click finishing a
  line without a duplicate vertex.
- 4 freehand assertions — a loop becomes an Area and a stroke stays a Line, 90 samples simplify to
  26 points, the command bar swaps fill for width.
- 4 embed assertions — shapes render in `/embed`, the visitor Layers chip lists only opted-in
  layers, and toggling never writes to the DB.

**How they were run** (no test runner exists in this repo, matching Pass 1): there is no Mapbox
token in the dev container, so the browser suites stub every `*.mapbox.com` request with a minimal
valid style. GL JS still does the real projection/unprojection, which is all the editors depend on.
Note that **Playwright resolves routes last-registered-first** — the catch-all has to be registered
*before* the specific style route or it swallows it. Chromium also needs `--no-proxy-server` here,
or it sends localhost through the agent proxy and every navigation times out.

---

## 10. Gotchas that will bite

- **Dev server restart required after schema changes** — `SCHEMA_SQL` runs once at DB init, not on
  hot-reload.
- **`npm run dev` must stay webpack**, not Turbopack (Next 16 + Node 24 crash).
- **Don't push to `main` unverified** — Amplify auto-deploys every push to production.
- `bytea` round-tripping differs between PGlite and node-postgres. Verify the asset route locally
  *and* against RDS before trusting it; this is the most likely place dev and prod diverge.
- Mapbox `image` sources want corners in **TL, TR, BR, BL** order. Out-of-order corners produce a
  bowtie-warped texture rather than an error.
- No auth exists on the portal or write APIs (documented gap). The upload route inherits that — it's
  publicly reachable on the Amplify URL. Not this feature's job to fix, but worth knowing that an
  unauthenticated endpoint now writes binary blobs to the DB. If that changes the priority of the
  auth work, that's a conversation to have.

---

## 11. Verification

- `curl /api/dev/summit-creek/config?state=draft` → includes `layers`.
- Publish, then `?state=published` → same layers, snapshot has asset **ids** and no base64 blobs
  (check the row size).
- Playwright screenshot `/embed/summit-creek` — chromium with `--use-angle=swiftshader`, wait for
  `.mapboxgl-canvas` plus ~9s for tiles and terrain.
- Toggle terrain on and confirm the overlay drapes rather than floating flat.
