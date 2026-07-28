"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Status, Layer, Corners } from "@/lib/types";
import { resolveMapStyle, hideLegacyLotLayers, applySatelliteTint, DEFAULT_APPEARANCE, STANDARD_CONFIG } from "@/lib/types";
import { syncLayers, setLayerCoordinates, setLayerOpacity } from "@/lib/mapLayers";
import {
  toMerc,
  fromMerc,
  rectFromCorners,
  cornersFromRect,
  scaleRectFromCorner,
  rotateRectTo,
  cornersBbox,
  type Pt,
} from "@/lib/layers";
import { jsend } from "@/lib/client";
import { cx } from "@/components/ui";

/**
 * Pin an image overlay to the ground: drag it into place over the satellite
 * imagery until the render's streets line up with the real ones.
 *
 * **The map is deliberately flat here — pitch 0, terrain off, rotation locked.**
 * Under pitch and terrain, unprojecting a dragged handle back to a ground
 * coordinate is ambiguous (GL JS resolves screen→ground against the DEM, which
 * streams in and changes underneath you), so handles would land somewhere other
 * than where they were dropped. Flattening the camera makes screen↔ground an
 * exact plane projection and sidesteps the whole problem. The operator leaves
 * the editor to check the result in 3D, where the overlay drapes onto terrain.
 *
 * Two modes, one `corners` array:
 *  • **Transform** — move / scale / rotate; stays a rectangle.
 *  • **Fine-tune** — all four corners move independently, for renders that
 *    weren't drawn straight down.
 *
 * Corners are saved on pointer-release, matching the autosave-on-blur idiom the
 * rest of the portal uses.
 */

const FILL = "le-fill";
const LINE = "le-line";
const LABEL = "le-label";

// Keeps the overlay's grips out from under the floating hint card (top-left)
// and the command bar (bottom) whenever we frame it.
const FRAME_PADDING = { top: 96, left: 64, right: 64, bottom: 130 };

type Mode = "transform" | "fine";
type Drag =
  | { kind: "move"; startCorners: Corners; startMerc: Pt }
  | { kind: "scale"; index: number; startRect: ReturnType<typeof rectFromCorners> }
  | { kind: "rotate"; startRect: ReturnType<typeof rectFromCorners> }
  | { kind: "corner"; index: number };

type Screen = { quad: [number, number][]; rotate: [number, number] | null };

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

