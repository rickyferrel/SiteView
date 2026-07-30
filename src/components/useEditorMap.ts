"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Status, Layer } from "@/lib/types";
import {
  resolveMapStyle,
  hideLegacyLotLayers,
  applySatelliteTint,
  DEFAULT_APPEARANCE,
  STANDARD_CONFIG,
} from "@/lib/types";
import { syncLayers } from "@/lib/mapLayers";
import { toMerc, type Pt } from "@/lib/layers";
import { featureCollectionBbox, type LngLat } from "@/lib/shapes";

/**
 * The editing map both layer editors run on: the development's own basemap and
 * lots, with the layer being edited drawn live on top.
 *
 * **The camera is deliberately flat — pitch 0, terrain off, rotation locked.**
 * Under pitch and terrain, GL JS resolves screen→ground against the DEM, which
 * streams in and changes underneath you, so an unprojected pointer lands
 * somewhere other than where the operator put it: image corners drift, and
 * drawn vertices land off the thing being traced. Flattening the camera makes
 * screen↔ground an exact plane projection and sidesteps it entirely. The
 * operator leaves the editor to check the result in 3D.
 *
 * This lives in one place on purpose. It's the invariant both editors depend on
 * for their pointer math to mean anything, and two copies of it is two chances
 * for one of them to quietly regain terrain.
 */

export const EDITOR_FILL = "le-fill";
export const EDITOR_LINE = "le-line";
export const EDITOR_LABEL = "le-label";

/**
 * Asymmetric so framing never tucks a grip under the floating chrome — the hint
 * card sits top-left, the command bar across the bottom, and a grip you can't
 * reach reads as an editor that doesn't work.
 */
export const EDITOR_PADDING = { top: 96, left: 64, right: 64, bottom: 130 };

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

export type EditorMap = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mapRef: React.RefObject<mapboxgl.Map | null>;
  ready: boolean;
  error: string | null;
  config: MapConfig | null;
  /** Pointer → ground in mercator. Exact, because the camera is flat. */
  pointerMerc: (e: { clientX: number; clientY: number }) => Pt | null;
  /** Pointer → ground in lng/lat. */
  pointerLngLat: (e: { clientX: number; clientY: number }) => LngLat | null;
  /** Redraw the overlay stack, substituting `live` for its stored row. */
  resync: (live?: Layer | null) => void;
  /** Frame a lng/lat bbox with the standard padding. */
  frame: (bbox: [number, number, number, number], duration?: number) => void;
};

export function useEditorMap(opts: {
  slug: string;
  /** Re-bootstraps when this changes — one map per layer being edited. */
  editKey: string;
  /**
   * Where to open. Return null to fall back to the lot cluster, then to the
   * development's opening view — which is what a brand-new shape wants, since
   * it has no geometry to frame yet.
   */
  initialBbox?: () => [number, number, number, number] | null;
  /**
   * The layer being edited, as it currently stands in the editor rather than in
   * the DB. Forced visible so an operator can't be editing something hidden.
   */
  liveLayer?: () => Layer | null;
}): EditorMap {
  const { slug, editKey } = opts;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const configRef = useRef<MapConfig | null>(null);

  const [config, setConfig] = useState<MapConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Callbacks are read through refs so the bootstrap effect never re-runs (and
  // never rebuilds the map) just because a parent re-rendered. Synced in an
  // effect rather than during render — and declared above the bootstrap effect,
  // so on mount the refs are current before the map is built.
  const initialBboxRef = useRef(opts.initialBbox);
  const liveLayerRef = useRef(opts.liveLayer);
  useEffect(() => {
    initialBboxRef.current = opts.initialBbox;
    liveLayerRef.current = opts.liveLayer;
  });

  /** Overlay stack with the edited layer's in-progress state swapped in. */
  const stack = useCallback((live: Layer | null): Layer[] => {
    const base = configRef.current?.layers ?? [];
    if (!live) return base;
    const forced = { ...live, visible: true };
    const merged = base.map((l) => (l.id === forced.id ? { ...l, ...forced } : l));
    return merged.some((l) => l.id === forced.id) ? merged : [...merged, forced];
  }, []);

  const resync = useCallback(
    (live?: Layer | null) => {
      const map = mapRef.current;
      if (!map) return;
      syncLayers(map, stack(live ?? liveLayerRef.current?.() ?? null), {
        fill: EDITOR_FILL,
        label: EDITOR_LABEL,
      });
    },
    [stack]
  );

  const frame = useCallback((bbox: [number, number, number, number], duration = 600) => {
    const map = mapRef.current;
    if (!map) return;
    const [w, s, e, n] = bbox;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: EDITOR_PADDING, duration, maxZoom: 19 }
    );
  }, []);

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

      configRef.current = cfg;
      setConfig(cfg);

      mapboxgl.accessToken = cfg.development.mapbox_token;
      const appearance = cfg.development.map_appearance ?? DEFAULT_APPEARANCE;

      // Frame preference: the thing being edited, else the lots, else the
      // development's opening view.
      const bbox = initialBboxRef.current?.() ?? featureCollectionBbox(fc);
      const view = cfg.development.default_view;

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: resolveMapStyle(cfg.development.mapbox_style, appearance.basemap),
        ...(bbox
          ? {
              bounds: [
                [bbox[0], bbox[1]],
                [bbox[2], bbox[3]],
              ] as [[number, number], [number, number]],
              fitBoundsOptions: { padding: EDITOR_PADDING, maxZoom: 19 },
            }
          : { center: view.center, zoom: view.zoom }),
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
          id: EDITOR_FILL,
          type: "fill",
          source: "parcels",
          paint: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            "fill-color": fillColorExpr(cfg.statuses) as any,
            "fill-opacity": 0.45,
            "fill-outline-color": "#ffffff",
          },
        });
        map.addLayer({
          id: EDITOR_LINE,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 0.55 },
        });
        map.addLayer({
          id: EDITOR_LABEL,
          type: "symbol",
          source: "parcels",
          layout: {
            "text-field": ["coalesce", ["get", "lot_number"], ""] as unknown as string,
            "text-size": 12,
            "text-allow-overlap": false,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#000000",
            "text-halo-width": 1,
            "text-opacity": 0.85,
          },
        });

        resync(liveLayerRef.current?.() ?? null);
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
      configRef.current = null;
      setReady(false);
    };
    // Bootstraps once per edited layer; live geometry and style changes flow
    // through refs and the imperative map helpers, never a re-run of this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, editKey]);

  const pointerLngLat = useCallback((e: { clientX: number; clientY: number }): LngLat | null => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return null;
    const r = el.getBoundingClientRect();
    const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
    return [ll.lng, ll.lat];
  }, []);

  const pointerMerc = useCallback(
    (e: { clientX: number; clientY: number }): Pt | null => {
      const ll = pointerLngLat(e);
      return ll ? toMerc(ll) : null;
    },
    [pointerLngLat]
  );

  return { containerRef, mapRef, ready, error, config, pointerMerc, pointerLngLat, resync, frame };
}
