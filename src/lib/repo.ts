import "server-only";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "./db";
import {
  fetchArcgisByBbox,
  fetchArcgisByParcelIds,
  collectMapboxLots,
  parcelInfo,
  SUMMIT_CREEK_TILESET,
  SUMMIT_CREEK_BBOX,
  type Bbox,
} from "./arcgis";
import type {
  Development,
  DevelopmentInput,
  DevelopmentSummary,
  Status,
  FieldDef,
  Filter,
  MapConfig,
  MapAppearance,
  DataState,
  ViewState,
} from "./types";
import { DEFAULT_APPEARANCE } from "./types";

// PGlite returns jsonb as parsed objects, but guard for both shapes.
function asObj<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

// ---- Reads ------------------------------------------------------------------

export async function getDevelopment(slug: string): Promise<Development | null> {
  const row = await queryOne<Record<string, unknown>>(
    "select * from developments where slug = $1",
    [slug]
  );
  if (!row) return null;
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    mapbox_token: row.mapbox_token as string,
    mapbox_style: row.mapbox_style as string,
    default_view: asObj(row.default_view, {} as Development["default_view"]),
    view_locked: Boolean(row.view_locked),
    stop_views: asObj(row.stop_views, {}),
    terrain_exaggeration: Number(row.terrain_exaggeration),
    map_appearance: asObj(row.map_appearance, DEFAULT_APPEARANCE),
  };
}

/** Every development with its parcel count — feeds the client switcher. */
export async function listDevelopments(): Promise<DevelopmentSummary[]> {
  return query<DevelopmentSummary>(
    `select d.id, d.slug, d.name, count(p.id)::int as parcel_count
       from developments d
       left join parcels p on p.development_id = d.id
      group by d.id, d.slug, d.name, d.created_at
      order by d.created_at`
  );
}

const NEW_DEV_VIEW: ViewState = {
  // Statewide Utah opening shot until the first parcel import recenters it.
  center: [-111.7, 40.3],
  zoom: 6.4,
  pitch: 0,
  bearing: 0,
};

// A working starter palette so the map renders meaningfully from parcel one.
// "Available" is the default → freshly imported lots read as ready-to-sell.
const NEW_DEV_STATUSES = [
  { name: "Available", color: "#5e8c61", sort: 1, def: true, show: true },
  { name: "Under Contract", color: "#c6a75e", sort: 2, def: false, show: true },
  { name: "Sold", color: "#8c3b3b", sort: 3, def: false, show: false },
];

/**
 * Spin up a new development: insert the row, seed a working status palette (so
 * the map always has a fallback fill color), and a starter "View Available"
 * filter. Slug uniqueness is enforced by the DB; callers map the conflict to 409.
 */
export async function createDevelopment(input: DevelopmentInput): Promise<Development> {
  const id = randomUUID();
  await query(
    `insert into developments
       (id, slug, name, mapbox_token, mapbox_style, default_view, stop_views, terrain_exaggeration, map_appearance)
     values ($1,$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,1.5,$7::jsonb)`,
    [
      id,
      input.slug,
      input.name,
      input.mapbox_token,
      input.mapbox_style,
      JSON.stringify(input.default_view ?? NEW_DEV_VIEW),
      JSON.stringify(DEFAULT_APPEARANCE),
    ]
  );
  for (const s of NEW_DEV_STATUSES) {
    await createStatus(id, {
      name: s.name,
      color: s.color,
      sort_order: s.sort,
      is_default: s.def,
      show_in_filter: s.show,
    });
  }
  await createFilter(id, { label: "View Available", field_key: "status", match_values: ["Available"], sort_order: 1 });
  const dev = await getDevelopment(input.slug);
  if (!dev) throw new Error("development insert failed");
  return dev;
}

/**
 * Rename or re-point a development. Only whitelisted columns are touched; a
 * `slug` change is allowed but the caller is responsible for warning that it
 * breaks the live `/embed/{slug}` URL WordPress points at. Uniqueness on slug
 * is enforced by the DB — callers map the conflict to a 409.
 */
