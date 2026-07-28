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

import type { Corners } from "./types";

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
