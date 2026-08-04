"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Status, Layer, ShapeStyle, LineLook } from "@/lib/types";
import {
  resolveMapStyle,
  hideLegacyLotLayers,
  applySatelliteTint,
  DEFAULT_APPEARANCE,
  DEFAULT_SHAPE_STYLE,
  STANDARD_CONFIG,
} from "@/lib/types";
import { syncLayers, renderShape } from "@/lib/mapLayers";
import {
  shapeGeometry,
  shapePoints,
  shapeBbox,
  MIN_SHAPE_POINTS,
  MAX_SHAPE_LABEL,
  type ShapeKind,
} from "@/lib/layers";
import { jsend } from "@/lib/client";
import { cx } from "@/components/ui";

/**
 * Draw a non-parcel feature straight onto the map — a river, a pond, a trail, a
 * park boundary — for developments with no site-plan render to pin.
 *
 * **The map is deliberately flat here — pitch 0, terrain off, rotation locked**,
 * for the same reason `LayerEditor` flattens it: under pitch and terrain, GL JS
 * resolves screen→ground against a DEM that is still streaming, so a clicked
 * vertex lands somewhere other than where it was clicked, and the error changes
 * as tiles arrive. Flat ground makes screen↔ground an exact plane projection.
 * The operator leaves the editor to check the result in 3D, where the shape
 * drapes onto terrain.
 *
 * Two phases over one vertex list:
 *  • **draw** — click to place vertices, with a rubber band to the cursor.
 *  • **edit** — drag a vertex to move it, a midpoint to insert one, Delete to
 *    remove the selected one.
 *
 * The shape is **created on the server the moment it first becomes valid** (3
 * points for an area, 2 for a line) and patched from then on. Deliberately not
 * created-up-front the way an image layer is: an image is already a finished
 * artifact worth protecting from a lost session, whereas a zero-vertex shape is
 * nothing — creating one up front would leave an undrawable row behind every
 * time an operator opened the tool and changed their mind.
 *
 * What renders here is what the embed renders: the preview goes through
 * `renderShape()` — the same spec builder `mapLayers.ts` uses for the real thing
 * — so a shape can't gain an outline, a look or a label in the editor that the
 * visitor never sees.
 */

const FILL = "se-fill";
const LINE = "se-line";
const LABEL = "se-label";

const PREVIEW_SRC = "se-shape-src";
const PREVIEW_ID = "se-shape";

// Clears the floating hint card (top-left) and the command bar (bottom) when we
// frame an existing shape, so its grips aren't born under the chrome. The bar is
// two rows — shape, then the text drawn on it — hence the deep bottom inset.
const FRAME_PADDING = { top: 96, left: 64, right: 64, bottom: 196 };

// Screen-space slop, in px. CLOSE_PX is how near the first vertex a click has to
// land to close a polygon; DEDUPE_PX drops the second click of a double-click,
// which would otherwise leave a zero-length segment behind at the finish point.
const CLOSE_PX = 12;
const DEDUPE_PX = 6;

// A line's paint recipe. "River" is three passes derived from the one colour
// (see `shapeLayerSpecs`); everything else about the shape is unchanged, so it's
// a look, not a kind — an operator can flip a drawn creek to solid and back.
const LOOKS: { value: LineLook; label: string; hint: string }[] = [
  { value: "solid", label: "Solid", hint: "One flat stroke — a trail, a boundary, a fence line." },
  {
    value: "river",
    label: "River",
    hint: "Soft dark banks and a lighter centre, so the line reads as water.",
  },
];

const SWATCHES: { color: string; label: string }[] = [
  { color: "#4a7fb5", label: "Water" },
  { color: "#5c8f5c", label: "Fairway" },
  { color: "#3f6b4a", label: "Woodland" },
  { color: "#b59a6a", label: "Path" },
  { color: "#8b8f96", label: "Stone" },
  { color: "#c25b4e", label: "Accent" },
];

type Phase = "draw" | "edit";
type ScreenPt = [number, number];
type Screen = { pts: ScreenPt[]; mids: { at: ScreenPt; insertAt: number }[]; hover: ScreenPt | null };

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

