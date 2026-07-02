"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { devPath, PICKER_MIN_ZOOM } from "@/lib/const";
import { jsend } from "@/lib/client";
import { newSessionToken, suggestAddress, retrieveSuggestion, type Suggestion } from "@/lib/geocode";
import type { ViewState } from "@/lib/types";
import { cx } from "@/components/ui";
import { money, acres as fmtAcres } from "@/lib/format";

// Attributes the picker route attaches to each parcel (from the LIR service).
type ParcelProps = {
  PARCEL_ID?: string;
  address?: string | null;
  acres?: number | null;
  market_value?: number | null;
  land_value?: number | null;
  prop_class?: string | null;
  subdivision?: string | null;
  built_yr?: number | null;
  bldg_sqft?: number | null;
};

// A picking basemap: satellite + streets, so the operator can see the actual
// lots/houses while selecting which parcels belong to the development.
const PICK_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

const SRC = "pick";
const BASE_FILL = "pick-base-fill";
const BASE_LINE = "pick-base-line";
const HOVER_LINE = "pick-hover-line";
const SEL_FILL = "pick-sel-fill";
const SEL_LINE = "pick-sel-line";

// Documented "selection palette" for the picker. Status colors come from data
// and own every saturated hue (green=available, red=sold, etc.), so on-map
// selection must read in a cool, surveyor-instrument register that can never be
// mistaken for a status: a cyan/azure for unselected geometry and a deliberate
// indigo-violet for the confirmed selection — neither maps to any status color.
// Brass stays a chrome-only accent (armed toggle, markers), never painted on the map.
const PALETTE = {
  base: "#5fb3d4", // cool azure — discovered, not-yet-selected parcels
  baseLine: "#9ad4ea",
  hover: "#dff2fa", // near-white cool — hovered outline
  sel: "#6366f1", // indigo-violet — confirmed selection (no status uses violet)
  selLine: "#a5b4fc",
  drag: "#8b5cf6", // violet drag-rectangle, matched to the selection family
};

const NONE = ["==", ["get", "PARCEL_ID"], "___none___"] as unknown as mapboxgl.FilterSpecification;
const idFilter = (ids: string[]) =>
  (ids.length
    ? ["in", ["get", "PARCEL_ID"], ["literal", ids]]
    : NONE) as unknown as mapboxgl.FilterSpecification;

type Props = { slug: string; token: string; initialView: ViewState };
type Box = { x: number; y: number };

