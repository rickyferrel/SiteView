"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Status, ViewState } from "@/lib/types";
import { resolveMapStyle, hideLegacyLotLayers, DEFAULT_APPEARANCE, STANDARD_CONFIG } from "@/lib/types";
import { jsend } from "@/lib/client";
import { cx } from "@/components/ui";

// The operator frames the public map's opening shot here: pan, zoom, tilt and
// rotate the real 3D map (styled + populated exactly like the embed), then
// capture the current camera as the development's default_view.

const FILL = "ov-fill";
const LINE = "ov-line";
const LABEL = "ov-label";

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

function eachVertex(f: GeoJSON.Feature, fn: (pt: [number, number]) => void) {
  const g = f.geometry;
  if (!g) return;
  const polys =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) for (const pt of ring) fn(pt as [number, number]);
}

// Same robust cluster framing the embed uses when no view is locked, so the
// "auto-fit" reset previews exactly what the public map will show.
function lotClusterBounds(fc: GeoJSON.FeatureCollection): mapboxgl.LngLatBounds | null {
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
  const thresh = Math.max(med(dists) * 6, 0.003);
  const kept = feats.filter((_, i) => dists[i] <= thresh);
  const use = kept.length ? kept : feats;
  const b = new mapboxgl.LngLatBounds();
  for (const { f } of use) eachVertex(f, (pt) => b.extend(pt));
  return b.isEmpty() ? null : b;
}

type Props = {
  slug: string;
  className?: string;
  // Fires after a successful save (flow: advance; design: refresh save-state).
  onSaved?: (view: ViewState) => void;
  // Fires after resetting back to auto-fit.
  onReset?: () => void;
};

type Phase = "idle" | "saving" | "saved";

export default function OpeningViewEditor({ slug, className, onSaved, onReset }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fcRef = useRef<GeoJSON.FeatureCollection | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [hud, setHud] = useState({ zoom: 0, pitch: 0, bearing: 0 });

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
      fcRef.current = fc;
      setLocked(cfg.development.view_locked);

      mapboxgl.accessToken = cfg.development.mapbox_token;
      const view = cfg.development.default_view;
      const appearance = cfg.development.map_appearance ?? DEFAULT_APPEARANCE;

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: resolveMapStyle(cfg.development.mapbox_style, appearance.basemap),
        center: view.center,
        zoom: view.zoom,
        pitch: view.pitch,
        bearing: view.bearing,
        maxPitch: 85,
        pitchWithRotate: true,
        antialias: true,
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

      const syncHud = () => {
        if (!map) return;
        setHud({ zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
      };

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

        if (appearance.terrain) {
          if (!map.getSource("mapbox-dem")) {
            map.addSource("mapbox-dem", {
              type: "raster-dem",
              url: "mapbox://mapbox.mapbox-terrain-dem-v1",
              tileSize: 512,
              maxzoom: 14,
            });
          }
          const exaggeration = appearance.terrainExaggeration ?? cfg.development.terrain_exaggeration;
          map.setTerrain({ source: "mapbox-dem", exaggeration });
        }

        map.addSource("parcels", { type: "geojson", data: fc, promoteId: "parcel_id" });
        map.addLayer({
          id: FILL,
          type: "fill",
          source: "parcels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          paint: { "fill-color": fillColorExpr(cfg.statuses) as any, "fill-opacity": 0.75, "fill-outline-color": "#ffffff" },
        });
        map.addLayer({
          id: LINE,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 0.5 },
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

        // If no view is locked yet, open on the same auto-fit the public map
        // currently uses, so the operator adjusts from what visitors see today.
        if (!cfg.development.view_locked) {
          const b = lotClusterBounds(fc);
          if (b) map.fitBounds(b, { padding: 60, pitch: 30, bearing: 0, maxZoom: 16, duration: 0 });
        }

        syncHud();
        setReady(true);
        setTimeout(() => map?.resize(), 200);
      });

      map.on("move", syncHud);
    })().catch((err) => {
      if (!cancelled) setError(String(err));
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [slug]);

  function captureView(): ViewState | null {
    const map = mapRef.current;
    if (!map) return null;
    const c = map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  }

  async function save() {
    const view = captureView();
    if (!view) return;
    setPhase("saving");
    setError(null);
    try {
      await jsend(`/api/dev/${slug}/view`, "PATCH", view);
      setLocked(true);
      setPhase("saved");
      onSaved?.(view);
      setTimeout(() => setPhase("idle"), 1600);
    } catch (e) {
      setPhase("idle");
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function resetToAuto() {
    setPhase("saving");
    setError(null);
    try {
      await jsend(`/api/dev/${slug}/view`, "DELETE");
      setLocked(false);
      setPhase("idle");
      const map = mapRef.current;
      const fc = fcRef.current;
      if (map && fc) {
        const b = lotClusterBounds(fc);
        if (b) map.fitBounds(b, { padding: 60, pitch: 30, bearing: 0, maxZoom: 16, duration: 800 });
      }
      onReset?.();
    } catch (e) {
      setPhase("idle");
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]",
        className
      )}
    >
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      {error && (
        <div className="glass-dark pop-in absolute left-4 top-4 z-30 max-w-sm rounded-[var(--radius)] px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">Something went wrong</div>
          <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
        </div>
      )}

      {/* Hint (top-left) */}
      <div className="absolute left-4 top-4 z-20 max-w-[260px]">
        <span className="glass-dark block rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/70">
          Drag to pan · scroll to zoom · <strong className="text-white/90">Ctrl + drag to tilt &amp; rotate</strong>. Frame the shot visitors land on, then save it.
        </span>
      </div>

      {/* Command bar (bottom): live readout · state · actions */}
      <div className="absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark mx-auto flex max-w-[720px] flex-wrap items-center gap-4 rounded-[var(--radius-lg)] px-4 py-3">
          {/* Live camera readout */}
          <div className="flex items-center gap-4 font-mono text-[11px] tracking-[0.02em] text-white/70 tabular-nums">
            <Readout label="ZOOM" value={hud.zoom.toFixed(1)} />
            <span className="h-6 w-px bg-white/15" />
            <Readout label="TILT" value={`${Math.round(hud.pitch)}°`} />
            <span className="h-6 w-px bg-white/15" />
            <Readout label="ROTATION" value={`${Math.round(hud.bearing)}°`} />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {locked && (
              <button
                onClick={resetToAuto}
                disabled={phase === "saving" || !ready}
                className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-40"
              >
                Reset to auto-fit
              </button>
            )}
            <button
              onClick={save}
              disabled={phase === "saving" || !ready}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
            >
              {phase === "saving" ? "Saving…" : phase === "saved" ? "Saved ✓" : "Use this view"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-[0.16em] text-white/40">{label}</span>
      <span className="text-[15px] leading-none text-white">{value}</span>
    </span>
  );
}
