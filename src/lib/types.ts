// Shared domain types for the Map Portal.

export type ViewState = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  // Container size (px) the view was framed in. Zoom is pixels-per-meter, so the
  // same zoom frames ~3x less ground on a phone than on a desktop iframe; the
  // embed rescales zoom against this reference so the *framing* survives the
  // trip. Absent on views saved before this existed — those render as-is.
  size?: [number, number];
};

// How the embed renders the basemap. "custom" keeps the development's own
// Mapbox style; the rest are stock Mapbox styles the operator can switch to.
export type Basemap = "custom" | "standard" | "clay" | "satellite-streets" | "outdoors" | "light" | "dark";

export type MapAppearance = {
  basemap: Basemap;
  terrain: boolean;
  terrainExaggeration: number;
  // Raster color grading applied to the "satellite-streets" basemap's imagery
  // layer only (its roads/labels are separate vector layers, untouched) — lets
  // the operator counteract off-season (e.g. winter/dead-grass) aerial photos.
  satelliteHueRotate: number; // degrees, -180..180
  satelliteSaturation: number; // -1..1
};

export const DEFAULT_APPEARANCE: MapAppearance = {
  basemap: "custom",
  terrain: true,
  terrainExaggeration: 1.5,
  satelliteHueRotate: 0,
  satelliteSaturation: 0,
};

export const BASEMAP_PRESETS: Record<Exclude<Basemap, "custom">, string> = {
  standard: "mapbox://styles/mapbox/standard",
  // "Clay" rides on the Standard style; the cartoon look comes from STANDARD_CONFIG.
  clay: "mapbox://styles/mapbox/standard",
  "satellite-streets": "mapbox://styles/mapbox/satellite-streets-v12",
  outdoors: "mapbox://styles/mapbox/outdoors-v12",
  light: "mapbox://styles/mapbox/light-v11",
  dark: "mapbox://styles/mapbox/dark-v11",
};

// Per-basemap configuration for Mapbox Standard, applied after the style loads.
// "clay" leans on Standard's soft, rounded 3D plus a faded/pastel theme to get
// the claymation, toy-like feel.
export const STANDARD_CONFIG: Partial<Record<Basemap, Record<string, string | boolean>>> = {
  clay: { lightPreset: "day", theme: "faded", show3dObjects: true },
};

export const BASEMAP_OPTIONS: { key: Basemap; label: string; desc: string }[] = [
  { key: "custom", label: "Branded", desc: "Your tuned development style" },
  { key: "outdoors", label: "Topographic", desc: "Contours + terrain shading" },
  { key: "clay", label: "Clay", desc: "Soft, cartoony 3D" },
  { key: "satellite-streets", label: "Satellite", desc: "Aerial imagery + labels" },
  { key: "standard", label: "Standard", desc: "Mapbox 3D default" },
  { key: "light", label: "Light", desc: "Minimal, pale basemap" },
  { key: "dark", label: "Dark", desc: "Minimal, dark basemap" },
];

// Resolves the effective Mapbox style URL for a development's chosen basemap.
export function resolveMapStyle(devStyle: string, basemap: Basemap): string {
  return basemap === "custom" ? devStyle : BASEMAP_PRESETS[basemap];
}

// The hand-made Summit Creek lot tileset the DB was migrated from. The custom
// Studio style still contains layers painting those lots (with their frozen
// pre-migration colors), so every style consumer must hide them — otherwise a
// lot removed in the portal appears to linger, painted by the basemap.
export const LEGACY_LOT_TILESET = "tbelliston45.tw32i6178auc";

