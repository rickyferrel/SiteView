import type mapboxgl from "mapbox-gl";
import type { FieldDef, LabelWeight, LotLabels } from "./types";
import { DEFAULT_LOT_LABELS } from "./types";
import { money, acres } from "./format";

/**
 * The text printed on each lot, built one way for every map that shows lots to
 * a visitor — the embed, the opening-view editor, and the live preview on Map
 * Design — so a label the operator styles is exactly the label the visitor reads.
 *
 * Text is resolved here in JS and stamped onto each feature rather than written
 * as a Mapbox expression: prices are stored as operator-typed strings ("$425,000")
 * that `to-number` can't parse, and stamping lets the label reuse the same
 * `money()`/`acres()` the lot panel uses.
 */

// Stamped by `withLotLabels()`; the symbol layer reads only these.
const LINE1 = "__label";
const LINE2 = "__label2";
const RANK = "__labelRank"; // 0 = typed by the operator, placed first

type FontFamily = {
  family: string;
  kind: "Sans" | "Serif" | "Mono" | "Condensed";
  // Google Fonts family the portal's font picker previews the face with. The
  // map itself never loads these — it draws Mapbox's own glyphs.
  css: string;
  weights: Partial<Record<LabelWeight, string>>;
};

// Every font here was checked against the Mapbox Fonts API (`mapbox` user,
// which every basemap's `glyphs` URL points at). A font Mapbox can't serve
// doesn't error — the labels just silently vanish — so don't add one unverified.
export const LABEL_FONTS: FontFamily[] = [
  { family: "Open Sans", kind: "Sans", css: "Open Sans", weights: { regular: "Open Sans Regular", medium: "Open Sans Semibold", bold: "Open Sans Bold" } },
  { family: "DIN Pro", kind: "Sans", css: "Barlow", weights: { regular: "DIN Pro Regular", medium: "DIN Pro Medium", bold: "DIN Pro Bold" } },
  { family: "Inter", kind: "Sans", css: "Inter", weights: { regular: "Inter Regular", medium: "Inter Medium", bold: "Inter Bold" } },
  { family: "Roboto", kind: "Sans", css: "Roboto", weights: { regular: "Roboto Regular", medium: "Roboto Medium", bold: "Roboto Bold" } },
  { family: "Montserrat", kind: "Sans", css: "Montserrat", weights: { regular: "Montserrat Regular", medium: "Montserrat Medium", bold: "Montserrat Bold" } },
  { family: "Lato", kind: "Sans", css: "Lato", weights: { regular: "Lato Regular", medium: "Lato Medium", bold: "Lato Bold" } },
  { family: "Poppins", kind: "Sans", css: "Poppins", weights: { regular: "Poppins Regular", medium: "Poppins Medium", bold: "Poppins Bold" } },
  { family: "Raleway", kind: "Sans", css: "Raleway", weights: { regular: "Raleway Regular", medium: "Raleway Medium", bold: "Raleway Bold" } },
  { family: "Source Sans Pro", kind: "Sans", css: "Source Sans 3", weights: { regular: "Source Sans Pro Regular", medium: "Source Sans Pro Semibold", bold: "Source Sans Pro Bold" } },
  { family: "Barlow", kind: "Sans", css: "Barlow", weights: { regular: "Barlow Regular", medium: "Barlow Medium", bold: "Barlow Bold" } },
  { family: "Ubuntu", kind: "Sans", css: "Ubuntu", weights: { regular: "Ubuntu Regular", medium: "Ubuntu Medium", bold: "Ubuntu Bold" } },
  { family: "Oswald", kind: "Condensed", css: "Oswald", weights: { regular: "Oswald Regular", medium: "Oswald Medium", bold: "Oswald Bold" } },
  { family: "Playfair Display", kind: "Serif", css: "Playfair Display", weights: { regular: "Playfair Display Regular", bold: "Playfair Display Bold" } },
  { family: "Merriweather", kind: "Serif", css: "Merriweather", weights: { regular: "Merriweather Regular", bold: "Merriweather Bold" } },
  { family: "PT Serif", kind: "Serif", css: "PT Serif", weights: { regular: "PT Serif Regular", bold: "PT Serif Bold" } },
  { family: "Frank Ruhl Libre", kind: "Serif", css: "Frank Ruhl Libre", weights: { regular: "Frank Ruhl Libre Regular", medium: "Frank Ruhl Libre Medium", bold: "Frank Ruhl Libre Bold" } },
  { family: "EB Garamond", kind: "Serif", css: "EB Garamond", weights: { regular: "EB Garamond Regular", bold: "EB Garamond Bold" } },
  { family: "Roboto Mono", kind: "Mono", css: "Roboto Mono", weights: { regular: "Roboto Mono Regular", medium: "Roboto Mono Medium", bold: "Roboto Mono Bold" } },
  { family: "Source Code Pro", kind: "Mono", css: "Source Code Pro", weights: { regular: "Source Code Pro Regular", medium: "Source Code Pro Medium", bold: "Source Code Pro Bold" } },
];

