// Geometry for the hand-drawing tool. Pure — no Mapbox, no DOM — so the editor,
// the measurements it shows while you drag, and the shape it finally POSTs all
// resolve to the same numbers.
//
// Shape math runs in **Web Mercator** normalized units — the same [0,1] space as
// `layers.ts` — for the same reason it does there: Mercator is conformal, so a
// dragged rectangle stays a rectangle, a split block's cuts stay parallel, and a
// duplicated row stays a row. The same work in lng/lat degrees shears by
// cos(latitude): at 40°N a square lot would come out 1.3x wider than it is tall.
//
// Distances are the exception. A merc unit is not a length (it shrinks toward the
// poles), so anything the operator *reads* — a segment length, a lot's frontage —
// is measured geodesically in `metersBetween` and shown in feet.
//
// The screen-space helper (`nearestOnSegment`) is plain 2D pixel math on purpose:
// snapping tolerance is a property of the operator's hand, not of the ground, so
// it's judged in pixels and unprojected afterwards.

import { toMerc, fromMerc, type Pt, type Rect } from "./layers";

/** A polygon ring in merc, **open** — the closing vertex is never stored. */
export type Ring = Pt[];
/** The same ring in lng/lat, open. What the UI hands around. */
export type LngLatRing = [number, number][];

// Below this half-extent a rectangle is a collapse, not a lot. ~1e-8 merc units
// is well under a metre, so it only ever catches a stray click.
const MIN_HALF = 1e-8;

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** Unit vector, or east if the input has no length. */
export function unit(v: Pt): Pt {
  const len = Math.hypot(v[0], v[1]);
  return len < 1e-12 ? [1, 0] : [v[0] / len, v[1] / len];
}

/** Quarter turn. Merc y grows south, so this is "clockwise on screen". */
export const perp = (d: Pt): Pt => [-d[1], d[0]];

export const toMercRing = (ring: LngLatRing): Ring => ring.map(toMerc);
export const toLngLatRing = (ring: Ring): LngLatRing => ring.map(fromMerc);

/** Open ring → a closed GeoJSON Polygon, the one shape the parcels API takes. */
export function ringPolygon(ring: LngLatRing): GeoJSON.Polygon {
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

/**
 * Every outer ring of a parcel geometry, opened (closing vertex dropped) so a
 * ring's vertex count is its corner count. Holes are skipped: they're snap noise
 * and nothing here creates them.
 */
export function outerRings(g: GeoJSON.Geometry | null | undefined): LngLatRing[] {
  if (!g) return [];
  const polys =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const out: LngLatRing[] = [];
  for (const poly of polys) {
    const ring = (poly[0] ?? []).map((c) => [c[0], c[1]] as [number, number]);
    if (ring.length < 3) continue;
    const a = ring[0];
    const b = ring[ring.length - 1];
    out.push(a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring);
  }
  return out;
}

/** lng/lat bbox of a ring — the cheap prefilter in front of snap projection. */
export function ringBbox(ring: LngLatRing): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of ring) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

/** Area centroid in merc, falling back to the vertex average for a sliver. */
export function ringCentroid(ring: Ring): Pt {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a2 += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a2) < 1e-18) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

/* ---- Measuring -------------------------------------------------------------- */

const EARTH_R = 6378137;
export const FEET_PER_M = 3.280839895;
/** Metres across one merc unit at a latitude — converts a typed gap to merc. */
export const metersPerMerc = (lat: number) => 2 * Math.PI * EARTH_R * Math.cos((lat * Math.PI) / 180);

/** Great-circle distance in metres. */
export function metersBetween(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const φ1 = a[1] * rad, φ2 = b[1] * rad;
  const dφ = φ2 - φ1;
  const dλ = (b[0] - a[0]) * rad;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing a→b, degrees clockwise from north. */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const φ1 = a[1] * rad, φ2 = b[1] * rad;
  const dλ = (b[0] - a[0]) * rad;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Feet, at the precision a plat is dimensioned in: whole feet, grouped. */
export function feet(meters: number): string {
  const ft = meters * FEET_PER_M;
  return ft < 10 ? ft.toFixed(1) : Math.round(ft).toLocaleString("en-US");
}

/** Total edge length of a closed ring, in metres. */
export function ringPerimeter(ring: LngLatRing): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) total += metersBetween(ring[i], ring[(i + 1) % ring.length]);
  return total;
}

/* ---- Rectangles ------------------------------------------------------------- */

/**
 * The rectangle a drag from `a` to `b` describes, in a frame rotated by `rot`.
 * The two points are opposite corners *in that frame*, so with an angle locked
 * to the street a drag lands a lot already square to it.
 */
