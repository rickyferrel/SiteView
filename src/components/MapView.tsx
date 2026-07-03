"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Status, Filter, FieldDef, DataState } from "@/lib/types";
import { resolveMapStyle, hideLegacyLotLayers, DEFAULT_APPEARANCE, STANDARD_CONFIG } from "@/lib/types";
import { money, acres } from "@/lib/format";
import { videoEmbed, isHttpUrl, type VideoEmbed } from "@/lib/video";
import VideoPreview from "@/components/VideoPreview";

// `ribbon: false` hides the draft-workflow ribbon — used by the customer-facing
// /preview/{slug} page, which shows draft data but must not leak operator language.
// `edit: true` adds operator tools (Remove lot) to the lot panel; only the portal's
// Preview & Publish draft iframe sends it, and it is ignored unless state is "draft".
type Props = { slug: string; state: DataState; stop?: string; ribbon?: boolean; edit?: boolean };

type Props_ = Record<string, unknown>;

const FILL = "parcels-fill";
const LINE = "parcels-line";
const LABEL = "parcels-label";
const SEL_FILL = "selected-fill";
const SEL_LINE = "selected-line";

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

function PanelVideo({ embed, title }: { embed: VideoEmbed; title: string }) {
  return (
    <div className="sc-video-wrap">
      <VideoPreview embed={embed} title={title} />
    </div>
  );
}

function eachVertex(f: GeoJSON.Feature, fn: (pt: [number, number]) => void) {
  const g = f.geometry;
  if (!g) return;
  const polys =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) for (const pt of ring) fn(pt as [number, number]);
}

// Bounds of the main lot cluster, so we frame the development on first open
// instead of trusting a stored default_view. A few far-flung outlier parcels
// can otherwise inflate the extent and zoom the camera out to a regional view,
// so reject parcels far from the cluster center (robust median-distance test).
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
  const thresh = Math.max(med(dists) * 6, 0.003); // ~>=330m floor for tight clusters
  const kept = feats.filter((_, i) => dists[i] <= thresh);
  const use = kept.length ? kept : feats;

  const b = new mapboxgl.LngLatBounds();
  for (const { f } of use) eachVertex(f, (pt) => b.extend(pt));
  return b.isEmpty() ? null : b;
}

