"use client";

import type mapboxgl from "mapbox-gl";
import type { Layer, Corners } from "./types";
import { DEFAULT_SHAPE_STYLE } from "./types";

/**
 * Puts operator-configured overlay layers onto a Mapbox map. Shared by the embed
 * (MapView) and the positioning editor so an overlay is drawn identically in
 * both — what the operator aligns is what the visitor sees.
 *
 * Stacking is deliberate, not "append on top":
 *
 *   • `above_lots: false` → inserted before the parcel FILL, under everything
 *     parcel-related. This is the site-plan-as-basemap case: lots sit on it.
 *   • `above_lots: true`  → inserted before the parcel LABEL, so the overlay
 *     covers the lot fills but the lot *numbers* still read over it. Numbers
 *     losing to an overlay would defeat the point of having them.
 *
 * Within each group, layers are added in ascending `sort_order`. Each insert
 * lands directly beneath the same anchor, so the later one stacks above the
 * earlier — bottom-to-top order falls out for free.
 *
 * Overlays are intentionally non-interactive: no click or hover handlers are
 * bound here. The embed's handlers are bound to the parcel FILL by id, so lot
 * clicks keep working straight through an above-lots overlay.
 */

export type LayerAnchors = {
  /** Parcel fill layer id — anchor for below-lots overlays. */
  fill: string;
  /** Lot-label layer id — anchor for above-lots overlays. */
  label: string;
};

const PREFIX = "ov-";
const SRC_PREFIX = "ov-src-";

/**
 * Source id carries the asset id for images. Assets are immutable, so a
 * re-upload produces a new id — and therefore a new source — instead of leaving
 * a cached texture of the *old* image pinned under the new corners.
 */
function srcId(l: Layer): string {
  return l.kind === "image" ? `${SRC_PREFIX}${l.id}-${l.asset_id}` : `${SRC_PREFIX}${l.id}`;
}
const lyrId = (id: string) => `${PREFIX}${id}`;

export function assetUrl(assetId: string): string {
  return `/api/asset/${assetId}`;
}

/** Half-created layers (no asset yet, no geometry yet) simply don't draw. */
function renderable(l: Layer): boolean {
  if (l.kind === "image") return !!l.asset_id && !!l.corners && l.corners.length === 4;
  return !!l.geometry && (l.geometry.type === "Polygon" || l.geometry.type === "LineString");
}

function anchorFor(map: mapboxgl.Map, l: Layer, anchors: LayerAnchors): string | undefined {
  const id = l.above_lots ? anchors.label : anchors.fill;
  return map.getLayer(id) ? id : undefined;
}

function addOne(map: mapboxgl.Map, l: Layer, anchors: LayerAnchors) {
  const sid = srcId(l);
  const lid = lyrId(l.id);
  const before = anchorFor(map, l, anchors);
  const visibility = l.visible ? "visible" : "none";

  if (l.kind === "image") {
    if (!map.getSource(sid)) {
      map.addSource(sid, {
        type: "image",
        url: assetUrl(l.asset_id as string),
        // Mapbox warps the texture between exactly these four points, in
        // TL, TR, BR, BL order. Out-of-order corners bowtie the image silently.
        coordinates: l.corners as Corners,
      });
    }
    map.addLayer(
      {
        id: lid,
        type: "raster",
        source: sid,
        layout: { visibility },
        paint: {
          "raster-opacity": l.opacity,
          // Overlays get nudged live in the editor; a fade reads as drag lag.
          "raster-fade-duration": 0,
        },
      },
      before
    );
    return;
  }

  const style = { ...DEFAULT_SHAPE_STYLE, ...l.style };
  const data: GeoJSON.Feature = {
    type: "Feature",
    geometry: l.geometry as GeoJSON.Geometry,
    properties: {},
  };
  const existing = map.getSource(sid) as mapboxgl.GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(sid, { type: "geojson", data });

  if (l.geometry?.type === "Polygon") {
    map.addLayer(
      {
        id: lid,
        type: "fill",
        source: sid,
        layout: { visibility },
        paint: { "fill-color": style.color, "fill-opacity": style.fillOpacity * l.opacity },
      },
      before
    );
  } else {
    map.addLayer(
      {
        id: lid,
        type: "line",
        source: sid,
        layout: { visibility, "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": style.color,
          "line-width": style.width,
          "line-opacity": l.opacity,
        },
      },
      before
    );
  }
}

/**
 * Bring the map's overlays in line with `layers`. Safe to call repeatedly: it
 * tears every overlay layer down and rebuilds in order, which is what keeps
 * stacking honest after a reorder or an above/below flip. Overlay counts are
 * small (a handful per map), so this isn't worth diffing around.
 *
 * Sources survive the rebuild when they're still wanted and still the right
 * shape, so reordering never re-downloads an image. Live corner dragging must
 * NOT go through here — use `setLayerCoordinates`, which mutates in place.
 */
export function syncLayers(map: mapboxgl.Map, layers: Layer[], anchors: LayerAnchors) {
  const wanted = layers.filter(renderable);
  const style = map.getStyle();

  for (const sl of style?.layers ?? []) {
    if (sl.id.startsWith(PREFIX) && map.getLayer(sl.id)) map.removeLayer(sl.id);
  }

  const keep = new Set(wanted.map(srcId));
  for (const sid of Object.keys(style?.sources ?? {})) {
    if (sid.startsWith(SRC_PREFIX) && !keep.has(sid) && map.getSource(sid)) {
      map.removeSource(sid);
    }
  }

  const byOrder = (a: Layer, b: Layer) => a.sort_order - b.sort_order;
  const below = wanted.filter((l) => !l.above_lots).sort(byOrder);
  const above = wanted.filter((l) => l.above_lots).sort(byOrder);
  for (const l of [...below, ...above]) addOne(map, l, anchors);
}

/** Live-drag path: move an image overlay without rebuilding anything. */
export function setLayerCoordinates(map: mapboxgl.Map, l: Layer, corners: Corners) {
  const src = map.getSource(srcId(l)) as mapboxgl.ImageSource | undefined;
  if (src && typeof src.setCoordinates === "function") src.setCoordinates(corners);
}

/** Visitor toggle / eye icon — client-side only, never a DB write. */
export function setLayerVisible(map: mapboxgl.Map, id: string, visible: boolean) {
  const lid = lyrId(id);
  if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", visible ? "visible" : "none");
}

/** Opacity slider feedback without waiting on a round-trip. */
export function setLayerOpacity(map: mapboxgl.Map, l: Layer, opacity: number) {
  const lid = lyrId(l.id);
  if (!map.getLayer(lid)) return;
  if (l.kind === "image") {
    map.setPaintProperty(lid, "raster-opacity", opacity);
  } else if (l.geometry?.type === "Polygon") {
    const style = { ...DEFAULT_SHAPE_STYLE, ...l.style };
    map.setPaintProperty(lid, "fill-opacity", style.fillOpacity * opacity);
  } else {
    map.setPaintProperty(lid, "line-opacity", opacity);
  }
}