/** lng/lat bbox of the lot cluster — where a brand-new shape opens framed. */
function parcelsBbox(fc: GeoJSON.FeatureCollection): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of fc.features ?? []) {
    const g = f.geometry;
    const polys = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys)
      for (const ring of poly)
        for (const pt of ring) {
          w = Math.min(w, pt[0]);
          s = Math.min(s, pt[1]);
          e = Math.max(e, pt[0]);
          n = Math.max(n, pt[1]);
        }
  }
  return Number.isFinite(w) && e > w ? [w, s, e, n] : null;
}

export default function ShapeEditor({
  slug,
  layer,
  kind,
  onCreated,
  onSaved,
  onDone,
  className,
}: {
  slug: string;
  /** null → drawing a brand-new shape; a row → editing its vertices. */
  layer: Layer | null;
  kind: ShapeKind;
  onCreated: (l: Layer) => void;
  onSaved: (l: Layer) => void;
  onDone: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  // The live vertex list, in lng/lat. Mirrored into a ref so map handlers and
  // window-bound drags (both bound once) always read the current value without
  // re-binding on every placed point.
  const [pts, setPts] = useState<[number, number][]>(() => shapePoints(layer?.geometry));
  const ptsRef = useRef(pts);
  // Last vertex list the server accepted — what Escape reverts an extension to.
  const savedPtsRef = useRef(pts);

  const [phase, setPhase] = useState<Phase>(layer ? "edit" : "draw");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const hoverRef = useRef(hover);
  const phaseRef = useRef(phase);

  // Placeholder name until the operator types one — or until they label the shape
  // on the map, which `commitLabel` adopts as the name while it's still this.
  const defaultName = kind === "polygon" ? "Area" : "Line";
  const [name, setName] = useState(layer?.name ?? defaultName);
  const nameRef = useRef(name);
  // What the server last heard, so leaving the field untouched isn't a write.
  const committedNameRef = useRef(name);
  const [style, setStyle] = useState<ShapeStyle>({ ...DEFAULT_SHAPE_STYLE, ...(layer?.style ?? {}) });
  const styleRef = useRef(style);

  const [screen, setScreen] = useState<Screen>({ pts: [], mids: [], hover: null });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // The row id lives in a ref (handlers and the bootstrap effect read it) but
  // "does the row exist yet" is also rendered, so it needs to be state — a ref
  // wouldn't re-render the readout on the transition from drawing to created.
  const layerIdRef = useRef<string | null>(layer?.id ?? null);
  const [exists, setExists] = useState(!!layer);
  const layerOpacity = layer?.opacity ?? 1;
  const aboveLots = layer?.above_lots ?? false;
  const minPts = MIN_SHAPE_POINTS[kind];

  // ---- Preview: the shape as the embed will draw it -------------------------
  // Two paths, because they run at different rates. Geometry changes every drag
  // frame and only needs the source refreshed; a style change can add or drop
  // whole layers (solid ↔ river is three passes instead of one, a typed label is
  // a symbol layer that didn't exist), so it rebuilds through the shared builder.

  const paintPreview = useCallback(() => {
    const src = mapRef.current?.getSource(PREVIEW_SRC) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const g = shapeGeometry(kind, ptsRef.current);
    src.setData(
      g
        ? { type: "Feature", geometry: g, properties: {} }
        : { type: "FeatureCollection", features: [] }
    );
  }, [kind]);

  const restylePreview = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource(PREVIEW_SRC)) return;
    // The spec builder only reads `geometry.type`, so an empty stub is enough to
    // pick fill-vs-line while the shape is still short of its first valid point.
    const stub: GeoJSON.Geometry =
      kind === "polygon"
        ? { type: "Polygon", coordinates: [] }
        : { type: "LineString", coordinates: [] };
    // Preview rides the same anchors the real layer will: an under-lots shape is
    // already correctly occluded, and its text already sits with the lot numbers.
    const bodyAnchor = aboveLots ? LABEL : FILL;
    renderShape(
      map,
      {
        baseId: PREVIEW_ID,
        source: PREVIEW_SRC,
        geometry: stub,
        style: styleRef.current,
        opacity: layerOpacity,
      },
      {
        body: map.getLayer(bodyAnchor) ? bodyAnchor : undefined,
        label: map.getLayer(LABEL) ? LABEL : undefined,
      }
    );
  }, [kind, aboveLots, layerOpacity]);

  const setPtsBoth = useCallback(
    (next: [number, number][]) => {
      ptsRef.current = next;
      setPts(next);
      paintPreview();
    },
    [paintPreview]
  );

  // ---- Writes --------------------------------------------------------------
  // Serialized through one promise chain. Two reasons: a vertex drag can release
  // while the previous PATCH is still in flight (out-of-order writes would leave
  // the row holding an older geometry than the screen), and before the row
  // exists two concurrent calls would each POST and create a duplicate layer.

  const inflight = useRef<Promise<void>>(Promise.resolve());

  const persist = useCallback(
    async (body: { geometry?: GeoJSON.Geometry; style?: ShapeStyle; name?: string }) => {
      const geometry = body.geometry ?? shapeGeometry(kind, ptsRef.current);
      setError(null);
      setSaving(true);
      try {
        if (layerIdRef.current) {
          const updated = await jsend<Layer>(`/api/layer/${layerIdRef.current}`, "PATCH", body);
          if (updated) onSaved(updated);
        } else {
          // Nothing to create until the shape is actually drawable — a style or
          // name tweak on an empty canvas is just local state for now.
          if (!geometry) return;
          const created = await jsend<Layer>(`/api/dev/${slug}/layers`, "POST", {
            kind: "shape",
            name: nameRef.current,
            geometry,
            style: styleRef.current,
          });
          layerIdRef.current = created.id;
          setExists(true);
          onCreated(created);
        }
        if (body.geometry) savedPtsRef.current = ptsRef.current;
        setDirty(false);
      } catch (e) {
        setDirty(true);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [kind, slug, onCreated, onSaved]
  );

  const queue = useCallback(
    (body: { geometry?: GeoJSON.Geometry; style?: ShapeStyle; name?: string }) => {
      inflight.current = inflight.current.then(() => persist(body)).catch(() => {});
    },
    [persist]
  );

  // ---- Map bootstrap -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let map: mapboxgl.Map | null = null;

    (async () => {
      const [cRes, pRes] = await Promise.all([
        fetch(`/api/dev/${slug}/config?state=draft`),
        fetch(`/api/dev/${slug}/parcels?state=draft`),
      ]);
      if (!cRes.ok) {
        if (!cancelled) setError("Couldn't load this development.");
        return;
      }
      const cfg = (await cRes.json()) as MapConfig;
      const fc = (await pRes.json()) as GeoJSON.FeatureCollection;
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = cfg.development.mapbox_token;
      const appearance = cfg.development.map_appearance ?? DEFAULT_APPEARANCE;
      // An existing shape frames itself; a new one frames the lots it belongs to,
      // falling back to the development's opening view when there are none yet.
      const box = shapeBbox(layer?.geometry) ?? parcelsBbox(fc);

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: resolveMapStyle(cfg.development.mapbox_style, appearance.basemap),
        ...(box
          ? {
              bounds: [
                [box[0], box[1]],
                [box[2], box[3]],
              ] as [[number, number], [number, number]],
              fitBoundsOptions: { padding: FRAME_PADDING },
            }
          : {
              center: cfg.development.default_view.center,
              zoom: Math.max(14, cfg.development.default_view.zoom ?? 14),
            }),
        // Flat and locked: see the note at the top of this file.
        pitch: 0,
        bearing: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // Double-click is the finish-drawing gesture; letting it zoom as well
        // would yank the ground out from under the shape the moment it's done.
        doubleClickZoom: false,
        antialias: true,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

      map.on("load", () => {
        if (!map) return;
        hideLegacyLotLayers(map);

        const standardCfg = STANDARD_CONFIG[appearance.basemap];
        if (standardCfg) {
          for (const [k, v] of Object.entries(standardCfg)) {
            try {
              map.setConfigProperty("basemap", k, v);
            } catch {
              /* style may not support this config property */
            }
          }
        }
        applySatelliteTint(map, appearance);
        // Terrain stays off on purpose — flat ground keeps unproject exact.
        map.setTerrain(null);

        map.addSource("parcels", { type: "geojson", data: fc, promoteId: "parcel_id" });
        map.addLayer({
          id: FILL,
          type: "fill",
          source: "parcels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          paint: { "fill-color": fillColorExpr(cfg.statuses) as any, "fill-opacity": 0.45, "fill-outline-color": "#ffffff" },
        });
        map.addLayer({
          id: LINE,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 0.55 },
        });
        map.addLayer({
          id: LABEL,
          type: "symbol",
          source: "parcels",
          layout: {
            "text-field": ["coalesce", ["get", "lot_number"], ""] as unknown as string,
            "text-size": 12,
            "text-allow-overlap": false,
          },
          paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1, "text-opacity": 0.85 },
        });

        // Every *other* layer for context. The one being drawn is excluded and
        // rendered as the preview below instead, so it isn't drawn twice — once
        // stale from the config and once live.
        syncLayers(
          map,
          (cfg.layers ?? []).filter((l) => l.id !== layerIdRef.current),
          { fill: FILL, label: LABEL }
        );

        map.addSource(PREVIEW_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        restylePreview();
        paintPreview();

        setReady(true);
        setTimeout(() => map?.resize(), 200);
      });
    })().catch((err) => {
      if (!cancelled) setError(String(err instanceof Error ? err.message : err));
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // Bootstraps once per edited shape. Live vertex/style changes flow through
    // refs and the imperative map helpers, never a re-run of this effect — and
    // `layer` is deliberately not a dep: creating the row mid-session must not
    // tear the map down under the operator's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, layer?.id, kind]);

  // ---- Keep the handle overlay glued to the ground -------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const paint = () => {
      const project = (p: [number, number]): ScreenPt => {
        const q = map.project(p);
        return [q.x, q.y];
      };
      const sp = ptsRef.current.map(project);
      // Midpoints are insertion affordances, so they only exist once the shape
      // is finished — during drawing the next click already appends a vertex.
      const mids: { at: ScreenPt; insertAt: number }[] = [];
      if (phaseRef.current === "edit" && sp.length >= 2) {
        // A polygon's closing segment gets one too; a line's ends are open.
        const segs = kind === "polygon" ? sp.length : sp.length - 1;
        for (let i = 0; i < segs; i++) {
          const a = sp[i];
          const b = sp[(i + 1) % sp.length];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 34) continue; // too tight to hit
          mids.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], insertAt: i + 1 });
        }
      }
      const h = hoverRef.current;
      setScreen({ pts: sp, mids, hover: h && phaseRef.current === "draw" ? project(h) : null });
    };
    paint();
    map.on("render", paint);
    return () => {
      map.off("render", paint);
    };
  }, [ready, pts, hover, phase, kind]);

  // ---- Drawing -------------------------------------------------------------

  const finish = useCallback(() => {
    const g = shapeGeometry(kind, ptsRef.current);
    if (!g) return; // not enough vertices yet — stay in draw
    hoverRef.current = null;
    setHover(null);
    phaseRef.current = "edit";
    setPhase("edit");
    queue({ geometry: g });
  }, [kind, queue]);

  const cancelDraw = useCallback(() => {
    hoverRef.current = null;
    setHover(null);
    if (layerIdRef.current) {
      // Extending an existing shape: throw away the new vertices, keep the row.
      setPtsBoth(savedPtsRef.current);
      phaseRef.current = "edit";
      setPhase("edit");
    } else {
      onDone();
    }
  }, [onDone, setPtsBoth]);

  // Map-level gestures. Rebinds on phase change (the cursor and the meaning of a
  // click both change); handlers read refs, so placing a vertex doesn't rebind.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    phaseRef.current = phase;
    map.getCanvas().style.cursor = phase === "draw" ? "crosshair" : "";
    if (phase !== "draw") return;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const cur = ptsRef.current;
      const here = map.project(p);

      if (kind === "polygon" && cur.length >= minPts) {
        const first = map.project(cur[0]);
        if (Math.hypot(first.x - here.x, first.y - here.y) < CLOSE_PX) {
          finish();
          return;
        }
      }
      if (cur.length) {
        const last = map.project(cur[cur.length - 1]);
        if (Math.hypot(last.x - here.x, last.y - here.y) < DEDUPE_PX) return;
      }
      setPtsBoth([...cur, p]);
    };

    const onMove = (e: mapboxgl.MapMouseEvent) => {
      if (!ptsRef.current.length) return;
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      hoverRef.current = p;
      setHover(p);
    };

    const onLeave = () => {
      hoverRef.current = null;
      setHover(null);
    };

    const onDbl = () => finish();

    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    map.on("dblclick", onDbl);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("mouseout", onLeave);
      map.off("dblclick", onDbl);
      try {
        map.getCanvas().style.cursor = "";
      } catch {
        /* map already torn down by the bootstrap effect's cleanup */
      }
    };
  }, [ready, phase, kind, minPts, finish, setPtsBoth]);

  // ---- Vertex editing ------------------------------------------------------

  /** Pointer → ground. Exact because the camera is flat. */
  function pointerLngLat(e: { clientX: number; clientY: number }): [number, number] | null {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return null;
    const r = el.getBoundingClientRect();
    const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
    return [ll.lng, ll.lat];
  }

  const removeVertex = useCallback(
    (index: number) => {
      const cur = ptsRef.current;
      // Refuse below the minimum rather than deleting into an invalid shape the
      // server would reject on the next drag.
      if (cur.length <= minPts) {
        setError(
          kind === "polygon"
            ? "An area needs at least 3 points — delete the whole layer instead."
            : "A line needs at least 2 points — delete the whole layer instead."
        );
        return;
      }
      setError(null);
      const next = cur.filter((_, i) => i !== index);
      setPtsBoth(next);
      setSelected(null);
      const g = shapeGeometry(kind, next);
      if (g) queue({ geometry: g });
    },
    [kind, minPts, queue, setPtsBoth]
  );

  /**
   * Drags run on **window** listeners, not on the SVG or via pointer capture —
   * the same lesson as `LayerEditor`: a grip is 13px across, so the pointer is
   * off it almost immediately and any handle-scoped listener stops receiving
   * moves the instant the drag matters. The window also keeps a drag alive when
   * the pointer leaves the map box.
   */
  function dragVertex(index: number) {
    const onMove = (ev: PointerEvent) => {
      const ll = pointerLngLat(ev);
      if (!ll) return;
      ev.preventDefault();
      const next = [...ptsRef.current];
      next[index] = ll;
      setPtsBoth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const g = shapeGeometry(kind, ptsRef.current);
      if (g) queue({ geometry: g });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onVertexDown(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    // Alt-click is the fast path for a stray vertex; the slow path is select +
    // Delete, which is what the hint documents.
    if (e.altKey) {
      removeVertex(index);
      return;
    }
    setSelected(index);
    dragVertex(index);
  }

  function onMidDown(e: React.PointerEvent, at: ScreenPt, insertAt: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    if (!map) return;
    const ll = map.unproject(at);
    const next = [...ptsRef.current];
    next.splice(insertAt, 0, [ll.lng, ll.lat]);
    setPtsBoth(next);
    setSelected(insertAt);
    // ptsRef already holds the inserted vertex, so this drags the new one.
    dragVertex(insertAt);
  }

  // ---- Keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The name field lives in the command bar: Backspace there is a backspace.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      if (phase === "draw") {
        if (e.key === "Enter") {
          e.preventDefault();
          finish();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          setPtsBoth(ptsRef.current.slice(0, -1));
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelDraw();
        }
        return;
      }
      if (e.key === "Escape") setSelected(null);
      if ((e.key === "Backspace" || e.key === "Delete") && selected != null) {
        e.preventDefault();
        removeVertex(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, selected, finish, cancelDraw, removeVertex, setPtsBoth]);

  // ---- Style / name commits ------------------------------------------------

  /** On-map + local only. For controls that fire continuously: sliders, typing. */
  function previewStyle(patch: Partial<ShapeStyle>) {
    const next = { ...styleRef.current, ...patch };
    styleRef.current = next;
    setStyle(next);
    restylePreview();
  }

  function commitStyle(patch: Partial<ShapeStyle>) {
    previewStyle(patch);
    queue({ style: styleRef.current });
  }

  function commitName(v: string) {
    const trimmed = v.trim() || defaultName;
    nameRef.current = trimmed;
    setName(trimmed);
    if (committedNameRef.current === trimmed) return; // blurred without editing
    committedNameRef.current = trimmed;
    // Before the row exists there's nothing to PATCH; the create call reads
    // `nameRef`, which is already current.
    if (layerIdRef.current) queue({ name: trimmed });
  }

  function commitLabel(v: string) {
    const label = v.trim();
    // A stack of layers called "Line" is nobody's intent: if the operator hasn't
    // named this one, the text they just drew on the map is the best name going.
    // Named first so a shape created by this same keystroke is POSTed named.
    if (label && nameRef.current === defaultName) commitName(label);
    commitStyle({ label });
  }

  async function done() {
    if (phase === "draw") finish();
    await inflight.current;
    onDone();
  }

  // ---- Render --------------------------------------------------------------

  const sp = screen.pts;
  const enough = pts.length >= minPts;
  // Drawing outline: the placed vertices, plus the rubber band to the cursor,
  // plus (for an area) the segment that will close the ring.
  const trail = phase === "draw" && screen.hover ? [...sp, screen.hover] : sp;
  const outline =
    kind === "polygon" && trail.length >= 2 && (phase === "edit" || enough)
      ? [...trail, trail[0]]
      : trail;

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]",
        className
      )}
    >
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      {/* Outline + rubber band. Pointer-transparent throughout: in draw phase the
          map's own click handler needs every press, and in edit phase only the
          grips (z-40) should take one. */}
      {ready && outline.length >= 2 && (
        <svg className="absolute inset-0 z-20 h-full w-full" style={{ pointerEvents: "none" }}>
          <polyline
            points={outline.map((p) => p.join(",")).join(" ")}
            fill="none"
            stroke="#d8b26a"
            strokeWidth={1.5}
            strokeDasharray={phase === "draw" ? "7 5" : undefined}
            strokeLinejoin="round"
          />
        </svg>
      )}

      {/* Grips ride ABOVE the floating chrome (z-40) for the same reason the image
          editor's do: a vertex that happens to sit behind the command bar would
          otherwise be impossible to grab. They're 13px, so they occlude almost
          nothing. */}
      {ready && (
        <svg
          className="absolute inset-0 z-40 h-full w-full"
          style={{ pointerEvents: "none", touchAction: "none" }}
        >
          {phase === "edit" &&
            screen.mids.map((m) => (
              <circle
                key={`m${m.insertAt}`}
                cx={m.at[0]}
                cy={m.at[1]}
                r={4.5}
                fill="#0c0f16"
                stroke="#d8b26a"
                strokeWidth={1.5}
                style={{ pointerEvents: "all", cursor: "copy" }}
                onPointerDown={(e) => onMidDown(e, m.at, m.insertAt)}
              />
            ))}

          {sp.map((p, i) => {
            const isFirst = i === 0;
            // In draw phase the first vertex of an area is the close target, so
            // it reads as a target rather than a plain placed point.
            const closeTarget = phase === "draw" && kind === "polygon" && isFirst && enough;
            return (
              <rect
                key={i}
                x={p[0] - 6.5}
                y={p[1] - 6.5}
                width={13}
                height={13}
                rx={closeTarget ? 6.5 : selected === i ? 3 : 2.5}
                fill={selected === i ? "#d8b26a" : closeTarget ? "#d8b26a" : "#ffffff"}
                stroke="#0c0f16"
                strokeWidth={1.5}
                style={
                  phase === "edit"
                    ? { pointerEvents: "all", cursor: "grab" }
                    : { pointerEvents: "none" }
                }
                onPointerDown={phase === "edit" ? (e) => onVertexDown(e, i) : undefined}
              />
            );
          })}
        </svg>
      )}

      {/* Floating chrome sits above the outline but below the grips, and every
          non-interactive part passes pointers through. */}
      <div className="pointer-events-none absolute left-4 top-4 z-30 max-w-[320px]">
        <span className="glass-dark block rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/70">
          {phase === "draw" ? (
            <>
              Click to place points{kind === "polygon" ? ", then click the first point to close the area" : ""}.
              Double-click or press Enter to finish, Backspace to undo a point.{" "}
              <strong className="text-white/90">Tilt and terrain are off while you draw</strong> so
              points land exactly where you click.
            </>
          ) : (
            <>
              Drag a point to move it, a hollow midpoint to add one. Click a point and press Delete
              to remove it (or ⌥-click).{" "}
              <strong className="text-white/90">Check it in 3D from the preview</strong> — on the map
              it drapes onto the terrain.
            </>
          )}
        </span>
      </div>

      {error && (
        <div className="glass-dark pop-in pointer-events-none absolute left-4 top-28 z-30 max-w-sm rounded-[var(--radius)] px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">
            {dirty ? "Couldn't save" : "Heads up"}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
        </div>
      )}

      {/* Command bar: shape on the top row, the text drawn on it underneath. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark pointer-events-auto mx-auto flex max-w-[960px] flex-col gap-2.5 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <input
              value={name}
              onChange={(e) => {
                // Mirrored into the ref as it's typed: the shape can be created
                // by the very next click, and the create call reads the ref.
                nameRef.current = e.target.value;
                setName(e.target.value);
              }}
              onBlur={(e) => commitName(e.target.value)}
              aria-label="Shape name"
              placeholder={kind === "polygon" ? "Area name" : "Line name"}
              className="h-8 w-[9.5rem] rounded-[var(--radius-sm)] border border-white/15 bg-white/[0.06] px-2.5 text-[13px] font-medium text-white placeholder:text-white/35 focus:border-white/30 focus:outline-none"
            />

            <div className="flex items-center gap-1.5">
              {SWATCHES.map((s) => (
                <button
                  key={s.color}
                  onClick={() => commitStyle({ color: s.color })}
                  aria-label={s.label}
                  title={s.label}
                  aria-pressed={style.color.toLowerCase() === s.color.toLowerCase()}
                  className={cx(
                    "h-6 w-6 rounded-full border transition",
                    style.color.toLowerCase() === s.color.toLowerCase()
                      ? "border-white ring-2 ring-white/30"
                      : "border-white/25 hover:border-white/60"
                  )}
                  style={{ background: s.color }}
                />
              ))}
              <label
                className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border border-white/25 transition hover:border-white/60"
                title="Custom colour"
              >
                <span
                  className="absolute inset-0"
                  style={{ background: "conic-gradient(#c25b4e,#b59a6a,#5c8f5c,#4a7fb5,#7a5ea8,#c25b4e)" }}
                />
                <input
                  type="color"
                  value={style.color}
                  onChange={(e) => commitStyle({ color: e.target.value })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="Custom colour"
                />
              </label>
            </div>

            {kind === "line" ? (
              <label className="flex min-w-[140px] flex-1 items-center gap-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Width</span>
                <input
                  type="range"
                  min={1}
                  max={40}
                  step={1}
                  value={style.width}
                  onChange={(e) => previewStyle({ width: Number(e.target.value) })}
                  onPointerUp={() => commitStyle({ width: styleRef.current.width })}
                  onKeyUp={() => commitStyle({ width: styleRef.current.width })}
                  className="h-1 flex-1 accent-[#d8b26a]"
                  aria-label="Line width"
                />
                <span className="w-8 shrink-0 text-right font-mono text-[11px] text-white/70 tabular-nums">
                  {style.width}
                </span>
              </label>
            ) : (
              <label className="flex min-w-[140px] flex-1 items-center gap-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Fill</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.fillOpacity}
                  onChange={(e) => previewStyle({ fillOpacity: Number(e.target.value) })}
                  onPointerUp={() => commitStyle({ fillOpacity: styleRef.current.fillOpacity })}
                  onKeyUp={() => commitStyle({ fillOpacity: styleRef.current.fillOpacity })}
                  className="h-1 flex-1 accent-[#d8b26a]"
                  aria-label="Fill opacity"
                />
                <span className="w-9 shrink-0 text-right font-mono text-[11px] text-white/70 tabular-nums">
                  {Math.round(style.fillOpacity * 100)}%
                </span>
              </label>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              <span className="font-mono text-[11px] tracking-[0.1em] text-white/45" aria-live="polite">
                {saving
                  ? "SAVING"
                  : dirty
                    ? "UNSAVED"
                    : exists
                      ? "SAVED"
                      : `${pts.length}/${minPts} POINTS`}
              </span>

              {phase === "draw" ? (
                <>
                  <button
                    onClick={cancelDraw}
                    className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={finish}
                    disabled={!enough}
                    className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
                  >
                    Finish
                  </button>
                </>
              ) : (
                <>
                  {kind === "line" && (
                    <button
                      onClick={() => {
                        phaseRef.current = "draw";
                        setPhase("draw");
                        setSelected(null);
                      }}
                      className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
                    >
                      Keep drawing
                    </button>
                  )}
                  <button
                    onClick={done}
                    disabled={!ready}
                    className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Look + text. Both write straight to the map as you touch them, so the
              decision is made against the imagery rather than a swatch. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-white/10 pt-2.5">
            {kind === "line" && (
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Look</span>
                <div className="flex rounded-[var(--radius-sm)] border border-white/15 p-0.5">
                  {LOOKS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => commitStyle({ look: o.value })}
                      aria-pressed={style.look === o.value}
                      title={o.hint}
                      className={cx(
                        "h-6 rounded-[6px] px-2.5 text-[12px] font-medium transition",
                        style.look === o.value
                          ? "bg-white text-[#10141b]"
                          : "text-white/55 hover:text-white"
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="flex min-w-[220px] flex-1 items-center gap-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Text</span>
              <input
                value={style.label}
                maxLength={MAX_SHAPE_LABEL}
                onChange={(e) => previewStyle({ label: e.target.value })}
                onBlur={() => commitLabel(styleRef.current.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder={
                  kind === "polygon" ? "Name drawn on the area" : "Name drawn along the line"
                }
                title={
                  kind === "polygon"
                    ? "Drawn at the middle of the area."
                    : "Drawn along the line and repeated, the way a river is labelled on a map."
                }
                className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-white/15 bg-white/[0.06] px-2.5 text-[13px] text-white placeholder:text-white/35 focus:border-white/30 focus:outline-none"
              />
            </label>

            {/* Sizing and colouring nothing is noise — these arrive with the text. */}
            {style.label.trim() !== "" && (
              <div className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Size</span>
                  <input
                    type="range"
                    min={8}
                    max={48}
                    step={1}
                    value={style.labelSize}
                    onChange={(e) => previewStyle({ labelSize: Number(e.target.value) })}
                    onPointerUp={() => commitStyle({ labelSize: styleRef.current.labelSize })}
                    onKeyUp={() => commitStyle({ labelSize: styleRef.current.labelSize })}
                    className="h-1 w-[5.5rem] accent-[#d8b26a]"
                    aria-label="Text size"
                  />
                  <span className="w-5 text-right font-mono text-[11px] text-white/70 tabular-nums">
                    {style.labelSize}
                  </span>
                </label>

                <label
                  className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-white/25 transition hover:border-white/60"
                  title="Text colour — the outline behind it flips to stay readable"
                >
                  <span className="absolute inset-0" style={{ background: style.labelColor }} />
                  <input
                    type="color"
                    value={style.labelColor}
                    onChange={(e) => commitStyle({ labelColor: e.target.value })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Text colour"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