export default function MapView({ slug, state, stop, ribbon = true, edit = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fcRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Props_ | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // Fetch config + parcels and initialize the map once.
  useEffect(() => {
    let cancelled = false;
    let map: mapboxgl.Map | null = null;

    (async () => {
      const [cRes, pRes] = await Promise.all([
        fetch(`/api/dev/${slug}/config?state=${state}`),
        fetch(`/api/dev/${slug}/parcels?state=${state}`),
      ]);
      if (!cRes.ok) {
        if (!cancelled) setError(state === "published" ? "Not published yet." : "Development not found.");
        return;
      }
      const cfg = (await cRes.json()) as MapConfig;
      const fc = (await pRes.json()) as GeoJSON.FeatureCollection;
      if (cancelled || !containerRef.current) return;
      setConfig(cfg);
      fcRef.current = fc;

      mapboxgl.accessToken = cfg.development.mapbox_token;
      const view = cfg.development.stop_views[stop ?? ""] ?? cfg.development.default_view;
      const usingNamedStop = !!(stop && cfg.development.stop_views[stop]);
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

      // On first open (no specific stop), frame the actual lots — keeping the
      // configured tilt/bearing — so they're always in view. Snap before paint
      // (duration 0) to avoid a visible jump from the stored default_view.
      // When the operator has hand-framed the opening view (view_locked), skip
      // the auto-fit entirely: the constructor already opened at default_view.
      if (!usingNamedStop && !cfg.development.view_locked) {
        const b = lotClusterBounds(fc);
        if (b) {
          // A clean north-up overview with a gentle tilt. The configured
          // default_view pitch (often steep/cinematic) would, over the lots'
          // large span, push the camera back to a regional view.
          map.fitBounds(b, {
            padding: 60,
            pitch: 30,
            bearing: 0,
            maxZoom: 16,
            duration: 0,
          });
        }
      }

      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(
        new mapboxgl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserHeading: true,
        }),
        "top-right"
      );

      map.on("load", () => {
        if (!map) return;

        hideLegacyLotLayers(map);

        // Stylized Mapbox Standard variants (e.g. "Clay") apply their config here.
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
        } else {
          map.setTerrain(null);
        }

        map.addSource("parcels", { type: "geojson", data: fc, promoteId: "parcel_id" });

        map.addLayer({
          id: FILL,
          type: "fill",
          source: "parcels",
          paint: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            "fill-color": fillColorExpr(cfg.statuses) as any,
            "fill-opacity": 0.75,
            "fill-outline-color": "#ffffff",
          },
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
        map.addLayer({
          id: SEL_FILL,
          type: "fill",
          source: "parcels",
          paint: { "fill-color": "#ffffff", "fill-opacity": 0.18 },
          filter: ["==", ["get", "parcel_id"], "___none___"],
        });
        map.addLayer({
          id: SEL_LINE,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": 0.95 },
          filter: ["==", ["get", "parcel_id"], "___none___"],
        });

        map.on("mouseenter", FILL, () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", FILL, () => {
          if (map) map.getCanvas().style.cursor = "";
        });
        map.on("click", FILL, (e) => {
          const f = e.features?.[0];
          if (!f || !map) return;
          const props = f.properties ?? {};
          setSelected(props);
          const pid = props.parcel_id;
          map.setFilter(SEL_FILL, ["==", ["get", "parcel_id"], pid]);
          map.setFilter(SEL_LINE, ["==", ["get", "parcel_id"], pid]);
          map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 17), pitch: 70, duration: 1200, essential: true });
        });

        setTimeout(() => map?.resize(), 300);
      });
    })().catch((err) => {
      if (!cancelled) setError(String(err));
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [slug, state, stop]);

  // Apply the active filter to the rendered layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !config || !map.getLayer(FILL)) return;
    const filter = config.filters.find((f) => f.id === activeFilter);
    const expr = filter
      ? (["in", ["get", filter.field_key === "status" ? "status" : filter.field_key], ["literal", filter.match_values]] as unknown as mapboxgl.FilterSpecification)
      : null;
    for (const id of [FILL, LINE, LABEL]) map.setFilter(id, expr);
  }, [activeFilter, config]);

  function closePanel() {
    setSelected(null);
    const map = mapRef.current;
    if (map?.getLayer(SEL_FILL)) {
      map.setFilter(SEL_FILL, ["==", ["get", "parcel_id"], "___none___"]);
      map.setFilter(SEL_LINE, ["==", ["get", "parcel_id"], "___none___"]);
    }
  }

  // Draft-only operator action: delete the lot row, drop its polygon from the
  // live source, and tell the framing portal page so its counts stay honest.
  async function removeLot(rowId: string) {
    const res = await fetch(`/api/parcel/${rowId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Remove failed (HTTP ${res.status})`);
    }
    const fc = fcRef.current;
    const map = mapRef.current;
    if (fc && map) {
      const next: GeoJSON.FeatureCollection = {
        ...fc,
        features: fc.features.filter((f) => String((f.properties as Props_ | null)?.rowId) !== rowId),
      };
      fcRef.current = next;
      (map.getSource("parcels") as mapboxgl.GeoJSONSource | undefined)?.setData(next);
    }
    closePanel();
    if (window.parent !== window) {
      window.parent.postMessage({ type: "sc:parcel-deleted", rowId }, window.location.origin);
    }
  }

  if (error) {
    return (
      <div className="sc-map-wrap" style={{ display: "grid", placeItems: "center", background: "#0c0f16", color: "#fff" }}>
        <div style={{ textAlign: "center", maxWidth: 380, padding: 24 }}>
          <div
            style={{
              fontFamily: "var(--font-plex-mono), 'IBM Plex Mono', ui-monospace, monospace",
              fontSize: 11,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "#9a7b45",
              marginBottom: 10,
            }}
          >
            Map unavailable
          </div>
          <div style={{ fontFamily: "var(--font-archivo), 'Archivo', sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>
            {error}
          </div>
          {state === "published" && (
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
              Open the portal and publish this development to make it live.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sc-map-wrap">
      <div ref={containerRef} className="sc-map" />

      {config && config.filters.length > 0 && (
        <div className="sc-filters">
          {config.filters.map((f: Filter) => (
            <button
              key={f.id}
              className={`sc-filter-btn ${activeFilter === f.id ? "active" : ""}`}
              onClick={() => setActiveFilter((cur) => (cur === f.id ? null : f.id))}
            >
              {activeFilter === f.id ? "View All" : f.label}
            </button>
          ))}
        </div>
      )}

      <div className="sc-instructions">
        <strong>To rotate the map: hold Ctrl + drag</strong>
      </div>

      {state === "draft" && ribbon && <div className="sc-draft-ribbon">Draft preview · not yet published</div>}

      {selected && config && (
        <LotPanel
          key={String(selected.parcel_id ?? "")}
          props={selected}
          fields={config.fields}
          statuses={config.statuses}
          onClose={closePanel}
          onDelete={edit && state === "draft" && selected.rowId != null ? () => removeLot(String(selected.rowId)) : undefined}
        />
      )}
    </div>
  );
}

function LotPanel({
  props,
  fields,
  statuses,
  onClose,
  onDelete,
}: {
  props: Props_;
  fields: FieldDef[];
  statuses: Status[];
  onClose: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleRemove() {
    if (!onDelete || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onDelete(); // success closes the panel from the parent
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
    }
  }

  const get = (k: string) => (props[k] == null ? "" : String(props[k]));
  const statusName = get("status");
  const status = statuses.find((s) => s.name === statusName);
  const embed = videoEmbed(get("video_url"));
  const price = money(get("list_price"));
  const ac = acres(get("parcel_acres"));
  const img = get("image_url");
  const link = get("lot_page_url");
  const allPanelFields = fields.filter((f) => f.show_in_panel && get(f.key));
  // Fields holding a playable video URL become previews instead of raw-URL text.
  const videoFields = allPanelFields
    .map((f) => ({ field: f, embed: videoEmbed(get(f.key)) }))
    .filter((v): v is { field: FieldDef; embed: VideoEmbed } => v.embed !== null);
  const panelFields = allPanelFields.filter((f) => !videoFields.some((v) => v.field.key === f.key));

  return (
    <>
      <div className="sc-panel-backdrop" onClick={onClose} />
      <div className="sc-panel">
        <button className="sc-close-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div style={{ clear: "both" }} />
        {statusName && (
          <span className="sc-lot-badge" style={{ background: status?.color ?? "#777" }}>
            {statusName}
          </span>
        )}
        <h2 className="sc-lot-title">{get("lot_number") ? `Lot ${get("lot_number")}` : "Parcel"}</h2>
        {get("property_address") && <div className="sc-lot-address">{get("property_address")}</div>}
        {embed && <PanelVideo embed={embed} title="Lot video" />}
        {videoFields.map((v) => (
          <PanelVideo key={v.field.key} embed={v.embed} title={v.field.label} />
        ))}
        {img && (
          <div className="sc-image-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="Lot" loading="lazy" />
          </div>
        )}
        <div className="sc-lot-meta">
          {ac && (
            <div>
              <strong>Acres:</strong> {ac}
            </div>
          )}
          {price && (
            <div>
              <strong>Price:</strong> {price}
            </div>
          )}
          {get("owner_name") && (
            <div>
              <strong>Owner:</strong> {get("owner_name")}
            </div>
          )}
          {panelFields.map((f) => (
            <div key={f.key}>
              <strong>{f.label}:</strong>{" "}
              {f.type === "money" ? (
                money(get(f.key))
              ) : isHttpUrl(get(f.key)) ? (
                <a href={get(f.key)} target="_blank" rel="noopener noreferrer" className="sc-meta-link">
                  View
                </a>
              ) : (
                get(f.key)
              )}
            </div>
          ))}
        </div>
        {link && (
          <a className="sc-lot-link" href={link} target="_blank" rel="noopener noreferrer">
            View lot details
          </a>
        )}
        {onDelete && (
          <div className="sc-remove-zone">
            <div className="sc-remove-note">Removes this lot from the draft map. The live map changes when you publish.</div>
            <div className="sc-remove-actions">
              {confirmRemove ? (
                <>
                  <button className="sc-remove-btn confirm" disabled={removing} onClick={handleRemove}>
                    {removing ? "Removing…" : "Confirm removal"}
                  </button>
                  <button className="sc-remove-btn quiet" disabled={removing} onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="sc-remove-btn" onClick={() => setConfirmRemove(true)}>
                  Remove lot
                </button>
              )}
            </div>
            {removeError && <div className="sc-remove-error">{removeError}</div>}
          </div>
        )}
      </div>
    </>
  );
}