const FONT_BY_FAMILY = new Map(LABEL_FONTS.map((f) => [f.family, f]));

export const LABEL_WEIGHTS: { value: LabelWeight; label: string }[] = [
  { value: "regular", label: "Regular" },
  { value: "medium", label: "Medium" },
  { value: "bold", label: "Bold" },
];

export function fontFor(family: string): FontFamily {
  return FONT_BY_FAMILY.get(family) ?? FONT_BY_FAMILY.get(DEFAULT_LOT_LABELS.font)!;
}

// Arial Unicode MS rides behind every face so an accented street name or a
// non-Latin character still gets a glyph instead of a gap.
function fontStack(family: string, weight: LabelWeight): string[] {
  const f = fontFor(family);
  return [
    f.weights[weight] ?? f.weights.regular!,
    weight === "bold" ? "Arial Unicode MS Bold" : "Arial Unicode MS Regular",
  ];
}

// The lot columns holding text the operator typed for one lot, line one and
// line two. Each always wins over its development-wide line (see
// `lotLabelText`); picking CUSTOM_LABEL as the field too means "only the lots I
// typed something for".
export const CUSTOM_LABEL = "map_label";
export const CUSTOM_LABEL2 = "map_label2";

/** Whether the operator typed either line for this lot. */
export function hasTypedLabel(props: Record<string, unknown>): boolean {
  return [CUSTOM_LABEL, CUSTOM_LABEL2].some((k) => String(props[k] ?? "").trim() !== "");
}

// What a lot can be labelled with. URL and yes/no fields are left out: neither
// reads as anything when printed on a lot.
const CORE_FIELDS: { key: string; label: string }[] = [
  { key: "lot_number", label: "Lot number" },
  { key: "property_address", label: "Address" },
  { key: "list_price", label: "Price" },
  { key: "parcel_acres", label: "Acres" },
  { key: "status", label: "Status" },
  { key: CUSTOM_LABEL, label: "Custom label only" },
];

export function labelFieldOptions(fields: FieldDef[]): { key: string; label: string }[] {
  return [
    ...CORE_FIELDS,
    ...fields.filter((f) => f.type !== "url" && f.type !== "bool").map((f) => ({ key: f.key, label: f.label })),
  ];
}

function fieldText(props: Record<string, unknown>, key: string, fields: FieldDef[]): string {
  if (!key) return "";
  const v = props[key] == null ? "" : String(props[key]).trim();
  if (!v) return "";
  if (key === "list_price") return money(v);
  if (key === "parcel_acres") {
    const a = acres(v);
    return a ? `${a} ac` : "";
  }
  if (fields.find((f) => f.key === key)?.type === "money") return money(v);
  return v;
}

