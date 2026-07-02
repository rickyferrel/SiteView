# Map Portal — Project Plan (v2)

A portal that is the **single source of truth** for 3D parcel maps. You edit lots,
statuses, colors, and fields in the portal, **preview exactly how it will look**,
then **publish** — and the live Mapbox map on WordPress updates with no WordPress
edits and no Mapbox re-uploads.

---

## 1. Systems we integrate with (all confirmed)

| System | What it gives us | Concrete reference |
|---|---|---|
| **ArcGIS — Parcels_Utah** | Parcel **geometry + assessor data** (owner, address), county-sourced, paginated 2000/req | `services1.arcgis.com/99lidPhWCzftIe9K/.../Parcels_Utah/FeatureServer/0` |
| **Mapbox** (account `tbelliston45`) | Base style (terrain/satellite) + token; current lots live in tileset `tbelliston45.tw32i6178auc` | style `cmmv7xrgt002g01s6ef6l96o1` |
| **WordPress** | Hosts the public map; currently a raw Custom HTML block (so we can swap it for one iframe) | Summit Creek, Woodland Hills UT |

**Join key:** both ArcGIS and the existing Mapbox tileset use **`PARCEL_ID`**
(e.g. `300770026`). Everything keys off it.

**Data split:** ArcGIS owns geometry + ownership; the **portal owns** sales status,
lot number, price, media URLs, and any custom fields you invent. Joined by `PARCEL_ID`.

---

## 2. Architecture

```
   ArcGIS (county truth)              PORTAL (your truth)
   geometry, owner, address    +      status, lot#, price, media, CUSTOM FIELDS
         └──────────────── joined by PARCEL_ID ───────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  Portal database  │  draft + published states
                          │  (Postgres+PostGIS)│
                          └─────────┬─────────┘
                                    │ serves: parcels.geojson + config(statuses,fields,filters)
                   ┌────────────────┴────────────────┐
                   ▼                                  ▼
         PREVIEW (draft data)               WORDPRESS <iframe> (published data)
         shown in the portal                identical embed page, LIVE
```

### Draft → Preview → Publish
- All edits write to a **draft** state.
- The portal shows a **live preview**: the *real* embed page in an iframe, rendering
  draft data — true WYSIWYG, because it's the same code WordPress runs.
- **Publish** snapshots draft → published (a versioned snapshot; one-click rollback).
- WordPress embeds the **published** embed URL and reflects changes on next load.

### One embed, two data sources
The map is built **once** as `/embed/{development}` served by the portal:
- `…/embed/summit-creek` → published data (what WordPress shows)
- `…/embed/summit-creek?preview=<token>` → draft data (what the portal preview shows)

All current behavior is preserved inside it: terrain + 70° pitch, lot side-panel /
mobile sheet, "View Available" filter, "View Future Phase" modal, `?stop=` camera
presets, geolocation. Status **colors** and the **filter bar** become data-driven
(generated from your statuses/field definitions instead of hard-coded).

### WordPress change (one time, reversible)
Replace the big inline `<style>/<div>/<script>` block with a single:
```html
<iframe src="https://<portal-domain>/embed/summit-creek"
        style="width:100%;height:90vh;min-height:780px;border:0;border-radius:16px"
        allow="geolocation"></iframe>
```
After this, you never edit WordPress again — you publish from the portal.

---

## 3. Data model

```
developments
  id, name, slug, mapbox_style_url, mapbox_token,
  default_view {center,zoom,pitch,bearing}, stop_views jsonb, boundary geometry

parcels
  id, development_id,
  parcel_id            -- join key (matches ArcGIS + Mapbox)
  geometry             -- PostGIS polygon, imported from ArcGIS
  status_id            -- FK -> statuses
  core: lot_number, property_address, list_price, parcel_acres,
        image_url, video_url, lot_page_url, owner_name
  properties jsonb     -- CUSTOM fields live here
  source_attrs jsonb   -- raw assessor attrs from ArcGIS (for refresh/audit)
  draft + published columns (or a parcels_published snapshot table)
  updated_at, updated_by

statuses                       -- you create these
  id, development_id, name, color, fill_opacity, sort_order,
  show_in_filter bool, clickable bool

field_defs                     -- you create custom fields here
  id, development_id, key, label, type(text|number|money|url|select|bool),
  options jsonb, show_in_panel bool, filterable bool, sort_order

filters                        -- configurable filter bar
  id, development_id, label, field_key, match_values jsonb, style(button|toggle)

publications                   -- publish history / rollback
  id, development_id, snapshot jsonb, published_at, published_by
```

`status` lives in the portal (made up by you). Current colors carried over as
defaults: Available `#5e8c61`, Under Contract `#c6a75e`, Future Lot `#4f6d8a`,
Sold `#8c3b3b`.

---

## 4. ArcGIS import flow

1. Draw the **development boundary** on a map in the portal (or pick parcels).
2. Portal queries the FeatureServer within that polygon, paginating 2000/page
   (a bbox over Summit Creek alone returns ~5,379 — boundary keeps it to your lots).
3. Upsert parcels by `PARCEL_ID`: store geometry + assessor attrs; **preserve** any
   existing portal overlay (status/price/custom) for that `PARCEL_ID`.
4. "Refresh from county" re-pulls geometry/ownership later without losing your data.

---

## 5. Build phases

- **Phase 1 — Data + import.** Postgres+PostGIS (Supabase). Boundary-based ArcGIS
  import. Seed Summit Creek; match to existing lots by `PARCEL_ID`.
- **Phase 2 — Config.** Statuses (name+color), custom field defs, filter defs.
- **Phase 3 — Portal editor.** List + map view; edit a lot (status, price, custom
  fields); draw/add new lots; bulk edits.
- **Phase 4 — Embed map.** Port current map JS to `/embed/{dev}`; data-driven colors
  + filter bar; reads draft or published.
- **Phase 5 — Preview + publish.** In-portal WYSIWYG preview (iframe, draft); Publish
  → snapshot; rollback.
- **Phase 6 — WordPress swap.** Replace the HTML block with the iframe. (Reversible.)
- **Phase 7 — Polish.** CDN caching, roles/login, audit log, multi-development.

A first **vertical slice** spans Phases 1–5 for Summit Creek only: import → edit a
lot → preview → publish → see it on the embed. Proves the whole loop end to end
before we touch WordPress.

---

## 6. Stack & cost

| Piece | Choice | Why |
|---|---|---|
| DB + API + auth | Supabase (Postgres + PostGIS) | Hosted; geometry-native; auto API; login |
| Portal + embed | Next.js on Vercel | Admin UI + `/embed/{dev}` in one app |
| Map | Mapbox GL JS (your style/token) | Reuse; data-driven colors |
| Parcel source | ArcGIS Parcels_Utah | County geometry, no manual digitizing |

Estimated running cost at this scale: **$0–25/month** beyond your existing Mapbox.

---

## 7. Open items / decisions

- [ ] **Embed approach:** iframe (recommended) vs in-page hosted script.
- [ ] **Mapbox token:** add URL restrictions (portal + WP domains) — it's currently
      unrestricted. (Public `pk` tokens are meant to be exposed; this just scopes it.)
- [ ] Confirm which statuses to seed (defaulting to your current four).
- [ ] `stop=` camera presets: forward parent URL params into the iframe (preserves
      existing deep links).
- [ ] Auth/users: deferred per your note (single editor for now).

---

## 8. Next step

Confirm the embed approach, then I build the **vertical slice** (Phases 1–5) locally
— the WordPress swap (Phase 6) stays as your final, reversible step when you're happy
with the preview.
```
