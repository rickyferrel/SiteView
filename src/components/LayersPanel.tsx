"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Layer, Corners } from "@/lib/types";
import { jget, jsend } from "@/lib/client";
import { assetUrl } from "@/lib/mapLayers";
import { toMerc, rectForAspect, cornersFromRect, type Pt } from "@/lib/layers";
import { featureCollectionBbox, isClosed, fullShapeStyle, type ShapeTool } from "@/lib/shapes";
import { prepareLayerImage, ImageTooLargeError, mb } from "@/lib/image";
import { LAYER_IMAGE_MIMES } from "@/lib/const";
import LayerEditor from "@/components/LayerEditor";
import ShapeEditor from "@/components/ShapeEditor";
import { Section, Button, Eyebrow, SaveState, EmptyState, Skeleton, fieldClass, cx } from "@/components/ui";

/**
 * The Map Design surface for non-parcel map features: a developer's site-plan
 * render pinned onto the map, or a drawn shape standing in for a river or a
 * pond when there's no render to pin. Lives here rather than on its own nav page
 * because it's part of how the map *looks*, alongside basemap and opening view.
 *
 * The two creation flows are deliberately mirror images:
 *  • **Image** — uploaded and created up front, then positioned, so a long
 *    alignment session can't lose the file.
 *  • **Shape** — created only once it's been drawn, because the API needs valid
 *    geometry to store and an abandoned sketch should leave nothing behind.
 */

type Phase = "idle" | "saving" | "saved";