/** Line one, line two — what a single lot's label will read. */
export function lotLabelText(
  props: Record<string, unknown>,
  l: LotLabels,
  fields: FieldDef[]
): [string, string] {
  // A label pointed at a custom field that has since been deleted goes back to
  // the lot number instead of quietly blanking every lot on the map.
  const known = (k: string) => CORE_FIELDS.some((c) => c.key === k) || fields.some((f) => f.key === k);
  const field = known(l.field) ? l.field : DEFAULT_LOT_LABELS.field;
  const field2 = known(l.field2) && l.field2 !== field && l.field2 !== CUSTOM_LABEL ? l.field2 : "";

  // Typed text is printed as typed — no prefix: "Lot Clubhouse" helps no one.
  const custom = fieldText(props, CUSTOM_LABEL, fields);
  const custom2 = fieldText(props, CUSTOM_LABEL2, fields);
  if (!custom && !custom2 && field === CUSTOM_LABEL) return ["", ""]; // "only the lots I typed for"
  let one = custom || fieldText(props, field, fields);
  let two = custom2 || fieldText(props, field2, fields);
  if (one && !custom) {
    // "Lot" and "Lot " both mean "Lot 12"; "#" means "#12".
    const pre = l.prefix.trimEnd();
    if (pre) one = /[\p{L}\p{N}]$/u.test(pre) ? `${pre} ${one}` : `${pre}${one}`;
  } else if (!one) {
    // A lot with no number but a price shows the price, not an empty top line.
    one = two;
    two = "";
  }
  return [one, two];
}

/** Copies the collection with each lot's label text stamped on its properties. */
export function withLotLabels(
  fc: GeoJSON.FeatureCollection,
  l: LotLabels,
  fields: FieldDef[]
): GeoJSON.FeatureCollection {
  return {
    ...fc,
    features: fc.features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const [one, two] = lotLabelText(props, l, fields);
      const rank = hasTypedLabel(props) ? 0 : 1;
      return { ...f, properties: { ...props, [LINE1]: one, [LINE2]: two, [RANK]: rank } };
    }),
  };
}

// Line two is a touch smaller, so "Lot 12 / $425,000" reads as a name and a
// detail rather than two competing headlines.
const TEXT_FIELD = [
  "case",
  ["==", ["coalesce", ["get", LINE2], ""], ""],
  ["format", ["coalesce", ["get", LINE1], ""], {}],
  ["format", ["coalesce", ["get", LINE1], ""], {}, "\n", {}, ["get", LINE2], { "font-scale": 0.85 }],
] as unknown as mapboxgl.ExpressionSpecification;

function layout(l: LotLabels) {
  return {
    visibility: l.show ? "visible" : "none",
    "text-field": TEXT_FIELD,
    "text-font": fontStack(l.font, l.weight),
    "text-size": l.size,
    "text-transform": l.uppercase ? "uppercase" : "none",
    "text-letter-spacing": l.letterSpacing,
    "text-allow-overlap": l.allowOverlap,
    // When labels collide, typed ones are placed first and a neighbor's number
    // is the one dropped. "Clubhouse" is wider than "31" and would otherwise
    // lose to the lots around it — and a label the operator typed and can't
    // see reads as a bug.
    "symbol-sort-key": ["coalesce", ["get", RANK], 1] as mapboxgl.ExpressionSpecification,
  };
}

function paint(l: LotLabels) {
  return {
    "text-color": l.color,
    "text-halo-color": l.haloColor,
    "text-halo-width": l.haloWidth,
    "text-opacity": l.opacity,
  };
}

/** The lot-label symbol layer. Its source must hold `withLotLabels()` output. */
export function lotLabelLayer(id: string, source: string, l: LotLabels): mapboxgl.SymbolLayerSpecification {
  return {
    id,
    type: "symbol",
    source,
    minzoom: l.minZoom,
    layout: layout(l) as mapboxgl.SymbolLayerSpecification["layout"],
    paint: paint(l),
  };
}

type LayoutName = Parameters<mapboxgl.Map["setLayoutProperty"]>[1];
type PaintName = Parameters<mapboxgl.Map["setPaintProperty"]>[1];

/** Restyles an existing label layer in place — the live preview's path. */
export function applyLotLabels(map: mapboxgl.Map, id: string, l: LotLabels) {
  if (!map.getLayer(id)) return;
  for (const [k, v] of Object.entries(layout(l))) map.setLayoutProperty(id, k as LayoutName, v);
  for (const [k, v] of Object.entries(paint(l))) map.setPaintProperty(id, k as PaintName, v);
  map.setLayerZoomRange(id, l.minZoom, 24);
}

