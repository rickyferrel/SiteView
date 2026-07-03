// Normalize an operator-uploaded GeoJSON payload into importable parcels.
// Shared by the upload UI (pre-flight summary) and the import API (the
// authoritative pass), so the summary the operator approves is exactly what
// the server imports. Pure module — no server-only imports.

export type NormalizedParcel = {
  parcel_id: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  properties: Record<string, unknown>;
  lot: {
    lot_number: string | null;
    property_address: string | null;
    list_price: string | null;
    parcel_acres: string | null;
  };
};

export type NormalizeResult = {
  parcels: NormalizedParcel[];
  /** Non-polygon features (points, lines, geometry collections) dropped. */
  skipped: number;
  warnings: string[];
};

// Property keys (matched case-insensitively) that can serve as the parcel ID.
// Ordered by specificity — the first present on a feature wins.
const ID_KEYS = [
  "parcel_id", "parcelid", "parcel", "apn", "pin", "tax_id", "taxid",
  "parcel_no", "parcel_num", "lot_id", "lot_number", "lotnumber", "lot",
  "id", "name", "label",
];

const LOT_NUMBER_KEYS = ["lot_number", "lotnumber", "lot_no", "lot_num", "lot", "name", "label"];
const ACRES_KEYS = ["parcel_acres", "acres", "acreage", "gis_acres", "area_acres"];
const ADDRESS_KEYS = ["property_address", "address", "situs_address", "situs", "parcel_add", "full_address"];
const PRICE_KEYS = ["list_price", "price", "asking_price"];

function lowerProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k.toLowerCase()] = v;
  return out;
}

function pick(lower: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = lower[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

// Every vertex must look like [longitude, latitude]. A CAD/GIS export in a
// projected system (State Plane, UTM — coordinates in feet/meters) fails this
// immediately, which is the most common way a "bad" file arrives.
function assertWgs84(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  const walk = (a: unknown): void => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === "number" && typeof a[1] === "number") {
      const [x, y] = a as [number, number];
      if (Math.abs(x) > 180 || Math.abs(y) > 90) {
        throw new Error(
          `Coordinates aren't longitude/latitude — found a point like (${Math.round(x)}, ${Math.round(y)}). ` +
            "CAD/GIS exports are often in a projected system (State Plane, UTM); re-export as WGS84 (EPSG:4326)."
        );
      }
      return;
    }
    for (const c of a) walk(c);
  };
  walk(geometry.coordinates);
}

function toFeatures(input: unknown): GeoJSON.Feature[] {
  const v = input as { type?: string; features?: unknown; coordinates?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.type !== "string") {
    throw new Error("Not GeoJSON — expected a FeatureCollection, Feature, or geometry object.");
  }
  if (v.type === "FeatureCollection") {
    if (!Array.isArray(v.features)) throw new Error("FeatureCollection has no features array.");
    return v.features as GeoJSON.Feature[];
  }
  if (v.type === "Feature") return [v as unknown as GeoJSON.Feature];
  if ("coordinates" in v) {
    return [{ type: "Feature", geometry: v as unknown as GeoJSON.Geometry, properties: {} }];
  }
  throw new Error(`Unsupported GeoJSON type "${v.type}".`);
}

/**
 * Round every vertex to `decimals` places (default 6 ≈ 11 cm on the ground) —
 * survey exports often carry 12+ decimals, which can triple payload size for
 * precision no display map can show.
 */
export function roundGeometry<G extends GeoJSON.Polygon | GeoJSON.MultiPolygon>(g: G, decimals = 6): G {
  const f = 10 ** decimals;
  const walk = (a: unknown): unknown =>
    Array.isArray(a)
      ? typeof a[0] === "number"
        ? (a as number[]).map((n) => Math.round(n * f) / f)
        : a.map(walk)
      : a;
  return { type: g.type, coordinates: walk(g.coordinates) } as G;
}

/**
 * Turn arbitrary uploaded GeoJSON into parcels ready for import: keep
 * Polygon/MultiPolygon features, verify WGS84 coordinates, derive a parcel ID
 * from recognizable properties (generating LOT-001-style IDs when absent), and
 * map obvious lot fields (lot #, acres, address, price). Throws with a
 * user-readable message on hard failures.
 */
export function normalizeGeoJSON(input: unknown): NormalizeResult {
  const features = toFeatures(input);
  const warnings: string[] = [];
  const parcels: NormalizedParcel[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  let generated = 0;
  let deduped = 0;

  for (const f of features) {
    const g = f?.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) {
      skipped++;
      continue;
    }
    assertWgs84(g);

    const props = (f.properties ?? {}) as Record<string, unknown>;
    const lower = lowerProps(props);

    let pid = pick(lower, ID_KEYS) ?? (typeof f.id === "string" || typeof f.id === "number" ? String(f.id) : null);
    if (!pid) {
      generated++;
      pid = `LOT-${String(parcels.length + 1).padStart(3, "0")}`;
    }
    const n = seen.get(pid) ?? 0;
    seen.set(pid, n + 1);
    if (n > 0) {
      deduped++;
      pid = `${pid}-${n + 1}`;
    }

    parcels.push({
      parcel_id: pid,
      geometry: g,
      properties: props,
      lot: {
        lot_number: pick(lower, LOT_NUMBER_KEYS),
        property_address: pick(lower, ADDRESS_KEYS),
        list_price: pick(lower, PRICE_KEYS),
        parcel_acres: pick(lower, ACRES_KEYS),
      },
    });
  }

  if (parcels.length === 0) {
    throw new Error(
      skipped > 0
        ? "No polygon features in this file — only points/lines were found. Lots must be polygons."
        : "No features found in this file."
    );
  }
  if (skipped > 0) warnings.push(`${skipped} non-polygon feature${skipped === 1 ? "" : "s"} (points/lines) skipped.`);
  if (generated > 0)
    warnings.push(`${generated} feature${generated === 1 ? " had" : "s had"} no recognizable ID property — sequential lot IDs were generated.`);
  if (deduped > 0) warnings.push(`${deduped} duplicate parcel ID${deduped === 1 ? "" : "s"} in the file — suffixed to keep them distinct.`);

  return { parcels, skipped, warnings };
}
