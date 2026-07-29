"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Layer, ShapeStyle } from "@/lib/types";
import { setShapeData, setShapeStyle } from "@/lib/mapLayers";
import { type Pt } from "@/lib/layers";
import {
  shapeGeometry,
  shapePoints,
  isClosed,
  minPoints,
  moveVertex,
  insertVertex,
  removeVertex,
  segmentMidpoints,
  translatePoints,
  simplify,
  endsWhereItStarted,
  lngLatBbox,
  fullShapeStyle,
  SHAPE_PRESETS,
  MIN_AREA_POINTS,
  MIN_LINE_POINTS,
  type LngLat,
  type ShapeTool,
} from "@/lib/shapes";
import { useEditorMap } from "@/components/useEditorMap";
import { jsend } from "@/lib/client";
import { cx } from "@/components/ui";

/**
 * Draw and edit a shape layer — the fallback for a pond, a river or a green when
 * there's no site-plan render to pin. Runs on the same flat camera as the image
 * editor (see `useEditorMap`), for the same reason: an unprojected pointer has
 * to land exactly on the thing the operator is tracing.
 *
 * Two phases, one open vertex list (`shapes.ts` owns the geometry):
 *  • **Draw** — putting points down. Area and Line click vertex by vertex;
 *    Freehand captures a drag. Nothing exists server-side yet.
 *  • **Edit** — the row exists and renders through the real overlay pipeline, so
 *    what's on screen is literally what a visitor gets. Vertices drag, midpoints
 *    add, the body moves.
 *
 * **Why a shape is created only once it's drawn**, inverting the image flow
 * (which uploads first so a long alignment session can't lose the file): the
 * create API requires valid geometry, and there's nothing to lose before the
 * first few clicks anyway. An abandoned draw leaves no row behind.
 */

type Phase = "draw" | "edit";

type Drag =
  | { kind: "vertex"; index: number }
  | { kind: "body"; startMerc: Pt; startPoints: LngLat[] };

// Grips are 14px like the image editor's, and drags listen on `window` for the
// same reason documented there: the pointer leaves a grip that small instantly,
// so anything scoped to the handle stops receiving moves the moment a drag
// actually starts.
const GRIP = 7;

