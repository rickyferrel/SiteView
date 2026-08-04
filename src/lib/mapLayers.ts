"use client";

import type mapboxgl from "mapbox-gl";
import type { Layer, Corners, ShapeStyle } from "./types";
import { DEFAULT_SHAPE_STYLE } from "./types";
import { shade, haloFor } from "./layers";

/**
 * Puts operator-configured overlay layers onto a Mapbox map. Shared by the embed
 * (MapView) and the positioning/drawing editors so an overlay is drawn
 * identically in both — what the operator aligns is what the visitor sees.
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
 * A shape's **text** ignores that grouping and always goes in above every
 * overlay, at the lot-label anchor: `above_lots` is a statement about where the
 * geometry belongs in the map, and text buried under a parcel fill or a
 * site-plan render is unreadable either way. So one shape row can put several
 * Mapbox layers on the map (see `shapeLayerSpecs`), and every helper here works
 * in terms of that set rather than a single layer id.
 *
 * Overlays are intentionally non-interactive: no click or hover handlers are
 * bound here. The embed's handlers are bound to the parcel FILL by id, so lot
 * clicks keep working straight through an above-lots overlay.
 */

export type LayerAnchors = {
  /** Parcel fill layer id — anchor for below-lots overlays. */
  fill: string;
  /** Lot-label layer id — anchor for above-lots overlays, and for all text. */
  label: string;
};

const PREFIX = "ov-";
const SRC_PREFIX = "ov-src-";

/** The union of paint property names `setPaintProperty` accepts. */
type PaintName = Parameters<mapboxgl.Map["setPaintProperty"]>[1];

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

/* ---- Shapes --------------------------------------------------------------- */

/** Everything needed to paint one drawn shape, independent of where it's stored. */
export type ShapeRender = {
  /** Base layer id; every sub-layer id derives from it. */
  baseId: string;
  source: string;
  geometry: GeoJSON.Geometry;
  style: Partial<ShapeStyle>;
  /** The layer row's opacity — folded into every pass so the slider is honest. */
  opacity: number;
  visible?: boolean;
};

const BANK = "-bank";
const SHEEN = "-sheen";
const TEXT = "-label";

/** Every layer id one shape can occupy. Order is irrelevant — this is for teardown. */
export function shapeLayerIds(baseId: string): string[] {
  return [baseId, baseId + BANK, baseId + SHEEN, baseId + TEXT];
}

/**
 * The Mapbox layers for one drawn shape, split into `body` (the geometry, in
 * bottom-to-top paint order) and `label` (its text, which the caller inserts
 * higher up the stack).
 *
 * The **river** look is three passes over the same vertex list, all derived from
 * the single colour the operator picked:
 *
 *   1. a wider, darker, heavily blurred *bank* — soft edges are most of what
 *      separates water from a stroke someone drew;
 *   2. the water body itself, lightly blurred;
 *   3. a narrow, lighter *sheen* just off the middle, reading as surface light.
 *
 * Blur and width scale off `style.width`, so one slider still sizes the river and
 * a 2px creek doesn't get a 6px halo. "solid" stays exactly one flat stroke — an
 * existing line keeps rendering byte-for-byte as it did before the look existed.
 */
export function shapeLayerSpecs(o: ShapeRender): {
  body: mapboxgl.LayerSpecification[];
  label: mapboxgl.SymbolLayerSpecification | null;
} {
  const s = { ...DEFAULT_SHAPE_STYLE, ...o.style };
  const visibility: "visible" | "none" = o.visible === false ? "none" : "visible";
  const op = o.opacity;
  const body: mapboxgl.LayerSpecification[] = [];

  if (o.geometry.type === "Polygon") {
    body.push({
      id: o.baseId,
      type: "fill",
      source: o.source,
      layout: { visibility },
      paint: { "fill-color": s.color, "fill-opacity": s.fillOpacity * op },
    });
  } else {
    const w = Math.max(0.5, s.width);
    const line = (
      id: string,
      paint: mapboxgl.LineLayerSpecification["paint"]
    ): mapboxgl.LineLayerSpecification => ({
      id,
      type: "line",
      source: o.source,
      layout: { visibility, "line-cap": "round", "line-join": "round" },
      paint,
    });

    if (s.look === "river") {
      body.push(
        line(o.baseId + BANK, {
          "line-color": shade(s.color, -0.5),
          "line-width": w + Math.max(3, w * 0.6),
          "line-blur": Math.max(2, w * 0.8),
          "line-opacity": 0.75 * op,
        }),
        line(o.baseId, {
          "line-color": s.color,
          "line-width": w,
          "line-blur": Math.max(0.5, w * 0.2),
          "line-opacity": op,
        }),
        line(o.baseId + SHEEN, {
          "line-color": shade(s.color, 0.55),
          "line-width": Math.max(1, w * 0.3),
          "line-blur": Math.max(1, w * 0.5),
          "line-opacity": 0.5 * op,
          // Nudged off centre so the cross-section isn't symmetrical: dark on
          // both banks, bright a little off the middle, which reads as a curved
          // water surface catching light rather than a striped ribbon.
          "line-offset": -Math.max(0.5, w * 0.14),
        })
      );
    } else {
      body.push(
        line(o.baseId, { "line-color": s.color, "line-width": w, "line-opacity": op })
      );
    }
  }

  const text = (s.label ?? "").trim();
  const label: mapboxgl.SymbolLayerSpecification | null = !text
    ? null
    : {
        id: o.baseId + TEXT,
        type: "symbol",
        source: o.source,
        layout: {
          visibility,
          "text-field": text,
          "text-size": s.labelSize,
          "text-letter-spacing": 0.06,
          ...(o.geometry.type === "Polygon"
            ? {
                // One label, at the polygon's centroid. Overlap is allowed
                // *because* there's only one candidate position: a label the
                // operator typed and can't see would read as a bug, and losing a
                // collision to a lot number is exactly how that happens.
                "symbol-placement": "point" as const,
                "text-max-width": 9,
                "text-allow-overlap": true,
              }
            : {
                // Text follows the line and repeats along it — the way a river or
                // a trail is labelled on a real map. Many candidate positions, so
                // dropping the ones that collide is safe here.
                "symbol-placement": "line" as const,
                "symbol-spacing": 280,
                "text-max-angle": 40,
                "text-padding": 4,
                "text-allow-overlap": false,
              }),
        },
        paint: {
          "text-color": s.labelColor,
          "text-halo-color": haloFor(s.labelColor),
          "text-halo-width": 1.5,
          "text-halo-blur": 0.5,
          "text-opacity": op,
        },
      };

  return { body, label };
}

