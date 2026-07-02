# Map Portal

A portal that is the **single source of truth** for your 3D parcel maps. Edit lots,
statuses, colors, and custom fields; **preview** exactly what the public site will
show; then **publish** — and the Mapbox 3D map embedded in WordPress updates, with no
WordPress edits and no Mapbox re-uploads.

Built as a working vertical slice for **Summit Creek**. See [PLAN.md](PLAN.md) for the
full design.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (uses --webpack, see note below)
```

Then:

1. Open the portal → **Dashboard** → click **Import / Refresh from County**.
   This pulls parcel geometry from the Utah County ArcGIS service and migrates your
   existing lot statuses/numbers/prices from the live Mapbox tileset (joined by
   `PARCEL_ID`). First run brings in ~80 real Summit Creek lots.
2. **Lots** → change any lot's status (e.g. mark **Sold**), price, media, custom fields.
3. **Map Design** → add/edit statuses & colors, custom fields, and filter buttons.
4. **Preview & Publish** → see the draft exactly as WordPress will render it, then
   **Publish to live**.

> The first map load takes a few seconds (Mapbox terrain + tiles).

### The WordPress side (one-time)

Replace your current map block with a single Custom HTML block containing the iframe
shown on the **Preview & Publish** page:

```html
<iframe src="https://YOUR-PORTAL-DOMAIN/embed/summit-creek"
        style="width:100%;height:90vh;min-height:780px;border:0;border-radius:16px"
        allow="geolocation" loading="lazy" title="Summit Creek Map"></iframe>
```

After that you never touch WordPress again — publishing from the portal updates the map.

---

## How it works

```
ArcGIS (county geometry) ─┐
                          ├─ joined by PARCEL_ID ─► Portal DB ─► /embed/{slug}
Mapbox tileset (your      ┘   (status/price/...      (draft +      reads draft|published
 existing statuses)            custom fields)         published)   GeoJSON + status config
```

- **Geometry** comes from ArcGIS; **status/price/media/custom fields** live in the portal.
- The embed renders parcels from a **GeoJSON** the portal serves, and builds the
  `fill-color` rule from your **statuses** config — so colors, lots, and statuses are all
  controlled in the portal.
- **Draft vs published:** edits are draft; the in-portal preview reads draft; WordPress
  reads the latest published snapshot. **Publish** snapshots draft → published.

### Key endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/dev/{slug}/config?state=draft\|published` | development + statuses + fields + filters |
| `GET /api/dev/{slug}/parcels?state=draft\|published` | parcels as GeoJSON |
| `POST /api/dev/{slug}/import` | import/migrate from ArcGIS + Mapbox |
| `PATCH /api/parcel/{rowId}` | edit a lot |
| `POST /api/dev/{slug}/publish` | snapshot draft → live |
| `GET /embed/{slug}` | the embeddable map (published; add `?state=draft` for preview) |

---

## Production

This slice uses **PGlite** (Postgres in WASM, file-backed) so it runs locally with no
services. For production, point at **Supabase** (or any Postgres):

1. Run the SQL in [`src/lib/schema.ts`](src/lib/schema.ts) on your database.
2. Replace [`src/lib/db.ts`](src/lib/db.ts) with a Supabase/`postgres` client exposing the
   same `query(text, params)` signature — the rest of the code is unchanged.
3. Deploy (e.g. Vercel). Published data is sent with CDN cache headers already.
4. In your Mapbox account, add URL restrictions to the public token (portal + WP domains).

---

## Notes

- **`npm run dev` uses `--webpack`** intentionally: Next 16's Turbopack dev server has an
  async-hooks leak that crashes under this app on Node 24. `npm run dev:turbo` is available
  if a future Next release fixes it. `npm run build && npm run start` is also stable.
- **PGlite data** is stored outside the project (OS temp dir) so the dev file-watcher
  doesn't choke on its many files. Override with `PGLITE_DIR`.