export function rectFromDrag(a: Pt, b: Pt, rot: number): Rect {
  const ex: Pt = [Math.cos(rot), Math.sin(rot)];
  const ey: Pt = [-Math.sin(rot), Math.cos(rot)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const u = dx * ex[0] + dy * ex[1];
  const v = dx * ey[0] + dy * ey[1];
  return {
    cx: a[0] + (ex[0] * u) / 2 + (ey[0] * v) / 2,
    cy: a[1] + (ex[1] * u) / 2 + (ey[1] * v) / 2,
    hw: Math.max(MIN_HALF, Math.abs(u) / 2),
    hh: Math.max(MIN_HALF, Math.abs(v) / 2),
    rot,
  };
}

/* ---- Splitting a block ------------------------------------------------------ */

/**
 * The direction lots run in when a block is cut. Axis 0 is the block's longest
 * edge — on a subdivision row that's the street frontage, so the default cut
 * gives lots side by side along the street; axis 1 is the quarter turn from it.
 */
export function blockAxis(ring: Ring, axis: 0 | 1): Pt {
  let best: Pt = [1, 0];
  let bestLen = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      best = [b[0] - a[0], b[1] - a[1]];
    }
  }
  const d = unit(best);
  return axis === 0 ? d : perp(d);
}

export function extentAlong(ring: Ring, dir: Pt): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of ring) {
    const s = dot(p, dir);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max };
}

function crossAt(a: Pt, b: Pt, dir: Pt, s: number): Pt {
  const da = dot(a, dir) - s;
  const db = dot(b, dir) - s;
  const t = da === db ? 0 : da / (da - db);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Sutherland–Hodgman clip against one half-plane `p·dir ≷ s`. Convex in, convex
 * out — which is the whole reason splitting works on any block shape, not just a
 * quad: a piece is the block clipped twice, between neighbouring cut lines.
 */
export function clipHalfPlane(ring: Ring, dir: Pt, s: number, keepAbove: boolean): Ring {
  if (ring.length < 3) return [];
  const inside = (p: Pt) => (keepAbove ? dot(p, dir) >= s : dot(p, dir) <= s);
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ia = inside(a);
    const ib = inside(b);
    if (ib) {
      if (!ia) out.push(crossAt(a, b, dir, s));
      out.push(b);
    } else if (ia) {
      out.push(crossAt(a, b, dir, s));
    }
  }
  return out.length >= 3 ? out : [];
}

/**
 * Cut `ring` into pieces at the normalised positions `ts` (0..1 along `dir`,
 * ascending). `ts.length` cuts make `ts.length + 1` lots, ordered along the axis
 * — which is the order they get numbered in, so a split row reads 12, 13, 14…
 * left to right instead of at random.
 */
export function sliceRing(ring: Ring, dir: Pt, ts: number[]): Ring[] {
  const { min, max } = extentAlong(ring, dir);
  const span = max - min;
  if (span <= 0) return [];
  const bounds = [min, ...ts.map((t) => min + t * span), max];
  const pieces: Ring[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const piece = clipHalfPlane(clipHalfPlane(ring, dir, bounds[i], true), dir, bounds[i + 1], false);
    if (piece.length >= 3) pieces.push(piece);
  }
  return pieces;
}

/** Evenly spaced cuts — what the N stepper produces before anything is dragged. */
export function evenCuts(n: number): number[] {
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (i + 1) / n);
}

/** Where a cut line crosses the block: the segment drawn, and dragged, on screen. */
export function cutSegment(ring: Ring, dir: Pt, s: number): [Pt, Pt] | null {
  const hits: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const da = dot(a, dir) - s;
    const db = dot(b, dir) - s;
    if (da === db) continue;
    if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) hits.push(crossAt(a, b, dir, s));
  }
  if (hits.length < 2) return null;
  const q = perp(dir);
  hits.sort((m, n) => dot(m, q) - dot(n, q));
  return [hits[0], hits[hits.length - 1]];
}

/* ---- Duplicating a row ------------------------------------------------------ */

export function translateRing(ring: Ring, d: Pt): Ring {
  return ring.map((p) => [p[0] + d[0], p[1] + d[1]] as Pt);
}

/**
 * The step that puts the next copy edge-to-edge with this one: the lot's own
 * extent along `dir`. Subdivision lots abut, so this is the default spacing and
 * anything else is a gap the operator asked for.
 */
export function flushStep(ring: Ring, dir: Pt): number {
  const { min, max } = extentAlong(ring, dir);
  return max - min;
}

/* ---- Screen space ----------------------------------------------------------- */

/** Closest point on segment a→b to p, in pixels, with the distance to it. */
export function nearestOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): { pt: [number, number]; d: number } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const pt: [number, number] = [a[0] + vx * t, a[1] + vy * t];
  return { pt, d: Math.hypot(p[0] - pt[0], p[1] - pt[1]) };
}

/**
 * A nice round ground distance for the scale ruler, and how wide it is on
 * screen: the first interval from the 1/2/5 ladder that draws between 56 and
 * 150 px, so the ruler's ticks stay legible at every zoom.
 */
export function scaleTick(feetPerPixel: number): { feet: number; px: number } {
  const ladder = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const ft of ladder) {
    const px = ft / feetPerPixel;
    if (px >= 56 && px <= 150) return { feet: ft, px };
  }
  const ft = ladder[ladder.length - 1];
  return { feet: ft, px: ft / feetPerPixel };
}
