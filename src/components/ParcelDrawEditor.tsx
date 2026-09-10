"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { MapConfig, Layer, Status, Corners } from "@/lib/types";
import { syncLayers, setLayerOpacity, setLayerCoordinates } from "@/lib/mapLayers";
import {
  toMerc,
  fromMerc,
  cornersFromRect,
  cornersBbox,
  rectFromCorners,
  rectForAspect,
  rotateRectTo,
  rotateHandle,
  scaleRectFromCorner,
  type Pt,
  type Rect,
} from "@/lib/layers";
import {
  bearingDeg,
  blockAxis,
  cutSegment,
  evenCuts,
  extentAlong,
  feet,
  FEET_PER_M,
  flushStep,
  metersBetween,
  metersPerMerc,
  nearestOnSegment,
  outerRings,
  rectFromDrag,
  ringBbox,
  ringCentroid,
  ringPerimeter,
  ringPolygon,
  scaleTick,
  sliceRing,
  toLngLatRing,
  toMercRing,
  translateRing,
  unit,
  type LngLatRing,
  type Ring,
} from "@/lib/draw";
import { polygonAcres, validateDrawnPolygon } from "@/lib/geojson";
// Imported lots carry the assessor's full precision (0.360511), drawn lots the
// 2dp the API measured. The lot list is one tabular-nums column, so it formats
// through the same helper the embed panel and the Lots table use.
import { acres as acresText } from "@/lib/format";
import { jsend } from "@/lib/client";
// The same Search Box session flow the county picker uses: an operator who
// came here to trace a plat has to get to the site first, and a development
// with no lots yet has no geometry to frame the camera on.
import { newSessionToken, suggestAddress, retrieveSuggestion, type Suggestion } from "@/lib/geocode";
// Pinning a render is the same upload the Map Design panel does — same
// downscale ladder, same alpha-aware encoder, same size ceiling — so a plan
// added here is indistinguishable from one added there.
import { prepareLayerImage, ImageTooLargeError, mb } from "@/lib/image";
import { PICKER_MIN_ZOOM, LAYER_IMAGE_MIMES } from "@/lib/const";
import { Chip, Dot, Eyebrow, cx } from "@/components/ui";

/**
 * Draw lots by hand, straight onto the satellite imagery — the third way geometry
 * gets into a development, next to the county picker and a GeoJSON upload. It's
 * for the plat that never became a shapefile: the operator traces the developer's
 * render, or lays a subdivision row out from scratch.
 *
 * **The map is deliberately flat here — pitch 0, terrain off, rotation locked**,
 * for the same reason `LayerEditor` and `ShapeEditor` flatten it: under pitch and
 * terrain GL JS resolves screen→ground against a DEM that is still streaming, so
 * a clicked corner lands somewhere other than where it was clicked, and the error
 * changes as tiles arrive. Flat ground makes screen↔ground an exact plane
 * projection — which is also what lets snapping be judged in pixels.
 *
 * Four tools, one vertex model:
 *  • **Draw a lot** — click each corner, close on the first one.
 *  • **Drag a rectangle** — one drag, then a rotation handle squares it to the
 *    street. The angle can be locked, so a row of suburban lots is drag-Enter,
 *    drag-Enter, drag-Enter.
 *  • **Split a block** — draw the block once, cut it into N. The block itself is
 *    scaffolding and is never saved as a lot.
 *  • **Copy a row** — take an existing lot and march N copies along its own edge,
 *    flush by default, because subdivision lots abut.
 *
 * Every lot is **created on the server the moment its outline closes**, not
 * batched at the end: a 54-lot session is an hour of work and a lost tab
 * shouldn't cost all of it. The client runs `validateDrawnPolygon` and
 * `polygonAcres` — the same functions the route runs — so the acreage ticking up
 * while you drag is the acreage that stores, and a shape this tool accepts is one
 * the server accepts.
 *
 * Undo covers what it can actually perform: a created lot is deleted, a reshape
 * is patched back to the geometry it had. Removing a lot is not on the stack, so
 * it asks first.
 */

// Satellite + streets: this is the acquisition surface, and you trace against
// imagery. Matches ParcelPicker and GeoJsonTrimMap so all three sources of
// geometry look like the same tool.
const PICK_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

const FILL = "pd-fill";
const LINE = "pd-line";
const LABEL = "pd-label";
const HL_HOVER = "pd-hl-hover";
const HL_SEL = "pd-hl-sel";
const CO_SRC = "pd-county-src";
const CO_FILL = "pd-county-fill";
const CO_LINE = "pd-county-line";
const CO_HOVER = "pd-county-hover";

/**
 * Drawing palette. Status colours come from the data and own every saturated
 * hue, so the instrument's own marks stay in the chrome register: brass for
 * anything the operator is drawing (matching the other two editors), the
 * picker's cool azure for county reference geometry, its indigo-violet for a
 * selected lot. White is reserved for the snap monument — the one mark that has
 * to read instantly against any imagery.
 */
const PAINT = {
  draw: "#d8b26a",
  drawWash: "rgba(216,178,106,0.13)",
  ghost: "#e3c88d",
  stage: "#0c0f16",
  county: "#5fb3d4",
  countyLine: "#9ad4ea",
  sel: "#6366f1",
  selLine: "#a5b4fc",
  hover: "#dff2fa",
};

// Screen-space slop, in px. CLOSE_PX is how near the first corner a click has to
// land to close the outline; DEDUPE_PX drops the second click of a double-click,
// which would otherwise leave a zero-length edge at the finish point; SNAP_PX is
// how near an existing corner or edge counts as "on it".
const CLOSE_PX = 12;
const DEDUPE_PX = 6;
const SNAP_PX = 10;

// Clears the tool rail (left) and the instrument bar (bottom) when we frame
// lots, so a corner grip isn't born under the chrome and ungrabbable.
const FRAME_PADDING = { top: 72, left: 268, right: 56, bottom: 150 };

const MIN_LOTS = 2;
const MAX_SPLIT = 24;
const MAX_COPIES = 24;

const FOCUS_DARK =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e6c887]";

type Mode = "polygon" | "rect" | "split" | "copy";

type LotRow = {
  rowId: string;
  parcel_id: string;
  lot_number: string;
  acres: string;
  status: string | null;
  color: string | null;
  locked: boolean;
  geometry: GeoJSON.Geometry;
};

type Undo =
  | { kind: "create"; rowIds: string[]; label: string }
  | { kind: "reshape"; rowId: string; geometry: GeoJSON.Geometry; label: string };

type ScreenPt = [number, number];

type Screen = {
  draw: ScreenPt[];
  cursor: ScreenPt | null;
  mids: { at: ScreenPt; insertAt: number }[];
  rect: { quad: ScreenPt[]; handle: ScreenPt } | null;
  pieces: { ring: ScreenPt[]; at: ScreenPt }[];
  cuts: { at: ScreenPt; a: ScreenPt; b: ScreenPt; i: number }[];
  ghosts: { ring: ScreenPt[]; at: ScreenPt }[];
  ghostHandle: ScreenPt | null;
  snap: ScreenPt | null;
};

const EMPTY_SCREEN: Screen = {
  draw: [],
  cursor: null,
  mids: [],
  rect: null,
  pieces: [],
  cuts: [],
  ghosts: [],
  ghostHandle: null,
  snap: null,
};

type SnapRing = { ring: LngLatRing; bbox: [number, number, number, number] };
type SnapHit = { ll: [number, number]; kind: "corner" | "edge" };

type CountyProps = {
  PARCEL_ID?: string;
  address?: string | null;
  acres?: number | null;
  market_value?: number | null;
  subdivision?: string | null;
  county?: string | null;
};

/* ---- Tools ---------------------------------------------------------------- */

const TOOLS: { mode: Mode; key: string; name: string; blurb: string; glyph: React.ReactNode }[] = [
  {
    mode: "polygon",
    blurb: "Trace any shape, corner by corner.",
    key: "1",
    name: "Draw a lot",
    glyph: (
      <>
        <path d="M8 2.2 14 6.6 11.7 13.6H4.3L2 6.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
        <rect x="6.6" y="0.9" width="2.8" height="2.8" fill="currentColor" />
        <rect x="12.7" y="5.3" width="2.6" height="2.6" fill="currentColor" />
      </>
    ),
  },
  {
    mode: "rect",
    blurb: "Drag a box, then turn it to the street.",
    key: "2",
    name: "Drag a rectangle",
    glyph: (
      <>
        <rect x="2.2" y="5.6" width="11.6" height="8.2" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M4.6 3.8a5.2 5.2 0 0 1 7 0" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        <path d="M11.1 1.6l1.1 2.3-2.5.2Z" fill="currentColor" />
      </>
    ),
  },
  {
    mode: "split",
    blurb: "Draw a block once, cut it into a row of lots.",
    key: "3",
    name: "Split a block",
    glyph: (
      <>
        <rect x="1.6" y="3.8" width="12.8" height="8.4" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M5.9 3.8v8.4M10.1 3.8v8.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.8 1.6" />
      </>
    ),
  },
  {
    mode: "copy",
    blurb: "Repeat a lot you already have, evenly spaced.",
    key: "4",
    name: "Copy a row",
    glyph: (
      <>
        <rect x="1.2" y="4.4" width="3.8" height="7.2" rx="0.5" fill="currentColor" opacity="0.85" />
        <rect x="6.1" y="4.4" width="3.8" height="7.2" rx="0.5" stroke="currentColor" strokeWidth="1.1" fill="none" strokeDasharray="1.8 1.5" />
        <rect x="11" y="4.4" width="3.8" height="7.2" rx="0.5" stroke="currentColor" strokeWidth="1.1" fill="none" strokeDasharray="1.8 1.5" />
      </>
    ),
  },
];

/* ---- Helpers -------------------------------------------------------------- */

function fillColorExpr(statuses: Status[]) {
  const def = statuses.find((s) => s.is_default)?.color ?? "#8c3b3b";
  if (statuses.length === 0) return def;
  const expr: unknown[] = ["match", ["get", "status"]];
  for (const s of statuses) expr.push(s.name, s.color);
  expr.push(def);
  return expr;
}

/** `jsend` throws "400: {json}" — pull the sentence the route wrote. */
function readable(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  const m = s.match(/^\d{3}:\s*([\s\S]*)$/);
  if (!m) return s;
  try {
    const j = JSON.parse(m[1]) as { error?: string };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    /* not JSON — fall through to the raw tail */
  }
  return m[1] || s;
}

function lotFeature(l: LotRow): GeoJSON.Feature {
  return {
    type: "Feature",
    id: l.parcel_id,
    geometry: l.geometry,
    properties: {
      rowId: l.rowId,
      parcel_id: l.parcel_id,
      lot_number: l.lot_number,
      status: l.status,
      parcel_acres: l.acres,
    },
  };
}

/** Same rule the server uses: the next plain number after the biggest one. */
function nextNumber(lots: LotRow[]): number {
  let max = 0;
  for (const l of lots) {
    const n = Number(String(l.lot_number ?? "").trim());
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

function bboxOf(lots: LotRow[]): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const l of lots)
    for (const ring of outerRings(l.geometry))
      for (const p of ring) {
        if (p[0] < w) w = p[0];
        if (p[0] > e) e = p[0];
        if (p[1] < s) s = p[1];
        if (p[1] > n) n = p[1];
      }
  return Number.isFinite(w) && e > w ? [w, s, e, n] : null;
}

/** Radians clockwise-from-east → the 0–179° a street angle is quoted in. */
/** Pointer → ground, in mercator. Exact, because the camera here is flat. */
function mercAt(map: mapboxgl.Map, p: ScreenPt): Pt {
  const ll = map.unproject(p);
  return toMerc([ll.lng, ll.lat]);
}

/**
 * Where a freshly pinned render lands: centred on what the operator is looking
 * at, 80% of the visible box, at the image's own aspect so nothing is stretched
 * and every corner grip is reachable. The Map Design panel frames a new render
 * on the lot cluster instead — right there, but wrong here, where the usual case
 * is a development with no lots yet and a camera the operator just aimed.
 */
function viewportCorners(map: mapboxgl.Map, aspect: number): Corners {
  const c = map.getCenter();
  const centre = toMerc([c.lng, c.lat]);
  const b = map.getBounds();
  const halfW = b ? Math.abs(toMerc([b.getEast(), c.lat])[0] - centre[0]) * 0.8 : 0.005 / 360;
  const halfH = b ? Math.abs(toMerc([c.lng, b.getNorth()])[1] - centre[1]) * 0.8 : 0.005 / 360;
  return cornersFromRect(rectForAspect(centre, halfW, halfH, aspect));
}

