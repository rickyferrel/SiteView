"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { newSessionToken, suggestAddress, retrieveSuggestion, type Suggestion } from "@/lib/geocode";
import type { NormalizedParcel } from "@/lib/geojson";
import { cx } from "@/components/ui";

// Trim step of the GeoJSON upload: the whole file (even a county-wide export)
// is rendered as a local layer, and the operator selects just the lots that
// belong to this development. Interaction model and selection palette are the
// same as ParcelPicker's, so picking feels identical regardless of source —
// the difference is that the data is already in hand, so there's no
// viewport-driven fetching and no zoom gate.
const PICK_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

const SRC = "trim";
const BASE_FILL = "trim-base-fill";
const BASE_LINE = "trim-base-line";
const HOVER_LINE = "trim-hover-line";
const SEL_FILL = "trim-sel-fill";
const SEL_LINE = "trim-sel-line";

// Mirrors ParcelPicker's documented selection palette (cool azure = loaded,
// indigo-violet = selected) — keep the two in sync.
const PALETTE = {
  base: "#5fb3d4",
  baseLine: "#9ad4ea",
  hover: "#dff2fa",
  sel: "#6366f1",
  selLine: "#a5b4fc",
  drag: "#8b5cf6",
};

const NONE = ["==", ["get", "PARCEL_ID"], "___none___"] as unknown as mapboxgl.FilterSpecification;
const idFilter = (ids: string[]) =>
  (ids.length
    ? ["in", ["get", "PARCEL_ID"], ["literal", ids]]
    : NONE) as unknown as mapboxgl.FilterSpecification;

type Hovered = { PARCEL_ID?: string; lot?: string | null; acres?: string | null };
type Box = { x: number; y: number };

type Props = {
  token: string;
  parcels: NormalizedParcel[];
  cap: number;
  fileName: string;
  /** Batched-upload progress from the parent; null when not importing. */
  progress: { done: number; total: number } | null;
  onImport: (selected: NormalizedParcel[]) => void;
  onDiscard: () => void;
};

export default function GeoJsonTrimMap({ token, parcels, cap, fileName, progress, onImport, onDiscard }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  const boxModeRef = useRef(false);
  const session = useRef(newSessionToken());

  const [selectedCount, setSelectedCount] = useState(0);
  const [preparing, setPreparing] = useState(true);
  const [boxMode, setBoxMode] = useState(false);
  const [box, setBox] = useState<{ start: Box; cur: Box } | null>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);

  // Search
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const importing = progress !== null;

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

  // ---- Map init (once per file — the component remounts on a new file) ----
  useEffect(() => {
    if (!containerRef.current) return;

    // The uploaded lots as a local layer, plus their extent for the opening frame.
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    const walk = (a: unknown): void => {
      if (!Array.isArray(a)) return;
      if (typeof a[0] === "number" && typeof a[1] === "number") {
        const [x, y] = a as [number, number];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        return;
      }
      for (const c of a) walk(c);
    };
    const features: GeoJSON.Feature[] = parcels.map((p) => {
      walk(p.geometry.coordinates);
      return {
        type: "Feature",
        properties: { PARCEL_ID: p.parcel_id, lot: p.lot.lot_number, acres: p.lot.parcel_acres },
        geometry: p.geometry,
      };
    });

    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: PICK_STYLE,
      bounds: [[minX, minY], [maxX, maxY]],
      fitBoundsOptions: { padding: 60, maxZoom: 16.5 },
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

    map.on("load", () => {
      map.addSource(SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features },
        promoteId: "PARCEL_ID",
      });

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
        const props = e.features?.[0]?.properties as Hovered | undefined;
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

      // County-scale files take the tiling worker a moment to index.
      map.once("idle", () => setPreparing(false));
      setTimeout(() => map.resize(), 200);
    });

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
      // A click (no real drag) toggles the single parcel under the pointer.
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

  function confirm() {
    const sel = selectedRef.current;
    if (sel.size === 0 || sel.size > cap) return;
    onImport(parcels.filter((p) => sel.has(p.parcel_id)));
  }

  const overCap = selectedCount > cap;
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

      {/* Status + guidance stack (top-left) */}
      <div className="absolute left-4 top-4 z-20 flex max-w-[280px] flex-col items-start gap-2">
        <span className="glass-dark inline-flex max-w-full items-center gap-2 rounded-[var(--radius-sm)] px-3.5 py-2 font-mono text-[11px] tracking-[0.04em] text-white/70 tabular-nums">
          {preparing ? (
            <>
              <Spinner /> PREPARING {parcels.length.toLocaleString()} LOTS…
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PALETTE.base }} />
              <span className="truncate">{fileName}</span> · {parcels.length.toLocaleString()}
            </>
          )}
        </span>
        <span className="glass-dark rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/55">
          {boxMode
            ? "Drag a box to grab the community — hold Alt to remove. Click a parcel to toggle it."
            : "Select just the lots that belong to this development — click parcels, or use Box select."}
        </span>
        {hovered && (
          <span className="glass-dark pop-in rounded-[var(--radius-sm)] px-3.5 py-2 font-mono text-[11px] text-white/80">
            {hovered.PARCEL_ID}
            {hovered.lot ? ` · Lot ${hovered.lot}` : ""}
            {hovered.acres ? ` · ${hovered.acres} ac` : ""}
          </span>
        )}
      </div>

      {/* Command bar (bottom) — readout · tools · CTA, same zones as the picker */}
      <div className="absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark mx-auto flex max-w-[820px] flex-wrap items-center gap-4 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">Selected</span>
            <span className="font-mono text-[26px] font-medium leading-none tracking-[-0.03em] text-white tabular-nums">
              {selectedCount.toLocaleString()}
              <span className={cx("ml-1 text-[12px] font-normal", overCap ? "text-danger-ink" : "text-white/40")}>
                / {cap.toLocaleString()} max
              </span>
            </span>
          </div>

          <div className="h-9 w-px bg-white/15" />

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
                className={cx("h-1.5 w-1.5 shrink-0 rounded-full transition", boxMode ? "bg-brass" : "bg-white/30")}
                aria-hidden="true"
              />
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 2" />
              </svg>
              Box select
            </button>

            {parcels.length <= cap && (
              <button
                onClick={() => {
                  selectedRef.current = new Set(parcels.map((p) => p.parcel_id));
                  syncSelection();
                }}
                className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
              >
                Select all
              </button>
            )}

            <button
              onClick={() => {
                selectedRef.current = new Set();
                syncSelection();
              }}
              disabled={selectedCount === 0}
              className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              Clear
            </button>

            <button
              onClick={onDiscard}
              disabled={importing}
              className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              Discard file
            </button>
          </div>

          <button
            onClick={confirm}
            disabled={selectedCount === 0 || overCap || importing}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
          >
            {importing ? <Spinner /> : null}
            {importing
              ? `Importing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
              : selectedCount > 0
                ? `Import ${selectedCount.toLocaleString()} lot${selectedCount === 1 ? "" : "s"}`
                : "Import lots"}
          </button>
        </div>
        {overCap && (
          <div className="glass-dark pop-in mx-auto mt-2 max-w-[820px] rounded-[var(--radius)] px-4 py-3">
            <p className="text-[12px] leading-relaxed text-white/70">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">Over the limit</span>
              <span className="ml-2">
                A development imports at most {cap.toLocaleString()} lots — remove {(selectedCount - cap).toLocaleString()} from
                the selection (Alt-drag a box to subtract).
              </span>
            </p>
          </div>
        )}
      </div>
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
