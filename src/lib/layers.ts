// Geometry for image-overlay positioning. Pure — no Mapbox, no DOM — so the
// editor and any future consumer resolve corners identically.
//
// All the math happens in **Web Mercator** normalized units (the same [0,1]
// space as mapboxgl.MercatorCoordinate), not in lng/lat. Two reasons:
//
//  • Mercator is conformal, so a rectangle in this space renders as a rectangle
//    on a north-up screen, and rotations look like rotations. Doing the same
//    math in lng/lat degrees would shear everything by cos(latitude).
//  • x and y share one scale, so an image's pixel aspect ratio maps straight
//    onto a merc half-width/half-height ratio with no correction.
//
// The editor forces the map flat (pitch 0, terrain off) while positioning, so
// screen↔ground is an exact plane projection and dragged handles land where the
// operator drops them.

import type { Corners, ShapeStyle } from "./types";

export type Pt = [number, number]; // mercator [x, y] — x east, y *south*

/** lng/lat → normalized Web Mercator. Matches MercatorCoordinate.fromLngLat. */
export function toMerc([lng, lat]: [number, number]): Pt {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  return [
    (180 + lng) / 360,
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360,
  ];
}

/** Normalized Web Mercator → lng/lat. Matches MercatorCoordinate.toLngLat. */
export function fromMerc([x, y]: Pt): [number, number] {
  const y2 = 180 - y * 360;
  return [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90];
}

/**
 * An image overlay in transform mode: a rectangle that stays a rectangle.
 * `rot` is radians clockwise on screen (merc y grows southward).
 */
export type Rect = { cx: number; cy: number; hw: number; hh: number; rot: number };

// Corner order is Mapbox's: TL, TR, BR, BL. Local-frame signs per corner.
const SX = [-1, 1, 1, -1];
const SY = [-1, -1, 1, 1];

const axes = (rot: number) => ({
  ex: [Math.cos(rot), Math.sin(rot)] as Pt,
  ey: [-Math.sin(rot), Math.cos(rot)] as Pt,
});

// Rectangles below this half-extent are treated as a collapse and refused, so a
// fast drag past the opposite corner can't zero the overlay out of existence.
// ~1e-7 merc units is roughly 4 m at the equator.
const MIN_HALF = 1e-7;

export function cornersFromRect(r: Rect): Corners {
  const { ex, ey } = axes(r.rot);
  return [0, 1, 2, 3].map((i) => {
    const x = r.cx + ex[0] * SX[i] * r.hw + ey[0] * SY[i] * r.hh;
    const y = r.cy + ex[1] * SX[i] * r.hw + ey[1] * SY[i] * r.hh;
    return fromMerc([x, y]);
  }) as Corners;
}

/**
 * Best-fit rectangle for four corners. Fine-tune mode can drag corners into a
 * non-rectangle; switching back to transform mode re-reads them through this,
 * which squares the shape up again (deliberate — transform mode's contract is
 * that it stays a rectangle).
 */
export function rectFromCorners(c: Corners): Rect {
  const m = c.map(toMerc) as [Pt, Pt, Pt, Pt];
  const cx = (m[0][0] + m[1][0] + m[2][0] + m[3][0]) / 4;
  const cy = (m[0][1] + m[1][1] + m[2][1] + m[3][1]) / 4;
  // Top edge sets the rotation; the two vertical edges average into the height.
  const ux = m[1][0] - m[0][0];
  const uy = m[1][1] - m[0][1];
  const rot = Math.atan2(uy, ux);
  const top = Math.hypot(ux, uy);
  const bottom = Math.hypot(m[2][0] - m[3][0], m[2][1] - m[3][1]);
  const left = Math.hypot(m[3][0] - m[0][0], m[3][1] - m[0][1]);
  const right = Math.hypot(m[2][0] - m[1][0], m[2][1] - m[1][1]);
  return {
    cx,
    cy,
    hw: Math.max(MIN_HALF, (top + bottom) / 4),
    hh: Math.max(MIN_HALF, (left + right) / 4),
    rot,
  };
}

export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return { ...r, cx: r.cx + dx, cy: r.cy + dy };
}

/**
 * Drag corner `i` to `p`, pinning the opposite corner. `lockAspect` scales both
 * axes together off whichever the operator pulled further — which is what you
 * want for a marketing render, where a stretched site plan reads as wrong long
 * before it reads as misaligned.
 */
export function scaleRectFromCorner(r: Rect, i: number, p: Pt, lockAspect: boolean): Rect {
  const { ex, ey } = axes(r.rot);
  const sx = SX[i];
  const sy = SY[i];
  // The pinned corner, in world merc.
  const ox = r.cx + ex[0] * -sx * r.hw + ey[0] * -sy * r.hh;
  const oy = r.cy + ex[1] * -sx * r.hw + ey[1] * -sy * r.hh;

  const dx = p[0] - ox;
  const dy = p[1] - oy;
  let hw = Math.abs(dx * ex[0] + dy * ex[1]) / 2;
  let hh = Math.abs(dx * ey[0] + dy * ey[1]) / 2;

  if (lockAspect) {
    const s = Math.max(hw / r.hw, hh / r.hh);
    hw = r.hw * s;
    hh = r.hh * s;
  }
  hw = Math.max(MIN_HALF, hw);
  hh = Math.max(MIN_HALF, hh);

  return {
    ...r,
    hw,
    hh,
    cx: ox + ex[0] * sx * hw + ey[0] * sy * hh,
    cy: oy + ex[1] * sx * hw + ey[1] * sy * hh,
  };
}

/**
 * Point the rotation handle at `p`. The handle lives off the top edge — local
 * bearing -90° — so the pointer angle is offset by a quarter turn.
 */