function degrees(rot: number): number {
  return Math.round((((rot * 180) / Math.PI) % 180 + 180) % 180);
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---- Component ------------------------------------------------------------ */

export default function ParcelDrawEditor({ slug, className }: { slug: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  // ---- Data ---------------------------------------------------------------
  const [lots, setLots] = useState<LotRow[]>([]);
  const lotsRef = useRef<LotRow[]>(lots);
  const configRef = useRef<MapConfig | null>(null);
  const [imageLayers, setImageLayers] = useState<Layer[]>([]);
  const [ready, setReady] = useState(false);

  // ---- Tool state ---------------------------------------------------------
  const [mode, setMode] = useState<Mode>("polygon");
  const modeRef = useRef<Mode>(mode);
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);

  // The in-progress outline (a lot in "Draw a lot", the scaffold in "Split").
  const [pts, setPts] = useState<LngLatRing>([]);
  const ptsRef = useRef<LngLatRing>(pts);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const hoverRef = useRef(hover);

  const [rect, setRect] = useState<Rect | null>(null);
  const rectRef = useRef<Rect | null>(null);
  const [lockAngle, setLockAngle] = useState(false);
  const lockAngleRef = useRef(lockAngle);
  // The angle the last rectangle was turned to. Kept as state as well as a ref
  // because the rail reads it back to the operator ("every lot at 43°").
  const [lastRot, setLastRot] = useState(0);
  const lastRotRef = useRef(0);

  const [block, setBlock] = useState<Ring | null>(null);
  const blockRef = useRef<Ring | null>(null);
  const [splitN, setSplitN] = useState(4);
  const splitNRef = useRef(splitN);
  const [splitAxis, setSplitAxis] = useState<0 | 1>(0);
  const [cuts, setCuts] = useState<number[]>(evenCuts(4));
  const cutsRef = useRef<number[]>(cuts);

  // The rail leads with what the operator drew; the development's existing
  // lots are context, not the task, so they stay folded away until asked for.
  const [showExisting, setShowExisting] = useState(false);

  const [copySrc, setCopySrc] = useState<string | null>(null);
  const copySrcRef = useRef<string | null>(null);
  const [copyN, setCopyN] = useState(3);
  // null means "the default step for this lot" — flush along its longest edge.
  // Only a drag (or Other way) replaces it, so picking a new source lot goes
  // back to the sensible answer without an effect to reset it.
  const [copyOverride, setCopyOverride] = useState<Pt | null>(null);

  const [reshape, setReshape] = useState<{ rowId: string; pts: LngLatRing } | null>(null);
  const reshapeRef = useRef<{ rowId: string; pts: LngLatRing } | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);

  // ---- Instrument state ---------------------------------------------------
  const [snapOn, setSnapOn] = useState(true);
  const snapOnRef = useRef(snapOn);
  const altRef = useRef(false);
  const spaceRef = useRef(false);
  const [snapHit, setSnapHit] = useState<SnapHit | null>(null);
  const snapHitRef = useRef<SnapHit | null>(null);

  const [planOn, setPlanOn] = useState(false);
  const [planOpacity, setPlanOpacity] = useState(0.75);
  const planOpacityRef = useRef(planOpacity);

  // ---- Site plan ----------------------------------------------------------
  // A render can be pinned from right here rather than back on Map Design:
  // tracing a plan and having the plan on the map is one task, and sending the
  // operator to another page to do half of it loses the camera they just framed.
  // The row it creates is an ordinary image layer — the same one Map Design
  // lists, and the same one that publishes.
  //
  // `pinning` holds the layer being positioned, and while it is set the drawing
  // tools stand down: every map click belongs to the render.
  const [pinning, setPinning] = useState<string | null>(null);
  const pinningRef = useRef<string | null>(null);
  const [pinMode, setPinMode] = useState<"transform" | "fine">("transform");
  const [pinLockAspect, setPinLockAspect] = useState(true);
  const [pinConfirmRemove, setPinConfirmRemove] = useState(false);
  // The live corner set, held in a ref: pointer handlers bound on `window` read
  // it without re-binding, and a drag frame nudges the image's coordinates on
  // the map instead of re-running `syncLayers`, which tears the stack down.
  const pinCornersRef = useRef<Corners | null>(null);
  const [pinScreen, setPinScreen] = useState<{ quad: ScreenPt[]; rotate: ScreenPt | null }>({
    quad: [],
    rotate: null,
  });
  const paintPinRef = useRef<(() => void) | null>(null);
  const [planBusy, setPlanBusy] = useState<string | null>(null);
  const planFileRef = useRef<HTMLInputElement>(null);
  const [countyOn, setCountyOn] = useState(false);
  const countyOnRef = useRef(countyOn);
  const [countyBusy, setCountyBusy] = useState(false);
  const [zoomOk, setZoomOk] = useState(true);
  const countyFeaturesRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const countyFetchedRef = useRef<Set<string>>(new Set());
  const [countyHover, setCountyHover] = useState<CountyProps | null>(null);

  const [countyCount, setCountyCount] = useState(0);
  const loadCountyRef = useRef<(() => void) | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [hoverLot, setHoverLot] = useState<string | null>(null);
  // The lot that just landed: it gets scrolled into view and keeps a hairline
  // ring, so "did that save?" is answered in the list, not just on the map.
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo[]>([]);
  const undoRef = useRef<Undo[]>(undo);

  // ---- Address search -----------------------------------------------------
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  // True while the map is sitting on the statewide opening shot a brand-new
  // development gets: there is nowhere meaningful to draw until the operator
  // says where the site is, so the search bar leads instead of the tools.
  const [unplaced, setUnplaced] = useState(false);
  const searchSession = useRef(newSessionToken());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The rail is bounded by the stage; on a short viewport with a tool's
  // settings open it has more than fits. `railMore` fades its bottom edge so
  // "there is more below" is visible rather than something being clipped away.
  const railRef = useRef<HTMLDivElement>(null);
  const [railMore, setRailMore] = useState(false);

  const [screen, setScreen] = useState<Screen>(EMPTY_SCREEN);
  const [scale, setScale] = useState<{ px: number; label: string }>({ px: 80, label: "100 FT" });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const nextLot = useMemo(() => nextNumber(lots), [lots]);

  // Lot numbers are plain numbers, so sort them as numbers: a plain string sort
  // files lot 110 between 11 and 12, which reads as a bug in an inventory list.
  // Anything non-numeric ("Clubhouse") sorts alphabetically after them.
  const orderedLots = useMemo(() => {
    const n = (v: string) => {
      const x = Number(String(v).trim());
      return Number.isFinite(x) && String(v).trim() !== "" ? x : Number.POSITIVE_INFINITY;
    };
    return [...lots].sort((a, b) => {
      const d = n(a.lot_number) - n(b.lot_number);
      if (Number.isFinite(d) && d !== 0) return d;
      return String(a.lot_number).localeCompare(String(b.lot_number), undefined, { numeric: true });
    });
  }, [lots]);

  // `locked` is set on any outline the operator drew or reshaped by hand, so it
  // is the honest answer to "what did I make here?" — and unlike a session
  // counter it survives a reload.
  const drawnLots = useMemo(() => orderedLots.filter((l) => l.locked), [orderedLots]);
  const existingLots = useMemo(() => orderedLots.filter((l) => !l.locked), [orderedLots]);

  /* ---- Mirrors: handlers and window drags read refs, never stale state ---- */

  const setLotsBoth = useCallback((next: LotRow[]) => {
    lotsRef.current = next;
    setLots(next);
    const src = mapRef.current?.getSource("parcels") as mapboxgl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: next.map(lotFeature) });
  }, []);

  const setPtsBoth = useCallback((next: LngLatRing) => {
    ptsRef.current = next;
    setPts(next);
  }, []);

  const setRectBoth = useCallback((next: Rect | null) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  const setCutsBoth = useCallback((next: number[]) => {
    cutsRef.current = next;
    setCuts(next);
  }, []);

  const setReshapeBoth = useCallback((next: { rowId: string; pts: LngLatRing } | null) => {
    reshapeRef.current = next;
    setReshape(next);
  }, []);

  const pushUndo = useCallback((entry: Undo) => {
    const next = [...undoRef.current, entry].slice(-40);
    undoRef.current = next;
    setUndo(next);
  }, []);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { hoverRef.current = hover; }, [hover]);
  useEffect(() => { snapOnRef.current = snapOn; }, [snapOn]);
  useEffect(() => { countyOnRef.current = countyOn; }, [countyOn]);
  useEffect(() => { lockAngleRef.current = lockAngle; }, [lockAngle]);
  useEffect(() => { blockRef.current = block; }, [block]);
  useEffect(() => { snapHitRef.current = snapHit; }, [snapHit]);
  useEffect(() => { pinningRef.current = pinning; }, [pinning]);

  /* ---- Snap candidates ---------------------------------------------------- */
  // Rebuilt whenever the geometry on the map changes. Bboxes are precomputed so
  // a mousemove rejects most rings with four number comparisons instead of
  // projecting every vertex of every parcel in the county.

  const snapRingsRef = useRef<SnapRing[]>([]);

  const rebuildSnap = useCallback(() => {
    const out: SnapRing[] = [];
    const skip = reshapeRef.current?.rowId;
    for (const l of lotsRef.current) {
      if (l.rowId === skip) continue;
      for (const ring of outerRings(l.geometry)) out.push({ ring, bbox: ringBbox(ring) });
    }
    if (countyOnRef.current) {
      for (const f of countyFeaturesRef.current.values())
        for (const ring of outerRings(f.geometry)) out.push({ ring, bbox: ringBbox(ring) });
    }
    snapRingsRef.current = out;
  }, []);

  // Deliberately keyed on the reshaped row's *id*, not the live vertex list: the
  // candidate set only changes when a different lot enters or leaves it, and
  // rebuilding on every drag frame would index the whole county 60 times a second.
  useEffect(() => { rebuildSnap(); }, [lots, countyOn, countyCount, reshape?.rowId, rebuildSnap]);

  /**
   * Nearest snap for a screen point: an existing corner wins over an edge, and
   * an edge snaps to the perpendicular foot on that segment. Judged in pixels,
   * then unprojected — exact, because the camera is flat.
   */
  const snapAt = useCallback((p: ScreenPt): SnapHit | null => {
    const map = mapRef.current;
    if (!map || !snapOnRef.current || altRef.current) return null;
    const here = map.unproject(p);
    // Screen tolerance → a degree box, so rings far from the cursor never get
    // projected at all.
    const far = map.unproject([p[0] + SNAP_PX * 3, p[1] + SNAP_PX * 3]);
    const dLng = Math.abs(far.lng - here.lng);
    const dLat = Math.abs(far.lat - here.lat);

    let bestCorner: { pt: ScreenPt; d: number } | null = null;
    let bestEdge: { pt: ScreenPt; d: number } | null = null;

    for (const { ring, bbox } of snapRingsRef.current) {
      if (bbox[0] > here.lng + dLng || bbox[2] < here.lng - dLng) continue;
      if (bbox[1] > here.lat + dLat || bbox[3] < here.lat - dLat) continue;
      const sp = ring.map((v) => {
        const q = map.project(v);
        return [q.x, q.y] as ScreenPt;
      });
      for (const v of sp) {
        const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
        if (d <= SNAP_PX && (!bestCorner || d < bestCorner.d)) bestCorner = { pt: v, d };
      }
      if (bestCorner) continue; // a corner beats every edge — no need to keep measuring
      for (let i = 0; i < sp.length; i++) {
        const hit = nearestOnSegment(p, sp[i], sp[(i + 1) % sp.length]);
        if (hit.d <= SNAP_PX && (!bestEdge || hit.d < bestEdge.d)) bestEdge = hit;
      }
    }

    const win = bestCorner ?? bestEdge;
    if (!win) return null;
    const ll = map.unproject(win.pt);
    return { ll: [ll.lng, ll.lat], kind: bestCorner ? "corner" : "edge" };
  }, []);

  /** Ground point for a click/drag: the snap if there is one, the raw point if not. */
  const groundAt = useCallback(
    (p: ScreenPt, fallback: [number, number]): [number, number] => {
      const hit = snapAt(p);
      snapHitRef.current = hit;
      setSnapHit(hit);
      return hit ? hit.ll : fallback;
    },
    [snapAt]
  );

  /* ---- Writes ------------------------------------------------------------- */
  // One promise chain. Batch creates (split, copy) must be sequential or the
  // server derives the same "next lot number" for all of them.

  const inflight = useRef<Promise<unknown>>(Promise.resolve());

  const createLot = useCallback(
    async (
      geometry: GeoJSON.Geometry,
      extra?: { parcel_id?: string; source_attrs?: Record<string, unknown>; locked?: boolean }
    ): Promise<LotRow> => {
      // Same validator the route runs, so a shape rejected here would have been
      // rejected there — including the no-area case.
      const g = validateDrawnPolygon(geometry);
      const res = await jsend<{
        rowId: string;
        parcel_id: string;
        lot_number: string;
        parcel_acres: string;
      }>(`/api/dev/${slug}/parcels`, "POST", { geometry: g, ...extra });
      const def = configRef.current?.statuses.find((s) => s.is_default) ?? null;
      const row: LotRow = {
        rowId: res.rowId,
        parcel_id: res.parcel_id,
        lot_number: res.lot_number,
        acres: res.parcel_acres,
        status: def?.name ?? null,
        color: def?.color ?? null,
        locked: extra?.locked !== false,
        geometry: g,
      };
      setLotsBoth([...lotsRef.current, row]);
      setLastCreated(row.rowId);
      return row;
    },
    [slug, setLotsBoth]
  );

  /** Run a write with the shared queue, the saving flag and one error surface. */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    const task = async () => {
      setSaving(true);
      setNote(null);
      try {
        return await fn();
      } catch (e) {
        setNote({ tone: "error", text: readable(e) });
        return null;
      } finally {
        setSaving(false);
      }
    };
    const p = inflight.current.then(task, task);
    inflight.current = p.catch(() => {});
    return p;
  }, []);

  /* ---- Finishing a shape -------------------------------------------------- */

  const clearDraft = useCallback(() => {
    setPtsBoth([]);
    setRectBoth(null);
    setBlock(null);
    blockRef.current = null;
    setHover(null);
    hoverRef.current = null;
    setPendingMode(null);
  }, [setPtsBoth, setRectBoth]);

  const finishPolygon = useCallback(() => {
    const ring = ptsRef.current;
    if (ring.length < 3) return;
    if (modeRef.current === "split") {
      // The block is scaffolding, not a lot: it stays local until it's cut.
      const merc = toMercRing(ring);
      blockRef.current = merc;
      setBlock(merc);
      setCutsBoth(evenCuts(splitNRef.current));
      setPtsBoth([]);
      setHover(null);
      hoverRef.current = null;
      return;
    }
    const geometry = ringPolygon(ring);
    setPtsBoth([]);
    setHover(null);
    hoverRef.current = null;
    void run(async () => {
      const row = await createLot(geometry);
      pushUndo({ kind: "create", rowIds: [row.rowId], label: `lot ${row.lot_number}` });
      setNote({ tone: "info", text: `Lot ${row.lot_number} saved · ${row.acres} ac` });
    });
  }, [createLot, pushUndo, run, setCutsBoth, setPtsBoth]);

  const finishRect = useCallback(() => {
    const r = rectRef.current;
    if (!r) return;
    lastRotRef.current = r.rot;
    setLastRot(r.rot);
    const geometry = ringPolygon(cornersFromRect(r));
    setRectBoth(null);
    void run(async () => {
      const row = await createLot(geometry);
      pushUndo({ kind: "create", rowIds: [row.rowId], label: `lot ${row.lot_number}` });
      setNote({ tone: "info", text: `Lot ${row.lot_number} saved · ${row.acres} ac` });
    });
  }, [createLot, pushUndo, run, setRectBoth]);

  /* ---- Split -------------------------------------------------------------- */

  const splitPieces = useMemo<Ring[]>(() => {
    if (!block) return [];
    return sliceRing(block, blockAxis(block, splitAxis), cuts);
  }, [block, splitAxis, cuts]);

  const commitSplit = useCallback(() => {
    const b = blockRef.current;
    if (!b) return;
    const pieces = sliceRing(b, blockAxis(b, splitAxis), cutsRef.current);
    if (pieces.length < MIN_LOTS) {
      setNote({ tone: "error", text: "Those cuts don't divide the block — drag them back inside it." });
      return;
    }
    blockRef.current = null;
    setBlock(null);
    void run(async () => {
      const made: string[] = [];
      const numbers: string[] = [];
      // Sequential and in axis order, so the row numbers left to right.
      for (const piece of pieces) {
        const row = await createLot(ringPolygon(toLngLatRing(piece)));
        made.push(row.rowId);
        numbers.push(row.lot_number);
      }
      pushUndo({ kind: "create", rowIds: made, label: `${made.length} lots` });
      setNote({
        tone: "info",
        text: `Created ${made.length} lots · ${numbers[0]}–${numbers[numbers.length - 1]}`,
      });
    });
  }, [createLot, pushUndo, run, splitAxis]);

  const setSplitCount = useCallback(
    (n: number) => {
      const clamped = Math.max(MIN_LOTS, Math.min(MAX_SPLIT, n));
      splitNRef.current = clamped;
      setSplitN(clamped);
      setCutsBoth(evenCuts(clamped));
    },
    [setCutsBoth]
  );

  /* ---- Copy --------------------------------------------------------------- */

  const copyLot = useMemo(() => lots.find((l) => l.rowId === copySrc) ?? null, [lots, copySrc]);

  const copyRing = useMemo<Ring | null>(() => {
    const ring = copyLot ? outerRings(copyLot.geometry)[0] : null;
    return ring ? toMercRing(ring) : null;
  }, [copyLot]);

  // Default step: along the lot's own longest edge, flush against it. That's
  // how a plat lays a row out, so it's the answer before anything is dragged.
  const defaultOffset = useCallback((ring: Ring): Pt => {
    const dir = blockAxis(ring, 0);
    const step = flushStep(ring, dir);
    return [dir[0] * step, dir[1] * step];
  }, []);

  const copyOff = useMemo<Pt | null>(
    () => copyOverride ?? (copyRing ? defaultOffset(copyRing) : null),
    [copyOverride, copyRing, defaultOffset]
  );

  /** Pick (or clear) the lot being copied, back at its default step. */
  const chooseCopySource = useCallback((rowId: string | null) => {
    copySrcRef.current = rowId;
    setCopySrc(rowId);
    setCopyOverride(null);
  }, []);

  const copyGhosts = useMemo<Ring[]>(() => {
    if (!copyRing || !copyOff) return [];
    return Array.from({ length: copyN }, (_, i) =>
      translateRing(copyRing, [copyOff[0] * (i + 1), copyOff[1] * (i + 1)])
    );
  }, [copyRing, copyOff, copyN]);

  const commitCopy = useCallback(() => {
    const ring = copyRing;
    const off = copyOff;
    if (!ring || !off) return;
    const ghosts = Array.from({ length: copyN }, (_, i) =>
      translateRing(ring, [off[0] * (i + 1), off[1] * (i + 1)])
    );
    void run(async () => {
      const made: string[] = [];
      const numbers: string[] = [];
      for (const g of ghosts) {
        const row = await createLot(ringPolygon(toLngLatRing(g)));
        made.push(row.rowId);
        numbers.push(row.lot_number);
      }
      pushUndo({ kind: "create", rowIds: made, label: `${made.length} lots` });
      setNote({
        tone: "info",
        text: `Created ${made.length} lots · ${numbers[0]}–${numbers[numbers.length - 1]}`,
      });
      chooseCopySource(null);
      setSelected(null);
    });
  }, [chooseCopySource, copyN, copyOff, copyRing, createLot, pushUndo, run]);

  /* ---- Lot edits ---------------------------------------------------------- */

  const renameLot = useCallback(
    (rowId: string, value: string) => {
      const trimmed = value.trim();
      const current = lotsRef.current.find((l) => l.rowId === rowId);
      if (!current || !trimmed || trimmed === current.lot_number) return;
      setLotsBoth(lotsRef.current.map((l) => (l.rowId === rowId ? { ...l, lot_number: trimmed } : l)));
      void run(() => jsend(`/api/parcel/${rowId}`, "PATCH", { patch: { lot_number: trimmed } }));
    },
    [run, setLotsBoth]
  );

  const removeLot = useCallback(
    (rowId: string) => {
      setConfirmRemove(null);
      const gone = lotsRef.current.find((l) => l.rowId === rowId);
      setLotsBoth(lotsRef.current.filter((l) => l.rowId !== rowId));
      setSelected((s) => (s === rowId ? null : s));
      if (copySrcRef.current === rowId) chooseCopySource(null);
      if (reshapeRef.current?.rowId === rowId) setReshapeBoth(null);
      // A removed lot leaves the undo stack: nothing on it can be performed any
      // more, and a stack that lies is worse than a short one.
      const kept = undoRef.current.filter((u) => (u.kind === "create" ? !u.rowIds.includes(rowId) : u.rowId !== rowId));
      undoRef.current = kept;
      setUndo(kept);
      void run(async () => {
        await jsend(`/api/parcel/${rowId}`, "DELETE");
        setNote({ tone: "info", text: `Removed lot ${gone?.lot_number ?? ""}`.trim() });
      });
    },
    [chooseCopySource, run, setLotsBoth, setReshapeBoth]
  );

  const undoLast = useCallback(() => {
    const stack = undoRef.current;
    const entry = stack[stack.length - 1];
    if (!entry) return;
    const rest = stack.slice(0, -1);
    undoRef.current = rest;
    setUndo(rest);
    void run(async () => {
      if (entry.kind === "create") {
        for (const rowId of entry.rowIds) await jsend(`/api/parcel/${rowId}`, "DELETE");
        setLotsBoth(lotsRef.current.filter((l) => !entry.rowIds.includes(l.rowId)));
        setNote({ tone: "info", text: `Undid ${entry.label}` });
      } else {
        const res = await jsend<{ parcel_acres: string }>(`/api/parcel/${entry.rowId}`, "PATCH", {
          geometry: entry.geometry,
        });
        setLotsBoth(
          lotsRef.current.map((l) =>
            l.rowId === entry.rowId
              ? { ...l, geometry: entry.geometry, acres: res?.parcel_acres ?? l.acres }
              : l
          )
        );
        if (reshapeRef.current?.rowId === entry.rowId) {
          setReshapeBoth({ rowId: entry.rowId, pts: outerRings(entry.geometry)[0] ?? [] });
        }
        setNote({ tone: "info", text: `Undid ${entry.label}` });
      }
    });
  }, [run, setLotsBoth, setReshapeBoth]);

  const zoomToLot = useCallback((l: LotRow) => {
    const map = mapRef.current;
    const box = bboxOf([l]);
    if (!map || !box) return;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: FRAME_PADDING, maxZoom: 18.5, duration: reducedMotion() ? 0 : 550 }
    );
  }, []);

  const startReshape = useCallback(
    (l: LotRow) => {
      const ring = outerRings(l.geometry)[0];
      if (!ring) return;
      clearDraft();
      chooseCopySource(null);
      setSelected(l.rowId);
      setSelectedVertex(null);
      setReshapeBoth({ rowId: l.rowId, pts: ring });
      zoomToLot(l);
    },
    [chooseCopySource, clearDraft, setReshapeBoth, zoomToLot]
  );

  const saveReshape = useCallback(
    (before: GeoJSON.Geometry) => {
      const r = reshapeRef.current;
      if (!r || r.pts.length < 3) return;
      const geometry = ringPolygon(r.pts);
      const lot = lotsRef.current.find((l) => l.rowId === r.rowId);
      pushUndo({ kind: "reshape", rowId: r.rowId, geometry: before, label: `lot ${lot?.lot_number ?? ""}`.trim() });
      void run(async () => {
        const res = await jsend<{ parcel_acres: string }>(`/api/parcel/${r.rowId}`, "PATCH", { geometry });
        setLotsBoth(
          lotsRef.current.map((l) =>
            l.rowId === r.rowId ? { ...l, geometry, acres: res?.parcel_acres ?? l.acres, locked: true } : l
          )
        );
      });
    },
    [pushUndo, run, setLotsBoth]
  );

  /* ---- Adopting a county outline ------------------------------------------ */

  const adoptCounty = useCallback(
    (pid: string) => {
      const f = countyFeaturesRef.current.get(pid);
      if (!f) return;
      const already = lotsRef.current.find((l) => l.parcel_id === pid);
      if (already) {
        setNote({ tone: "error", text: `Lot ${already.lot_number} already covers parcel ${pid}.` });
        return;
      }
      const p = (f.properties ?? {}) as CountyProps;
      void run(async () => {
        const row = await createLot(f.geometry, {
          parcel_id: pid,
          source_attrs: { ...(f.properties ?? {}) },
          // The county's own outline, adopted unchanged — so it isn't "drawn",
          // and a later re-import should still be allowed to refresh it.
          // Reshaping it by hand locks it, like any other lot.
          locked: false,
        });
        pushUndo({ kind: "create", rowIds: [row.rowId], label: `lot ${row.lot_number}` });
        setNote({
          tone: "info",
          text: `Added lot ${row.lot_number} from county parcel ${pid}${p.acres ? ` · ${row.acres} ac` : ""}`,
        });
      });
    },
    [createLot, pushUndo, run]
  );

  /* ---- Map bootstrap ------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;
    let map: mapboxgl.Map | null = null;

    (async () => {
      const [cRes, pRes] = await Promise.all([
        fetch(`/api/dev/${slug}/config?state=draft`),
        fetch(`/api/dev/${slug}/parcels?state=draft`),
      ]);
      if (!cRes.ok) {
        if (!cancelled) setNote({ tone: "error", text: "Couldn't load this development." });
        return;
      }
      const cfg = (await cRes.json()) as MapConfig;
      const fc = (await pRes.json()) as GeoJSON.FeatureCollection;
      if (cancelled || !containerRef.current) return;

      configRef.current = cfg;
      setImageLayers((cfg.layers ?? []).filter((l) => l.kind === "image"));

      const rows: LotRow[] = (fc.features ?? []).map((f) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        return {
          rowId: String(p.rowId ?? ""),
          parcel_id: String(p.parcel_id ?? ""),
          lot_number: p.lot_number == null ? "" : String(p.lot_number),
          acres: acresText(p.parcel_acres == null ? "" : String(p.parcel_acres)),
          status: p.status == null ? null : String(p.status),
          color: p.status_color == null ? null : String(p.status_color),
          locked: p.geometry_locked === true,
          geometry: f.geometry,
        };
      });
      lotsRef.current = rows;
      setLots(rows);

      mapboxgl.accessToken = cfg.development.mapbox_token;
      setToken(cfg.development.mapbox_token);
      const box = bboxOf(rows);
      // A development that has never imported a lot still carries the statewide
      // opening shot `createDevelopment` seeds. Zooming that centre to 16 lands
      // on somebody else's rooftops and reads as "here is your site" — so leave
      // the wide shot alone and let the search bar do the placing.
      const framed = cfg.development.view_locked || (cfg.development.default_view.zoom ?? 0) >= 12;
      if (!cancelled) setUnplaced(!box && !framed);

      map = new mapboxgl.Map({
        container: containerRef.current,
        style: PICK_STYLE,
        ...(box
          ? {
              bounds: [
                [box[0], box[1]],
                [box[2], box[3]],
              ] as [[number, number], [number, number]],
              fitBoundsOptions: { padding: FRAME_PADDING, maxZoom: 17.5 },
            }
          : {
              center: cfg.development.default_view.center,
              zoom: framed
                ? Math.max(16, cfg.development.default_view.zoom ?? 16)
                : (cfg.development.default_view.zoom ?? 6),
            }),
        // Flat and locked: see the note at the top of this file.
        pitch: 0,
        bearing: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // Double-click finishes an outline; letting it zoom as well would yank
        // the ground out from under the lot the moment it's done.
        doubleClickZoom: false,
        boxZoom: false,
        antialias: true,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

      const readScale = () => {
        if (!map) return;
        const lat = map.getCenter().lat;
        const metersPerPx =
          (metersPerMerc(lat) / (512 * Math.pow(2, map.getZoom()))) || 1;
        const tick = scaleTick(metersPerPx * FEET_PER_M);
        setScale({ px: tick.px, label: `${tick.feet.toLocaleString("en-US")} FT` });
      };

      const loadCounty = () => {
        if (!map || !countyOnRef.current) return;
        const z = map.getZoom();
        setZoomOk(z >= PICKER_MIN_ZOOM);
        if (z < PICKER_MIN_ZOOM) return;
        const b = map.getBounds();
        if (!b) return;
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        // ~100 m of key resolution: nudging the map doesn't re-ask for parcels
        // it already has.
        const key = bbox.map((n) => n.toFixed(3)).join(",");
        if (countyFetchedRef.current.has(key)) return;
        countyFetchedRef.current.add(key);
        setCountyBusy(true);
        fetch(`/api/arcgis?bbox=${bbox.join(",")}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load county parcels here."))))
          .then((res: GeoJSON.FeatureCollection) => {
            for (const f of res.features ?? []) {
              const pid = f.properties?.PARCEL_ID as string | undefined;
              if (pid && !countyFeaturesRef.current.has(pid)) countyFeaturesRef.current.set(pid, f);
            }
            const src = map?.getSource(CO_SRC) as mapboxgl.GeoJSONSource | undefined;
            src?.setData({
              type: "FeatureCollection",
              features: [...countyFeaturesRef.current.values()],
            });
            setCountyCount(countyFeaturesRef.current.size);
          })
          .catch((e) => {
            countyFetchedRef.current.delete(key);
            setNote({ tone: "error", text: readable(e) });
          })
          .finally(() => setCountyBusy(false));
      };
      // The toggle needs to ask for this viewport the moment it's switched on,
      // without waiting for the next pan.
      loadCountyRef.current = loadCounty;

      map.on("load", () => {
        if (!map) return;

        map.addSource(CO_SRC, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          promoteId: "PARCEL_ID",
        });
        map.addLayer({
          id: CO_FILL,
          type: "fill",
          source: CO_SRC,
          layout: { visibility: "none" },
          paint: { "fill-color": PAINT.county, "fill-opacity": 0.07 },
        });
        map.addLayer({
          id: CO_LINE,
          type: "line",
          source: CO_SRC,
          layout: { visibility: "none" },
          paint: { "line-color": PAINT.countyLine, "line-width": 1, "line-opacity": 0.8 },
        });
        map.addLayer({
          id: CO_HOVER,
          type: "line",
          source: CO_SRC,
          layout: { visibility: "none" },
          paint: { "line-color": PAINT.hover, "line-width": 2.4 },
          filter: ["==", ["get", "PARCEL_ID"], "___none___"] as unknown as mapboxgl.FilterSpecification,
        });

        map.addSource("parcels", {
          type: "geojson",
          data: { type: "FeatureCollection", features: lotsRef.current.map(lotFeature) },
          promoteId: "parcel_id",
        });
        map.addLayer({
          id: FILL,
          type: "fill",
          source: "parcels",
          paint: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            "fill-color": fillColorExpr(cfg.statuses) as any,
            // Deliberately light: you draw *next to* these, and a 45% fill over
            // a plat render hides the lines you're tracing.
            "fill-opacity": 0.32,
          },
        });
        map.addLayer({
          id: LINE,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": 0.6 },
        });
        map.addLayer({
          id: HL_HOVER,
          type: "line",
          source: "parcels",
          paint: { "line-color": PAINT.hover, "line-width": 2.2 },
          filter: ["==", ["get", "rowId"], "___none___"] as unknown as mapboxgl.FilterSpecification,
        });
        map.addLayer({
          id: HL_SEL,
          type: "line",
          source: "parcels",
          paint: { "line-color": PAINT.selLine, "line-width": 3 },
          filter: ["==", ["get", "rowId"], "___none___"] as unknown as mapboxgl.FilterSpecification,
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
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#000000",
            "text-halo-width": 1,
            "text-opacity": 0.85,
          },
        });

        // Terrain stays off on purpose — flat ground keeps unproject exact.
        map.setTerrain(null);

        map.on("mousemove", CO_FILL, (e) => {
          if (!countyOnRef.current) return;
          const props = e.features?.[0]?.properties as CountyProps | undefined;
          if (props?.PARCEL_ID) {
            map?.setFilter(CO_HOVER, [
              "==",
              ["get", "PARCEL_ID"],
              props.PARCEL_ID,
            ] as unknown as mapboxgl.FilterSpecification);
          }
          setCountyHover(props ?? null);
        });
        map.on("mouseleave", CO_FILL, () => {
          map?.setFilter(CO_HOVER, ["==", ["get", "PARCEL_ID"], "___none___"] as unknown as mapboxgl.FilterSpecification);
          setCountyHover(null);
        });

        readScale();
        loadCounty();
        setReady(true);
        // Guarded: the tab switcher can unmount us inside this 200ms, and
        // resizing a removed map throws on its torn-down canvas.
        setTimeout(() => {
          if (!cancelled) map?.resize();
        }, 200);
      });

      map.on("zoom", readScale);
      map.on("idle", loadCounty);
    })().catch((err) => {
      if (!cancelled) setNote({ tone: "error", text: readable(err) });
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // Bootstraps once per development. Live geometry flows through refs and the
    // imperative map helpers, never a re-run of this effect.
  }, [slug]);

  /* ---- Underlays ---------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // Opacity rides a ref here on purpose: `syncLayers` tears the overlay stack
    // down and rebuilds it, which is far too much for a slider — the effect
    // below nudges the paint property instead.
    syncLayers(
      map,
      planOn
        ? imageLayers.map((l) => ({
            ...l,
            visible: true,
            opacity: planOpacityRef.current,
            // A rebuild part-way through positioning must not snap the render
            // back to the corners the row was loaded with — the live set lives
            // in the ref until the operator is done with it.
            corners:
              l.id === pinningRef.current && pinCornersRef.current ? pinCornersRef.current : l.corners,
          }))
        : [],
      { fill: FILL, label: LABEL }
    );
  }, [ready, planOn, imageLayers]);

  useEffect(() => {
    planOpacityRef.current = planOpacity;
    const map = mapRef.current;
    if (!map || !ready || !planOn) return;
    for (const l of imageLayers) setLayerOpacity(map, l, planOpacity);
  }, [ready, planOn, planOpacity, imageLayers]);

  // The render's outline and grips are screen-space furniture over a ground-space
  // quad, so they are re-projected on every map render — and on demand, because
  // a corner drag changes the quad without the camera moving.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !pinning) {
      paintPinRef.current = null;
      setPinScreen({ quad: [], rotate: null });
      return;
    }
    const paint = () => {
      const c = pinCornersRef.current;
      if (!c) return;
      const quad = c.map((ll) => {
        const pt = map.project(ll as [number, number]);
        return [pt.x, pt.y] as ScreenPt;
      });
      // Rotation grip: 34px clear of the top edge in screen space, so it keeps
      // its distance at every zoom.
      const [tl, tr, , bl] = quad;
      let rotate: ScreenPt | null = null;
      if (tl && tr && bl) {
        const ux = tl[0] - bl[0];
        const uy = tl[1] - bl[1];
        const len = Math.hypot(ux, uy) || 1;
        rotate = [(tl[0] + tr[0]) / 2 + (ux / len) * 34, (tl[1] + tr[1]) / 2 + (uy / len) * 34];
      }
      setPinScreen({ quad, rotate });
    };
    paintPinRef.current = paint;
    paint();
    map.on("render", paint);
    return () => {
      map.off("render", paint);
      paintPinRef.current = null;
    };
  }, [ready, pinning]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vis = countyOn ? "visible" : "none";
    for (const id of [CO_FILL, CO_LINE, CO_HOVER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
    if (countyOn) loadCountyRef.current?.();
  }, [ready, countyOn]);

  // Info notices are an acknowledgement, not a state — they clear themselves.
  // An error stays until the next action clears it.
  useEffect(() => {
    if (note?.tone !== "info") return;
    const t = setTimeout(() => setNote(null), 2800);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!lastCreated) return;
    listRef.current
      ?.querySelector(`[data-row="${lastCreated}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [lastCreated]);

  /* ---- Keep the overlay glued to the ground ------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const project = (p: [number, number]): ScreenPt => {
      const q = map.project(p);
      return [q.x, q.y];
    };
    const projectMerc = (p: Pt): ScreenPt => project(fromMerc(p));

    const paint = () => {
      const active = reshape ? reshape.pts : pts;
      const sp = active.map(project);

      const mids: { at: ScreenPt; insertAt: number }[] = [];
      if (reshape && sp.length >= 3) {
        for (let i = 0; i < sp.length; i++) {
          const a = sp[i];
          const b = sp[(i + 1) % sp.length];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 34) continue; // too tight to hit
          mids.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], insertAt: i + 1 });
        }
      }

      let rectScreen: Screen["rect"] = null;
      if (rect) {
        rectScreen = {
          quad: cornersFromRect(rect).map(project),
          handle: project(rotateHandle(rect, rect.hh * 0.22 + 1e-6)),
        };
      }

      const pieces = splitPieces.map((ring) => ({
        ring: ring.map(projectMerc),
        at: projectMerc(ringCentroid(ring)),
      }));

      const cutLines: Screen["cuts"] = [];
      if (block) {
        const dir = blockAxis(block, splitAxis);
        const { min, max } = extentAlong(block, dir);
        cuts.forEach((t, i) => {
          const seg = cutSegment(block, dir, min + t * (max - min));
          if (!seg) return;
          const a = projectMerc(seg[0]);
          const b = projectMerc(seg[1]);
          cutLines.push({ a, b, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], i });
        });
      }

      const ghosts = copyGhosts.map((ring) => ({
        ring: ring.map(projectMerc),
        at: projectMerc(ringCentroid(ring)),
      }));

      setScreen({
        draw: sp,
        cursor: !reshape && hover && pts.length > 0 ? project(hover) : null,
        mids,
        rect: rectScreen,
        pieces,
        cuts: cutLines,
        ghosts,
        ghostHandle: ghosts.length ? ghosts[0].at : null,
        snap: snapHit ? project(snapHit.ll) : null,
      });
    };

    paint();
    map.on("render", paint);
    return () => {
      map.off("render", paint);
    };
  }, [ready, pts, hover, rect, reshape, block, cuts, splitAxis, splitPieces, copyGhosts, snapHit]);

  /* ---- Map gestures ------------------------------------------------------- */

  const pointerLngLat = useCallback((e: { clientX: number; clientY: number }): ScreenPt | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const canvas = map.getCanvas();
    const drawingCursor =
      !reshape && !pinning && (mode === "polygon" || mode === "split" || mode === "rect");
    canvas.style.cursor =
      reshape || pinning ? "" : drawingCursor ? "crosshair" : mode === "copy" ? "pointer" : "";

    const lotAt = (p: mapboxgl.Point): string | null =>
      (map.queryRenderedFeatures(p, { layers: [FILL] })[0]?.properties?.rowId as string) ?? null;
    const countyAt = (p: mapboxgl.Point): string | null =>
      countyOnRef.current
        ? ((map.queryRenderedFeatures(p, { layers: [CO_FILL] })[0]?.properties?.PARCEL_ID as string) ?? null)
        : null;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
      if (reshapeRef.current) return; // grips own the interaction while reshaping
      if (pinningRef.current) return; // so does the render being positioned
      const here: ScreenPt = [e.point.x, e.point.y];
      const m = modeRef.current;

      if (m === "copy") {
        const rowId = lotAt(e.point);
        if (rowId) {
          chooseCopySource(rowId);
          setSelected(rowId);
          setNote(null);
        }
        return;
      }

      const busy = ptsRef.current.length > 0 || !!rectRef.current || !!blockRef.current;
      if (!busy) {
        const pid = countyAt(e.point);
        if (pid) {
          adoptCounty(pid);
          return;
        }
      }
      if (m === "rect" || blockRef.current) return;

      const cur = ptsRef.current;
      if (cur.length >= 3) {
        const first = map.project(cur[0]);
        if (Math.hypot(first.x - here[0], first.y - here[1]) < CLOSE_PX) {
          finishPolygon();
          return;
        }
      }
      if (cur.length) {
        const last = map.project(cur[cur.length - 1]);
        if (Math.hypot(last.x - here[0], last.y - here[1]) < DEDUPE_PX) return;
      }
      setPtsBoth([...cur, groundAt(here, [e.lngLat.lng, e.lngLat.lat])]);
    };

    const onMove = (e: mapboxgl.MapMouseEvent) => {
      if (reshapeRef.current || pinningRef.current) return;
      const here: ScreenPt = [e.point.x, e.point.y];
      const m = modeRef.current;
      if (m === "polygon" || m === "split" || m === "rect") {
        const ll = groundAt(here, [e.lngLat.lng, e.lngLat.lat]);
        if (m !== "rect" && !blockRef.current && ptsRef.current.length) {
          hoverRef.current = ll;
          setHover(ll);
        }
      }
    };

    const onLeave = () => {
      hoverRef.current = null;
      setHover(null);
      setSnapHit(null);
      snapHitRef.current = null;
    };

    const onDbl = () => {
      if (reshapeRef.current || pinningRef.current) return;
      if (!blockRef.current && modeRef.current !== "rect") finishPolygon();
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    map.on("dblclick", onDbl);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("mouseout", onLeave);
      map.off("dblclick", onDbl);
    };
  }, [ready, mode, reshape, pinning, adoptCounty, chooseCopySource, finishPolygon, groundAt, setPtsBoth]);

  /* ---- Rectangle drag on the canvas --------------------------------------- */
  // The one gesture that can't share the map's own drag: mapbox would pan.
  // dragPan is disabled while the rectangle tool is armed, and Space hands
  // panning back the way every drawing app does it.

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const armed = mode === "rect" && !reshape && !pinning;
    if (armed && !spaceRef.current) map.dragPan.disable();
    else map.dragPan.enable();
    if (!armed) return;

    const el = map.getCanvasContainer();

    const onDown = (ev: MouseEvent) => {
      if (ev.button !== 0 || spaceRef.current || rectRef.current) return;
      const p = pointerLngLat(ev);
      if (!p) return;
      ev.preventDefault();
      const startLL = groundAt(p, [map.unproject(p).lng, map.unproject(p).lat]);
      const startMerc = toMerc(startLL);
      const rot = lockAngleRef.current ? lastRotRef.current : 0;
      let moved = false;

      const move = (m: MouseEvent) => {
        const q = pointerLngLat(m);
        if (!q) return;
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 3) moved = true;
        const ll = groundAt(q, [map.unproject(q).lng, map.unproject(q).lat]);
        setRectBoth(rectFromDrag(startMerc, toMerc(ll), rot));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (!moved) setRectBoth(null); // a stray click isn't a lot
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    el.addEventListener("mousedown", onDown);
    return () => el.removeEventListener("mousedown", onDown);
  }, [ready, mode, reshape, pinning, groundAt, pointerLngLat, setRectBoth]);

  /* ---- Grips -------------------------------------------------------------- */
  /* Drags run on **window** listeners, not the grip: a grip is 13px, so the
     pointer is off it almost immediately and any handle-scoped listener stops
     receiving moves the instant the drag matters. */

  function beginDrag(onMove: (p: ScreenPt) => void, onEnd?: () => void) {
    const move = (ev: PointerEvent) => {
      const p = pointerLngLat(ev);
      if (!p) return;
      ev.preventDefault();
      onMove(p);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function dragReshapeVertex(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const start = reshapeRef.current;
    if (!map || !start) return;
    const before = ringPolygon(start.pts);
    if (e.altKey) {
      if (start.pts.length <= 3) {
        setNote({ tone: "error", text: "A lot needs at least 3 corners — remove the whole lot instead." });
        return;
      }
      const next = start.pts.filter((_, i) => i !== index);
      setReshapeBoth({ ...start, pts: next });
      setSelectedVertex(null);
      saveReshape(before);
      return;
    }
    setSelectedVertex(index);
    beginDrag(
      (p) => {
        const cur = reshapeRef.current;
        if (!cur) return;
        const ll = map.unproject(p);
        const next = [...cur.pts];
        next[index] = groundAt(p, [ll.lng, ll.lat]);
        setReshapeBoth({ ...cur, pts: next });
      },
      () => saveReshape(before)
    );
  }

  function dragReshapeMid(e: React.PointerEvent, at: ScreenPt, insertAt: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const start = reshapeRef.current;
    if (!map || !start) return;
    const before = ringPolygon(start.pts);
    const ll = map.unproject(at);
    const seeded = [...start.pts];
    seeded.splice(insertAt, 0, [ll.lng, ll.lat]);
    setReshapeBoth({ ...start, pts: seeded });
    setSelectedVertex(insertAt);
    beginDrag(
      (p) => {
        const cur = reshapeRef.current;
        if (!cur) return;
        const at2 = map.unproject(p);
        const next = [...cur.pts];
        next[insertAt] = groundAt(p, [at2.lng, at2.lat]);
        setReshapeBoth({ ...cur, pts: next });
      },
      () => saveReshape(before)
    );
  }

  function dragRectCorner(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const start = rectRef.current;
    if (!map || !start) return;
    beginDrag((p) => {
      const ll = map.unproject(p);
      const ground = groundAt(p, [ll.lng, ll.lat]);
      setRectBoth(scaleRectFromCorner(start, index, toMerc(ground), false));
    });
  }

  function dragRectRotate(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const start = rectRef.current;
    if (!map || !start) return;
    beginDrag(
      (p) => {
        const ll = map.unproject(p);
        setRectBoth(rotateRectTo(start, toMerc([ll.lng, ll.lat])));
      },
      () => {
        if (!rectRef.current) return;
        lastRotRef.current = rectRef.current.rot;
        setLastRot(rectRef.current.rot);
      }
    );
  }

  function dragCut(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const b = blockRef.current;
    if (!map || !b) return;
    const dir = blockAxis(b, splitAxis);
    const { min, max } = extentAlong(b, dir);
    const span = max - min || 1;
    beginDrag((p) => {
      const ll = map.unproject(p);
      const s = toMerc([ll.lng, ll.lat]);
      const t = (s[0] * dir[0] + s[1] * dir[1] - min) / span;
      const cur = [...cutsRef.current];
      const lo = index === 0 ? 0.02 : cur[index - 1] + 0.02;
      const hi = index === cur.length - 1 ? 0.98 : cur[index + 1] - 0.02;
      cur[index] = Math.max(lo, Math.min(hi, t));
      setCutsBoth(cur);
    });
  }

  function dragCopyHandle(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const ring = copyRing;
    if (!map || !ring) return;
    const origin = ringCentroid(ring);
    beginDrag((p) => {
      const ll = map.unproject(p);
      const target = toMerc([ll.lng, ll.lat]);
      const raw: Pt = [target[0] - origin[0], target[1] - origin[1]];
      const dir = unit(raw);
      const len = Math.hypot(raw[0], raw[1]);
      const flush = flushStep(ring, dir);
      // Snap the spacing back to flush when it's close: abutting lots are the
      // answer nine times in ten, and a 3-inch gap is invisible on screen.
      const use = Math.abs(len - flush) < flush * 0.14 ? flush : Math.max(flush * 0.25, len);
      setCopyOverride([dir[0] * use, dir[1] * use]);
    });
  }

  /* ---- Site plan ---------------------------------------------------------- */

  const pinLayer = pinning ? (imageLayers.find((l) => l.id === pinning) ?? null) : null;

  /** Frame a render. `onlyIfOffscreen` leaves a camera the operator aimed alone. */
  const frameCorners = useCallback((c: Corners, onlyIfOffscreen = false) => {
    const map = mapRef.current;
    if (!map) return;
    const [west, south, east, north] = cornersBbox(c);
    if (onlyIfOffscreen) {
      const b = map.getBounds();
      if (b && west <= b.getEast() && east >= b.getWest() && south <= b.getNorth() && north >= b.getSouth()) {
        return;
      }
    }
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: FRAME_PADDING, duration: 600 }
    );
  }, []);

  /**
   * A drag frame moves the image's own coordinates and repaints the quad —
   * nothing goes through React state, and nothing rebuilds the overlay stack.
   */
  function setPinCorners(layer: Layer, c: Corners) {
    pinCornersRef.current = c;
    const map = mapRef.current;
    if (map) setLayerCoordinates(map, layer, c);
    paintPinRef.current?.();
  }

  /** Corners save on pointer-release, the way every other edit here autosaves. */
  function savePinCorners() {
    const id = pinningRef.current;
    const c = pinCornersRef.current;
    if (!id || !c) return;
    void run(async () => {
      await jsend<Layer>(`/api/layer/${id}`, "PATCH", { corners: c });
    });
  }

  function dragPinBody(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const layer = pinLayer;
    const start = pinCornersRef.current;
    const from = pointerLngLat(e);
    if (!map || !layer || !start || !from) return;
    const origin = mercAt(map, from);
    beginDrag((p) => {
      const m = mercAt(map, p);
      const dx = m[0] - origin[0];
      const dy = m[1] - origin[1];
      // Translation works on the raw quad, not a re-derived rectangle, so
      // nudging a fine-tuned render never squares it back up.
      setPinCorners(
        layer,
        start.map((c) => {
          const q = toMerc(c);
          return fromMerc([q[0] + dx, q[1] + dy]);
        }) as Corners
      );
    }, savePinCorners);
  }

  function dragPinCorner(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const layer = pinLayer;
    const start = pinCornersRef.current;
    if (!map || !layer || !start) return;
    // Snapshot the mode and the modifier now: neither can meaningfully change
    // mid-drag, and reading them here keeps the window listener free of stale
    // closures.
    const startRect = pinMode === "fine" ? null : rectFromCorners(start);
    const lock = pinLockAspect;
    beginDrag((p) => {
      const m = mercAt(map, p);
      if (startRect) {
        setPinCorners(layer, cornersFromRect(scaleRectFromCorner(startRect, index, m, lock)));
        return;
      }
      const next = [...(pinCornersRef.current ?? start)] as Corners;
      next[index] = fromMerc(m);
      setPinCorners(layer, next);
    }, savePinCorners);
  }

  function dragPinRotate(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const map = mapRef.current;
    const layer = pinLayer;
    const start = pinCornersRef.current;
    if (!map || !layer || !start) return;
    const startRect = rectFromCorners(start);
    beginDrag((p) => {
      setPinCorners(layer, cornersFromRect(rotateRectTo(startRect, mercAt(map, p))));
    }, savePinCorners);
  }

  const startPinning = useCallback(
    (id: string) => {
      const layer = imageLayers.find((l) => l.id === id);
      if (!layer?.corners) return;
      // Positioning owns the map while it lasts, so anything half-drawn goes
      // first — a stray outline left under the render is impossible to finish.
      clearDraft();
      if (reshapeRef.current) setReshapeBoth(null);
      setSelectedVertex(null);
      setNote(null);
      setPinConfirmRemove(false);
      pinCornersRef.current = layer.corners;
      setPlanOn(true);
      setPinMode("transform");
      pinningRef.current = id;
      setPinning(id);
      frameCorners(layer.corners, true);
    },
    [clearDraft, frameCorners, imageLayers, setReshapeBoth]
  );

  const stopPinning = useCallback(() => {
    const id = pinningRef.current;
    const c = pinCornersRef.current;
    pinningRef.current = null;
    pinCornersRef.current = null;
    setPinning(null);
    setPinConfirmRemove(false);
    // Fold the positioned corners back into the row now that a rebuild costs
    // nothing: from here on, `syncLayers` is the only thing drawing it.
    if (id && c) setImageLayers((cur) => cur.map((l) => (l.id === id ? { ...l, corners: c } : l)));
  }, []);

  async function addPlan(file: File) {
    const map = mapRef.current;
    if (!map) return;
    setNote(null);
    setPlanBusy("Reading…");
    try {
      const prepared = await prepareLayerImage(file);
      setPlanBusy("Uploading…");
      const corners = viewportCorners(map, prepared.width / prepared.height);
      // Created on the server before it is positioned, for the same reason a
      // drawn lot is saved the moment it closes: an alignment session is long,
      // and a lost tab shouldn't cost the upload as well.
      const layer = await jsend<Layer>(`/api/dev/${slug}/layers`, "POST", {
        kind: "image",
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Site plan",
        corners,
        image: {
          data: prepared.data,
          mime: prepared.mime,
          width: prepared.width,
          height: prepared.height,
        },
      });
      setImageLayers((cur) => [...cur, layer]);
      pinCornersRef.current = corners;
      setPlanOn(true);
      setPinMode("transform");
      setPinConfirmRemove(false);
      pinningRef.current = layer.id;
      setPinning(layer.id);
      setNote({
        tone: "info",
        text: prepared.reduced
          ? `Resized for upload: ${mb(prepared.originalBytes)} → ${mb(prepared.bytes)} MB (${prepared.width}×${prepared.height}). Drag it onto the site.`
          : "Drag the render onto the site, then trace it.",
      });
    } catch (e) {
      setNote({
        tone: "error",
        text: e instanceof ImageTooLargeError ? e.message : readable(e),
      });
    } finally {
      setPlanBusy(null);
    }
  }

  function removePlan() {
    const id = pinningRef.current;
    if (!id) return;
    pinningRef.current = null;
    pinCornersRef.current = null;
    setPinning(null);
    setPinConfirmRemove(false);
    setImageLayers((cur) => cur.filter((l) => l.id !== id));
    void run(async () => {
      await jsend(`/api/layer/${id}`, "DELETE");
    });
  }

  /* ---- Keyboard ----------------------------------------------------------- */

  const switchMode = useCallback(
    (next: Mode) => {
      // Positioning is modal: it ends with Done or Escape, not by a tool key
      // quietly handing the map back while the render is still under the cursor.
      if (pinningRef.current) return;
      if (next === mode) return;
      const busy = ptsRef.current.length > 0 || !!rectRef.current || !!blockRef.current;
      if (busy && pendingMode !== next) {
        setPendingMode(next);
        setNote({
          tone: "error",
          text: "You're part-way through a shape. Press Escape to discard it, or pick that tool again to switch.",
        });
        return;
      }
      clearDraft();
      setPendingMode(null);
      setNote(null);
      setSelectedVertex(null);
      if (reshapeRef.current) setReshapeBoth(null);
      if (next !== "copy") chooseCopySource(null);
      setMode(next);
    },
    [chooseCopySource, clearDraft, mode, pendingMode, setReshapeBoth]
  );

  const cancelCurrent = useCallback(() => {
    if (pinningRef.current) {
      stopPinning();
      return;
    }
    if (reshapeRef.current) {
      setReshapeBoth(null);
      setSelectedVertex(null);
      return;
    }
    if (ptsRef.current.length || rectRef.current || blockRef.current) {
      clearDraft();
      setNote(null);
      return;
    }
    if (copySrcRef.current) {
      chooseCopySource(null);
      setSelected(null);
    }
  }, [chooseCopySource, clearDraft, setReshapeBoth, stopPinning]);

  const finishCurrent = useCallback(() => {
    if (pinningRef.current) {
      stopPinning();
      return;
    }
    if (reshapeRef.current) {
      setReshapeBoth(null);
      setSelectedVertex(null);
      return;
    }
    const m = modeRef.current;
    if (m === "rect" && rectRef.current) return finishRect();
    if (m === "split" && blockRef.current) return commitSplit();
    if (m === "copy" && copySrcRef.current) return commitCopy();
    finishPolygon();
  }, [commitCopy, commitSplit, finishPolygon, finishRect, setReshapeBoth, stopPinning]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt") altRef.current = true;
      if (isTyping(e.target)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;

      if (e.code === "Space") {
        spaceRef.current = true;
        mapRef.current?.dragPan.enable();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelCurrent();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        finishCurrent();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (reshapeRef.current && selectedVertex != null) {
          e.preventDefault();
          const cur = reshapeRef.current;
          if (cur.pts.length <= 3) {
            setNote({ tone: "error", text: "A lot needs at least 3 corners — remove the whole lot instead." });
            return;
          }
          const before = ringPolygon(cur.pts);
          setReshapeBoth({ ...cur, pts: cur.pts.filter((_, i) => i !== selectedVertex) });
          setSelectedVertex(null);
          saveReshape(before);
          return;
        }
        if (ptsRef.current.length) {
          e.preventDefault();
          setPtsBoth(ptsRef.current.slice(0, -1));
        }
        return;
      }
      const tool = TOOLS.find((t) => t.key === e.key);
      if (tool) {
        e.preventDefault();
        switchMode(tool.mode);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key.toLowerCase() === "s") setSnapOn((v) => !v);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") altRef.current = false;
      if (e.code === "Space") {
        spaceRef.current = false;
        if (modeRef.current === "rect" && !reshapeRef.current) mapRef.current?.dragPan.disable();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [cancelCurrent, finishCurrent, saveReshape, selectedVertex, setPtsBoth, setReshapeBoth, switchMode, undoLast]);

  /* ---- Highlight ---------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const f = (id: string | null) =>
      ["==", ["get", "rowId"], id ?? "___none___"] as unknown as mapboxgl.FilterSpecification;
    if (map.getLayer(HL_HOVER)) map.setFilter(HL_HOVER, f(hoverLot));
    if (map.getLayer(HL_SEL)) map.setFilter(HL_SEL, f(copySrc ?? selected));
  }, [ready, hoverLot, selected, copySrc]);

  /* ---- Derived readout ---------------------------------------------------- */

  const liveRing = useMemo<LngLatRing | null>(() => {
    if (reshape) return reshape.pts;
    if (rect) return cornersFromRect(rect);
    if (pts.length >= 3) return hover && !block ? [...pts, hover] : pts;
    return null;
  }, [reshape, rect, pts, hover, block]);

  const measure = useMemo(() => {
    // Split and copy report the row they're about to create; everything else
    // reports the shape under the cursor.
    if (mode === "split" && block && splitPieces.length) {
      const acresEach = splitPieces.map((p) => polygonAcres(ringPolygon(toLngLatRing(p))));
      const total = acresEach.reduce((s, a) => s + a, 0);
      return {
        primary: { label: "Lots", value: String(splitPieces.length), unit: "" },
        second: { label: "Each", value: (total / splitPieces.length).toFixed(2), unit: "ac" },
        third: { label: "Block", value: total.toFixed(2), unit: "ac" },
      };
    }
    if (mode === "copy" && copyLot && copyRing && copyOff) {
      const step = Math.hypot(copyOff[0], copyOff[1]);
      const flush = flushStep(copyRing, unit(copyOff));
      const lat = fromMerc(ringCentroid(copyRing))[1];
      const gapM = ((step - flush) * metersPerMerc(lat));
      return {
        primary: { label: "Copies", value: String(copyN), unit: "" },
        second: { label: "Each", value: copyLot.acres || "—", unit: "ac" },
        third: {
          label: "Gap",
          value: Math.abs(gapM) < 0.15 ? "flush" : feet(Math.abs(gapM)),
          unit: Math.abs(gapM) < 0.15 ? "" : "ft",
        },
      };
    }
    if (liveRing && liveRing.length >= 3) {
      const poly = ringPolygon(liveRing);
      const last =
        pts.length && hover && !reshape && !rect
          ? metersBetween(pts[pts.length - 1], hover)
          : null;
      return {
        primary: { label: "Area", value: polygonAcres(poly).toFixed(2), unit: "ac" },
        second: last != null
          ? { label: "Edge", value: feet(last), unit: "ft" }
          : { label: "Perimeter", value: feet(ringPerimeter(liveRing)), unit: "ft" },
        third: { label: "Corners", value: String(liveRing.length - (last != null ? 1 : 0)), unit: "" },
      };
    }
    if (pts.length === 2 && hover) {
      return {
        primary: { label: "Edge", value: feet(metersBetween(pts[1], hover)), unit: "ft" },
        second: { label: "Bearing", value: `${Math.round(bearingDeg(pts[1], hover))}°`, unit: "" },
        third: { label: "Corners", value: "2", unit: "" },
      };
    }
    return {
      primary: { label: "Area", value: "—", unit: "" },
      second: { label: "Perimeter", value: "—", unit: "" },
      third: { label: "Corners", value: String(pts.length), unit: "" },
    };
  }, [block, copyLot, copyN, copyOff, copyRing, hover, liveRing, mode, pts, rect, reshape, splitPieces]);

  const hint = useMemo(() => {
    // The bar speaks for whatever owns the map. While a render is being placed
    // that is the render — leaving "click each corner of the lot" up would be
    // instructions for a gesture that is currently switched off.
    if (pinning) {
      return pinMode === "transform"
        ? "Line the render up with the imagery: drag it, resize from a corner, turn it with the top grip."
        : "Drag one corner at a time to correct a render that wasn’t drawn straight down.";
    }
    if (reshape) return "Drag a corner to move it, or a hollow midpoint to add one. Escape when you're done.";
    if (mode === "rect") {
      return rect
        ? "Turn the top handle to match the street, drag a corner to resize, then finish the lot."
        : "Drag from one corner of the lot to the opposite corner. Hold Space to pan the map.";
    }
    if (mode === "split") {
      return block
        ? "Set how many lots, then drag a cut line to make one wider than the rest."
        : "Draw the whole block first — click each corner, then click the first corner to close it.";
    }
    if (mode === "copy") {
      return copySrc
        ? "Set how many copies. Drag the handle to change the direction or leave a gap."
        : "Click the lot you want to copy.";
    }
    if (pts.length === 0 && countyOn) return "Click each corner of the lot — or click a county outline to add it whole.";
    return pts.length === 0
      ? "Click each corner of the lot. Click the first corner again to finish."
      : "Keep clicking corners. Click the first corner to close the lot.";
  }, [block, countyOn, copySrc, mode, pinMode, pinning, pts.length, rect, reshape]);

  /* ---- Actions in the bar ------------------------------------------------- */

  // Label and enablement only — the click runs `finishCurrent`, the same path
  // Enter takes, so the button and the key can never mean different things.
  const primaryAction = useMemo(() => {
    if (pinning) return { label: "Done placing", enabled: true };
    if (reshape) return { label: "Done", enabled: true };
    if (mode === "rect") return { label: "Finish lot", enabled: !!rect };
    if (mode === "split")
      return block
        ? { label: `Create ${splitPieces.length} lots`, enabled: splitPieces.length >= MIN_LOTS }
        : { label: "Finish block", enabled: pts.length >= 3 };
    if (mode === "copy")
      return { label: `Create ${copyN} ${copyN === 1 ? "copy" : "copies"}`, enabled: !!copySrc };
    return { label: "Finish lot", enabled: pts.length >= 3 };
  }, [block, copyN, copySrc, mode, pinning, pts.length, rect, reshape, splitPieces.length]);

  const canCancel =
    !!pinning || !!reshape || pts.length > 0 || !!rect || !!block || (mode === "copy" && !!copySrc);

  /* ---- The lot list ------------------------------------------------------- */

  const renderRows = useCallback(
    (rows: LotRow[]) => (
      <ul className="divide-y divide-line-2">
        {rows.map((l) => {
          const active = selected === l.rowId || copySrc === l.rowId;
          return (
            <li
              key={l.rowId}
              data-row={l.rowId}
              onMouseEnter={() => setHoverLot(l.rowId)}
              onMouseLeave={() => setHoverLot((h) => (h === l.rowId ? null : h))}
              className={cx(
                "group flex items-center gap-2 px-3 py-[7px] transition",
                active ? "bg-brass-wash" : "hover:bg-panel-2/70",
                lastCreated === l.rowId && "ring-1 ring-inset ring-brass/40"
              )}
            >
              <Dot color={l.color ?? "#c3cad6"} />
              <input
                defaultValue={l.lot_number}
                key={`${l.rowId}:${l.lot_number}`}
                // An imported lot can arrive with no number. A bare empty box
                // reads as a broken field; a dash reads as "not set yet".
                placeholder="—"
                aria-label={`Lot number, currently ${l.lot_number || "unset"}`}
                onBlur={(e) => renameLot(l.rowId, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = l.lot_number;
                    e.currentTarget.blur();
                  }
                }}
                className="h-6 w-[44px] shrink-0 rounded-[6px] border border-transparent bg-transparent px-1 font-mono text-[12px] font-medium text-ink transition placeholder:text-faint hover:border-line focus:border-ink/30 focus:bg-panel focus-visible:outline-none"
              />
              {/* Hand-drawn or hand-reshaped: a county re-import will refresh
                  this lot's details but leave its outline alone. */}
              {l.locked && <Chip>DRAWN</Chip>}
              <button
                onClick={() => {
                  setSelected(l.rowId);
                  zoomToLot(l);
                }}
                title="Zoom to this lot"
                className="ml-auto shrink-0 rounded-[6px] px-1 font-mono text-[12px] tabular-nums text-graphite transition hover:text-ink"
              >
                {l.acres || "—"} <span className="text-faint">ac</span>
              </button>
              {confirmRemove === l.rowId ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => removeLot(l.rowId)}
                    className="rounded-[6px] border border-danger/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-danger-ink transition hover:bg-danger/10"
                  >
                    Remove
                  </button>
                  <button
                    onClick={() => setConfirmRemove(null)}
                    aria-label="Keep this lot"
                    className="rounded-[6px] px-1 text-[13px] leading-none text-faint transition hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                  <IconButton title={`Reshape lot ${l.lot_number}`} onClick={() => startReshape(l)}>
                    <path d="M3 11.5V13h1.5l7-7L10 4.5l-7 7Z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
                    <path d="M10.6 3.9 11.8 2.7a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4l-1.2 1.2Z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
                  </IconButton>
                  <IconButton title={`Remove lot ${l.lot_number}`} onClick={() => setConfirmRemove(l.rowId)}>
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </IconButton>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    ),
    [confirmRemove, copySrc, lastCreated, removeLot, renameLot, selected, startReshape, zoomToLot]
  );

  /* ---- Render ------------------------------------------------------------- */

  const undoTop = undo[undo.length - 1] ?? null;
  const drawTrail = screen.cursor ? [...screen.draw, screen.cursor] : screen.draw;
  const closing = drawTrail.length >= 3;

  /* ---- Address search ------------------------------------------------------
     The map is the only way into this tool, so "where is the site?" has to be
     answerable without leaving it. Suggest is debounced and biased toward the
     current centre; retrieve resolves the one the operator picked and flies
     there at drawing zoom. */

  // On a brand-new development the tools have nothing to bite on, so the
  // cursor starts in the search field rather than on empty desert.
  useEffect(() => {
    if (ready && unplaced) searchRef.current?.focus({ preventScroll: true });
  }, [ready, unplaced]);

  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const check = () =>
      setRailMore(el.scrollHeight - el.clientHeight > 4 && el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [mode, block, copySrc, planOn, pinning, imageLayers.length]);

  function onQuery(v: string) {
    setQuery(v);
    setSearchOpen(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!token) return;
    searchTimer.current = setTimeout(async () => {
      const c = mapRef.current?.getCenter();
      const res = await suggestAddress(v, token, searchSession.current, c ? [c.lng, c.lat] : undefined);
      setSuggestions(res);
    }, 250);
  }

  async function flyToSuggestion(sug: Suggestion) {
    setQuery(sug.name);
    setSearchOpen(false);
    setSuggestions([]);
    searchRef.current?.blur();
    const coords = await retrieveSuggestion(sug.mapbox_id, token, searchSession.current);
    if (!coords || !mapRef.current) {
      setNote({ tone: "error", text: "Couldn’t find that address. Try a street plus a city." });
      return;
    }
    // Closer than the picker's 16.3: you are about to trace corners, not
    // survey a neighbourhood.
    mapRef.current.flyTo({ center: coords, zoom: 17.4, pitch: 0, bearing: 0, duration: 1400, essential: true });
    setUnplaced(false);
  }

  return (
    <div className={cx("grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_312px]", className)}>
      {/* ---- Stage ---------------------------------------------------------- */}
      <div className="relative min-h-0 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]">
        <div ref={containerRef} className="absolute inset-0 h-full w-full" />

        <input
          ref={planFileRef}
          type="file"
          accept={[...LAYER_IMAGE_MIMES, "image/*"].join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared so re-picking the same file still fires a change event.
            e.target.value = "";
            if (f) void addPlan(f);
          }}
        />

        {/* Outlines, previews, ghosts. Pointer-transparent: the map's own click
            handler needs every press, and only grips (z-40) should take one. */}
        {ready && (
          <svg className="absolute inset-0 z-20 h-full w-full" style={{ pointerEvents: "none" }}>
            {/* Split preview: the lots the block is about to become. */}
            {screen.pieces.map((p, i) => (
              <g key={`piece${i}`}>
                <polygon
                  points={p.ring.map((q) => q.join(",")).join(" ")}
                  fill={PAINT.drawWash}
                  stroke={PAINT.draw}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                />
                <text
                  x={p.at[0]}
                  y={p.at[1] + 4}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={12}
                  fill="#ffffff"
                  stroke={PAINT.stage}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {nextLot + i}
                </text>
              </g>
            ))}
            {screen.cuts.map((c) => (
              <line
                key={`cut${c.i}`}
                x1={c.a[0]}
                y1={c.a[1]}
                x2={c.b[0]}
                y2={c.b[1]}
                stroke={PAINT.draw}
                strokeWidth={1.6}
                strokeDasharray="6 4"
              />
            ))}

            {/* Copy preview: the row about to be created. */}
            {screen.ghosts.map((g, i) => (
              <g key={`ghost${i}`}>
                <polygon
                  points={g.ring.map((q) => q.join(",")).join(" ")}
                  fill="rgba(227,200,141,0.10)"
                  stroke={PAINT.ghost}
                  strokeWidth={1.3}
                  strokeDasharray="6 4"
                  strokeLinejoin="round"
                />
                <text
                  x={g.at[0]}
                  y={g.at[1] + 4}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={12}
                  fill="#ffffff"
                  stroke={PAINT.stage}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {nextLot + i}
                </text>
              </g>
            ))}

            {/* Pending rectangle. */}
            {screen.rect && (
              <>
                <polygon
                  points={screen.rect.quad.map((q) => q.join(",")).join(" ")}
                  fill={PAINT.drawWash}
                  stroke={PAINT.draw}
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                />
                <line
                  x1={(screen.rect.quad[0][0] + screen.rect.quad[1][0]) / 2}
                  y1={(screen.rect.quad[0][1] + screen.rect.quad[1][1]) / 2}
                  x2={screen.rect.handle[0]}
                  y2={screen.rect.handle[1]}
                  stroke={PAINT.draw}
                  strokeWidth={1.4}
                />
              </>
            )}

            {/* The outline being clicked out, plus the rubber band and the edge
                that will close it. */}
            {!reshape && drawTrail.length >= 2 && (
              <>
                {closing && (
                  <polygon
                    points={drawTrail.map((q) => q.join(",")).join(" ")}
                    fill={PAINT.drawWash}
                    stroke="none"
                  />
                )}
                <polyline
                  points={drawTrail.map((q) => q.join(",")).join(" ")}
                  fill="none"
                  stroke={PAINT.draw}
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                />
                {closing && (
                  <line
                    x1={drawTrail[drawTrail.length - 1][0]}
                    y1={drawTrail[drawTrail.length - 1][1]}
                    x2={drawTrail[0][0]}
                    y2={drawTrail[0][1]}
                    stroke={PAINT.draw}
                    strokeWidth={1.4}
                    strokeDasharray="5 5"
                    opacity={0.75}
                  />
                )}
              </>
            )}

            {/* Reshape outline. */}
            {reshape && screen.draw.length >= 3 && (
              <polygon
                points={screen.draw.map((q) => q.join(",")).join(" ")}
                fill={PAINT.drawWash}
                stroke={PAINT.draw}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
            )}
          </svg>
        )}

        {/* Grips ride ABOVE the floating chrome (z-40): a corner sitting behind
            the rail or the bar has to stay grabbable. They're 13px. */}
        {ready && (
          <svg
            className="absolute inset-0 z-40 h-full w-full"
            style={{ pointerEvents: "none", touchAction: "none" }}
          >
            {reshape &&
              screen.mids.map((m) => (
                <circle
                  key={`m${m.insertAt}`}
                  cx={m.at[0]}
                  cy={m.at[1]}
                  r={4.5}
                  fill={PAINT.stage}
                  stroke={PAINT.draw}
                  strokeWidth={1.5}
                  style={{ pointerEvents: "all", cursor: "copy" }}
                  onPointerDown={(e) => dragReshapeMid(e, m.at, m.insertAt)}
                />
              ))}

            {screen.draw.map((p, i) => {
              const target = !reshape && i === 0 && screen.draw.length >= 3;
              return (
                <rect
                  key={`v${i}`}
                  x={p[0] - 6.5}
                  y={p[1] - 6.5}
                  width={13}
                  height={13}
                  rx={target ? 6.5 : selectedVertex === i ? 3 : 2.5}
                  fill={target || selectedVertex === i ? PAINT.draw : "#ffffff"}
                  stroke={PAINT.stage}
                  strokeWidth={1.5}
                  style={reshape ? { pointerEvents: "all", cursor: "grab" } : { pointerEvents: "none" }}
                  onPointerDown={reshape ? (e) => dragReshapeVertex(e, i) : undefined}
                />
              );
            })}

            {screen.rect && (
              <>
                {screen.rect.quad.map((p, i) => (
                  <rect
                    key={`rc${i}`}
                    x={p[0] - 6.5}
                    y={p[1] - 6.5}
                    width={13}
                    height={13}
                    rx={2.5}
                    fill="#ffffff"
                    stroke={PAINT.stage}
                    strokeWidth={1.5}
                    style={{ pointerEvents: "all", cursor: "nwse-resize" }}
                    onPointerDown={(e) => dragRectCorner(e, i)}
                  />
                ))}
                <circle
                  cx={screen.rect.handle[0]}
                  cy={screen.rect.handle[1]}
                  r={8}
                  fill={PAINT.stage}
                  stroke={PAINT.draw}
                  strokeWidth={2}
                  style={{ pointerEvents: "all", cursor: "grab" }}
                  onPointerDown={dragRectRotate}
                />
              </>
            )}

            {screen.cuts.map((c) => (
              <rect
                key={`cg${c.i}`}
                x={c.at[0] - 6}
                y={c.at[1] - 6}
                width={12}
                height={12}
                rx={2}
                transform={`rotate(45 ${c.at[0]} ${c.at[1]})`}
                fill={PAINT.draw}
                stroke={PAINT.stage}
                strokeWidth={1.5}
                style={{ pointerEvents: "all", cursor: "move" }}
                onPointerDown={(e) => dragCut(e, c.i)}
              />
            ))}

            {screen.ghostHandle && (
              <circle
                cx={screen.ghostHandle[0]}
                cy={screen.ghostHandle[1]}
                r={8}
                fill={PAINT.stage}
                stroke={PAINT.ghost}
                strokeWidth={2}
                style={{ pointerEvents: "all", cursor: "move" }}
                onPointerDown={dragCopyHandle}
              />
            )}

            {/* Snap monument — a surveyor's mark, so a snap is something you see
                happen rather than something that mysteriously worked. */}
            {screen.snap && snapHit && (
              <g pointerEvents="none">
                <circle cx={screen.snap[0]} cy={screen.snap[1]} r={7.5} fill="none" stroke={PAINT.stage} strokeWidth={3.5} opacity={0.55} />
                <circle cx={screen.snap[0]} cy={screen.snap[1]} r={7.5} fill="none" stroke="#ffffff" strokeWidth={1.6} />
                {[
                  [0, -1],
                  [0, 1],
                  [-1, 0],
                  [1, 0],
                ].map(([dx, dy], i) => (
                  <line
                    key={i}
                    x1={screen.snap![0] + dx * 5}
                    y1={screen.snap![1] + dy * 5}
                    x2={screen.snap![0] + dx * 12}
                    y2={screen.snap![1] + dy * 12}
                    stroke="#ffffff"
                    strokeWidth={1.4}
                  />
                ))}
                <circle cx={screen.snap[0]} cy={screen.snap[1]} r={1.7} fill="#ffffff" />
                <text
                  x={screen.snap[0] + 15}
                  y={screen.snap[1] - 9}
                  className="font-mono"
                  fontSize={9}
                  letterSpacing="0.14em"
                  fill="#ffffff"
                  stroke={PAINT.stage}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {snapHit.kind === "corner" ? "CORNER" : "EDGE"}
                </text>
              </g>
            )}
          </svg>
        )}

        {/* The render's outline, and the target for dragging it bodily. Under
            the floating chrome and transparent to pointers except on the quad
            itself, so panning the map beside it still works. */}
        {pinning && pinScreen.quad.length === 4 && (
          <svg className="absolute inset-0 z-20 h-full w-full" style={{ pointerEvents: "none", touchAction: "none" }}>
            <polygon
              points={pinScreen.quad.map((q) => q.join(",")).join(" ")}
              fill={PAINT.drawWash}
              stroke={PAINT.draw}
              strokeWidth={1.5}
              strokeDasharray="7 5"
              style={{ pointerEvents: "fill", cursor: "move" }}
              onPointerDown={dragPinBody}
            />
            {pinMode === "transform" && pinScreen.rotate && (
              <line
                x1={(pinScreen.quad[0][0] + pinScreen.quad[1][0]) / 2}
                y1={(pinScreen.quad[0][1] + pinScreen.quad[1][1]) / 2}
                x2={pinScreen.rotate[0]}
                y2={pinScreen.rotate[1]}
                stroke={PAINT.draw}
                strokeWidth={1.5}
              />
            )}
          </svg>
        )}

        {/* Grips ride above the rail (z-40): a corner that happens to sit behind
            a floating panel has to stay grabbable. */}
        {pinning && pinScreen.quad.length === 4 && (
          <svg className="absolute inset-0 z-40 h-full w-full" style={{ pointerEvents: "none", touchAction: "none" }}>
            {pinMode === "transform" && pinScreen.rotate && (
              <circle
                cx={pinScreen.rotate[0]}
                cy={pinScreen.rotate[1]}
                r={8}
                fill={PAINT.stage}
                stroke={PAINT.draw}
                strokeWidth={2}
                style={{ pointerEvents: "all", cursor: "grab" }}
                onPointerDown={dragPinRotate}
              />
            )}
            {pinScreen.quad.map((q, i) => (
              <rect
                key={`pin${i}`}
                x={q[0] - 7}
                y={q[1] - 7}
                width={14}
                height={14}
                rx={pinMode === "fine" ? 7 : 3}
                fill={pinMode === "fine" ? PAINT.draw : "#ffffff"}
                stroke={PAINT.stage}
                strokeWidth={1.5}
                style={{ pointerEvents: "all", cursor: pinMode === "fine" ? "crosshair" : "nwse-resize" }}
                onPointerDown={(e) => dragPinCorner(e, i)}
              />
            ))}
          </svg>
        )}

        {/* ---- Tool rail --------------------------------------------------- */}
        {/* The rail is bounded by the stage and scrolls inside it. A short
            laptop viewport leaves ~310px here, and an expanded Split/Copy panel
            wants more than that — unbounded, it ran off the bottom edge and
            under the instrument bar, which is where the toggles went missing. */}
        <div
          ref={railRef}
          className={cx(
            "pointer-events-none absolute bottom-3 left-3 top-3 z-30 flex w-[224px] flex-col gap-2 overflow-y-auto overscroll-contain",
            railMore && "[mask-image:linear-gradient(to_bottom,#000_calc(100%-34px),transparent)]"
          )}
        >
          {/* ---- Positioning a site plan ----------------------------------- */}
          {/* Replaces the tool rail rather than sitting beside it: while a render
              is being placed the drawing tools are stood down, and leaving them
              on screen only invites a click that does nothing. */}
          {pinning && (
            <div className="glass-dark pointer-events-auto rounded-[var(--radius)] p-1.5">
              <div className="flex items-baseline justify-between px-2 pb-1 pt-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">
                  Place plan
                </span>
                <span className="font-mono text-[9px] tracking-[0.16em] text-white/25" aria-live="polite">
                  {saving ? "SAVING" : "SAVED"}
                </span>
              </div>

              <p className="truncate px-2 pb-1.5 text-[12px] text-white/70">
                {pinLayer?.name ?? "Site plan"}
              </p>

              <div className="mx-1 flex rounded-[6px] border border-white/15 p-0.5">
                {(["transform", "fine"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setPinMode(m)}
                    aria-pressed={pinMode === m}
                    className={cx(
                      "h-6 flex-1 rounded-[5px] text-[11px] font-medium transition",
                      FOCUS_DARK,
                      pinMode === m ? "bg-white text-[#0c0f16]" : "text-white/60 hover:text-white"
                    )}
                  >
                    {m === "transform" ? "Move" : "Corners"}
                  </button>
                ))}
              </div>

              <p className="px-2 pb-1 pt-2 text-[11px] leading-[1.4] text-white/45">
                {pinMode === "transform"
                  ? "Drag the render to move it, a corner to resize, the top grip to turn it."
                  : "Drag each corner on its own, for a render that wasn’t drawn straight down. Resizing squares it back up, so do this last."}
              </p>

              {pinMode === "transform" && (
                <Toggle
                  on={pinLockAspect}
                  onClick={() => setPinLockAspect((v) => !v)}
                  label="Lock aspect"
                  note={pinLockAspect ? "Corners keep the shape" : "Corners stretch it"}
                />
              )}

              <label className="flex items-center gap-2 px-2 pb-1.5 pt-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">Fade</span>
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={planOpacity}
                  onChange={(e) => setPlanOpacity(Number(e.target.value))}
                  className="h-1 flex-1 accent-[#d8b26a]"
                  aria-label="Site plan opacity"
                />
                <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-white/55">
                  {Math.round(planOpacity * 100)}%
                </span>
              </label>

              <div className="mt-1 flex gap-1.5 border-t border-white/10 px-1 pt-2">
                <button
                  onClick={() => pinCornersRef.current && frameCorners(pinCornersRef.current)}
                  className={cx(
                    "flex-1 rounded-[6px] border border-white/15 px-2 py-1.5 text-[11.5px] text-white/70 transition hover:bg-white/[0.07] hover:text-white",
                    FOCUS_DARK
                  )}
                >
                  Zoom to it
                </button>
                <button
                  onClick={stopPinning}
                  className={cx(
                    "flex-1 rounded-[6px] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-2 py-1.5 text-[11.5px] font-semibold text-white transition hover:brightness-110",
                    FOCUS_DARK
                  )}
                >
                  Done
                </button>
              </div>

              <button
                onClick={() => (pinConfirmRemove ? removePlan() : setPinConfirmRemove(true))}
                onBlur={() => setPinConfirmRemove(false)}
                className={cx(
                  "mx-1 mt-1 block w-[calc(100%-8px)] rounded-[6px] px-2 py-1.5 text-[11px] transition",
                  FOCUS_DARK,
                  pinConfirmRemove
                    ? "bg-[rgba(190,74,74,0.22)] text-white"
                    : "text-white/40 hover:bg-white/[0.06] hover:text-white/70"
                )}
              >
                {pinConfirmRemove ? "Remove this plan — click again" : "Remove plan"}
              </button>
            </div>
          )}

          {!pinning && (
            <div className="glass-dark pointer-events-auto rounded-[var(--radius)] p-1.5">
              <div className="flex items-baseline justify-between px-2 pb-1 pt-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">Tool</span>
                <span className="font-mono text-[9px] tracking-[0.16em] text-white/25">KEYS 1–4</span>
              </div>
              {TOOLS.map((t) => (
                <button
                  key={t.mode}
                  onClick={() => switchMode(t.mode)}
                  aria-pressed={mode === t.mode}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-[7px] py-[5px] pl-1 pr-2 text-left transition",
                    FOCUS_DARK,
                    mode === t.mode
                      ? "bg-[rgba(216,178,106,0.16)] text-white"
                      : "text-white/60 hover:bg-white/[0.07] hover:text-white",
                    pendingMode === t.mode && "ring-1 ring-inset ring-[#d8b26a]"
                  )}
                >
                  <span
                    className={cx(
                      "h-5 w-[3px] shrink-0 rounded-full transition",
                      mode === t.mode ? "bg-[#d8b26a]" : "bg-transparent"
                    )}
                    aria-hidden="true"
                  />
                  <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
                    {t.glyph}
                  </svg>
                  <span className="flex-1 text-[12.5px] font-medium tracking-[-0.01em]">{t.name}</span>
                  <kbd className="rounded-[4px] border border-white/15 px-1 font-mono text-[9px] leading-[14px] text-white/40">
                    {t.key}
                  </kbd>
                </button>
              ))}

              {/* The tool names are terse by design; this is the line that says
                  what the selected one is actually for. */}
              <p className="border-t border-white/10 px-2 pb-1 pt-2 text-[11px] leading-[1.4] text-white/45">
                {TOOLS.find((t) => t.mode === mode)?.blurb}
              </p>

              {/* Progressive disclosure: only the tool that needs setting up
                  shows its settings, and only once it has something to set. */}
              {mode === "rect" && (
                <div className="mt-1.5 border-t border-white/10 pt-1.5">
                  <Toggle
                    on={lockAngle}
                    onClick={() => setLockAngle((v) => !v)}
                    label="Keep this angle"
                    note={
                      lockAngle
                        ? `Every lot at ${degrees(lastRot)}°`
                        : "Each lot starts square to north"
                    }
                  />
                </div>
              )}

              {mode === "split" && block && (
                <div className="mt-1.5 border-t border-white/10 px-2 pb-1 pt-2.5">
                  <Stepper
                    label="Lots"
                    value={splitN}
                    min={MIN_LOTS}
                    max={MAX_SPLIT}
                    onChange={setSplitCount}
                  />
                  <button
                    onClick={() => setSplitAxis((a) => (a === 0 ? 1 : 0))}
                    className={cx(
                      "mt-2 flex w-full items-center justify-between rounded-[6px] border border-white/15 px-2 py-1.5 text-[11.5px] text-white/70 transition hover:bg-white/[0.07] hover:text-white",
                      FOCUS_DARK
                    )}
                  >
                    Turn the cuts
                    <span className="font-mono text-[10px] tracking-[0.12em] text-white/40">⇄</span>
                  </button>
                  <p className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/35">
                    Creates lots {nextLot}–{nextLot + Math.max(0, splitPieces.length - 1)}
                  </p>
                </div>
              )}

              {mode === "copy" && copyLot && (
                <div className="mt-1.5 border-t border-white/10 px-2 pb-1 pt-2.5">
                  <Stepper label="Copies" value={copyN} min={1} max={MAX_COPIES} onChange={setCopyN} />
                  <div className="mt-2 flex gap-1.5">
                    <button
                      onClick={() => copyOff && setCopyOverride([-copyOff[0], -copyOff[1]])}
                      className={cx(
                        "flex-1 rounded-[6px] border border-white/15 px-2 py-1.5 text-[11.5px] text-white/70 transition hover:bg-white/[0.07] hover:text-white",
                        FOCUS_DARK
                      )}
                    >
                      Other way
                    </button>
                    <button
                      onClick={() => setCopyOverride(null)}
                      disabled={!copyOverride}
                      className={cx(
                        "flex-1 rounded-[6px] border border-white/15 px-2 py-1.5 text-[11.5px] text-white/70 transition hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-35",
                        FOCUS_DARK
                      )}
                    >
                      Flush again
                    </button>
                  </div>
                  <p className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/35">
                    From lot {copyLot.lot_number} · creates {nextLot}–{nextLot + copyN - 1}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Precision + reference */}
          <div className="glass-dark pointer-events-auto rounded-[var(--radius)] p-1.5">
            <Toggle
              on={snapOn}
              onClick={() => setSnapOn((v) => !v)}
              label="Snap to corners"
              note="Hold ⌥ to suspend"
            />
            <div className="mx-2 my-1 h-px bg-white/10" />
            <Toggle
              on={planOn}
              disabled={imageLayers.length === 0}
              onClick={() => setPlanOn((v) => !v)}
              label="Trace site plan"
              note={imageLayers.length === 0 ? "Add a render below" : `${imageLayers.length} pinned`}
            />
            {planOn && imageLayers.length > 0 && (
              <>
                <label className="flex items-center gap-2 px-2 pb-1.5 pt-1">
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">Fade</span>
                  <input
                    type="range"
                    min={0.15}
                    max={1}
                    step={0.05}
                    value={planOpacity}
                    onChange={(e) => setPlanOpacity(Number(e.target.value))}
                    className="h-1 flex-1 accent-[#d8b26a]"
                    aria-label="Site plan opacity"
                  />
                  <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-white/55">
                    {Math.round(planOpacity * 100)}%
                  </span>
                </label>
                {/* Every pinned render is listed, not just the one added here:
                    a plan pinned back on Map Design is the same row, and it is
                    just as likely to be the one sitting a few metres off. */}
                <div className="px-1 pb-0.5">
                  {imageLayers.map((l) => (
                    <div key={l.id} className="flex items-center gap-1.5 py-[2px] pl-1">
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-white/55">{l.name}</span>
                      <button
                        onClick={() => startPinning(l.id)}
                        className={cx(
                          "shrink-0 rounded-[5px] border border-white/15 px-1.5 py-[3px] text-[10.5px] text-white/60 transition hover:bg-white/[0.07] hover:text-white",
                          FOCUS_DARK
                        )}
                      >
                        Place
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {/* The render usually arrives with the operator, not before them:
                pinning it here saves a round trip to Map Design mid-trace. */}
            <button
              onClick={() => planFileRef.current?.click()}
              disabled={!!planBusy}
              className={cx(
                "mx-1 mt-0.5 mb-0.5 flex w-[calc(100%-8px)] items-center gap-1.5 rounded-[6px] border border-dashed border-white/15 px-2 py-1.5 text-[11.5px] text-white/55 transition hover:border-white/30 hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-50",
                FOCUS_DARK
              )}
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden="true">
                <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M2.5 10.5 6 7.5l2.5 2 2-1.5 3 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <circle cx="5.75" cy="6" r="1" fill="currentColor" />
              </svg>
              {planBusy ?? (imageLayers.length ? "Pin another render" : "Pin a site plan")}
            </button>
            <Toggle
              on={countyOn}
              onClick={() => {
                setCountyHover(null);
                setCountyOn((v) => !v);
              }}
              label="Trace county lines"
              note={
                !countyOn
                  ? "Click one to add it whole"
                  : countyBusy
                    ? "Loading…"
                    : !zoomOk
                      ? "Zoom in to load"
                      : `${countyCount} loaded`
              }
            />
          </div>
        </div>

        {/* ---- Address search ---------------------------------------------- */}
        {/* Offset past the tool rail, same column the notice uses. Kept at z-30
            so a corner grip (z-40) under it is still grabbable. */}
        <div className="absolute left-[240px] top-3 z-30 w-[min(360px,calc(100%-296px))]">
          <div
            className={cx(
              "glass-dark flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 transition",
              "focus-within:ring-1 focus-within:ring-[#d8b26a]/70",
              unplaced && "ring-1 ring-[#d8b26a]/60"
            )}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-white/50" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onFocus={() => suggestions.length && setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setSearchOpen(false);
                  searchRef.current?.blur();
                } else if (e.key === "Enter" && suggestions.length) {
                  e.preventDefault();
                  void flyToSuggestion(suggestions[0]);
                }
              }}
              placeholder="Search an address to fly there…"
              aria-label="Search an address"
              // Inline, not a utility: globals' unlayered :focus-visible rule
              // beats layered utilities, and its ink outline is invisible here.
              style={{ outline: "none" }}
              className="h-9 w-full bg-transparent text-[13px] text-white placeholder:text-white/45"
            />
            {query ? (
              <button
                onClick={() => {
                  setQuery("");
                  setSuggestions([]);
                  setSearchOpen(false);
                }}
                className={cx("shrink-0 px-1 text-white/45 transition hover:text-white", FOCUS_DARK)}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : (
              <kbd className="shrink-0 rounded-[4px] border border-white/15 px-1 font-mono text-[9px] leading-[14px] text-white/35">
                /
              </kbd>
            )}
          </div>

          {searchOpen && suggestions.length > 0 && (
            <ul className="pop-in glass-dark mt-1.5 overflow-hidden rounded-[var(--radius-sm)] p-1">
              {suggestions.map((sug) => (
                <li key={sug.mapbox_id}>
                  <button
                    onClick={() => void flyToSuggestion(sug)}
                    className={cx(
                      "flex w-full flex-col rounded-[6px] px-2.5 py-1.5 text-left transition hover:bg-white/10",
                      FOCUS_DARK
                    )}
                  >
                    <span className="text-[12.5px] font-medium text-white">{sug.name}</span>
                    {sug.place_formatted && (
                      <span className="truncate text-[11px] text-white/50">{sug.place_formatted}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* The one line that explains why the map opened on nowhere. */}
          {unplaced && !searchOpen && !note && (
            <p className="glass-dark pop-in mt-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11.5px] leading-snug text-white/70">
              This development has no lots yet, so the map hasn’t got a site to open on. Search an
              address to fly to it, then start drawing.
            </p>
          )}
        </div>

        {/* ---- Transient notice / county hover ------------------------------ */}
        {(note || countyHover) && (
          // Offset past the rail and below the search bar: a notice that covers
          // the tool you just picked is worse than no notice.
          <div className="pointer-events-none absolute left-[240px] top-[54px] z-30 w-[min(400px,calc(100%-296px))]">
            {note ? (
              <div className="glass-dark pop-in rounded-[var(--radius-sm)] px-3.5 py-2">
                <span
                  className={cx(
                    "font-mono text-[9.5px] uppercase tracking-[0.16em]",
                    note.tone === "error" ? "text-danger-ink" : "text-white/40"
                  )}
                >
                  {note.tone === "error" ? "Can’t do that" : "Saved"}
                </span>
                <p className="mt-0.5 text-[12.5px] leading-snug text-white/80">{note.text}</p>
              </div>
            ) : (
              countyHover && (
                <div className="glass-dark pop-in inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: PAINT.county }} />
                  <span className="font-mono text-[11px] tabular-nums text-white/80">
                    {countyHover.PARCEL_ID}
                    {countyHover.acres != null ? ` · ${Number(countyHover.acres).toFixed(2)} ac` : ""}
                  </span>
                  <span className="text-[11.5px] text-white/45">Click to add it as a lot</span>
                </div>
              )
            )}
          </div>
        )}

        {/* ---- Instrument bar ---------------------------------------------- */}
        {/* Starts past the rail rather than centred on the stage: centred, its
            left end sat under the tool panel on any map narrower than ~1100px. */}
        <div className="pointer-events-none absolute bottom-0 left-3 right-0 z-30 p-3 sm:left-[236px]">
          <div className="glass-dark pointer-events-auto mx-auto w-[min(660px,100%)] overflow-hidden rounded-[var(--radius-lg)]">
            <div className="flex items-center gap-1 px-4 pb-2 pt-2.5">
              <Measure {...measure.primary} />
              <Measure {...measure.second} />
              <Measure {...measure.third} />
              <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                <span className="font-mono text-[10px] tracking-[0.12em] text-white/40" aria-live="polite">
                  {saving ? "SAVING" : pinning ? "PLACING" : `NEXT ${nextLot}`}
                </span>
                {canCancel && (
                  <button
                    onClick={cancelCurrent}
                    className={cx(
                      "inline-flex h-8 items-center rounded-[var(--radius-sm)] px-2.5 text-[12.5px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white",
                      FOCUS_DARK
                    )}
                  >
                    {reshape ? "Cancel" : "Discard"}
                  </button>
                )}
                <button
                  onClick={finishCurrent}
                  disabled={!primaryAction.enabled}
                  className={cx(
                    "inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-4 text-[12.5px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-35",
                    FOCUS_DARK
                  )}
                >
                  {primaryAction.label}
                </button>
              </div>
            </div>

            {/* The rule between measurement and guidance is a live scale bar —
                the ticks are ground distance at this zoom, not decoration. */}
            <Ruler px={scale.px} label={scale.label} />

            <div className="flex items-center gap-3 px-4 py-2">
              <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-white/85">{hint}</p>
              <span className="hidden shrink-0 items-center gap-1 sm:flex">
                <Key>⏎</Key>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">finish</span>
                <Key>esc</Key>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">discard</span>
                <Key>⌘Z</Key>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">undo</span>
              </span>
            </div>
          </div>
        </div>

        {!ready && (
          <div className="contour-field absolute inset-0 z-50 grid place-items-center">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/45">
              Bringing the map up…
            </span>
          </div>
        )}
      </div>

      {/* ---- Lot list ------------------------------------------------------- */}
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel shadow-[var(--shadow-card)]">
        <header className="flex items-end justify-between gap-3 border-b border-line-2 px-4 py-3">
          <div>
            <Eyebrow>Drawn here</Eyebrow>
            <div className="mt-1.5 font-mono text-[22px] font-medium leading-none tracking-[-0.03em] text-ink tabular-nums">
              {drawnLots.length}
            </div>
          </div>
          <div className="text-right">
            <Eyebrow>Next number</Eyebrow>
            <div className="mt-1.5 font-mono text-[22px] font-medium leading-none tracking-[-0.03em] text-brass-ink tabular-nums">
              {nextLot}
            </div>
          </div>
        </header>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {/* Before the first lot exists, the rail's job is to teach the tool —
              not to inventory lots the operator didn't come here to look at. */}
          {drawnLots.length === 0 ? <StartGuide /> : renderRows(drawnLots)}

          {/* The development's existing lots: real, reachable, deliberately quiet.
              They are context for tracing and snapping, not the task at hand. */}
          {existingLots.length > 0 && (
            <div className="border-t border-line-2">
              <button
                onClick={() => setShowExisting((v) => !v)}
                aria-expanded={showExisting}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition hover:bg-panel-2/70"
              >
                <svg
                  viewBox="0 0 16 16"
                  className={cx("h-3 w-3 shrink-0 text-faint transition-transform", showExisting && "rotate-90")}
                  fill="none"
                  aria-hidden="true"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="flex-1 text-[12px] text-graphite">
                  <span className="font-mono tabular-nums text-ink">{existingLots.length}</span> lots already in
                  this development
                </span>
              </button>
              {showExisting && renderRows(existingLots)}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line-2 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            {reshape ? "Reshaping" : saving ? "Saving" : "Saved"}
          </span>
          <button
            onClick={undoLast}
            disabled={!undoTop}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-[12px] font-medium text-graphite transition hover:bg-panel-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
              <path d="M3 8h7a3 3 0 0 1 0 6H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M5.5 5 2.8 8l2.7 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {undoTop ? `Undo ${undoTop.label}` : "Nothing to undo"}
            <kbd className="rounded-[4px] border border-line px-1 font-mono text-[9px] leading-[14px] text-faint">⌘Z</kbd>
          </button>
        </footer>
      </aside>
    </div>
  );
}

/* ---- Local pieces ---------------------------------------------------------- */

// What the rail shows before the operator has drawn anything. The old rail
// opened on 82 existing lots, which answered a question nobody had asked and
// buried the only sentence that mattered ("click the corners") in 9px at the
// bottom of the map. Three steps, in the order you actually do them.
const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "Pick a tool",
    body: "Draw a lot traces corners one at a time. The other three are shortcuts for when a whole row is the same shape.",
  },
  {
    n: "2",
    title: "Click the corners",
    body: "Acreage and perimeter tick up under the map as you go. Corners snap to nearby lots — hold Alt to place one freely.",
  },
  {
    n: "3",
    title: "Close the shape",
    body: "Click your first corner again. The lot saves itself, takes the next number, and appears in this list.",
  },
];

function StartGuide() {
  return (
    <div className="px-4 py-4">
      <Eyebrow>How this works</Eyebrow>
      <ol className="mt-3 flex flex-col gap-3.5">
        {STEPS.map((s) => (
          <li key={s.n} className="flex gap-2.5">
            <span
              className="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-brass/45 font-mono text-[10px] font-medium leading-none text-brass-ink"
              aria-hidden="true"
            >
              {s.n}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium leading-tight tracking-[-0.01em] text-ink">{s.title}</div>
              <p className="mt-1 text-[11.5px] leading-[1.45] text-graphite">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line-2 pt-3 text-[11px] leading-[1.45] text-faint">
        Nothing here is public until you publish. Every lot lands in the draft, so you can undo,
        reshape or delete any of it first.
      </p>
    </div>
  );
}



function Measure({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex min-w-[68px] flex-col gap-[3px] pr-3">
      <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-white/35">{label}</span>
      <span className="font-mono text-[17px] font-medium leading-none tracking-[-0.03em] text-white tabular-nums">
        {value}
        {unit && <span className="ml-1 text-[10px] font-normal tracking-normal text-white/40">{unit}</span>}
      </span>
    </div>
  );
}

/**
 * The scale ruler. Majors at the labelled interval, minors at a fifth of it —
 * so the bar reads as a rule, and the numbers above it read as measurements
 * taken with one.
 */
function Ruler({ px, label }: { px: number; label: string }) {
  const step = Math.max(12, px);
  return (
    <div
      className="relative h-[13px] border-y border-white/10"
      aria-hidden="true"
      style={{
        backgroundImage:
          `repeating-linear-gradient(90deg, rgba(255,255,255,0.34) 0 1px, transparent 1px ${step}px),` +
          `repeating-linear-gradient(90deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ${step / 5}px)`,
        backgroundSize: "100% 8px, 100% 4px",
        backgroundPosition: "left bottom, left bottom",
        backgroundRepeat: "no-repeat",
      }}
    >
      <span
        className="absolute right-0 top-1/2 -translate-y-1/2 pl-2 pr-3 font-mono text-[8.5px] uppercase tracking-[0.16em] text-white/40"
        style={{ background: "linear-gradient(90deg, transparent, rgba(12,15,22,0.9) 30%)" }}
      >
        {label}
      </span>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-white/15 px-1 font-mono text-[9px] leading-[15px] text-white/45">
      {children}
    </kbd>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const btn =
    "grid h-6 w-6 place-items-center rounded-[5px] border border-white/15 text-[13px] leading-none text-white/70 transition hover:bg-white/[0.1] hover:text-white disabled:pointer-events-none disabled:opacity-30";
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">{label}</span>
      <div className="flex items-center gap-1.5">
        <button onClick={() => onChange(value - 1)} disabled={value <= min} className={cx(btn, FOCUS_DARK)} aria-label={`One fewer ${label.toLowerCase()}`}>
          −
        </button>
        <span className="w-6 text-center font-mono text-[15px] font-medium text-white tabular-nums">{value}</span>
        <button onClick={() => onChange(value + 1)} disabled={value >= max} className={cx(btn, FOCUS_DARK)} aria-label={`One more ${label.toLowerCase()}`}>
          +
        </button>
      </div>
    </div>
  );
}

function Toggle({
  on,
  label,
  note,
  onClick,
  disabled,
}: {
  on: boolean;
  label: string;
  note?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cx(
        "flex w-full items-center gap-2 rounded-[7px] px-2 py-[5px] text-left transition disabled:pointer-events-none disabled:opacity-40",
        FOCUS_DARK,
        on ? "bg-[rgba(216,178,106,0.14)] text-white" : "text-white/60 hover:bg-white/[0.06] hover:text-white"
      )}
    >
      <span
        className={cx(
          "relative h-[14px] w-[24px] shrink-0 rounded-full border transition",
          on ? "border-[#d8b26a]/70 bg-[#d8b26a]/35" : "border-white/20 bg-white/[0.06]"
        )}
        aria-hidden="true"
      >
        <span
          className={cx(
            "absolute top-[2px] h-[8px] w-[8px] rounded-full transition-all",
            on ? "left-[13px] bg-[#e6c887]" : "left-[2px] bg-white/45"
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium tracking-[-0.01em]">{label}</span>
        {note && <span className="block font-mono text-[9px] uppercase tracking-[0.12em] text-white/35">{note}</span>}
      </span>
    </button>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid h-6 w-6 place-items-center rounded-[6px] text-faint transition hover:bg-panel-2 hover:text-ink"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
