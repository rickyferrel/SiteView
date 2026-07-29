// Geometry for drawn shape layers — an area, a line, or a freehand stroke
// standing in for a pond, a river or a green when there's no render to pin.
//
// Pure (no Mapbox, no DOM) for the same reason `layers.ts` is: the editor and
// both API routes have to agree on what a shape *is*, and geometry that only
// exists inside a component can't be checked on the way into the DB.
//
// **The working vertex list is always OPEN** — no duplicated closing point, even
// for an area. Closing a ring is GeoJSON's requirement, not the operator's
// mental model, so it happens in exactly one place (`polygonFrom`) and is undone
// in exactly one place (`shapePoints`). Everything in between — dragging,
// inserting, deleting a vertex — is then a plain array operation that never has
// to special-case "the last point is secretly the first one".

import { toMerc, fromMerc, type Pt } from "./layers";
import { DEFAULT_SHAPE_STYLE, type ShapeStyle } from "./types";

export type LngLat = [number, number];

/** How the operator puts points down. All three end up as the same GeoJSON. */
export type ShapeTool = "area" | "line" | "freehand";

// A ring needs three corners to enclose anything; a line needs two ends. Below
// these a shape isn't degenerate-looking, it's *not a shape*, so drawing won't
// finish and vertex deletion refuses rather than producing invalid GeoJSON.
export const MIN_AREA_POINTS = 3;
export const MIN_LINE_POINTS = 2;

// Two positions closer than this are the same click. Degrees, so ~1e-11 of a
// degree — far below what a pointer can express at any zoom Mapbox allows.
const EPS = 1e-11;

function same(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
}

/** Drop consecutive duplicates — a double-click and freehand both produce them. */
export function dedupe<T extends readonly number[]>(pts: readonly T[]): T[] {
  return pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
}

/* ---- Building geometry --------------------------------------------------- */

/**
 * Close an open vertex list into a Polygon. Tolerates a list that already
 * repeats its first point at the end (the operator clicked the first vertex to
 * close), so both ways of finishing a ring converge on one representation.
 */
export function polygonFrom(points: readonly LngLat[]): GeoJSON.Polygon | null {
  const p = dedupe(points);
  if (p.length > 1 && same(p[0], p[p.length - 1])) p.pop();
  if (p.length < MIN_AREA_POINTS) return null;
  return { type: "Polygon", coordinates: [[...p, p[0]]] };
}

export function lineFrom(points: readonly LngLat[]): GeoJSON.LineString | null {
  const p = dedupe(points);
  if (p.length < MIN_LINE_POINTS) return null;
  return { type: "LineString", coordinates: p };
}

export function shapeGeometry(points: readonly LngLat[], closed: boolean) {
  return closed ? polygonFrom(points) : lineFrom(points);
}

/** The open vertex list behind a stored geometry — the inverse of the above. */
export function shapePoints(g: GeoJSON.Geometry | null | undefined): LngLat[] {
  if (!g) return [];
  if (g.type === "LineString") {
    return g.coordinates.map((c) => [c[0], c[1]] as LngLat);
  }
  if (g.type === "Polygon") {
    const ring = (g.coordinates[0] ?? []).map((c) => [c[0], c[1]] as LngLat);
    if (ring.length > 1 && same(ring[0], ring[ring.length - 1])) ring.pop();
    return ring;
  }
  return [];
}

export function isClosed(g: GeoJSON.Geometry | null | undefined): boolean {
  return g?.type === "Polygon";
}

/** The minimum vertex count for a shape of this shape. */
export function minPoints(closed: boolean): number {
  return closed ? MIN_AREA_POINTS : MIN_LINE_POINTS;
}

/* ---- Editing vertices ----------------------------------------------------- */

export function moveVertex(points: readonly LngLat[], i: number, p: LngLat): LngLat[] {
  const next = [...points];
  next[i] = p;
  return next;
}

/** Insert `p` at index `i`, pushing whatever was there along. */
export function insertVertex(points: readonly LngLat[], i: number, p: LngLat): LngLat[] {
  const next = [...points];
  next.splice(i, 0, p);
  return next;
}

/**
 * Remove vertex `i`, or refuse (null) when that would take the shape below the
 * minimum for its kind. Refusing beats silently converting an area into a line.
 */
export function removeVertex(
  points: readonly LngLat[],
  i: number,
  closed: boolean
): LngLat[] | null {
  if (points.length <= minPoints(closed)) return null;
  return points.filter((_, j) => j !== i);
}

/**
 * Segment midpoints, each tagged with the index a vertex dropped there would
 * take. A closed shape gets one extra for the wrap segment (last → first),
 * whose insertion index is the end of the list.
 *
 * Unit-agnostic, like `simplify`: the editor passes **screen points**, which is
 * exact rather than approximate because the editing camera is flat and north-up
 * (see `useEditorMap`) — under those constraints screen space is an affine
 * transform of mercator, so a midpoint stays a midpoint through it.
 */
