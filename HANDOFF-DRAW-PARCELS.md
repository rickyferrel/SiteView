# Handoff — Manual parcel drawing ("Draw by hand")

Mid-flight feature. **Last updated:** 2026-09-02. Everything below is uncommitted on `main`.

Pairs with [CLAUDE.md](CLAUDE.md) (the mental model) — this doc only covers the draw tool.
Unrelated to [HANDOFF.md](HANDOFF.md), which is the AWS deploy status doc.

---

## 1. The ask

> "I need a way to add parcels manually. The UI should be really user friendly and not hard to
> learn. The default should be drawing it out by hand, but there should be other ways available
> too that are easier and speed up the process. If it's a 54 parcel development then that's a lot
> of free hand drawing."

Existing acquisition paths were County records (ArcGIS picker), Upload file (GeoJSON/Shapefile),
and CSV (enriches existing lots only — no geometry). Nothing let an operator draw a lot.

## 2. Decisions locked with the user

These came out of two rounds of questions. **Don't re-litigate them** — they're answered.

| Question | Decision |
|---|---|
| Where it lives | Third tab **"Draw by hand"** on `d/[slug]/parcels`, next to County records / Upload file |
| Scope | Draws new lots **and** reshapes/deletes existing ones |
| Speed tools | **All four**: edge snapping, rectangle+rotate, split-a-block-into-N, duplicate+offset row |
| Saving | **Per-lot, on completion** — closing a polygon POSTs immediately (a 54-lot session is an hour; a lost tab shouldn't cost it) |
| After a draw | **Auto-number + editable list** — never interrupts; a running lot list beside the map has inline-editable lot numbers |
| Lot numbers | **Plain integers** `1, 2, 3…` (max existing numeric `lot_number` + 1) |
| Tracing underlays | Pinned **site-plan render** + snappable **county outlines**, both **off by default** (satellite only out of the box) |
| County re-import | **Protect hand-edited geometry** via a new column — re-import refreshes attributes, never the outline |

Design direction: stay inside the portal's existing identity (surveyor's-instrument — paper/panel
greys, sparing `--brass`, `--stage` near-black map chrome, Archivo/Inter/IBM Plex Mono, hairline
`--line`, 9–16px radii). No new palette or fonts. The one bold move is the drawing instrument
itself — mode switcher, live measurement readout, snap feedback.

## 3. What's built

### Backend — done, typechecks clean

| File | Change |
|---|---|
| [src/lib/schema.ts](src/lib/schema.ts), [migrate.sql](migrate.sql) | `alter table parcels add column if not exists geometry_locked boolean not null default false` (additive-ALTER pattern, mirrored by hand in both per CLAUDE.md) |
| [src/lib/geojson.ts](src/lib/geojson.ts) | `polygonAreaM2()`, `polygonAcres()`, `validateDrawnPolygon()` — pure, so the client and the route run the *same* validation and the acreage ticking up while dragging is the acreage stored |
| [src/lib/repo.ts](src/lib/repo.ts) | `createDrawnParcel()`, `setParcelGeometry()`, private `nextLotNumber()` / `freeParcelId()`; `upsertParcel` now does `geometry = case when parcels.geometry_locked then parcels.geometry else excluded.geometry end`; `toFeature` exposes `geometry_locked` |
| [src/lib/types.ts](src/lib/types.ts) | `Parcel.geometry_locked: boolean` |
| [src/app/api/dev/[slug]/parcels/route.ts](src/app/api/dev/[slug]/parcels/route.ts) | `POST` → create one drawn lot |
| [src/app/api/parcel/[rowId]/route.ts](src/app/api/parcel/[rowId]/route.ts) | `PATCH` now also takes `{ geometry }` (deliberately *not* a whitelisted `patch` column — geometry is validated and re-measured, never a raw column write) |

API contract the UI uses:

- `POST /api/dev/{slug}/parcels` `{ geometry, lot_number?, parcel_id?, status_id?, property_address?, list_price?, source_attrs? }` → `{ rowId, parcel_id, lot_number, parcel_acres }`; `400 {error}` with a readable sentence on bad geometry
- `PATCH /api/parcel/{rowId}` `{ geometry }` → `{ ok, parcel_acres }` (still takes `{patch, properties}` for field edits)
- `DELETE /api/parcel/{rowId}`
- `GET /api/dev/{slug}/parcels?state=draft` → features carry `rowId`, `lot_number`, `parcel_acres`, `status`, `status_color`, `geometry_locked`