/** Drop every layer one shape occupies. Missing ids are ignored. */
export function removeShapeLayers(map: mapboxgl.Map, baseId: string) {
  for (const id of shapeLayerIds(baseId)) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}

/**
 * Paint one shape from scratch — used by `ShapeEditor` for its live preview,
 * which is why it's a rebuild rather than a paint-property poke: switching a line
 * from solid to river changes the *set* of layers, not just their paint, and no
 * amount of setPaintProperty gets you there. Going through the same spec builder
 * as the embed is what keeps the editor from showing a look the visitor won't.
 */
export function renderShape(
  map: mapboxgl.Map,
  o: ShapeRender,
  before: { body?: string; label?: string }
) {
  removeShapeLayers(map, o.baseId);
  const { body, label } = shapeLayerSpecs(o);
  for (const spec of body) map.addLayer(spec, before.body);
  if (label) map.addLayer(label, before.label ?? before.body);
}

/* ---- The stack ------------------------------------------------------------ */

function anchorFor(map: mapboxgl.Map, l: Layer, anchors: LayerAnchors): string | undefined {
  const id = l.above_lots ? anchors.label : anchors.fill;
  return map.getLayer(id) ? id : undefined;
}

function shapeRender(l: Layer): ShapeRender {
  return {
    baseId: lyrId(l.id),
    source: srcId(l),
    geometry: l.geometry as GeoJSON.Geometry,
    style: l.style,
    opacity: l.opacity,
    visible: l.visible,
  };
}

/** The geometry half: a raster for an image, one or more strokes for a shape. */
function addBody(map: mapboxgl.Map, l: Layer, anchors: LayerAnchors) {
  const sid = srcId(l);
  const before = anchorFor(map, l, anchors);

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
        id: lyrId(l.id),
        type: "raster",
        source: sid,
        layout: { visibility: l.visible ? "visible" : "none" },
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

  const data: GeoJSON.Feature = {
    type: "Feature",
    geometry: l.geometry as GeoJSON.Geometry,
    properties: {},
  };
  const existing = map.getSource(sid) as mapboxgl.GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(sid, { type: "geojson", data });

  for (const spec of shapeLayerSpecs(shapeRender(l)).body) map.addLayer(spec, before);
}

/** The text half, anchored with the lot numbers. No-op unless a shape has a label. */
function addText(map: mapboxgl.Map, l: Layer, anchors: LayerAnchors) {
  if (l.kind !== "shape") return;
  const { label } = shapeLayerSpecs(shapeRender(l));
  if (!label) return;
  map.addLayer(label, map.getLayer(anchors.label) ? anchors.label : anchorFor(map, l, anchors));
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
  const ordered = [...below, ...above];
  // Geometry first, then every label — so a shape's name can't end up under the
  // next layer's fill just because that layer sorts higher.
  for (const l of ordered) addBody(map, l, anchors);
  for (const l of ordered) addText(map, l, anchors);
}

/** Live-drag path: move an image overlay without rebuilding anything. */
export function setLayerCoordinates(map: mapboxgl.Map, l: Layer, corners: Corners) {
  const src = map.getSource(srcId(l)) as mapboxgl.ImageSource | undefined;
  if (src && typeof src.setCoordinates === "function") src.setCoordinates(corners);
}

/** Visitor toggle / eye icon — client-side only, never a DB write. */
export function setLayerVisible(map: mapboxgl.Map, id: string, visible: boolean) {
  for (const lid of shapeLayerIds(lyrId(id))) {
    if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", visible ? "visible" : "none");
  }
}

/** Opacity slider feedback without waiting on a round-trip. */
export function setLayerOpacity(map: mapboxgl.Map, l: Layer, opacity: number) {
  if (l.kind === "image") {
    const lid = lyrId(l.id);
    if (map.getLayer(lid)) map.setPaintProperty(lid, "raster-opacity", opacity);
    return;
  }
  if (!l.geometry) return;
  // Re-derive the specs at the new opacity and push back only the opacity
  // properties, so the fade-per-pass weighting lives in one place.
  const { body, label } = shapeLayerSpecs({ ...shapeRender(l), opacity });
  for (const spec of [...body, ...(label ? [label] : [])]) {
    if (!map.getLayer(spec.id)) continue;
    for (const [k, v] of Object.entries(spec.paint ?? {})) {
      if (k.endsWith("-opacity")) map.setPaintProperty(spec.id, k as PaintName, v as number);
    }
  }
}