export default function ParcelPicker({ slug, token, initialView }: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  // Selection + loaded parcels live in refs (read inside map handlers) and are
  // mirrored into state for rendering.
  const featuresRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());
  const selectedRef = useRef<Set<string>>(new Set());
  const boxModeRef = useRef(false);
  const session = useRef(newSessionToken());

  const [selectedCount, setSelectedCount] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [zoomOk, setZoomOk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [boxMode, setBoxMode] = useState(false);
  const [box, setBox] = useState<{ start: Box; cur: Box } | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<ParcelProps | null>(null);

  // Search
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncSelection = useCallback(() => {
    const map = mapRef.current;
    const ids = [...selectedRef.current];
    setSelectedCount(ids.length);
    if (map?.getLayer(SEL_FILL)) {
      map.setFilter(SEL_FILL, idFilter(ids));
      map.setFilter(SEL_LINE, idFilter(ids));
    }
  }, []);

  const toggle = useCallback(
    (pid: string) => {
      const sel = selectedRef.current;
      if (sel.has(pid)) sel.delete(pid);
      else sel.add(pid);
      syncSelection();
    },
    [syncSelection]
  );

  const clearSelection = useCallback(() => {
    selectedRef.current = new Set();
    syncSelection();
  }, [syncSelection]);

  // ---- Map init (once) ----
  useEffect(() => {
    if (!containerRef.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: PICK_STYLE,
      center: initialView.center,
      zoom: Math.max(initialView.zoom, 6),
      pitch: 0,
      bearing: 0,
      dragRotate: false,
      pitchWithRotate: false,
      boxZoom: false, // we run our own box-select
      antialias: true,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();

    const loadViewport = () => {
      const z = map.getZoom();
      setZoomOk(z >= PICKER_MIN_ZOOM);
      if (z < PICKER_MIN_ZOOM) return;
      const b = map.getBounds();
      if (!b) return;
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const key = bbox.map((n) => n.toFixed(3)).join(",");
      if (fetchedRef.current.has(key)) return;
      fetchedRef.current.add(key);
      setLoading(true);
      setError(null);
      fetch(`/api/arcgis?bbox=${bbox.join(",")}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load parcels here"))))
        .then((fc: GeoJSON.FeatureCollection) => {
          for (const f of fc.features) {
            const pid = f.properties?.PARCEL_ID as string | undefined;
            if (pid && !featuresRef.current.has(pid)) featuresRef.current.set(pid, f);
          }
          const merged = [...featuresRef.current.values()];
          setLoadedCount(merged.length);
          const source = map.getSource(SRC) as mapboxgl.GeoJSONSource | undefined;
          source?.setData({ type: "FeatureCollection", features: merged });
        })
        .catch((e) => {
          fetchedRef.current.delete(key);
          setError(String(e instanceof Error ? e.message : e));
        })
        .finally(() => setLoading(false));
    };

    map.on("load", () => {
      map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "PARCEL_ID" });

      map.addLayer({
        id: BASE_FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-color": PALETTE.base, "fill-opacity": 0.14, "fill-outline-color": PALETTE.baseLine },
      });
      map.addLayer({
        id: BASE_LINE,
        type: "line",
        source: SRC,
        paint: { "line-color": PALETTE.baseLine, "line-width": 0.8, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: HOVER_LINE,
        type: "line",
        source: SRC,
        paint: { "line-color": PALETTE.hover, "line-width": 1.8 },
        filter: NONE,
      });
      map.addLayer({
        id: SEL_FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-color": PALETTE.sel, "fill-opacity": 0.5 },
        filter: NONE,
      });
      map.addLayer({
        id: SEL_LINE,
        type: "line",
        source: SRC,
        paint: { "line-color": PALETTE.selLine, "line-width": 2.6 },
        filter: NONE,
      });

      map.on("mousemove", BASE_FILL, (e) => {
        const props = e.features?.[0]?.properties as ParcelProps | undefined;
        map.getCanvas().style.cursor = "pointer";
        if (props?.PARCEL_ID) map.setFilter(HOVER_LINE, idFilter([props.PARCEL_ID]));
        setHovered(props ?? null);
      });
      map.on("mouseleave", BASE_FILL, () => {
        map.getCanvas().style.cursor = "";
        map.setFilter(HOVER_LINE, NONE);
        setHovered(null);
      });
      map.on("click", BASE_FILL, (e) => {
        if (boxModeRef.current) return;
        const pid = e.features?.[0]?.properties?.PARCEL_ID as string | undefined;
        if (pid) toggle(pid);
      });

      loadViewport();
      setTimeout(() => map.resize(), 200);
    });

    map.on("idle", loadViewport);

    // ---- Box-select on the canvas (only while box mode is on) ----
    const canvas = map.getCanvasContainer();
    const rectOf = () => containerRef.current!.getBoundingClientRect();
    const pt = (e: MouseEvent): Box => {
      const r = rectOf();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let start: Box | null = null;
    let subtractive = false; // Alt/Shift while dragging removes instead of adds

    const onMove = (e: MouseEvent) => {
      if (!start) return;
      setBox({ start, cur: pt(e) });
    };
    const onUp = (e: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!start) return;
      const end = pt(e);
      const a = new mapboxgl.Point(Math.min(start.x, end.x), Math.min(start.y, end.y));
      const b = new mapboxgl.Point(Math.max(start.x, end.x), Math.max(start.y, end.y));
      start = null;
      setBox(null);
      // A click (no real drag) toggles the single parcel under the pointer, so
      // parcels can still be added/removed individually while box mode is on.
      if (Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4) {
        const pid = map.queryRenderedFeatures([end.x, end.y], { layers: [BASE_FILL] })[0]
          ?.properties?.PARCEL_ID as string | undefined;
        if (pid) toggle(pid);
        return;
      }
      const hits = map.queryRenderedFeatures([a, b], { layers: [BASE_FILL] });
      for (const f of hits) {
        const pid = f.properties?.PARCEL_ID as string | undefined;
        if (!pid) continue;
        if (subtractive) selectedRef.current.delete(pid);
        else selectedRef.current.add(pid);
      }
      syncSelection();
    };
    const onDown = (e: MouseEvent) => {
      if (!boxModeRef.current || e.button !== 0) return;
      e.preventDefault();
      subtractive = e.altKey || e.shiftKey;
      start = pt(e);
      setBox({ start, cur: start });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    canvas.addEventListener("mousedown", onDown);

    return () => {
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Box mode toggles map drag-pan.
  useEffect(() => {
    boxModeRef.current = boxMode;
    const map = mapRef.current;
    if (!map) return;
    if (boxMode) map.dragPan.disable();
    else map.dragPan.enable();
  }, [boxMode]);

  // ---- Search ----
  function onQuery(v: string) {
    setQuery(v);
    setSearchOpen(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const map = mapRef.current;
      const c = map?.getCenter();
      const res = await suggestAddress(v, token, session.current, c ? [c.lng, c.lat] : undefined);
      setSuggestions(res);
    }, 250);
  }

  async function pick(s: Suggestion) {
    setQuery(s.name);
    setSearchOpen(false);
    setSuggestions([]);
    const coords = await retrieveSuggestion(s.mapbox_id, token, session.current);
    if (coords && mapRef.current) {
      mapRef.current.flyTo({ center: coords, zoom: 16.3, pitch: 0, duration: 1400, essential: true });
    }
  }

  async function confirm() {
    const ids = [...selectedRef.current];
    if (!ids.length) return;
    setImporting(true);
    setError(null);
    try {
      // PARCEL_IDs are only unique within a county, and each county has its own
      // LIR service — group by the county each feature was fetched from so a
      // selection near (or across) a county line imports from the right layer.
      const byCounty = new Map<string, string[]>();
      for (const id of ids) {
        const county = (featuresRef.current.get(id)?.properties?.county as string | undefined) ?? "Utah";
        byCounty.set(county, [...(byCounty.get(county) ?? []), id]);
      }
      for (const [county, group] of byCounty) {
        await jsend(`/api/dev/${slug}/import`, "POST", { mode: "ids", ids: group, county });
      }
      // Next step in the add-flow: frame the camera the public map opens on.
      router.push(devPath(slug, "opening-view"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setImporting(false);
    }
  }

  const boxRect = box
    ? {
        left: Math.min(box.start.x, box.cur.x),
        top: Math.min(box.start.y, box.cur.y),
        width: Math.abs(box.start.x - box.cur.x),
        height: Math.abs(box.start.y - box.cur.y),
      }
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      {/* drag rectangle — violet, matched to the selection palette */}
      {boxRect && (
        <div
          className="pointer-events-none absolute z-20 rounded-[3px] border-2"
          style={{ ...boxRect, borderColor: PALETTE.drag, background: `${PALETTE.drag}26` }}
        />
      )}

      {/* Search command bar */}
      <div className="absolute left-1/2 top-4 z-30 w-[min(440px,calc(100%-2rem))] -translate-x-1/2">
        <div className="glass-dark flex items-center gap-2 rounded-[var(--radius)] px-3">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-white/55" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onFocus={() => suggestions.length && setSearchOpen(true)}
            placeholder="Search an address to fly there…"
            className="h-11 w-full bg-transparent text-sm text-white placeholder:text-white/45 focus:outline-none"
          />
          {query && (
            <button onClick={() => { setQuery(""); setSuggestions([]); }} className="text-white/45 transition hover:text-white" aria-label="Clear search">
              ×
            </button>
          )}
        </div>
        {searchOpen && suggestions.length > 0 && (
          <ul className="pop-in glass-dark mt-2 overflow-hidden rounded-[var(--radius)] p-1.5">
            {suggestions.map((s) => (
              <li key={s.mapbox_id}>
                <button
                  onClick={() => pick(s)}
                  className="flex w-full flex-col rounded-[var(--radius-sm)] px-2.5 py-2 text-left transition hover:bg-white/10"
                >
                  <span className="text-[13px] font-medium text-white">{s.name}</span>
                  {s.place_formatted && <span className="truncate text-[11px] text-white/50">{s.place_formatted}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Status + guidance stack (top-left) — the single source of guidance. */}
      <div className="absolute left-4 top-4 z-20 flex max-w-[260px] flex-col items-start gap-2">
        {!zoomOk ? (
          <span className="glass-dark rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] font-medium text-white/85">
            Zoom in to a neighborhood to load parcels
          </span>
        ) : (
          <span className="glass-dark inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-3.5 py-2 font-mono text-[11px] tracking-[0.04em] text-white/70 tabular-nums">
            {loading ? (
              <>
                <Spinner /> ACQUIRING PARCELS…
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: PALETTE.base }} /> {loadedCount} IN VIEW
              </>
            )}
          </span>
        )}
        {zoomOk && (
          <span className="glass-dark rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/55">
            {boxMode ? "Drag a box to grab a cluster — hold Alt to remove. Click a parcel to toggle it." : "Click parcels to toggle them. Pan to load more."}
          </span>
        )}
        {zoomOk && hovered && <ParcelHoverCard p={hovered} />}
      </div>

      {/* Command bar (bottom) — three zones split by hairlines: readout · tools · CTA */}
      <div className="absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark mx-auto flex max-w-[780px] flex-wrap items-center gap-4 rounded-[var(--radius-lg)] px-4 py-3">
          {/* Zone 1 — selection readout */}
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">Selected</span>
            <span className="font-mono text-[26px] font-medium leading-none tracking-[-0.03em] text-white tabular-nums">
              {selectedCount}
            </span>
          </div>

          <div className="h-9 w-px bg-white/15" />

          {/* Zone 2 — tools: armed Box select (brass affordance) + demoted Clear */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBoxMode((m) => !m)}
              aria-pressed={boxMode}
              className={cx(
                "inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border px-3 text-[13px] font-medium transition",
                boxMode
                  ? "border-brass/70 bg-brass/15 text-white"
                  : "border-white/15 bg-white/[0.06] text-white/85 hover:bg-white/[0.12]"
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 shrink-0 rounded-full transition",
                  boxMode ? "bg-brass" : "bg-white/30"
                )}
                aria-hidden="true"
              />
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 2" />
              </svg>
              Box select
            </button>

            <button
              onClick={clearSelection}
              disabled={selectedCount === 0}
              className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              Clear
            </button>
          </div>

          {/* Zone 3 — brass Import CTA, pinned right */}
          <button
            onClick={confirm}
            disabled={selectedCount === 0 || importing}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
          >
            {importing ? <Spinner /> : null}
            {importing
              ? "Importing…"
              : selectedCount > 0
                ? `Import ${selectedCount} parcel${selectedCount === 1 ? "" : "s"}`
                : "Import parcels"}
          </button>
        </div>
        {error && (
          <div className="glass-dark pop-in mx-auto mt-2 max-w-[780px] rounded-[var(--radius)] px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">Import failed</div>
            <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Live readout of the assessor attributes for the parcel under the cursor —
// so the operator sees acreage + value before deciding to include a parcel.
function ParcelHoverCard({ p }: { p: ParcelProps }) {
  const ac = p.acres != null ? fmtAcres(String(p.acres)) : "";
  const val = p.market_value != null ? money(String(p.market_value)) : "";
  const title = p.address || (p.PARCEL_ID ? `Parcel ${p.PARCEL_ID}` : "Parcel");
  const hasData = ac || val || p.prop_class || p.built_yr;
  return (
    <div className="glass-dark pop-in w-[240px] rounded-[var(--radius)] px-3.5 py-3">
      <div className="truncate text-[13px] font-semibold text-white">{title}</div>
      {p.subdivision && <div className="mt-0.5 truncate text-[11px] text-white/50">{p.subdivision}</div>}
      {hasData ? (
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5">
          {ac && <Stat label="Acres" value={ac} />}
          {val && <Stat label="Assessor value" value={val} />}
          {p.prop_class && <Stat label="Class" value={p.prop_class} />}
          {p.built_yr ? <Stat label="Built" value={String(p.built_yr)} /> : null}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-white/45">No assessor record for this parcel.</div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">{label}</span>
      <span className="text-[13px] font-medium text-white tabular-nums">{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin text-current" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