### Frontend — written, and **verified in a browser** (see §5)

| File | Size | What's in it |
|---|---|---|
| [src/components/ParcelDrawEditor.tsx](src/components/ParcelDrawEditor.tsx) | ~2,670 lines | The whole tool |
| [src/lib/draw.ts](src/lib/draw.ts) | ~310 lines | Pure geometry: rect-from-drag with rotation, half-plane clipping, block slicing, even cuts, flush-step offset, nearest-point-on-segment, bearing/perimeter/feet, map scale ticks |
| [src/app/(portal)/d/[slug]/parcels/page.tsx](src/app/(portal)/d/[slug]/parcels/page.tsx) | small diff | Third `Source` tab + per-tab blurb map |

Present in the code (all four modes, `Mode = "polygon" \| "rect" \| "split" \| "copy"`):

- Polygon: click corners, rubber band, close within `CLOSE_PX`, `DEDUPE_PX` double-click guard
- Rectangle + rotate
- Split a block into N (`MIN_LOTS` 2 → `MAX_SPLIT` 24), scaffold block never saved as a lot
- Duplicate + offset row (`MAX_COPIES` 24, flush spacing default)
- Snapping: corner-beats-edge, `SNAP_PX` 10, `S` toggles, **Alt** suspends, white "snap monument" marker
- Underlays: county via `/api/arcgis` (`CO_*` layers), site plan via `syncLayers`/`setLayerOpacity` with an opacity slider
- Undo on Cmd/Ctrl+Z (including multi-row batch creates from split/copy)
- Lot list with inline rename → `PATCH {patch:{lot_number}}`
- Per-mode hint line, measurement readouts, `Measure`/`Ruler`/`Stepper`/`Toggle`/`Key` sub-components
- Reduced-motion respected

## 4. The environment trap (diagnosed 2026-08-07, resolved 2026-09-01)

**On this machine `npm run dev` talked to production RDS, not PGlite.** `.env.local` had
`DATABASE_URL` commented out but left `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` live,
and `db.ts` selects Postgres on `DATABASE_URL` **or** `PGHOST`. The `PGLITE_DIR` line right above
them made it read like a local setup; it was dead config while `PGHOST` was set.

**Resolved by option A on 2026-09-01:** the `PG*` block in `.env.local` is now commented out
behind a two-line marker explaining how to restore it. A verbatim backup of the original file
sits in this session's scratchpad as `env.local.rds-backup`.

⚠️ **`.env.local` is currently pointed at local PGlite.** To put dev back on production RDS,
uncomment lines 8–12 of `.env.local` and restart the server. Until then `npm run dev` serves the
PGlite seed (`summit-creek`, 82 lots + a `test` dev), **not** the real 17-development RDS data.

`SCHEMA_SQL` runs on **every** PGlite boot and the migration is additive, so the pre-existing
July data dir picked up `geometry_locked` on the first restart — no reseed was needed.

Still true and still important: **a GET cannot tell you whether the migration ran.** `toFeature`
reads `r.geometry_locked ?? false`, so `GET …/parcels` returns `geometry_locked: false` for every
lot *with the column absent*. Prove it with a write, not a read.

## 5. What's been verified

**Everything below was exercised on 2026-09-01 against local PGlite (`summit-creek`), in a real
browser (Playwright, chromium `--use-angle=swiftshader`), watching the network for every non-GET
call. The draft was returned to exactly 82 parcels afterward — 0 test lots remain.**

### Backend — API paths confirmed against a migrated DB

| Request | Result |
|---|---|
| `POST …/parcels` valid rect | `200 {rowId, parcel_id:"LOT-220", lot_number:"220", parcel_acres:"0.70"}` — acreage matches hand-computed 0.704 |
| round-trip `GET …/parcels?state=draft` | the new lot carries **`geometry_locked: true`** — the column exists and is written |
| `PATCH /api/parcel/{id} {geometry}` | `200 {ok, parcel_acres}` — re-measured (0.70 → 1.41 on a doubled-width box) |
| `PATCH` 2-corner polygon | `400 "A lot needs at least 3 corners."` |
| `PATCH {patch:{lot_number}}` | `200` |
| `DELETE /api/parcel/{id}` | `200`, count back to 82 |
| UTM/State-Plane coords, `{}`, unknown slug | `400` WGS84 hint / `400 "geometry required"` / `404` (unchanged) |