export default function LayerEditor({
  slug,
  layer,
  onSaved,
  onDone,
  className,
}: {
  slug: string;
  layer: Layer;
  onSaved: (l: Layer) => void;
  onDone: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const dragRef = useRef<Drag | null>(null);

  // The live corner set. Held in a ref too, so pointer handlers (bound once)
  // always read the current value without re-binding on every frame.
  const [corners, setCorners] = useState<Corners>(layer.corners as Corners);
  const cornersRef = useRef<Corners>(corners);
  const layerRef = useRef<Layer>(layer);

  const [mode, setMode] = useState<Mode>("transform");
  const [lockAspect, setLockAspect] = useState(true);
  const [opacity, setOpacity] = useState(layer.opacity);
  const [screen, setScreen] = useState<Screen>({ quad: [], rotate: null });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const setCornersBoth = useCallback((c: Corners) => {
    cornersRef.current = c;
    setCorners(c);
    const map = mapRef.current;
    if (map) setLayerCoordinates(map, layerRef.current, c);
  }, []);

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
      const [w, s, e, n] = cornersBbox(cornersRef.current);

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: resolveMapStyle(cfg.development.mapbox_style, appearance.basemap),
        bounds: [
          [w, s],
          [e, n],
        ],
        // Asymmetric padding clears the floating chrome: a corner grip tucked
        // under the hint card or the command bar can't be grabbed.
        fitBoundsOptions: { padding: FRAME_PADDING },
        // Flat and locked: see the note at the top of this file.
        pitch: 0,
        bearing: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
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

        // Draw the whole stack for context, but force the layer being edited
        // visible and at the operator's working opacity even if it's hidden in
        // the panel — you can't align something you can't see.
        const edited = layerRef.current;
        const all = (cfg.layers ?? []).map((l) =>
          l.id === edited.id
            ? { ...l, visible: true, opacity, corners: cornersRef.current }
            : l
        );
        if (!all.some((l) => l.id === edited.id)) {
          all.push({ ...edited, visible: true, opacity, corners: cornersRef.current });
        }
        syncLayers(map, all, { fill: FILL, label: LABEL });

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
    // Bootstraps once per layer; live corner/opacity changes flow through refs
    // and the imperative map helpers, never through a re-run of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, layer.id]);

  // ---- Keep the handle overlay glued to the ground -------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const paint = () => {
      const c = cornersRef.current;
      const quad = c.map((p) => {
        const pt = map.project(p as [number, number]);
        return [pt.x, pt.y] as [number, number];
      });
      // Rotation grip: off the top edge, 34px clear of it in screen space, so
      // it sits the same distance away at every zoom.
      let rotate: [number, number] | null = null;
      const [tl, tr, , bl] = quad;
      if (tl && tr && bl) {
        const mx = (tl[0] + tr[0]) / 2;
        const my = (tl[1] + tr[1]) / 2;
        const ux = tl[0] - bl[0];
        const uy = tl[1] - bl[1];
        const len = Math.hypot(ux, uy) || 1;
        rotate = [mx + (ux / len) * 34, my + (uy / len) * 34];
      }
      setScreen({ quad, rotate });
    };
    paint();
    map.on("render", paint);
    return () => {
      map.off("render", paint);
    };
  }, [ready, corners]);

  // ---- Dragging ------------------------------------------------------------

  /** Pointer → ground, in mercator. Exact because the camera is flat. */
  function pointerMerc(e: { clientX: number; clientY: number }): Pt | null {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return null;
    const r = el.getBoundingClientRect();
    const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
    return toMerc([ll.lng, ll.lat]);
  }

  /**
   * Drags run on **window** listeners, not on the SVG or via pointer capture.
   * A corner grip is 14px across, so the pointer is off it almost immediately —
   * anything scoped to the handle itself stops receiving moves the moment the
   * drag actually starts, and the overlay silently refuses to resize. Listening
   * on the window also keeps a drag alive when the pointer leaves the map box.
   */
  function beginDrag(e: React.PointerEvent, drag: Drag) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = drag;
    // Snapshot the modifier now: it can't meaningfully change mid-drag, and
    // reading it here keeps the listener free of stale-closure surprises.
    const lock = lockAspect;

    const onMove = (ev: PointerEvent) => {
      const p = pointerMerc(ev);
      if (!p) return;
      ev.preventDefault();

      if (drag.kind === "move") {
        // Translation works on the raw quad, not a re-derived rectangle — so
        // nudging a fine-tuned (perspective-corrected) overlay never squares it up.
        const dx = p[0] - drag.startMerc[0];
        const dy = p[1] - drag.startMerc[1];
        setCornersBoth(
          drag.startCorners.map((c) => {
            const m = toMerc(c);
            return fromMerc([m[0] + dx, m[1] + dy]);
          }) as Corners
        );
      } else if (drag.kind === "scale") {
        setCornersBoth(cornersFromRect(scaleRectFromCorner(drag.startRect, drag.index, p, lock)));
      } else if (drag.kind === "rotate") {
        setCornersBoth(cornersFromRect(rotateRectTo(drag.startRect, p)));
      } else {
        // Fine-tune: this corner alone, straight to where the pointer is.
        const next = [...cornersRef.current] as Corners;
        next[drag.index] = fromMerc(p);
        setCornersBoth(next);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragRef.current = null;
      void save();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await jsend<Layer>(`/api/layer/${layer.id}`, "PATCH", {
        corners: cornersRef.current,
      });
      layerRef.current = { ...layerRef.current, corners: cornersRef.current };
      onSaved(updated ?? layerRef.current);
      setDirty(false);
    } catch (err) {
      setDirty(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function commitOpacity(v: number) {
    const map = mapRef.current;
    if (map) setLayerOpacity(map, layerRef.current, v);
    jsend<Layer>(`/api/layer/${layer.id}`, "PATCH", { opacity: v })
      .then((l) => {
        layerRef.current = { ...layerRef.current, opacity: v };
        onSaved(l ?? layerRef.current);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function zoomToLayer() {
    const map = mapRef.current;
    if (!map) return;
    const [w, s, e, n] = cornersBbox(cornersRef.current);
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: FRAME_PADDING, duration: 600 }
    );
  }

  const quad = screen.quad;
  const showRotate = mode === "transform" && screen.rotate && quad.length === 4;

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]",
        className
      )}
    >
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      {/* The overlay's outline and body-drag target, under the floating chrome.
          Transparent to pointers except on the quad itself, so panning the map
          outside the overlay still works. */}
      {ready && quad.length === 4 && (
        <svg
          className="absolute inset-0 z-20 h-full w-full"
          style={{ pointerEvents: "none", touchAction: "none" }}
        >
          <polygon
            points={quad.map((p) => p.join(",")).join(" ")}
            fill="rgba(154,123,69,0.06)"
            stroke="#d8b26a"
            strokeWidth={1.5}
            strokeDasharray="7 5"
            style={{ pointerEvents: "fill", cursor: "move" }}
            onPointerDown={(e) => {
              const p = pointerMerc(e);
              if (!p) return;
              beginDrag(e, { kind: "move", startCorners: cornersRef.current, startMerc: p });
            }}
          />
          {showRotate && screen.rotate && (
            <line
              x1={(quad[0][0] + quad[1][0]) / 2}
              y1={(quad[0][1] + quad[1][1]) / 2}
              x2={screen.rotate[0]}
              y2={screen.rotate[1]}
              stroke="#d8b26a"
              strokeWidth={1.5}
            />
          )}
        </svg>
      )}

      {/* Grips ride ABOVE the hint card and command bar (z-40). An overlay whose
          corner happens to sit behind a floating control would otherwise be
          impossible to resize — the press lands on the chrome and nothing moves.
          Only the grips themselves occlude the bar, and they're 14px. */}
      {ready && quad.length === 4 && (
        <svg
          className="absolute inset-0 z-40 h-full w-full"
          style={{ pointerEvents: "none", touchAction: "none" }}
        >
          {showRotate && screen.rotate && (
            <circle
              cx={screen.rotate[0]}
              cy={screen.rotate[1]}
              r={8}
              fill="#0c0f16"
              stroke="#d8b26a"
              strokeWidth={2}
              style={{ pointerEvents: "all", cursor: "grab" }}
              onPointerDown={(e) =>
                beginDrag(e, { kind: "rotate", startRect: rectFromCorners(cornersRef.current) })
              }
            />
          )}
          {quad.map((p, i) => (
            <rect
              key={i}
              x={p[0] - 7}
              y={p[1] - 7}
              width={14}
              height={14}
              rx={mode === "fine" ? 7 : 3}
              fill={mode === "fine" ? "#d8b26a" : "#ffffff"}
              stroke="#0c0f16"
              strokeWidth={1.5}
              style={{ pointerEvents: "all", cursor: mode === "fine" ? "crosshair" : "nwse-resize" }}
              onPointerDown={(e) =>
                beginDrag(
                  e,
                  mode === "fine"
                    ? { kind: "corner", index: i }
                    : { kind: "scale", index: i, startRect: rectFromCorners(cornersRef.current) }
                )
              }
            />
          ))}
        </svg>
      )}

      {/* Floating chrome sits above the handle overlay, so every non-interactive
          part of it must pass pointers through — otherwise it silently eats the
          corner grips underneath it and the overlay just refuses to resize. */}
      <div className="pointer-events-none absolute left-4 top-4 z-30 max-w-[300px]">
        <span className="glass-dark block rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/70">
          {mode === "transform" ? (
            <>
              Drag the image to move it, a corner to resize, the top grip to rotate.{" "}
              <strong className="text-white/90">Tilt and terrain are off while you position</strong> so
              handles land exactly where you drop them.
            </>
          ) : (
            <>
              Drag each corner on its own to correct a render that wasn&apos;t drawn straight down.{" "}
              <strong className="text-white/90">Resizing or rotating squares the shape back up</strong>,
              so fine-tune last.
            </>
          )}
        </span>
      </div>

      {error && (
        <div className="glass-dark pop-in pointer-events-none absolute left-4 top-24 z-30 max-w-sm rounded-[var(--radius)] px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">
            Couldn&apos;t save
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
        </div>
      )}

      {/* Command bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark pointer-events-auto mx-auto flex max-w-[840px] flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex rounded-[var(--radius-sm)] border border-white/15 p-0.5">
            {(["transform", "fine"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cx(
                  "h-7 rounded-[6px] px-3 text-[12px] font-medium transition",
                  mode === m ? "bg-white text-[#0c0f16]" : "text-white/65 hover:text-white"
                )}
              >
                {m === "transform" ? "Move & scale" : "Fine-tune corners"}
              </button>
            ))}
          </div>

          {mode === "transform" && (
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-white/70">
              <input
                type="checkbox"
                checked={lockAspect}
                onChange={(e) => setLockAspect(e.target.checked)}
                className="h-3.5 w-3.5 accent-[#d8b26a]"
              />
              Lock aspect
            </label>
          )}

          <label className="flex min-w-[150px] flex-1 items-center gap-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
              Opacity
            </span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => {
                const v = Number(e.target.value);
                setOpacity(v);
                const map = mapRef.current;
                if (map) setLayerOpacity(map, layerRef.current, v);
              }}
              onPointerUp={() => commitOpacity(opacity)}
              onKeyUp={() => commitOpacity(opacity)}
              className="h-1 flex-1 accent-[#d8b26a]"
              aria-label="Overlay opacity"
            />
            <span className="w-9 shrink-0 text-right font-mono text-[11px] text-white/70 tabular-nums">
              {Math.round(opacity * 100)}%
            </span>
          </label>

          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <span
              className="font-mono text-[11px] tracking-[0.1em] text-white/45"
              aria-live="polite"
            >
              {saving ? "SAVING" : dirty ? "UNSAVED" : "SAVED"}
            </span>
            <button
              onClick={zoomToLayer}
              disabled={!ready}
              className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-40"
            >
              Zoom to layer
            </button>
            <button
              onClick={onDone}
              disabled={!ready}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
