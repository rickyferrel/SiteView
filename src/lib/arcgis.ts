import "server-only";

// Data acquisition: parcel geometry + assessor attributes from the Utah GIS
// (gis.utah.gov / UGRC) LIR parcel service, and (one-time) enrichment of the
// user's existing lot data (status/lot#/price) from the live Mapbox tileset.
// Everything joins on PARCEL_ID.
//
// We deliberately use the *LIR* ("Land Information Records") service rather than
// the plain `Parcels_Utah` one: LIR carries the county assessor's data on the
// same geometry and PARCEL_ID — acreage (PARCEL_ACRES), market value
// (TOTAL_MKT_VALUE / LAND_MKT_VALUE), subdivision, property class, year built,
// building sqft — so a picked parcel can show price + acres with no extra call.
// Trade-off: LIR is per-county (this is Utah County) and omits OWNERNAME. For a
// sales map that's a good trade; other counties get their own `Parcels_<County>_LIR`.
const ARCGIS_QUERY =
  "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/Parcels_Utah_LIR/FeatureServer/0/query";

// Curated, normalized view of the assessor attributes we surface in the picker
// and persist on import. Numbers come back as numbers from the LIR service;
// everything is null when the assessor hasn't populated it for a parcel.
export type ParcelInfo = {
  acres: number | null;
  marketValue: number | null; // total assessed market value (land + improvements)
  landValue: number | null;
  propClass: string | null; // e.g. "Vacant", "Residential"
  subdivision: string | null;
  builtYr: number | null;
  bldgSqft: number | null;
  address: string | null;
  county: string | null;
};

const asNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const asStr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** Pull the assessor fields we care about out of a raw LIR feature's properties. */
export function parcelInfo(p: Record<string, unknown>): ParcelInfo {
  const address = [asStr(p.PARCEL_ADD), asStr(p.PARCEL_CITY)].filter(Boolean).join(", ");
  return {
    acres: asNum(p.PARCEL_ACRES),
    marketValue: asNum(p.TOTAL_MKT_VALUE),
    landValue: asNum(p.LAND_MKT_VALUE),
    propClass: asStr(p.PROP_CLASS),
    subdivision: asStr(p.SUBDIV_NAME),
    builtYr: asNum(p.BUILT_YR),
    bldgSqft: asNum(p.BLDG_SQFT),
    address: address || null,
    county: asStr(p.COUNTY_NAME),
  };
}

export type Bbox = [number, number, number, number]; // [west, south, east, north]

type ArcgisFeature = {
  type: "Feature";
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
};

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}…`);
  return (await res.json()) as Record<string, unknown>;
}

/** All parcels intersecting a bbox, following ArcGIS pagination. */
export async function fetchArcgisByBbox(bbox: Bbox, maxPages = 30): Promise<ArcgisFeature[]> {
  const pageSize = 1000;
  const out: ArcgisFeature[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${ARCGIS_QUERY}?where=${encodeURIComponent("1=1")}` +
      `&geometry=${bbox.join(",")}&geometryType=esriGeometryEnvelope` +
      `&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=*&f=geojson&resultRecordCount=${pageSize}&resultOffset=${page * pageSize}`;
    const g = await getJson(url);
    const feats = (g.features as ArcgisFeature[] | undefined) ?? [];
    out.push(...feats);
    if (feats.length < pageSize) break;
  }
  return out;
}

/** Geometry for an explicit set of PARCEL_IDs (chunked IN queries). */
export async function fetchArcgisByParcelIds(ids: string[]): Promise<ArcgisFeature[]> {
  const out: ArcgisFeature[] = [];
  const chunk = 150;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const inList = slice.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const url =
      `${ARCGIS_QUERY}?where=${encodeURIComponent(`PARCEL_ID IN (${inList})`)}` +
      `&outFields=*&outSR=4326&f=geojson&resultRecordCount=${chunk}`;
    const g = await getJson(url);
    out.push(...(((g.features as ArcgisFeature[] | undefined) ?? [])));
  }
  return out;
}

// ---- Mapbox tileset enrichment (existing lot attributes) --------------------

export type LotAttrs = {
  SALES_STATUS?: string;
  LOT_NUMBER?: string;
  LOT_LABEL?: string;
  LIST_PRICE?: string;
  PARCEL_ACRES?: string;
  PROPERTY_ADDRESS?: string;
  IMAGE_URL?: string;
  VIDEO_URL?: string;
  LOT_PAGE_URL?: string;
};

function gridPoints(bbox: Bbox, step: number): [number, number][] {
  const [w, s, e, n] = bbox;
  const pts: [number, number][] = [];
  for (let lng = w; lng <= e + step; lng += step)
    for (let lat = s; lat <= n + step; lat += step) pts.push([lng, lat]);
  return pts;
}

async function runBatched<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

/**
 * Sample the existing Mapbox tileset across a bbox grid and collect every lot's
 * marketing attributes, keyed by PARCEL_ID. This is how we migrate your current
 * statuses/lot numbers/prices into the portal on first import.
 */
export async function collectMapboxLots(
  token: string,
  tileset: string,
  bbox: Bbox
): Promise<Map<string, LotAttrs>> {
  const byId = new Map<string, LotAttrs>();
  const pts = gridPoints(bbox, 0.01);
  await runBatched(pts, 6, async ([lng, lat]) => {
    const url =
      `https://api.mapbox.com/v4/${tileset}/tilequery/${lng},${lat}.json` +
      `?radius=1000&limit=50&dedupe=true&geometry=polygon&access_token=${token}`;
    try {
      const g = await getJson(url);
      for (const f of (g.features as ArcgisFeature[] | undefined) ?? []) {
        const p = f.properties as LotAttrs & { PARCEL_ID?: string };
        if (p.PARCEL_ID && !byId.has(p.PARCEL_ID)) byId.set(p.PARCEL_ID, p);
      }
    } catch {
      /* tolerate individual sample failures */
    }
  });
  return byId;
}

// The existing Summit Creek lot tileset + its full extent (from its TileJSON).
export const SUMMIT_CREEK_TILESET = "tbelliston45.tw32i6178auc";
export const SUMMIT_CREEK_BBOX: Bbox = [-111.708984, 39.97712, -111.621094, 40.044438];