export default function LayersPanel({ slug }: { slug: string }) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | null>(null);
  // Set while a brand-new shape is being drawn — there's no row to point at yet.
  const [drawing, setDrawing] = useState<ShapeTool | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLayers(await jget<Layer[]>(`/api/dev/${slug}/layers`));
    setLoaded(true);
  }, [slug]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await load();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const mark = useCallback(() => {
    setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
    setPhase("saved");
  }, []);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setPhase("saving");
      setError(null);
      try {
        await fn();
        mark();
      } catch (e) {
        setPhase("idle");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [mark]
  );

  /** Optimistic row patch + PATCH, so sliders and switches feel immediate. */
  function patch(id: string, body: Partial<Layer>) {
    setLayers((cur) => cur.map((l) => (l.id === id ? { ...l, ...body } : l)));
    void run(async () => {
      await jsend(`/api/layer/${id}`, "PATCH", body);
    });
  }

  // ---- Upload ---------------------------------------------------------------

  async function onFile(file: File) {
    setError(null);
    setBusy("Reading image…");
    try {
      const prepared = await prepareLayerImage(file);
      setBusy("Uploading…");
      const corners = await framingCorners(slug, prepared.width / prepared.height);
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
      setLayers((cur) => [...cur, layer]);
      setEditing(layer.id);
      mark();
      if (prepared.reduced) {
        setError(
          `Resized for upload: ${mb(prepared.originalBytes)} MB → ${mb(prepared.bytes)} MB ` +
            `(${prepared.width}×${prepared.height}).`
        );
      }
    } catch (e) {
      setError(
        e instanceof ImageTooLargeError ? e.message : e instanceof Error ? e.message : String(e)
      );
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // ---- Reorder --------------------------------------------------------------

  function onDrop(targetId: string) {
    const from = layers.findIndex((l) => l.id === dragId);
    const to = layers.findIndex((l) => l.id === targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...layers];
    next.splice(to, 0, next.splice(from, 1)[0]);
    commitOrder(next);
  }

  function nudge(id: string, dir: -1 | 1) {
    const i = layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layers.length) return;
    const next = [...layers];
    [next[i], next[j]] = [next[j], next[i]];
    commitOrder(next);
  }

  function commitOrder(next: Layer[]) {
    setLayers(next.map((l, i) => ({ ...l, sort_order: i + 1 })));
    void run(async () => {
      await jsend(`/api/layer/reorder`, "POST", { slug, ids: next.map((l) => l.id) });
    });
  }

  const merge = (l: Layer) =>
    setLayers((cur) => cur.map((x) => (x.id === l.id ? { ...x, ...l } : x)));

  const edited = layers.find((l) => l.id === editing);

  if (edited?.kind === "image" && edited.corners) {
    return (
      <Section
        title={`Positioning · ${edited.name}`}
        hint="Line the render up with the satellite imagery. Saved as you go."
      >
        <LayerEditor
          slug={slug}
          layer={edited}
          className="h-[560px] w-full"
          onSaved={merge}
          onDone={() => setEditing(null)}
        />
      </Section>
    );
  }

  if (drawing || edited?.kind === "shape") {
    const shape = edited?.kind === "shape" ? edited : null;
    return (
      <Section
        title={shape ? `Editing · ${shape.name}` : "Drawing a shape"}
        hint={
          shape
            ? "Move points to reshape it. Saved as you go."
            : "Trace the feature over the satellite imagery. It's saved the moment you finish."
        }
      >
        <ShapeEditor
          slug={slug}
          layer={shape}
          tool={drawing ?? (shape && isClosed(shape.geometry) ? "area" : "line")}
          className="h-[560px] w-full"
          onCreated={(l) => {
            // Deliberately leaves `drawing` set: the editor tracks the new row
            // itself, and swapping to the edit path here would change its
            // `editKey` and rebuild the map out from under the operator the
            // instant they finished drawing.
            setLayers((cur) => [...cur, l]);
            mark();
          }}
          onSaved={merge}
          onDone={() => {
            setDrawing(null);
            setEditing(null);
          }}
        />
      </Section>
    );
  }

  return (
    <Section
      title="Map layers"
      hint="Pin a site-plan render onto the map so the golf course, river and parks show without being drawn as lots — or draw the feature yourself when there's no render. Applies on next preview / publish."
      action={
        <div className="flex items-center gap-3">
          <SaveState state={phase} at={savedAt} />
          <DrawMenu onPick={setDrawing} />
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy ?? "Add image layer"}
          </Button>
        </div>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept={[...LAYER_IMAGE_MIMES, "image/*"].join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />

      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] border border-line bg-panel-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-graphite">
          {error}
        </div>
      )}

      {!loaded ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-[var(--radius-sm)]" />
          ))}
        </div>
      ) : layers.length === 0 ? (
        <EmptyState
          title="No layers yet"
          hint="Upload the developer's site-plan render and pin it to the map. Everything on it — trees, streets, the river, the clubhouse — comes along without being rebuilt as parcel geometry. No render? Draw the pond or the river straight onto the map instead."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="brass" size="sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                {busy ?? "Add image layer"}
              </Button>
              <DrawMenu onPick={setDrawing} />
            </div>
          }
        />
      ) : (
        <>
          {/* Highest sort_order paints last, so show the stack top-down the way
              it reads on the map. */}
          <div className="space-y-2">
            {[...layers].reverse().map((l, revIdx) => {
              const idx = layers.length - 1 - revIdx;
              return (
                <div
                  key={l.id}
                  draggable
                  onDragStart={() => setDragId(l.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(l.id)}
                  onDragEnd={() => setDragId(null)}
                  className={cx(
                    "rounded-[var(--radius-sm)] border border-line bg-panel px-3 py-2.5 transition",
                    "hover:border-[color:var(--color-panel-3)]",
                    dragId === l.id && "opacity-50"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className="cursor-grab select-none font-mono text-[13px] leading-none text-faint"
                      aria-hidden="true"
                      title="Drag to reorder"
                    >
                      ⠿
                    </span>

                    {l.kind === "image" && l.asset_id ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={assetUrl(l.asset_id)}
                        alt=""
                        className="h-11 w-11 shrink-0 rounded-[6px] border border-line object-cover"
                      />
                    ) : (
                      <ShapeSwatch layer={l} />
                    )}

                    <input
                      defaultValue={l.name}
                      onBlur={(e) => e.target.value !== l.name && patch(l.id, { name: e.target.value })}
                      className={fieldClass("!h-8 min-w-[9rem] flex-1 font-medium")}
                      aria-label="Layer name"
                    />

                    <IconButton
                      label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                      onClick={() => patch(l.id, { visible: !l.visible })}
                      active={l.visible}
                    >
                      {l.visible ? <EyeIcon /> : <EyeOffIcon />}
                    </IconButton>

                    <div className="flex flex-col">
                      <ArrowButton label="Move up" disabled={idx === layers.length - 1} onClick={() => nudge(l.id, 1)} up />
                      <ArrowButton label="Move down" disabled={idx === 0} onClick={() => nudge(l.id, -1)} />
                    </div>

                    {l.kind === "image"
                      ? l.corners && (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(l.id)}>
                            Position
                          </Button>
                        )
                      : l.geometry && (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(l.id)}>
                            Edit shape
                          </Button>
                        )}

                    <DeleteLayerButton
                      name={l.name}
                      onConfirm={() =>
                        run(async () => {
                          await jsend(`/api/layer/${l.id}`, "DELETE");
                          setLayers((cur) => cur.filter((x) => x.id !== l.id));
                        })
                      }
                    />
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-line-2 pt-2.5">
                    <OpacitySlider value={l.opacity} onCommit={(v) => patch(l.id, { opacity: v })} />

                    <Segmented
                      value={l.above_lots ? "above" : "below"}
                      onChange={(v) => patch(l.id, { above_lots: v === "above" })}
                      options={[
                        { value: "below", label: "Under lots" },
                        { value: "above", label: "Over lots" },
                      ]}
                    />

                    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-graphite">
                      <input
                        type="checkbox"
                        checked={l.visitor_toggle}
                        onChange={(e) => patch(l.id, { visitor_toggle: e.target.checked })}
                        className="h-4 w-4 accent-[color:var(--color-ink)]"
                      />
                      visitors can toggle
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-faint">
            <strong className="font-medium text-graphite">Under lots</strong> puts the render beneath
            the parcels — the usual choice for a site plan the lots sit on.{" "}
            <strong className="font-medium text-graphite">Over lots</strong> covers the lot fills but
            still lets lot numbers read on top.
          </p>
        </>
      )}
    </Section>
  );
}

/* ---- Initial placement --------------------------------------------------- */

/**
 * Where a freshly uploaded render lands: centered on the lot cluster and sized
 * to contain it, at the image's own aspect so nothing is stretched. That puts it
 * on screen and roughly right, which is a far better starting point for nudging
 * than the middle of the current viewport. Falls back to a ~1 km box on the
 * development's opening view when there are no lots yet.
 */
async function framingCorners(slug: string, aspect: number): Promise<Corners> {
  let center: Pt | null = null;
  let halfW = 0;
  let halfH = 0;

  try {
    const fc = await jget<GeoJSON.FeatureCollection>(`/api/dev/${slug}/parcels?state=draft`);
    const bbox = featureCollectionBbox(fc);
    if (bbox) {
      // toMerc is monotonic in both axes, so the lng/lat bbox corners map
      // straight onto the mercator ones — note north is the *smaller* merc y.
      const [w, s, e, n] = bbox;
      const min = toMerc([w, n]);
      const max = toMerc([e, s]);
      center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
      // A touch of margin so the render's own border isn't clipped by the lots.
      halfW = ((max[0] - min[0]) / 2) * 1.15;
      halfH = ((max[1] - min[1]) / 2) * 1.15;
    }
  } catch {
    /* fall through to the opening-view fallback */
  }

  if (!center) {
    const cfg = await jget<{ development: { default_view: { center: [number, number] } } }>(
      `/api/dev/${slug}/config?state=draft`
    );
    center = toMerc(cfg.development.default_view.center);
    halfW = halfH = 0.005 / 360; // ~500 m of longitude at the equator
  }

  return cornersFromRect(rectForAspect(center, halfW, halfH, aspect));
}

/* ---- Small controls ------------------------------------------------------ */

/** Stands in for the image thumbnail: how this shape reads on the map. */
function ShapeSwatch({ layer }: { layer: Layer }) {
  const style = fullShapeStyle(layer.style);
  const area = isClosed(layer.geometry);
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] border border-line bg-panel-2">
      <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true">
        {area ? (
          <path
            d="M4 9 L12 4 L20 10 L17 19 L7 18 Z"
            fill={style.color}
            fillOpacity={style.fillOpacity}
            stroke={style.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M3 18 C 8 18, 8 7, 13 7 S 19 15, 21 6"
            fill="none"
            stroke={style.color}
            // Echo the real line weight without letting a 40px river fill the chip.
            strokeWidth={Math.max(2, Math.min(7, style.width / 3))}
            strokeLinecap="round"
          />
        )}
      </svg>
    </span>
  );
}