export async function updateDevelopment(
  slug: string,
  patch: { name?: string; slug?: string; mapbox_token?: string; mapbox_style?: string }
): Promise<Development | null> {
  const dev = await getDevelopment(slug);
  if (!dev) return null;

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${sets.length + 1}`);
    vals.push(val);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.slug !== undefined) set("slug", patch.slug);
  if (patch.mapbox_token !== undefined) set("mapbox_token", patch.mapbox_token);
  if (patch.mapbox_style !== undefined) set("mapbox_style", patch.mapbox_style);
  if (sets.length === 0) return dev;

  vals.push(dev.id);
  await query(`update developments set ${sets.join(", ")} where id = $${vals.length}`, vals);
  return getDevelopment(patch.slug ?? slug);
}

/**
 * Delete a development and everything under it. Every child table
 * (statuses, field_defs, filters, parcels, publications) is `on delete
 * cascade`, so this single delete tears down the whole workspace. Returns
 * false when the slug doesn't exist.
 */
export async function deleteDevelopment(slug: string): Promise<boolean> {
  const dev = await getDevelopment(slug);
  if (!dev) return false;
  await query("delete from developments where id = $1", [dev.id]);
  return true;
}

export async function updateAppearance(devId: string, appearance: MapAppearance) {
  await query("update developments set map_appearance = $1::jsonb where id = $2", [
    JSON.stringify(appearance),
    devId,
  ]);
}

/**
 * Set (and lock) the opening camera the embed uses on first open. Locking flips
 * `view_locked` so the embed stops auto-fitting the lot cluster and honors this
 * exact view. Passing `locked: false` clears default_view back to auto-fit.
 */
export async function updateDefaultView(devId: string, view: ViewState, locked: boolean) {
  await query(
    "update developments set default_view = $1::jsonb, view_locked = $2 where id = $3",
    [JSON.stringify(view), locked, devId]
  );
}

export async function getStatuses(devId: string): Promise<Status[]> {
  return query<Status>(
    "select * from statuses where development_id = $1 order by sort_order, name",
    [devId]
  );
}

export async function getFields(devId: string): Promise<FieldDef[]> {
  const rows = await query<Record<string, unknown>>(
    "select * from field_defs where development_id = $1 order by sort_order, label",
    [devId]
  );
  return rows.map((r) => ({ ...(r as unknown as FieldDef), options: asObj(r.options, null) }));
}

export async function getFilters(devId: string): Promise<Filter[]> {
  const rows = await query<Record<string, unknown>>(
    "select * from filters where development_id = $1 order by sort_order, label",
    [devId]
  );
  return rows.map((r) => ({
    ...(r as unknown as Filter),
    match_values: asObj(r.match_values, [] as string[]),
  }));
}

async function latestPublication(devId: string) {
  return queryOne<{ snapshot: unknown; published_at: string }>(
    "select snapshot, published_at from publications where development_id = $1 order by published_at desc limit 1",
    [devId]
  );
}

export async function getDraftConfig(dev: Development): Promise<MapConfig> {
  const [statuses, fields, filters, pub] = await Promise.all([
    getStatuses(dev.id),
    getFields(dev.id),
    getFilters(dev.id),
    latestPublication(dev.id),
  ]);
  return { development: dev, statuses, fields, filters, published_at: pub?.published_at ?? null };
}

type ParcelJoin = Record<string, unknown> & {
  status_name: string | null;
  status_color: string | null;
  status_default: boolean | null;
};

function toFeature(r: ParcelJoin): GeoJSON.Feature {
  const custom = asObj<Record<string, unknown>>(r.properties, {});
  return {
    type: "Feature",
    id: r.parcel_id as string,
    geometry: asObj(r.geometry, { type: "Polygon", coordinates: [] } as GeoJSON.Geometry),
    properties: {
      rowId: r.id,
      parcel_id: r.parcel_id,
      status: r.status_name,
      status_color: r.status_color,
      status_default: r.status_default ?? false,
      lot_number: r.lot_number,
      property_address: r.property_address,
      list_price: r.list_price,
      parcel_acres: r.parcel_acres,
      image_url: r.image_url,
      video_url: r.video_url,
      lot_page_url: r.lot_page_url,
      owner_name: r.owner_name,
      ...custom,
    },
  };
}

export async function getDraftParcels(devId: string): Promise<GeoJSON.FeatureCollection> {
  const rows = await query<ParcelJoin>(
    `select p.*, s.name as status_name, s.color as status_color, s.is_default as status_default
     from parcels p left join statuses s on s.id = p.status_id
     where p.development_id = $1
     order by p.lot_number nulls last, p.parcel_id`,
    [devId]
  );
  return { type: "FeatureCollection", features: rows.map(toFeature) };
}

export async function getConfig(slug: string, state: DataState): Promise<MapConfig | null> {
  const dev = await getDevelopment(slug);
  if (!dev) return null;
  if (state === "published") {
    const pub = await latestPublication(dev.id);
    if (!pub) return null;
    const snap = asObj<{ config: MapConfig }>(pub.snapshot, { config: null as never });
    return snap.config ?? null;
  }
  return getDraftConfig(dev);
}

export async function getParcels(
  slug: string,
  state: DataState
): Promise<GeoJSON.FeatureCollection | null> {
  const dev = await getDevelopment(slug);
  if (!dev) return null;
  if (state === "published") {
    const pub = await latestPublication(dev.id);
    if (!pub) return { type: "FeatureCollection", features: [] };
    const snap = asObj<{ featureCollection: GeoJSON.FeatureCollection }>(pub.snapshot, {
      featureCollection: { type: "FeatureCollection", features: [] },
    });
    return snap.featureCollection;
  }
  return getDraftParcels(dev.id);
}

// ---- Import -----------------------------------------------------------------

type LotFields = {
  status_id: string | null;
  lot_number: string | null;
  property_address: string | null;
  list_price: string | null;
  parcel_acres: string | null;
  image_url: string | null;
  video_url: string | null;
  lot_page_url: string | null;
};

async function upsertParcel(
  devId: string,
  parcelId: string,
  geometry: GeoJSON.Geometry,
  ownerName: string | null,
  sourceAttrs: Record<string, unknown>,
  lot: LotFields | null,
  overwriteAttrs: boolean
) {
  const setAttrs = overwriteAttrs && lot
    ? `, status_id = excluded.status_id, lot_number = excluded.lot_number,
         property_address = excluded.property_address, list_price = excluded.list_price,
         parcel_acres = excluded.parcel_acres, image_url = excluded.image_url,
         video_url = excluded.video_url, lot_page_url = excluded.lot_page_url`
    : "";
  await query(
    `insert into parcels
       (id, development_id, parcel_id, geometry, status_id, lot_number, property_address,
        list_price, parcel_acres, image_url, video_url, lot_page_url, owner_name, source_attrs, updated_at)
     values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
     on conflict (development_id, parcel_id) do update set
       geometry = excluded.geometry,
       source_attrs = excluded.source_attrs,
       owner_name = coalesce(excluded.owner_name, parcels.owner_name)
       ${setAttrs},
       updated_at = now()`,
    [
      randomUUID(),
      devId,
      parcelId,
      JSON.stringify(geometry),
      lot?.status_id ?? null,
      lot?.lot_number ?? null,
      lot?.property_address ?? null,
      lot?.list_price ?? null,
      lot?.parcel_acres ?? null,
      lot?.image_url ?? null,
      lot?.video_url ?? null,
      lot?.lot_page_url ?? null,
      ownerName,
      JSON.stringify(sourceAttrs),
    ]
  );
}

function composeAddress(p: Record<string, unknown>): string | null {
  const add = p.PARCEL_ADD as string | null;
  const city = p.PARCEL_CITY as string | null;
  const zip = p.PARCEL_ZIP as string | null;
  const parts = [add, city, zip].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// Default lot fields for a generically-imported parcel, drawn from the county
// assessor (LIR) attributes: real acreage + the assessed market value as an
// editable starting price, plus a composed address. The operator refines these
// (and their own marketing price) in the lots editor before publishing.
function lotFromAssessor(props: Record<string, unknown>, statusId: string | null): LotFields {
  const info = parcelInfo(props);
  return {
    status_id: statusId,
    lot_number: null,
    property_address: info.address ?? composeAddress(props),
    list_price: info.marketValue != null ? String(info.marketValue) : null,
    parcel_acres: info.acres != null ? String(info.acres) : null,
    image_url: null,
    video_url: null,
    lot_page_url: null,
  };
}

/**
 * One-time migration for Summit Creek: pull existing lot attributes (status,
 * lot #, price, media) from the live Mapbox tileset, fetch matching geometry
 * from ArcGIS, and upsert. Result: the portal mirrors the live site.
 */
export async function importSummitCreek(slug: string): Promise<{ matched: number; imported: number }> {
  const dev = await getDevelopment(slug);
  if (!dev) throw new Error("development not found");

  const lots = await collectMapboxLots(dev.mapbox_token, SUMMIT_CREEK_TILESET, SUMMIT_CREEK_BBOX);
  const ids = [...lots.keys()];
  if (ids.length === 0) return { matched: 0, imported: 0 };

  const feats = await fetchArcgisByParcelIds(ids);

  const statuses = await getStatuses(dev.id);
  const byName = new Map(statuses.map((s) => [s.name.toLowerCase(), s.id]));
  const defaultId = statuses.find((s) => s.is_default)?.id ?? null;

  let imported = 0;
  for (const f of feats) {
    const pid = (f.properties.PARCEL_ID as string) ?? "";
    if (!pid) continue;
    const a = lots.get(pid) ?? {};
    const statusName = (a.SALES_STATUS ?? "").toString().toLowerCase();
    const lot: LotFields = {
      status_id: byName.get(statusName) ?? defaultId,
      lot_number: a.LOT_NUMBER ?? a.LOT_LABEL ?? null,
      property_address: a.PROPERTY_ADDRESS ?? composeAddress(f.properties),
      list_price: a.LIST_PRICE ?? null,
      parcel_acres: a.PARCEL_ACRES ?? null,
      image_url: a.IMAGE_URL ?? null,
      video_url: a.VIDEO_URL ?? null,
      lot_page_url: a.LOT_PAGE_URL ?? null,
    };
    await upsertParcel(dev.id, pid, f.geometry, (f.properties.OWNERNAME as string) ?? null, f.properties, lot, true);
    imported++;
  }
  return { matched: ids.length, imported };
}

/** Generic import: every parcel in a drawn bbox, geometry-only, default status. */
export async function importByBbox(slug: string, bbox: Bbox): Promise<{ imported: number }> {
  const dev = await getDevelopment(slug);
  if (!dev) throw new Error("development not found");
  const statuses = await getStatuses(dev.id);
  const defaultId = statuses.find((s) => s.is_default)?.id ?? null;
  const feats = await fetchArcgisByBbox(bbox);
  let imported = 0;
  for (const f of feats) {
    const pid = (f.properties.PARCEL_ID as string) ?? "";
    if (!pid) continue;
    await upsertParcel(
      dev.id,
      pid,
      f.geometry,
      (f.properties.OWNERNAME as string) ?? null,
      f.properties,
      lotFromAssessor(f.properties, defaultId),
      false
    );
    imported++;
  }
  return { imported };
}

// Rough centroid of a GeoJSON geometry — average of its coordinate vertices.
// Good enough to recenter the opening camera on a freshly imported cluster.
function geomCenter(g: GeoJSON.Geometry): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  const walk = (a: unknown): void => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === "number" && typeof a[1] === "number") {
      sx += a[0] as number;
      sy += a[1] as number;
      n++;
      return;
    }
    for (const c of a) walk(c);
  };
  if ("coordinates" in g) walk((g as { coordinates: unknown }).coordinates);
  return n ? [sx / n, sy / n] : null;
}

/**
 * Acquire an explicit set of parcels (by PARCEL_ID) into a development: pull
 * clean geometry from ArcGIS, upsert with the default status + a composed
 * address. On a development's first import we also recenter its opening camera
 * onto the cluster, so the published map opens on the actual neighborhood.
 */
export async function importByParcelIds(
  slug: string,
  ids: string[]
): Promise<{ imported: number }> {
  const dev = await getDevelopment(slug);
  if (!dev) throw new Error("development not found");
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { imported: 0 };

  const statuses = await getStatuses(dev.id);
  const defaultId = statuses.find((s) => s.is_default)?.id ?? null;
  const feats = await fetchArcgisByParcelIds(uniq);

  let imported = 0;
  let cx = 0, cy = 0, cn = 0;
  for (const f of feats) {
    const pid = (f.properties.PARCEL_ID as string) ?? "";
    if (!pid) continue;
    await upsertParcel(
      dev.id,
      pid,
      f.geometry,
      (f.properties.OWNERNAME as string) ?? null,
      f.properties,
      lotFromAssessor(f.properties, defaultId),
      false
    );
    const c = geomCenter(f.geometry);
    if (c) {
      cx += c[0];
      cy += c[1];
      cn++;
    }
    imported++;
  }

  // First real import on a still-statewide camera → frame the new cluster.
  // Never override a view the operator has framed by hand.
  if (cn > 0 && !dev.view_locked && dev.default_view.zoom < 12) {
    const view: ViewState = { center: [cx / cn, cy / cn], zoom: 15.6, pitch: 62, bearing: 0 };
    await query("update developments set default_view = $1::jsonb where id = $2", [
      JSON.stringify(view),
      dev.id,
    ]);
  }
  return { imported };
}

// ---- Mutations --------------------------------------------------------------

const PARCEL_FIELDS = new Set([
  "status_id",
  "lot_number",
  "property_address",
  "list_price",
  "parcel_acres",
  "image_url",
  "video_url",
  "lot_page_url",
]);

export async function updateParcel(
  rowId: string,
  patch: Record<string, unknown>,
  properties?: Record<string, unknown>
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!PARCEL_FIELDS.has(k)) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (properties) {
    sets.push(`properties = $${i++}::jsonb`);
    vals.push(JSON.stringify(properties));
  }
  if (!sets.length) return;
  vals.push(rowId);
  await query(`update parcels set ${sets.join(", ")}, updated_at = now() where id = $${i}`, vals);
}

export async function createStatus(devId: string, s: Partial<Status>) {
  const id = randomUUID();
  await query(
    `insert into statuses (id, development_id, name, color, fill_opacity, sort_order, show_in_filter, is_default)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, devId, s.name ?? "New status", s.color ?? "#888888", s.fill_opacity ?? 0.75, s.sort_order ?? 99, s.show_in_filter ?? true, s.is_default ?? false]
  );
  return id;
}