export function hideLegacyLotLayers(map: {
  getStyle(): unknown;
  setLayoutProperty(layerId: string, name: string, value: string): void;
}) {
  const style = map.getStyle() as {
    sources?: Record<string, { url?: string }>;
    layers?: Array<{ id: string; source?: string }>;
  } | null;
  const legacySources = new Set(
    Object.entries(style?.sources ?? {})
      .filter(([id, s]) => id.includes(LEGACY_LOT_TILESET) || (s.url ?? "").includes(LEGACY_LOT_TILESET))
      .map(([id]) => id)
  );
  if (!legacySources.size) return;
  for (const layer of style?.layers ?? []) {
    if (layer.source && legacySources.has(layer.source)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

// Applies the operator's satellite color grading to every raster layer in the
// loaded style (i.e. the aerial imagery layer of "satellite-streets" — its
// road/label overlay is vector, so this can't discolor them). No-op unless a
// non-zero adjustment is set.
export function applySatelliteTint(
  map: {
    getStyle(): unknown;
    setPaintProperty(layerId: string, name: string, value: number): void;
  },
  appearance: MapAppearance
) {
  const hueRotate = appearance.satelliteHueRotate || 0;
  const saturation = appearance.satelliteSaturation || 0;
  if (!hueRotate && !saturation) return;
  const style = map.getStyle() as { layers?: Array<{ id: string; type: string }> } | null;
  for (const layer of style?.layers ?? []) {
    if (layer.type !== "raster") continue;
    map.setPaintProperty(layer.id, "raster-hue-rotate", hueRotate);
    map.setPaintProperty(layer.id, "raster-saturation", saturation);
  }
}

export type Development = {
  id: string;
  slug: string;
  name: string;
  mapbox_token: string;
  mapbox_style: string;
  default_view: ViewState;
  // When true the embed opens exactly at default_view; when false it auto-fits
  // the lot cluster on first open. Set once the operator frames the view by hand.
  view_locked: boolean;
  stop_views: Record<string, ViewState>;
  terrain_exaggeration: number;
  map_appearance: MapAppearance;
};

// What the operator provides to spin up a new development.
export type DevelopmentInput = {
  slug: string;
  name: string;
  mapbox_token: string;
  mapbox_style: string;
  default_view?: ViewState;
};

// Lightweight row for the client switcher — one per development.
export type DevelopmentSummary = {
  id: string;
  slug: string;
  name: string;
  parcel_count: number;
};

export type Status = {
  id: string;
  development_id: string;
  name: string;
  color: string;
  fill_opacity: number;
  sort_order: number;
  show_in_filter: boolean;
  is_default: boolean;
};

export type FieldType = "text" | "number" | "money" | "url" | "select" | "bool";

export type FieldDef = {
  id: string;
  development_id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  show_in_panel: boolean;
  filterable: boolean;
  sort_order: number;
};

export type Filter = {
  id: string;
  development_id: string;
  label: string;
  field_key: string; // "status" or a field_defs.key
  match_values: string[];
  sort_order: number;
};

export type Parcel = {
  id: string;
  development_id: string;
  parcel_id: string;
  geometry: GeoJSON.Geometry;
  status_id: string | null;
  lot_number: string | null;
  property_address: string | null;
  list_price: string | null;
  parcel_acres: string | null;
  image_url: string | null;
  video_url: string | null;
  lot_page_url: string | null;
  owner_name: string | null;
  properties: Record<string, unknown>;
  source_attrs: Record<string, unknown>;
  updated_at: string;
};

// ---- Map layers -------------------------------------------------------------
// Non-parcel features on the map: a pinned site-plan render, or a drawn shape
// standing in for a river / pond / green when there's no render to pin.

export type LayerKind = "image" | "shape";

// The four ground corners an image overlay is pinned to, in Mapbox's required
// TL, TR, BR, BL order. Out-of-order corners bowtie-warp the texture silently
// rather than erroring, so always build these through `cornersFromRect()`.
export type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

// How a line is painted. "solid" is one flat stroke — right for a boundary or a
// trail. "river" paints the same vertex list in three passes (soft dark bank,
// water body, light sheen just off the middle) so it reads as water rather than
// as a line someone drew. LineString only: an area is always a flat fill.
export type LineLook = "solid" | "river";

export type ShapeStyle = {
  color: string;
  width: number; // line width in px (LineString only)
  fillOpacity: number; // 0..1 (Polygon only)
  look: LineLook; // LineString only
  // Text drawn on the shape itself: along the line for a line, at the centroid
  // for an area. "" → no label layer at all, which is the default.
  label: string;
  labelSize: number; // px
  labelColor: string; // halo is derived from it, so text stays legible either way

  // ---- The card a visitor opens by clicking the shape ----------------------
  // A shape becomes clickable exactly when one of these is filled in — see
  // `shapeInfo()` in lib/layers.ts. Scenery with nothing to say stays scenery
  // and lets clicks fall through to the lot underneath it.
  //
  // These live on `style` rather than in columns of their own on purpose: the
  // whole blob is jsonb read through DEFAULT_SHAPE_STYLE, so adding them needs
  // no migration, they publish with the rest of the config, and shapes drawn
  // before they existed read back as plain, unclickable scenery.
  infoTitle: string; // "" → the layer's name is the heading
  infoBody: string;
  infoImage: string; // http(s) only, enforced server-side
  infoVideo: string; // same pipeline as a lot's video_url
  infoLink: string;
  infoLinkLabel: string; // "" → "Learn more"
};

export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  color: "#4a7fb5",
  width: 6,
  fillOpacity: 0.55,
  look: "solid",
  label: "",
  labelSize: 14,
  labelColor: "#ffffff",
  infoTitle: "",
  infoBody: "",
  infoImage: "",
  infoVideo: "",
  infoLink: "",
  infoLinkLabel: "",
};

export type Layer = {
  id: string;
  development_id: string;
  kind: LayerKind;
  name: string;
  sort_order: number;
  visible: boolean;
  opacity: number;
  // false → drawn beneath every parcel layer; true → above the parcel fill but
  // still below the lot-number labels, so numbers stay legible over a render.
  above_lots: boolean;
  // Surfaces this layer in the embed's collapsed "Layers" checklist.
  visitor_toggle: boolean;
  // kind="image": the opaque id bytes are fetched from /api/asset/{id} under.
  asset_id: string | null;
  corners: Corners | null;
  // kind="shape": a GeoJSON LineString or Polygon.
  geometry: GeoJSON.Geometry | null;
  style: ShapeStyle;
};

// What the embed map consumes for a development.
export type MapConfig = {
  development: Development;
  statuses: Status[];
  fields: FieldDef[];
  filters: Filter[];
  layers: Layer[];
  published_at: string | null;
};

export type DataState = "draft" | "published";