### Frontend — all four modes driven in a browser, end to end

| Path | Evidence |
|---|---|
| **Draw a lot** (polygon) | 4 corners + close on the first → `POST` `200`, lot 220 · 10.75 ac. Toast "Lot 220 saved · 10.75 ac", count 82→83, next number 220→221, list row highlighted with a `DRAWN` chip, footer "Undo lot 220" |
| **Drag a rectangle** | drag → 4 grips + rotate handle + live `AREA 10.75 ac / PERIMETER 2,744 ft / CORNERS 4`; "Finish lot" → `POST` `200`. Deliberately **not** auto-committed on mouseup — it waits for Finish |
| **Split a block** | block ring → `Create 4 lots` → 4 × `POST` `200` (8.15 / 8.42 / 8.49 / 7.90 ac, summing to the block). Scaffold never saved as a lot |
| **Copy a row** | source lot clicked → `Create 3 copies` → 3 × `POST` `200`, each **10.84 ac — identical to the source** |
| **Reshape** | list pencil → zooms to the lot, 4 corner grips + hollow midpoints, footer "RESHAPING", Cancel/Done. Dragging a real grip → `PATCH` `200 {parcel_acres:"12.20"}`; readout **and** list row live-updated 10.75 → 12.20 |
| **Rename** | inline list edit → `PATCH {patch:{lot_number}}` `200` |
| **Delete** | row × → two-step confirm → `DELETE` `200`, row gone |
| **Undo (Cmd+Z)** | after a saved draw: issues the `DELETE`, list 83 → 82, footer back to "Nothing to undo" |
| **Snapping** | `S` and the toggle both flip it; an `EDGE` snap monument renders when a click lands on an existing lot edge |
| **Site plan underlay** | toggle renders the pinned render under the lots; `FADE` opacity slider works (75%) |
| **County outlines** | reads "ZOOM IN TO LOAD" at low zoom; after zooming, clicking an outline adopts it whole → `POST` `200` |
| **Mode guard** | switching tools mid-shape shows "CAN'T DO THAT — You're part-way through a shape. Press Escape to discard it, or pick that tool again to switch." |

`npx tsc --noEmit` passes clean. `npm run lint` reports the **same** 4 errors + 1 warning as
before this work, all pre-existing in files it never touched (`(portal)/page.tsx`,
`d/[slug]/page.tsx`, `d/[slug]/lots/page.tsx`, `MpcgLanding.tsx`). The new files add zero.

### Worth knowing

- **A county-adopted lot is `geometry_locked: false`**, unlike a drawn one, and gets the county's
  real `parcel_id` (e.g. `300770267`) instead of a generated `DRAWN-nnn`. That is correct — its
  outline *is* county geometry, so a re-import refreshing it loses nothing. Only hand-drawn and
  hand-reshaped outlines are protected. It also means the `DRAWN` chip is absent on adopted lots.
- **Lot numbers are not unique-constrained.** Renaming two lots to the same number is accepted.
  Probably fine (plats do reuse numbers with suffixes) but it is not enforced anywhere.

### Fixed during verification

1. **`400`-vs-`500` error mapping** — was already done in the working tree before this session:
   both routes now throw `DrawGeometryError` for operator mistakes and `500` for everything else.