export default function ShapeEditor({
  slug,
  layer,
  tool,
  onCreated,
  onSaved,
  onDone,
  className,
}: {
  slug: string;
  /** An existing shape row, or null to draw a new one. */
  layer: Layer | null;
  /** Input mode for a new shape. Ignored when `layer` is given. */
  tool: ShapeTool;
  onCreated: (l: Layer) => void;
  onSaved: (l: Layer) => void;
  onDone: () => void;
  className?: string;
}) {
  const [points, setPoints] = useState<LngLat[]>(() => shapePoints(layer?.geometry));
  const pointsRef = useRef(points);
  const [closed, setClosed] = useState(() =>
    layer ? isClosed(layer.geometry) : tool === "area"
  );
  const closedRef = useRef(closed);
  const [phase, setPhase] = useState<Phase>(layer ? "edit" : "draw");

  // These three mirror their state, written wherever the state is set. Handlers
  // bound once on the map read them, so a gesture in flight always sees the
  // current value without re-binding — and without a stale closure.
  const [style, setStyle] = useState<ShapeStyle>(() => fullShapeStyle(layer?.style));
  const styleRef = useRef(style);

  // The server row. Null until the first finished draw creates it.
  const [row, setRow] = useState<Layer | null>(layer);
  const rowRef = useRef(row);

  const [screen, setScreen] = useState<[number, number][]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const draggingRef = useRef(false);

  /** The edited layer as it stands right now — what the map should be drawing. */
  const liveRow = useCallback((): Layer | null => {
    const r = rowRef.current;
    if (!r) return null;
    const g = shapeGeometry(pointsRef.current, closedRef.current);
    return { ...r, geometry: g ?? r.geometry, style: styleRef.current };
  }, []);

  const {
    containerRef,
    mapRef,
    ready,
    error: mapError,
    pointerMerc,
    pointerLngLat,
    resync,
    frame,
  } = useEditorMap({
    slug,
    editKey: layer?.id ?? "new",
    initialBbox: () => lngLatBbox(pointsRef.current),
    liveLayer: liveRow,
  });

  const error = saveError ?? mapError;

  /**
   * Update the working vertex list and push it to the map in one step. The live
   * path mutates the existing source (`setShapeData`); it falls back to a full
   * `resync` only when the geometry changed type, which a fill layer can't
   * render as a line.
   */
  const setPointsBoth = useCallback(
    (next: LngLat[]) => {
      pointsRef.current = next;
      setPoints(next);
      const map = mapRef.current;
      const r = rowRef.current;
      if (!map || !r) return;
      const g = shapeGeometry(next, closedRef.current);
      if (!g) return;
      if (!setShapeData(map, r, g)) resync(liveRow());
    },
    [mapRef, resync, liveRow]
  );

  // ---- Screen projection ----------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const paint = () => {
      setScreen(
        pointsRef.current.map((p) => {
          const pt = map.project(p);
          return [pt.x, pt.y] as [number, number];
        })
      );
    };
    paint();
    map.on("render", paint);
    return () => {
      map.off("render", paint);
    };
  }, [mapRef, ready, points]);

  // ---- Drawing: click to place, drag to sketch ------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || phase !== "draw") return;

    const freehand = !layer && tool === "freehand";

    // Freehand owns the drag gesture, so panning has to yield while it's armed.
    // Wheel zoom and the nav control still work, and the moment the stroke ends
    // we're in edit phase and pan comes back.
    if (freehand) map.dragPan.disable();

    const onClick = (e: mapboxgl.MapMouseEvent) => {
      if (freehand) return;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      // Clicking the first vertex closes an area — the standard way to finish a
      // ring, and the only one that doesn't need the command bar.
      const first = pointsRef.current[0];
      if (closedRef.current && first && pointsRef.current.length >= MIN_AREA_POINTS) {
        const a = map.project(first);
        const b = map.project(p);
        if (Math.hypot(a.x - b.x, a.y - b.y) <= 12) {
          void finish();
          return;
        }
      }
      pointsRef.current = [...pointsRef.current, p];
      setPoints(pointsRef.current);
    };

    const onMove = (e: mapboxgl.MapMouseEvent) => {
      if (freehand) return;
      setCursor([e.point.x, e.point.y]);
    };

    const onDouble = (e: mapboxgl.MapMouseEvent) => {
      if (freehand) return;
      // The dblclick lands on top of the second click, which already added its
      // vertex — so finish with what we have rather than adding another.
      e.preventDefault();
      void finish();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        pointsRef.current = pointsRef.current.slice(0, -1);
        setPoints(pointsRef.current);
      } else if (e.key === "Escape") {
        e.preventDefault();
        pointsRef.current = [];
        setPoints([]);
      }
    };

    /** Freehand: one sample per pointer event, simplified on release. */
    const onPointerDown = (ev: PointerEvent) => {
      if (!freehand || ev.button !== 0) return;
      const el = containerRef.current;
      if (!el || !(ev.target instanceof Node) || !el.contains(ev.target)) return;
      ev.preventDefault();

      const rect = el.getBoundingClientRect();
      const raw: Pt[] = [[ev.clientX - rect.left, ev.clientY - rect.top]];
      draggingRef.current = true;

      const move = (m: PointerEvent) => {
        raw.push([m.clientX - rect.left, m.clientY - rect.top]);
        // Preview the raw stroke; simplification happens once, at the end.
        pointsRef.current = raw.map((p) => {
          const ll = map.unproject(p);
          return [ll.lng, ll.lat] as LngLat;
        });
        setPoints(pointsRef.current);
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        draggingRef.current = false;

        // 2px: below what a hand can hold steady, so this only ever removes
        // tremor, never a curve the operator meant.
        const kept = simplify(raw, 2);
        const loop = endsWhereItStarted(raw);
        closedRef.current = loop;
        setClosed(loop);
        pointsRef.current = kept.map((p) => {
          const ll = map.unproject(p);
          return [ll.lng, ll.lat] as LngLat;
        });
        setPoints(pointsRef.current);
        void finish();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("dblclick", onDouble);
    map.doubleClickZoom.disable();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);

    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("dblclick", onDouble);
      map.doubleClickZoom.enable();
      if (freehand) map.dragPan.enable();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
    // `finish` is stable enough for this effect's lifetime (it reads everything
    // it needs from refs); re-binding map handlers on every render would drop
    // clicks mid-gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, containerRef, ready, phase, tool, layer]);

  // ---- Editing: vertex, midpoint and body drags -----------------------------

  function beginDrag(e: React.PointerEvent, drag: Drag) {
    e.preventDefault();
    e.stopPropagation();

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      if (drag.kind === "vertex") {
        const ll = pointerLngLat(ev);
        if (ll) setPointsBoth(moveVertex(pointsRef.current, drag.index, ll));
      } else {
        const p = pointerMerc(ev);
        if (!p) return;
        setPointsBoth(
          translatePoints(drag.startPoints, p[0] - drag.startMerc[0], p[1] - drag.startMerc[1])
        );
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      void saveGeometry();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onBodyDown(e: React.PointerEvent) {
    const p = pointerMerc(e);
    if (!p) return;
    beginDrag(e, { kind: "body", startMerc: p, startPoints: pointsRef.current });
  }

  /**
   * A midpoint grip inserts its vertex and hands the drag straight to it. The
   * new vertex lands under the pointer rather than at the exact midpoint —
   * they're within a few pixels, and using the pointer means the shape doesn't
   * twitch on grab.
   */
  function beginMidpointDrag(e: React.PointerEvent, index: number) {
    const at = pointerLngLat(e);
    if (!at) return;
    setPointsBoth(insertVertex(pointsRef.current, index, at));
    setSelected(index);
    beginDrag(e, { kind: "vertex", index });
  }

  function dropVertex(i: number) {
    const next = removeVertex(pointsRef.current, i, closedRef.current);
    if (!next) {
      setSaveError(
        closedRef.current
          ? `An area needs at least ${MIN_AREA_POINTS} points.`
          : `A line needs at least ${MIN_LINE_POINTS} points.`
      );
      return;
    }
    setSaveError(null);
    setSelected(null);
    setPointsBoth(next);
    void saveGeometry();
  }

  // ---- Persistence ----------------------------------------------------------

  /** First finished draw: create the row. Afterwards: patch geometry. */
  async function finish() {
    const g = shapeGeometry(pointsRef.current, closedRef.current);
    if (!g) return; // Not enough points yet — keep drawing.

    if (rowRef.current) {
      setPhase("edit");
      await saveGeometry();
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const created = await jsend<Layer>(`/api/dev/${slug}/layers`, "POST", {
        kind: "shape",
        name: closedRef.current ? "Area" : "Line",
        geometry: g,
        style: styleRef.current,
      });
      rowRef.current = created;
      setRow(created);
      setPhase("edit");
      setDirty(false);
      onCreated(created);
      // Hand the shape to the real overlay pipeline, so from here on the
      // operator is looking at exactly what the embed will draw.
      resync({ ...created, geometry: g, style: styleRef.current });
    } catch (err) {
      setDirty(true);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveGeometry() {
    const r = rowRef.current;
    const g = shapeGeometry(pointsRef.current, closedRef.current);
    if (!r || !g) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await jsend<Layer>(`/api/layer/${r.id}`, "PATCH", { geometry: g });
      const merged = updated ?? { ...r, geometry: g };
      rowRef.current = merged;
      setRow(merged);
      setDirty(false);
      onSaved(merged);
    } catch (err) {
      setDirty(true);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** Style is previewed live and written on release, like the opacity slider. */
  function previewStyle(patch: Partial<ShapeStyle>) {
    const next = { ...styleRef.current, ...patch };
    styleRef.current = next;
    setStyle(next);
    const map = mapRef.current;
    const r = rowRef.current;
    if (map && r) setShapeStyle(map, r, next);
  }

  function commitStyle() {
    const r = rowRef.current;
    if (!r) return;
    jsend<Layer>(`/api/layer/${r.id}`, "PATCH", { style: styleRef.current })
      .then((l) => {
        const merged = l ?? { ...r, style: styleRef.current };
        rowRef.current = merged;
        setRow(merged);
        onSaved(merged);
      })
      .catch((err) => setSaveError(err instanceof Error ? err.message : String(err)));
  }

  function startOver() {
    pointsRef.current = [];
    setPoints([]);
    setSelected(null);
    setCursor(null);
    setPhase("draw");
  }

  function zoomToShape() {
    const bbox = lngLatBbox(pointsRef.current);
    if (bbox) frame(bbox);
  }

  // ---- Render ---------------------------------------------------------------

  const enough = points.length >= minPoints(closed);
  // Straight off the already-projected vertices — exact on this flat, north-up
  // camera, and it keeps the map out of the render pass entirely.
  const mids = phase === "edit" && enough ? segmentMidpoints(screen, closed) : [];

  // While drawing, the shape isn't a real layer yet, so the SVG *is* the
  // preview. In edit phase the map draws the fill/line and the SVG carries only
  // the outline and the grips.
  const outline = screen.map((p) => p.join(",")).join(" ");
  const band =
    phase === "draw" && cursor && screen.length
      ? `${screen[screen.length - 1].join(",")} ${cursor.join(",")}`
      : null;

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]",
        className
      )}
    >
      <div
        ref={containerRef}
        className={cx("absolute inset-0 h-full w-full", phase === "draw" && "cursor-crosshair")}
      />

      {ready && screen.length > 0 && (
        <svg
          className="absolute inset-0 z-20 h-full w-full"
          style={{ pointerEvents: "none", touchAction: "none" }}
        >
          {/* Body-drag target. Invisible and separate from the outline below:
              a stroke you can comfortably grab is ~14px, which is nothing like
              the 1.5px hairline the outline should be. */}
          {phase === "edit" &&
            (closed ? (
              <polygon
                points={outline}
                fill="transparent"
                style={{ pointerEvents: "fill", cursor: "move" }}
                onPointerDown={onBodyDown}
              />
            ) : (
              <polyline
                points={outline}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: "stroke", cursor: "move" }}
                onPointerDown={onBodyDown}
              />
            ))}

          {/* While drawing there's no map layer yet, so this preview *is* the
              shape; in edit mode the map draws it for real and this is just the
              selection outline over the top. */}
          {phase === "draw" && closed && screen.length >= 3 && (
            <polygon points={outline} fill={style.color} fillOpacity={style.fillOpacity * 0.6} />
          )}
          {closed && phase === "edit" ? (
            <polygon
              points={outline}
              fill="none"
              stroke="#ffffff"
              strokeWidth={1.5}
              strokeDasharray="6 5"
            />
          ) : (
            <polyline
              points={outline}
              fill="none"
              stroke={phase === "draw" ? style.color : "#ffffff"}
              strokeWidth={phase === "draw" ? 2.5 : 1.5}
              strokeDasharray={phase === "draw" ? undefined : "6 5"}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {band && (
            <polyline
              points={band}
              fill="none"
              stroke={style.color}
              strokeWidth={2}
              strokeDasharray="4 4"
              strokeOpacity={0.8}
            />
          )}
        </svg>
      )}

      {/* Grips ride above the floating chrome for the reason documented in
          LayerEditor: a grip behind the command bar is a grip you can't grab. */}
      {ready && (
        <svg
          className="absolute inset-0 z-40 h-full w-full"
          style={{ pointerEvents: "none", touchAction: "none" }}
        >
          {mids.map((m) => (
            <circle
              key={`m${m.index}`}
              cx={m.point[0]}
              cy={m.point[1]}
              r={4.5}
              fill="#0c0f16"
              fillOpacity={0.55}
              stroke="#ffffff"
              strokeWidth={1.5}
              style={{ pointerEvents: "all", cursor: "copy" }}
              onPointerDown={(e) => beginMidpointDrag(e, m.index)}
            >
              <title>Drag to add a point</title>
            </circle>
          ))}
          {screen.map((p, i) => (
            <rect
              key={i}
              x={p[0] - GRIP}
              y={p[1] - GRIP}
              width={GRIP * 2}
              height={GRIP * 2}
              rx={GRIP}
              fill={selected === i ? "#d8b26a" : "#ffffff"}
              stroke="#0c0f16"
              strokeWidth={1.5}
              style={{
                pointerEvents: phase === "edit" ? "all" : "none",
                cursor: "grab",
              }}
              onPointerDown={(e) => {
                if (phase !== "edit") return;
                setSelected(i);
                // Alt-click removes, matching the shortcut every map editor uses;
                // the command bar carries the discoverable version.
                if (e.altKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  dropVertex(i);
                  return;
                }
                beginDrag(e, { kind: "vertex", index: i });
              }}
            />
          ))}
        </svg>
      )}

      <div className="pointer-events-none absolute left-4 top-4 z-30 max-w-[320px]">
        <span className="glass-dark block rounded-[var(--radius-sm)] px-3.5 py-2 text-[12px] leading-snug text-white/70">
          {phase === "draw" ? (
            tool === "freehand" ? (
              <>
                Drag to sketch. <strong className="text-white/90">End near where you started</strong>{" "}
                and it closes into a filled area — otherwise it stays a line. Panning is off while
                you sketch; zoom still works.
              </>
            ) : closed ? (
              <>
                Click to drop points around the edge. Close it by{" "}
                <strong className="text-white/90">clicking the first point</strong>, double-clicking,
                or pressing Enter. Backspace undoes the last point.
              </>
            ) : (
              <>
                Click along the route — a river, a trail.{" "}
                <strong className="text-white/90">Double-click or press Enter</strong> to finish.
                Backspace undoes the last point.
              </>
            )
          ) : (
            <>
              Drag a point to move it, a hollow midpoint to add one, the shape itself to slide the
              whole thing. <strong className="text-white/90">Alt-click a point to remove it.</strong>
            </>
          )}
        </span>
      </div>

      {error && (
        <div className="glass-dark pop-in pointer-events-none absolute left-4 top-24 z-30 max-w-sm rounded-[var(--radius)] px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">
            {mapError ? "Couldn't load" : "Couldn't save"}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
        </div>
      )}

      {/* Command bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-4">
        <div className="glass-dark pointer-events-auto mx-auto flex max-w-[900px] flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
              Color
            </span>
            {SHAPE_PRESETS.map((p) => (
              <button
                key={p.color}
                onClick={() => {
                  previewStyle({ color: p.color });
                  commitStyle();
                }}
                aria-label={p.label}
                title={p.label}
                className={cx(
                  "h-5 w-5 rounded-full border transition",
                  style.color.toLowerCase() === p.color.toLowerCase()
                    ? "border-white ring-2 ring-white/30"
                    : "border-white/25 hover:border-white/60"
                )}
                style={{ background: p.color }}
              />
            ))}
            <input
              type="color"
              value={style.color.slice(0, 7)}
              onChange={(e) => previewStyle({ color: e.target.value })}
              onBlur={commitStyle}
              aria-label="Custom color"
              className="h-5 w-5 cursor-pointer rounded-full border border-white/25 bg-transparent p-0"
            />
          </div>

          {closed ? (
            <label className="flex min-w-[130px] flex-1 items-center gap-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                Fill
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={style.fillOpacity}
                onChange={(e) => previewStyle({ fillOpacity: Number(e.target.value) })}
                onPointerUp={commitStyle}
                onKeyUp={commitStyle}
                className="h-1 flex-1 accent-[#d8b26a]"
                aria-label="Fill opacity"
              />
              <span className="w-9 shrink-0 text-right font-mono text-[11px] text-white/70 tabular-nums">
                {Math.round(style.fillOpacity * 100)}%
              </span>
            </label>
          ) : (
            <label className="flex min-w-[130px] flex-1 items-center gap-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                Width
              </span>
              <input
                type="range"
                min={1}
                max={40}
                step={1}
                value={style.width}
                onChange={(e) => previewStyle({ width: Number(e.target.value) })}
                onPointerUp={commitStyle}
                onKeyUp={commitStyle}
                className="h-1 flex-1 accent-[#d8b26a]"
                aria-label="Line width"
              />
              <span className="w-9 shrink-0 text-right font-mono text-[11px] text-white/70 tabular-nums">
                {style.width}px
              </span>
            </label>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <span className="font-mono text-[11px] tracking-[0.1em] text-white/45" aria-live="polite">
              {saving ? "SAVING" : dirty ? "UNSAVED" : row ? "SAVED" : `${points.length} POINTS`}
            </span>

            {phase === "edit" && selected != null && (
              <button
                onClick={() => dropVertex(selected)}
                className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
              >
                Remove point
              </button>
            )}

            {phase === "draw" ? (
              <>
                <button
                  onClick={startOver}
                  disabled={points.length === 0}
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-40"
                >
                  Clear
                </button>
                <button
                  onClick={() => void finish()}
                  disabled={!enough || saving}
                  className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
                >
                  {closed ? "Close area" : "Finish line"}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={startOver}
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
                >
                  Redraw
                </button>
                <button
                  onClick={zoomToShape}
                  disabled={!ready}
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-40"
                >
                  Zoom to shape
                </button>
                <button
                  onClick={onDone}
                  className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