export function segmentMidpoints(
  points: readonly Pt[],
  closed: boolean
): { index: number; point: Pt }[] {
  const n = points.length;
  const segments = closed ? n : n - 1;
  const out: { index: number; point: Pt }[] = [];
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push({ index: i + 1, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return out;
}

/** Slide every vertex by a mercator delta — the whole-shape drag. */
export function translatePoints(points: readonly LngLat[], dx: number, dy: number): LngLat[] {
  return points.map((p) => {
    const m = toMerc(p);
    return fromMerc([m[0] + dx, m[1] + dy]);
  });
}

/* ---- Freehand ------------------------------------------------------------- */

/** Perpendicular distance from `p` to segment ab, in the units passed in. */
function perpDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // Clamped projection, so a point beyond either end measures to that end.
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Ramer–Douglas–Peucker. A freehand stroke arrives as one sample per pointer
 * event — hundreds of points for a river — which is slow to render, miserable
 * to edit vertex-by-vertex, and mostly records the operator's hand tremor.
 *
 * Deliberately unit-agnostic: the editor simplifies in **screen pixels**, before
 * unprojecting, so the tolerance means "closer than N pixels to the line the
 * operator drew" at whatever zoom they drew it. Simplifying in mercator instead
 * would make the same stroke keep wildly different detail at different zooms.
 *
 * Iterative rather than recursive: a 5,000-point stroke is an easy stack
 * overflow in the naive form.
 */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let far = -1;
    let best = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(points[i], points[a], points[b]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// How near a freehand stroke has to end to its own start, in screen pixels, to
// read as "I drew a loop" rather than "I drew a stroke". Generous: closing is
// the recoverable outcome (the operator sees a filled area and can redraw),
// and sketching a pond is a natural loop while sketching a river never is.
export const FREEHAND_CLOSE_PX = 28;

export function endsWhereItStarted(screenPoints: readonly Pt[]): boolean {
  if (screenPoints.length < MIN_AREA_POINTS) return false;
  const a = screenPoints[0];
  const b = screenPoints[screenPoints.length - 1];
  return Math.hypot(b[0] - a[0], b[1] - a[1]) <= FREEHAND_CLOSE_PX;
}

/* ---- Framing -------------------------------------------------------------- */

export function lngLatBbox(
  points: readonly LngLat[]
): [number, number, number, number] | null {
  if (!points.length) return null;
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/**
 * Bounding box of every position in a parcel FeatureCollection — what "frame
 * the lot cluster" resolves to for an editor opening on a shape that doesn't
 * exist yet.
 */
export function featureCollectionBbox(
  fc: GeoJSON.FeatureCollection | null | undefined
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const eat = (pos: GeoJSON.Position) => {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
  };

  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") for (const ring of g.coordinates) ring.forEach(eat);
    else if (g.type === "MultiPolygon")
      for (const poly of g.coordinates) for (const ring of poly) ring.forEach(eat);
    else if (g.type === "LineString") g.coordinates.forEach(eat);
    else if (g.type === "Point") eat(g.coordinates);
  }

  return Number.isFinite(minX) && maxX > minX ? [minX, minY, maxX, maxY] : null;
}

/* ---- Validation + styling (shared by both API routes) --------------------- */

/**
 * The only geometry a shape layer may hold. Guards the DB rather than the
 * renderer: `mapLayers.ts` quietly declines to draw anything else, so bad
 * geometry that got stored would show up as a layer that exists in the list and
 * is invisible on the map — the worst kind of bug to report.
 */
export function validShapeGeometry(v: unknown): v is GeoJSON.Polygon | GeoJSON.LineString {
  const g = v as GeoJSON.Geometry | null;
  if (!g || (g.type !== "Polygon" && g.type !== "LineString")) return false;

  const rings: GeoJSON.Position[][] =
    g.type === "Polygon" ? g.coordinates : [g.coordinates as GeoJSON.Position[]];
  if (!Array.isArray(rings) || rings.length === 0) return false;

  // A GeoJSON ring repeats its first position, so a triangle is 4 positions.
  const need = g.type === "Polygon" ? MIN_AREA_POINTS + 1 : MIN_LINE_POINTS;

  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < need) return false;
    for (const p of ring) {
      if (
        !Array.isArray(p) ||
        p.length < 2 ||
        !Number.isFinite(Number(p[0])) ||
        !Number.isFinite(Number(p[1])) ||
        Math.abs(Number(p[0])) > 180 ||
        Math.abs(Number(p[1])) > 90
      ) {
        return false;
      }
    }
  }

  if (g.type === "Polygon") {
    for (const ring of rings) {
      if (!same(ring[0], ring[ring.length - 1])) return false;
    }
  }
  return true;
}

/**
 * Keep only style keys we recognise, in ranges the paint properties accept.
 * Partial by design: `updateLayer` merges style into the stored jsonb, so a
 * patch that carries just a color leaves width and fill alone.
 */
export function sanitizeShapeStyle(s: Partial<ShapeStyle> | undefined): Partial<ShapeStyle> {
  if (!s) return {};
  const out: Partial<ShapeStyle> = {};
  if (typeof s.color === "string" && /^#[0-9a-f]{3,8}$/i.test(s.color)) out.color = s.color;
  if (Number.isFinite(Number(s.width))) out.width = Math.max(1, Math.min(60, Number(s.width)));
  if (Number.isFinite(Number(s.fillOpacity))) {
    out.fillOpacity = Math.max(0, Math.min(1, Number(s.fillOpacity)));
  }
  return out;
}

export function fullShapeStyle(s: Partial<ShapeStyle> | undefined): ShapeStyle {
  return { ...DEFAULT_SHAPE_STYLE, ...sanitizeShapeStyle(s) };
}

/**
 * Starting colors for the things operators actually draw. A color picker with no
 * suggestions produces a map of accidental primaries; these are muted enough to
 * sit under lot fills without fighting them.
 */
export const SHAPE_PRESETS: { label: string; color: string }[] = [
  { label: "Water", color: "#4a7fb5" },
  { label: "Grass", color: "#5f8a52" },
  { label: "Sand", color: "#c8ab74" },
  { label: "Path", color: "#9b8e7a" },
  { label: "Stone", color: "#7d8794" },
];