2. **`Cannot set properties of undefined (setting 'width')`** — a real crash, thrown on every
   switch away from a source tab. Both map bootstraps fired an uncancelled
   `setTimeout(() => map.resize(), 200)`; if the operator switches tabs inside that window,
   cleanup runs `map.remove()` and the timer then resizes a torn-down canvas.
   [ParcelPicker.tsx](src/components/ParcelPicker.tsx) (pre-existing, and the one actually firing —
   this feature's third tab just made the race easy to hit) and
   [ParcelDrawEditor.tsx](src/components/ParcelDrawEditor.tsx) (same latent bug in the new code)
   both now guard the callback. Verified by thrashing the tab switcher at 120ms intervals: **0 errors.**
3. **Ragged acreage column** — the lot list rendered `parcel_acres` raw, so imported lots showed
   the assessor's `0.360511 ac` next to a drawn lot's `10.75 ac` in one tabular-nums column.
   Formatted through the shared `acres()` helper in `format.ts` at the boundary where the list
   is seeded — the same helper the embed panel and the Lots table use.

## 5b. Parity pass — "do drawn lots behave like regular ones?" (2026-09-02)

Audited every surface a parcel reaches, on local PGlite (`summit-creek`), draft **and** published.
**They do**, and the four places they didn't are fixed below. Verified: a drawn lot's GeoJSON
feature carries the identical property set to an imported one; core-field, custom-field and status
edits go through the same `PATCH /api/parcel/{rowId}`; it matches status filters; it snapshots into
`publish()` and comes back in `?state=published`; it counts in `parcel_count`; and in the embed it
renders with the same status fill, white outline, lot-number label, selection highlight and lot
panel (acres/price/custom field) — confirmed by clicking it in a real browser. Draft returned to
exactly 83 parcels and republished afterward; **0 test lots remain**.

Fixed:

1. **A zero-area lot could be saved through the API.** The client refused one; the route didn't, so
   a scripted or replayed `POST`/`PATCH` stored a lot with no fill — invisible on the map, and
   therefore unclickable, unselectable and un-deletable from the embed. `validateDrawnPolygon` now
   rejects it (after rounding, since 6dp rounding is what collapses a sliver), so **one rule, one
   message, both sides**. Also catches a symmetric bow-tie, whose lobes cancel to zero area. The
   client's duplicate check in `createLot` is gone.
2. **Hand-drawn `parcel_id`s squatted on the GeoJSON importer's namespace.** `freeParcelId` minted
   `LOT-nnn`; `normalizeGeoJSON` mints `LOT-001…` for uploaded features with no ID of their own,
   counting from 1 every time. Draw eight lots into a fresh development, then upload an ID-less
   file, and all eight collide: the upsert lands on the drawn row, the geometry lock throws the
   uploaded outline away, and eight lots quietly never arrive. Drawn lots now mint **`DRAWN-nnn`**.
   `parcel_id` is internal plumbing (the operator reads `lot_number`; the portal only falls back to
   `parcel_id` when `lot_number` is blank, which a drawn lot never is). Verified: uploading three
   ID-less features into a dev holding a drawn lot now creates three lots, `LOT-001..003`.
3. **A locked outline could end up with the county's acreage.** `upsertParcel`'s overwrite path set
   `parcel_acres = excluded.parcel_acres` unconditionally, so a re-import over a hand-reshaped lot
   kept the hand-drawn shape but replaced the acreage that describes it. Acreage is now guarded by
   the same `geometry_locked` case as geometry — it follows the outline, not the attributes.
4. **The Lots table showed acreage raw**, so a drawn lot read `0.34` beside an imported `0.335278`
   in one tabular-nums column. Now formatted through `acres()`, like everywhere else.

Known and deliberate, not defects: a drawn lot has no `source_attrs`, `owner_name` or seeded
`list_price` (there's no assessor record behind it), and its untouched text columns are `null`
where an imported lot's are `""` — every reader normalizes both to blank.

## 5c. Operator report — "no address lookup, nothing fits" (2026-09-02)

Reported against a **brand-new development** (`tet`, 0 lots) on a 1440×742 laptop. Both halves
were real and both are fixed; verified in a browser at 742px **and** 640px.

**1. Nowhere to search, and the map opened on nowhere.** The County-records tab has had a Search
Box command bar since it shipped; the draw tab never got one, so the only way to reach a site was
to pan the whole state by hand. Worse, with no lots to frame `bboxOf` returns null and the
bootstrap fell through to `Math.max(16, default_view.zoom)` — zooming the *statewide* opening shot
`createDevelopment` seeds (`[-111.7, 40.3]`, z6.4) to 16, which lands on strangers' rooftops in
Orem and reads as "here is your site."

- The same `geocode.ts` suggest→retrieve session flow the picker uses now sits at the top of the
  draw stage: debounced, biased to the current centre, `/` focuses it, Escape closes, Enter takes
  the first hit, and a pick flies to **z17.4** (closer than the picker's 16.3 — you're about to
  trace corners, not survey a neighbourhood).
- The bootstrap now distinguishes a *framed* view (`view_locked`, or `zoom >= 12`, i.e. a real
  import auto-framed it) from the untouched statewide default. Unframed and lotless, it leaves the
  wide shot alone, rings the search field, focuses it, and says why: "This development has no lots
  yet, so the map hasn't got a site to open on." A development with lots is unchanged.
- Kept at `z-30` like the tool rail, so a corner grip (`z-40`) under it is still grabbable.
- The input carries `style={{ outline: "none" }}`, not a utility class: globals' **unlayered**
  `:focus-visible { outline: 2px solid var(--ink) }` outranks any layered Tailwind utility, and ink
  on dark glass is invisible. The field ring is `focus-within` on the container instead.

**2. The chrome didn't fit the stage.** At 742px the stage is ~450px tall; the tool rail wanted
~380 and the instrument bar ~120, and the bar is centred — so on any map narrower than ~1100px its
left end sat *under* the rail, and the rail's lower panel ran off the bottom edge. The reference
toggles were simply gone.

- Rail is now bounded by the stage (`top-3 bottom-3`) and scrolls inside it, with a mask fade on
  the bottom edge when there's more below (`railMore`, driven by a `ResizeObserver` — note it
  fires once on `observe`, so no synchronous `setState` in the effect body, which this repo's lint
  flags as an error).
- Instrument bar starts past the rail (`sm:left-[236px]`) instead of centring on the stage.
- Rail trimmed: tighter tool/toggle rows, no "Trace over" caption, and the Split/Copy **empty-state
  paragraphs are gone** — they repeated the tool blurb above them and the instrument bar's hint
  below them, in the one place with no room to spare. Settings now render only once there's a block
  or a source lot.
- Page: shorter draw blurb, `h-[calc(100vh-8.25rem)] min-h-[540px]`. Net stage height 446 → 482px
  at the reported viewport, with nothing overlapping in any of the four modes.

## 6. What's left

1. **`npm run migrate` against RDS — the one hard blocker.** The new routes write
   `geometry_locked`, and `upsertParcel`'s county-re-import path now references it too, so the
   migration is required for *existing* import flows the moment this lands — not just for the
   draw routes. Pushing to `main` auto-deploys, so this is not optional. It is additive and safe
   (`add column if not exists … not null default false`) but it is production DDL: get an
   explicit go-ahead.
2. **Restore `.env.local`** when local testing is done (§4), or leave it on PGlite deliberately.
3. Optional polish, neither a defect: the seeded `summit-creek` has four lots with blank
   `lot_number`, which render as empty inputs at the top of the list; and a newly drawn lot takes
   the development's **default status**, which on this dev is "Sold" — worth confirming that is
   the intended default for a lot that was just drawn.
4. Not yet exercised: `Alt` to suspend snapping, and the `MAX_SPLIT`/`MAX_COPIES` (24) ceilings.
   Every other interaction in §5 has browser evidence.

## 7. Gotchas specific to this work

- **Check which database you're on before you write anything** (§4). `curl localhost:3000/api/dev`
  — 17 developments and no `summit-creek` means you are pointed at **production RDS**; a short list
  led by `summit-creek` (82 lots) means local PGlite. As of 2026-09-01 `.env.local` is on PGlite.
- Both existing editors (`LayerEditor`, `ShapeEditor`) run the map **flat** — pitch 0, terrain off,
  rotation locked — and this one must too. Under pitch/terrain, GL JS resolves screen→ground
  against a streaming DEM, so a clicked vertex lands somewhere other than where it was clicked.
- Handle drags listen on `window`, not the grip: a grip is ~14px and the pointer leaves it
  immediately, so a handle-scoped listener stops receiving moves.
- `validateDrawnPolygon()` / `polygonAcres()` must stay pure and stay in `geojson.ts` — the client
  imports them. Moving them into a `server-only` module breaks the tool.
- Geometry goes through `setParcelGeometry`, never through `updateParcel`'s column whitelist.
- [src/components/ShapeEditor.tsx](src/components/ShapeEditor.tsx) is the reference implementation
  for every interaction pattern here; when something feels wrong, compare against it.