export async function updateStatus(id: string, s: Partial<Status>) {
  const cols = ["name", "color", "fill_opacity", "sort_order", "show_in_filter", "is_default"] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const c of cols) {
    if (s[c] !== undefined) {
      sets.push(`${c} = $${i++}`);
      vals.push(s[c]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  await query(`update statuses set ${sets.join(", ")} where id = $${i}`, vals);
}

export async function deleteStatus(id: string) {
  await query("delete from statuses where id = $1 and is_default = false", [id]);
}

export async function createField(devId: string, f: Partial<FieldDef>) {
  const id = randomUUID();
  await query(
    `insert into field_defs (id, development_id, key, label, type, options, show_in_panel, filterable, sort_order)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [id, devId, f.key ?? `field_${id.slice(0, 6)}`, f.label ?? "New field", f.type ?? "text", JSON.stringify(f.options ?? null), f.show_in_panel ?? true, f.filterable ?? false, f.sort_order ?? 99]
  );
  return id;
}

export async function deleteField(id: string) {
  await query("delete from field_defs where id = $1", [id]);
}

export async function createFilter(devId: string, f: Partial<Filter>) {
  const id = randomUUID();
  await query(
    `insert into filters (id, development_id, label, field_key, match_values, sort_order)
     values ($1,$2,$3,$4,$5::jsonb,$6)`,
    [id, devId, f.label ?? "New filter", f.field_key ?? "status", JSON.stringify(f.match_values ?? []), f.sort_order ?? 99]
  );
  return id;
}

export async function deleteFilter(id: string) {
  await query("delete from filters where id = $1", [id]);
}

// ---- Publish ----------------------------------------------------------------

export async function publish(slug: string, note?: string) {
  const dev = await getDevelopment(slug);
  if (!dev) throw new Error("development not found");
  const config = await getDraftConfig(dev);
  const featureCollection = await getDraftParcels(dev.id);
  const id = randomUUID();
  await query(
    "insert into publications (id, development_id, snapshot, note) values ($1,$2,$3::jsonb,$4)",
    [id, dev.id, JSON.stringify({ config: { ...config, published_at: null }, featureCollection }), note ?? null]
  );
  return { id, count: featureCollection.features.length };
}

export async function listPublications(devId: string) {
  return query<{ id: string; note: string | null; published_at: string }>(
    "select id, note, published_at from publications where development_id = $1 order by published_at desc limit 20",
    [devId]
  );
}