export function rotateRectTo(r: Rect, p: Pt): Rect {
  return { ...r, rot: Math.atan2(p[1] - r.cy, p[0] - r.cx) + Math.PI / 2 };
}

/** Where the rotation grip sits: `pad` merc units clear of the top edge. */
export function rotateHandle(r: Rect, pad: number): [number, number] {
  const { ey } = axes(r.rot);
  return fromMerc([r.cx - ey[0] * (r.hh + pad), r.cy - ey[1] * (r.hh + pad)]);
}

/**
 * First placement for a freshly uploaded image: centered on the current view,
 * north-up, contained inside `maxHalfW`/`maxHalfH` at the image's own aspect so
 * it lands on screen undistorted and ready to nudge.
 */
export function rectForAspect(
  center: Pt,
  maxHalfW: number,
  maxHalfH: number,
  aspect: number
): Rect {
  const byWidth = Math.min(maxHalfW, maxHalfH * aspect);
  return {
    cx: center[0],
    cy: center[1],
    hw: Math.max(MIN_HALF, byWidth),
    hh: Math.max(MIN_HALF, byWidth / aspect),
    rot: 0,
  };
}

/** lng/lat bounding box of a corner set — drives "zoom to layer". */
export function cornersBbox(c: Corners): [number, number, number, number] {
  const lngs = c.map((p) => p[0]);
  const lats = c.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/* ---- Drawn shapes -------------------------------------------------------- */
// Shape layers are a plain vertex list in lng/lat, not a rectangle, so none of
// the mercator rect math above applies to them. These helpers are the single
// place that knows how a vertex list maps onto GeoJSON — the editor, the API
// route and the renderer all read a shape through them, so a polygon's implicit
// closing point can't be counted twice in one place and dropped in another.

export type ShapeKind = "polygon" | "line";

/** Fewest vertices that make a drawable shape. Below this, nothing is saved. */
export const MIN_SHAPE_POINTS: Record<ShapeKind, number> = { polygon: 3, line: 2 };

export function shapeKindOf(g: GeoJSON.Geometry | null | undefined): ShapeKind {
  return g?.type === "Polygon" ? "polygon" : "line";
}

/**
 * Vertex list → GeoJSON, or `null` when there aren't enough points yet. A
 * polygon's ring is closed here and **only** here: `pts` never carries the
 * duplicate closing vertex, so it can't show up as a stacked pair of grips.
 */
export function shapeGeometry(
  kind: ShapeKind,
  pts: [number, number][]
): GeoJSON.Geometry | null {
  if (pts.length < MIN_SHAPE_POINTS[kind]) return null;
  if (kind === "line") return { type: "LineString", coordinates: pts };
  return { type: "Polygon", coordinates: [[...pts, pts[0]]] };
}

/** GeoJSON → editable vertex list, dropping a polygon's closing vertex. */
export function shapePoints(g: GeoJSON.Geometry | null | undefined): [number, number][] {
  if (!g) return [];
  if (g.type === "LineString") return g.coordinates.map((c) => [c[0], c[1]]);
  if (g.type !== "Polygon") return [];
  const ring = (g.coordinates[0] ?? []).map((c) => [c[0], c[1]] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return ring;
}

/** lng/lat bounding box of a drawn shape — frames the editor on open. */
export function shapeBbox(
  g: GeoJSON.Geometry | null | undefined
): [number, number, number, number] | null {
  const pts = shapePoints(g);
  if (!pts.length) return null;
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/**
 * Gate for a shape write. The renderer draws a Polygon as a fill and anything
 * else as a line, and a degenerate ring (two points, or coordinates that aren't
 * pairs of finite numbers) draws as nothing at all rather than failing — so an
 * under-length shape has to be refused here or it becomes an invisible layer the
 * operator can't explain.
 */
export function validShapeGeometry(v: unknown): v is GeoJSON.Geometry {
  const g = v as GeoJSON.Geometry | null;
  if (!g || (g.type !== "Polygon" && g.type !== "LineString")) return false;
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates;
  if (!Array.isArray(ring)) return false;
  const ok = ring.every(
    (p) =>
      Array.isArray(p) &&
      p.length >= 2 &&
      Number.isFinite(Number(p[0])) &&
      Number.isFinite(Number(p[1])) &&
      Math.abs(Number(p[0])) <= 180 &&
      Math.abs(Number(p[1])) <= 90
  );
  if (!ok) return false;
  // A closed ring repeats its first vertex, so a triangle arrives as 4 points.
  return ring.length >= (g.type === "Polygon" ? 4 : 2);
}

/**
 * Shared by both write routes. Style is operator input that lands in a jsonb
 * column and then goes straight into a Mapbox paint property, so a bad colour
 * string is a broken map layer rather than a validation error — hence the
 * whitelist rather than a cast.
 */
export function sanitizeShapeStyle(s: Partial<ShapeStyle> | undefined): Partial<ShapeStyle> {
  if (!s) return {};
  const out: Partial<ShapeStyle> = {};
  if (typeof s.color === "string" && /^#[0-9a-f]{3,8}$/i.test(s.color)) out.color = s.color;
  if (Number.isFinite(Number(s.width))) out.width = Math.max(0, Math.min(60, Number(s.width)));
  if (Number.isFinite(Number(s.fillOpacity))) {
    out.fillOpacity = Math.max(0, Math.min(1, Number(s.fillOpacity)));
  }
  return out;
}

/** Reject anything that would bowtie the texture or NaN out the source. */
export function validCorners(v: unknown): v is Corners {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        Number.isFinite(Number(p[0])) &&
        Number.isFinite(Number(p[1])) &&
        Math.abs(Number(p[0])) <= 180 &&
        Math.abs(Number(p[1])) <= 90
    )
  );
}
