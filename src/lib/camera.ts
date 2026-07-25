// Opening-camera logic for the 3D map, shared by the public embed (MapView) and
// the operator's Opening View editor so both frame a development identically.
//
// This lives apart from lib/types.ts on purpose: types.ts is imported by server
// code (repo.ts), so it must never pull in mapbox-gl. This module is
// browser-only and imports the real Map type.

import mapboxgl from "mapbox-gl";
import type { ViewState } from "@/lib/types";

// Id of the terrain DEM source both map surfaces add.
export const DEM_SOURCE = "mapbox-dem";

// A clean north-up overview with a gentle tilt, used whenever we auto-fit the
// lot cluster. A steep cinematic pitch would, over the lots' large span, push
// the camera back to a regional view.
export const CLUSTER_FIT = { padding: 60, pitch: 30, bearing: 0, maxZoom: 16 } as const;

function eachVertex(f: GeoJSON.Feature, fn: (pt: [number, number]) => void) {
  const g = f.geometry;
  if (!g) return;
  const polys =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) for (const pt of ring) fn(pt as [number, number]);
}

// Bounds of the main lot cluster, so we can frame the development on first open
// instead of trusting a stored default_view. A few far-flung outlier parcels
// can otherwise inflate the extent and zoom the camera out to a regional view,
// so reject parcels far from the cluster center (robust median-distance test).
export function lotClusterBounds(fc: GeoJSON.FeatureCollection): mapboxgl.LngLatBounds | null {
  const feats: { f: GeoJSON.Feature; c: [number, number] }[] = [];
  for (const f of fc.features) {
    let sx = 0, sy = 0, n = 0;
    eachVertex(f, ([x, y]) => { sx += x; sy += y; n++; });
    if (n) feats.push({ f, c: [sx / n, sy / n] });
  }
  if (!feats.length) return null;

  const med = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  };
  const cx = med(feats.map((d) => d.c[0]));
  const cy = med(feats.map((d) => d.c[1]));
  const dists = feats.map((d) => Math.hypot(d.c[0] - cx, d.c[1] - cy));
  const thresh = Math.max(med(dists) * 6, 0.003); // ~>=330m floor for tight clusters
  const kept = feats.filter((_, i) => dists[i] <= thresh);
  const use = kept.length ? kept : feats;

  const b = new mapboxgl.LngLatBounds();
  for (const { f } of use) eachVertex(f, (pt) => b.extend(pt));
  return b.isEmpty() ? null : b;
}

// The shot a map opens on: either an exact camera (an operator-locked
// default_view or a named stop) or an auto-fit of the lot cluster.
export type OpeningView =
  | { kind: "view"; view: ViewState }
  | { kind: "fit"; bounds: mapboxgl.LngLatBounds };

// Resolve what a development should open on: an exact camera when the operator
// hand-framed one (or a named stop was requested), otherwise the lot cluster.
export function openingViewFor(
  view: ViewState,
  exact: boolean,
  fc: GeoJSON.FeatureCollection | null
): OpeningView {
  if (!exact && fc) {
    const bounds = lotClusterBounds(fc);
    if (bounds) return { kind: "fit", bounds };
  }
  return { kind: "view", view };
}

// Stamped on the camera moves we make ourselves, so a hold can tell its own
// re-assertions apart from a move the visitor asked for.
const HOLD_MOVE = { cameraHold: true };
const isHoldMove = (e: unknown) => Boolean((e as { cameraHold?: boolean } | null)?.cameraHold);

export function applyOpeningView(map: mapboxgl.Map, opening: OpeningView, duration = 0) {
  if (opening.kind === "fit") {
    map.fitBounds(opening.bounds, { ...CLUSTER_FIT, duration }, HOLD_MOVE);
  } else if (duration > 0) {
    map.easeTo({ ...opening.view, duration }, HOLD_MOVE);
  } else {
    map.jumpTo(opening.view, HOLD_MOVE);
  }
}

// Raw input that means the visitor has taken the wheel. `movestart` covers the
// rest (keyboard nav, the navigation control's buttons, geolocate) — every
// camera move that isn't one of ours releases the hold.
const TAKEOVER_EVENTS = ["mousedown", "touchstart", "wheel", "dblclick"] as const;

export type CameraHold = {
  /** Re-assert the opening camera (no-op once released). */
  apply: () => void;
  /** Resize the map to its container without giving up the hold. */
  resize: () => void;
  /** Stand down permanently — the camera is the visitor's from here. */
  release: () => void;
  /** True while the opening camera is still being held. */
  active: () => boolean;
};

/**
 * Hold the map on its opening camera until the terrain has settled.
 *
 * With terrain enabled, mapbox-gl re-derives the camera from DEM elevation on
 * every frame (Terrain.update → Transform.updateElevation(true) →
 * Transform._constrainCamera). Until the DEM tile under the view *center* has
 * loaded, the center's ground reads as sea level, so a tilted opening view puts
 * the camera hundreds of metres below terrain that has already loaded around it
 * — mapbox then shoves the camera up above the surface and rewrites
 * center/zoom/pitch from it. Which DEM tiles arrive first is a network race, so
 * the same map opened twice could land on the framed view once and a wrecked
 * one the next time.
 *
 * So: re-assert the intended camera as DEM tiles stream in, once more when the
 * map goes idle with the DEM fully loaded, and then stand down. Any real user
 * input releases the hold immediately, and a timeout backstops a map whose
 * tiles never finish.
 */
export function holdOpeningView(
  map: mapboxgl.Map,
  opening: OpeningView,
  { timeoutMs = 12_000 }: { timeoutMs?: number } = {}
): CameraHold {
  let holding = true;
  const offs: Array<() => void> = [];

  const listen = <T extends (typeof TAKEOVER_EVENTS)[number] | "sourcedata" | "idle" | "movestart">(
    type: T,
    listener: (ev: mapboxgl.MapEventOf<T>) => void
  ) => {
    map.on(type, listener);
    offs.push(() => map.off(type, listener));
  };

  const apply = () => {
    if (holding) applyOpeningView(map, opening);
  };

  // A resize keeps the current center/zoom, which leaves an auto-fit framed for
  // the old box — so re-frame after it. Tagged, or it would look like the
  // visitor moving the camera.
  const resize = () => {
    map.resize(HOLD_MOVE);
    apply();
  };

  const release = () => {
    if (!holding) return;
    holding = false;
    clearTimeout(timer);
    for (const off of offs) off();
    offs.length = 0;
  };

  let demSeen = false;
  listen("sourcedata", (e) => {
    if (e.sourceId !== DEM_SOURCE) return;
    demSeen = true;
    apply();
  });
  listen("idle", () => {
    apply();
    // The DEM streams in after the style is up; only stand down once it's here
    // (or when there's no terrain at all, so nothing can move the camera). An
    // idle before the DEM has said anything is too early to trust — the
    // timeout below backstops a DEM that never reports in.
    const dem = map.getSource(DEM_SOURCE);
    if (!dem || (demSeen && map.isSourceLoaded(DEM_SOURCE))) release();
  });
  listen("movestart", (e) => {
    if (!isHoldMove(e)) release();
  });
  for (const ev of TAKEOVER_EVENTS) listen(ev, release);

  const timer = setTimeout(release, timeoutMs);

  return { apply, resize, release, active: () => holding };
}
