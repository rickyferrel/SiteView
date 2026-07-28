import type mapboxgl from "mapbox-gl";
import type { ViewState } from "@/lib/types";

/**
 * Opening-camera helpers shared by the embed (MapView) and the opening-view
 * editor, so what the operator frames is what every visitor lands on.
 *
 * Two things break a stored `default_view` in the wild:
 *
 * 1. **Terrain re-frames the camera behind our back.** With 3D terrain on, GL JS
 *    keeps the camera above the ground: as DEM tiles stream in, the elevation it
 *    samples changes, and if the camera would sit under the hill behind it the
 *    transform is pulled up — silently, without firing `move`. Whether it fires
 *    depends on which DEM tiles happened to arrive first, so the same saved view
 *    opened twice can land at two different zooms (measured: ~1 in 6 loads at a
 *    steep pitch jumped 14.8 → 13.0, i.e. ~3.5x more land in frame).
 *    `holdCamera()` re-asserts the intended camera until the map settles.
 *
 * 2. **Zoom is pixels-per-meter, not a framing.** The same center/zoom shows
 *    ~3x less ground across a 390px phone than across a 1440px desktop iframe,
 *    and the operator frames the shot in a short editor box. `zoomForViewport()`
 *    scales the stored zoom by the viewport ratio so the *framing* — not the
 *    zoom number — is what travels.
 */

export type Camera = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
};

export function readCamera(map: mapboxgl.Map): Camera {
  const c = map.getCenter();
  return {
    center: [c.lng, c.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

/**
 * How far the stored zoom must move so a viewport of `width`x`height` frames the
 * same ground the operator framed in `view.size`. Ground span at a given zoom is
 * `pixels / pixelsPerMeter(zoom)`, and zoom doubles that scale per level — so
 * matching a viewport ratio `r` means `zoom + log2(r)`. We take the smaller of
 * the two axes ("contain"), so everything the operator framed stays on screen,
 * with slack on the roomier axis rather than cropping.
 *
 * Views saved before `size` existed have no reference frame, so they pass
 * through untouched — old maps keep rendering exactly as they do today.
 */
export function zoomForViewport(view: ViewState, width: number, height: number): number {
  const size = view.size;
  if (!size || !size[0] || !size[1] || !width || !height) return view.zoom;
  const ratio = Math.min(width / size[0], height / size[1]);
  if (!Number.isFinite(ratio) || ratio <= 0) return view.zoom;
  // Clamp the correction: a freakishly narrow embed shouldn't pull the camera
  // out to a regional view, and a huge one shouldn't crash into the ground.
  const delta = Math.max(-2.5, Math.min(1.5, Math.log2(ratio)));
  return Math.max(0, Math.min(22, view.zoom + delta));
}

/** The stored view resolved for an actual container — what to open the map at. */
export function cameraFor(view: ViewState, width: number, height: number): Camera {
  return {
    center: view.center,
    zoom: zoomForViewport(view, width, height),
    pitch: view.pitch,
    bearing: view.bearing,
  };
}

function matches(map: mapboxgl.Map, cam: Camera): boolean {
  const c = map.getCenter();
  return (
    Math.abs(c.lng - cam.center[0]) < 1e-6 &&
    Math.abs(c.lat - cam.center[1]) < 1e-6 &&
    Math.abs(map.getZoom() - cam.zoom) < 0.01 &&
    Math.abs(map.getPitch() - cam.pitch) < 0.1 &&
    Math.abs(((map.getBearing() - cam.bearing) % 360 + 540) % 360 - 180) < 0.1
  );
}

/**
 * Pin the map to `cam` while the scene settles, then get out of the way.
 *
 * Terrain nudges the transform without firing `move`, so we poll rather than
 * listen — but the moment a *real* camera change starts (`movestart`: the
 * visitor drags, or a control flies somewhere) we release for good and never
 * fight the user. The hold also expires on its own, and gives up after a few
 * corrections so a camera terrain genuinely refuses can't loop.
 *
 * Returns a release function; call it on unmount.
 */
export function holdCamera(map: mapboxgl.Map, cam: Camera, windowMs = 12000): () => void {
  let released = false;
  let ours = false;
  let corrections = 0;

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    clearTimeout(expiry);
    map.off("movestart", onMoveStart);
  };

  // Any camera movement we didn't cause means something with intent moved it.
  const onMoveStart = () => {
    if (!ours) release();
  };

  const check = () => {
    if (released || matches(map, cam)) return;
    if (corrections >= 5) return release();
    corrections++;
    ours = true;
    map.jumpTo(cam);
    ours = false;
  };

  const timer = setInterval(check, 350);
  const expiry = setTimeout(release, windowMs);
  map.on("movestart", onMoveStart);
  check();

  return release;
}