/**
 * "Draw shape" and the three input modes behind it. A menu rather than three
 * buttons because drawing is the fallback path — the image overlay is what
 * operators reach for first, and it shouldn't have to share top billing with
 * three siblings.
 */
function DrawMenu({ onPick }: { onPick: (t: ShapeTool) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const items: { tool: ShapeTool; label: string; hint: string }[] = [
    { tool: "area", label: "Area", hint: "Click corners — a pond, a green, a park" },
    { tool: "line", label: "Line", hint: "Click along a route — a river, a trail" },
    { tool: "freehand", label: "Freehand", hint: "Drag to sketch it in one stroke" },
  ];

  return (
    <div ref={boxRef} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Draw shape
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[248px] overflow-hidden rounded-[var(--radius-sm)] border border-line bg-panel shadow-[var(--shadow-card)]"
        >
          {items.map((it) => (
            <button
              key={it.tool}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(it.tool);
              }}
              className="block w-full px-3.5 py-2.5 text-left transition hover:bg-panel-2"
            >
              <span className="block text-[13px] font-medium text-ink">{it.label}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-faint">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OpacitySlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const v = drag ?? value;
  const commit = () => {
    if (drag != null) {
      onCommit(drag);
      setDrag(null);
    }
  };
  return (
    <label className="flex min-w-[190px] flex-1 items-center gap-2.5">
      <Eyebrow className="!tracking-[0.12em]">Opacity</Eyebrow>
      <input
        type="range"
        min={0.1}
        max={1}
        step={0.05}
        value={v}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="instrument !mt-0 flex-1"
        aria-label="Layer opacity"
      />
      <span className="w-9 font-mono text-[11px] text-faint tabular-nums">{Math.round(v * 100)}%</span>
    </label>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex rounded-[var(--radius-sm)] border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx(
            "h-7 rounded-[6px] px-2.5 text-[12px] font-medium transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
            value === o.value ? "bg-ink text-white" : "text-graphite hover:bg-panel-2"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition",
        "hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
        active ? "text-ink" : "text-faint"
      )}
    >
      {children}
    </button>
  );
}

function ArrowButton({
  label,
  onClick,
  disabled,
  up,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  up?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cx(
        "flex h-3.5 w-5 items-center justify-center text-faint transition",
        "hover:text-ink disabled:pointer-events-none disabled:opacity-25",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15"
      )}
    >
      <svg viewBox="0 0 10 6" className={cx("h-[6px] w-2.5", !up && "rotate-180")} fill="none" aria-hidden="true">
        <path d="M1 5L5 1L9 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function DeleteLayerButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return armed ? (
    <button
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
      className="inline-flex h-7 items-center rounded-[var(--radius-sm)] border border-danger/40 px-2 font-mono text-[11px] tracking-[0.04em] text-danger transition hover:bg-danger/[0.07]"
    >
      confirm
    </button>
  ) : (
    <IconButton label={`Delete ${name}`} onClick={() => setArmed(true)}>
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
        <path
          d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.5 8.3c0 .4.4.7.8.7h3.4c.4 0 .8-.3.8-.7L11 4.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5c1 0 1.9.3 2.7.7M14.5 8s-1.2 2.2-3.3 3.4M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.6 6.7a2 2 0 0 0 2.8 2.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