// Starting points for the look. Each sets only how the text is drawn, never what
// it says or when it shows — picking a preset can't blank out the labels.
export const LABEL_PRESETS: { name: string; hint: string; style: Partial<LotLabels> }[] = [
  {
    name: "Classic",
    hint: "The original: small white text, thin dark outline",
    style: { font: "Open Sans", weight: "regular", size: 12, uppercase: false, letterSpacing: 0, color: "#ffffff", haloColor: "#000000", haloWidth: 1, opacity: 0.85 },
  },
  {
    name: "Bold",
    hint: "Heavier and larger, for wide views",
    style: { font: "DIN Pro", weight: "bold", size: 15, uppercase: false, letterSpacing: 0, color: "#ffffff", haloColor: "#0d1320", haloWidth: 1.5, opacity: 1 },
  },
  {
    name: "Minimal",
    hint: "Small caps, airy spacing",
    style: { font: "Inter", weight: "medium", size: 11, uppercase: true, letterSpacing: 0.12, color: "#ffffff", haloColor: "#0d1320", haloWidth: 0.8, opacity: 0.95 },
  },
  {
    name: "Signage",
    hint: "Condensed capitals, warm white",
    style: { font: "Oswald", weight: "medium", size: 15, uppercase: true, letterSpacing: 0.04, color: "#fff4df", haloColor: "#3a2a14", haloWidth: 1.5, opacity: 1 },
  },
  {
    name: "Estate",
    hint: "A serif with some ceremony",
    style: { font: "Playfair Display", weight: "bold", size: 14, uppercase: false, letterSpacing: 0.01, color: "#ffffff", haloColor: "#1b2433", haloWidth: 1.2, opacity: 1 },
  },
  {
    name: "Ink",
    hint: "Dark text for light or topo basemaps",
    style: { font: "Montserrat", weight: "bold", size: 12, uppercase: false, letterSpacing: 0.02, color: "#141a26", haloColor: "#ffffff", haloWidth: 1.5, opacity: 1 },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;
const KEY = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Reads stored or posted label settings, falling back to `base` key by key —
 * so a row from before labels existed reads as the original look, and a PATCH
 * carrying one bad value keeps the rest. The appearance route sanitizes with
 * this too: there is exactly one definition of a valid label.
 */
export function readLotLabels(raw: unknown, base: LotLabels = DEFAULT_LOT_LABELS): LotLabels {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  const color = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);

  const font = typeof r.font === "string" && FONT_BY_FAMILY.has(r.font) ? r.font : base.font;
  const wanted = LABEL_WEIGHTS.some((w) => w.value === r.weight) ? (r.weight as LabelWeight) : base.weight;
  // A weight this family doesn't come in falls back to regular rather than
  // asking Mapbox for a font that isn't there.
  const weight = fontFor(font).weights[wanted] ? wanted : "regular";

  return {
    show: bool(r.show, base.show),
    field: typeof r.field === "string" && KEY.test(r.field) ? r.field : base.field,
    field2: r.field2 === "" || (typeof r.field2 === "string" && KEY.test(r.field2)) ? (r.field2 as string) : base.field2,
    prefix: typeof r.prefix === "string" ? r.prefix.slice(0, 24) : base.prefix,
    font,
    weight,
    size: num(r.size, base.size, 8, 36),
    uppercase: bool(r.uppercase, base.uppercase),
    letterSpacing: num(r.letterSpacing, base.letterSpacing, 0, 0.5),
    color: color(r.color, base.color),
    haloColor: color(r.haloColor, base.haloColor),
    haloWidth: num(r.haloWidth, base.haloWidth, 0, 4),
    opacity: num(r.opacity, base.opacity, 0, 1),
    minZoom: num(r.minZoom, base.minZoom, 0, 20),
    allowOverlap: bool(r.allowOverlap, base.allowOverlap),
  };
}
