"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Layer, Corners, ShapeStyle } from "@/lib/types";
import { jget, jsend } from "@/lib/client";
import { assetUrl } from "@/lib/mapLayers";
import {
  toMerc,
  rectForAspect,
  cornersFromRect,
  shapeKindOf,
  shade,
  shapeInfo,
  MAX_INFO_TITLE,
  MAX_INFO_BODY,
  MAX_INFO_LINK_LABEL,
  type Pt,
  type ShapeKind,
} from "@/lib/layers";
import { prepareLayerImage, ImageTooLargeError, mb } from "@/lib/image";
import { isHttpUrl } from "@/lib/video";
import { LAYER_IMAGE_MIMES } from "@/lib/const";
import LayerEditor from "@/components/LayerEditor";
import ShapeEditor from "@/components/ShapeEditor";
import { Section, Button, Eyebrow, SaveState, EmptyState, Skeleton, Field, fieldClass, cx } from "@/components/ui";

/**
 * The Map Design surface for non-parcel map features: a developer's site-plan
 * render pinned onto the map, or (later) a drawn shape standing in for a river
 * or a pond. Lives here rather than on its own nav page because it's part of how
 * the map *looks*, alongside basemap and opening view.
 *
 * A freshly uploaded image is created on the server immediately, framed over the
 * lot cluster, and then positioned. Uploading first means a long alignment
 * session can't lose the upload, and the editor only ever edits a real row.
 *
 * A drawn shape is the other way round — `ShapeEditor` creates the row the moment
 * the shape first has enough points to be one. See the note there.
 */

type Phase = "idle" | "saving" | "saved";

/** Which editor is open, if any. `layer: null` → drawing something new. */
type Drawing = { layer: Layer | null; kind: ShapeKind };

export default function LayersPanel({ slug }: { slug: string }) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  // Which shape has its click-card editor expanded. One at a time — these are
  // long forms and a stack of them buries the layer list they belong to.
  const [detailing, setDetailing] = useState<string | null>(null);
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

  /** Style is merged, not replaced — the route does the same on its side. */
  function patchStyle(l: Layer, style: Partial<ShapeStyle>) {
    patch(l.id, { style: { ...l.style, ...style } });
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

  const edited = layers.find((l) => l.id === editing && l.kind === "image" && l.corners);

  if (drawing) {
    const isNew = !drawing.layer;
    const noun = drawing.kind === "polygon" ? "area" : "line";
    return (
      <Section
        title={isNew ? `Drawing · new ${noun}` : `Editing · ${drawing.layer?.name}`}
        hint={
          isNew
            ? "Trace the feature over the satellite imagery. It saves itself once it has enough points."
            : "Move, add or remove points. Saved as you go."
        }
      >
        <ShapeEditor
          // Keyed so switching shapes remounts the map, but *creating* the row
          // mid-session doesn't — `drawing` deliberately isn't updated on create.
          key={drawing.layer?.id ?? `new-${drawing.kind}`}
          slug={slug}
          layer={drawing.layer}
          kind={drawing.kind}
          className="h-[560px] w-full"
          onCreated={(l) => {
            setLayers((cur) => [...cur, l]);
            mark();
          }}
          onSaved={(l) => {
            setLayers((cur) => cur.map((x) => (x.id === l.id ? { ...x, ...l } : x)));
            mark();
          }}
          onDone={() => setDrawing(null)}
        />
      </Section>
    );
  }

  if (edited) {
    return (
      <Section
        title={`Positioning · ${edited.name}`}
        hint="Line the render up with the satellite imagery. Saved as you go."
      >
        <LayerEditor
          slug={slug}
          layer={edited}
          className="h-[560px] w-full"
          onSaved={(l) => setLayers((cur) => cur.map((x) => (x.id === l.id ? { ...x, ...l } : x)))}
          onDone={() => setEditing(null)}
        />
      </Section>
    );
  }

  return (
    <Section
      title="Map layers"
      hint="Put the golf course, river and parks on the map without drawing them as lots — pin the developer's site-plan render, or trace a feature by hand. Applies on next preview / publish."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <SaveState state={phase} at={savedAt} />
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy ?? "Add image"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDrawing({ layer: null, kind: "polygon" })}>
            Draw area
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDrawing({ layer: null, kind: "line" })}>
            Draw line
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
          hint="Pin the developer's site-plan render and everything on it — trees, streets, the river, the clubhouse — comes along without being rebuilt as parcel geometry. No render? Trace the features you need: an area for a pond or a park, a line for a river or a trail."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="brass" size="sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                {busy ?? "Add image"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDrawing({ layer: null, kind: "polygon" })}>
                Draw area
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDrawing({ layer: null, kind: "line" })}>
                Draw line
              </Button>
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

                    {l.kind === "image" && l.corners && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(l.id)}>
                        Position
                      </Button>
                    )}

                    {l.kind === "shape" && l.geometry && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDrawing({ layer: l, kind: shapeKindOf(l.geometry) })}
                        >
                          Edit shape
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailing((cur) => (cur === l.id ? null : l.id))}
                        >
                          {shapeInfo(l.name, l.style) ? "Card ✓" : "Card"}
                        </Button>
                      </>
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

                  {detailing === l.id && l.kind === "shape" && (
                    <ShapeCardEditor
                      key={l.id}
                      layer={l}
                      onCommit={(style) => patchStyle(l, style)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-faint">
            <strong className="font-medium text-graphite">Under lots</strong> puts the layer beneath
            the parcels — the usual choice for a site plan the lots sit on, or a river they back
            onto. <strong className="font-medium text-graphite">Over lots</strong>{" "}
            covers the lot fills but still lets lot numbers read on top. Inside a drawn
            shape&rsquo;s editor, a line
            can be painted as a <strong className="font-medium text-graphite">river</strong> and
            either kind can carry <strong className="font-medium text-graphite">text</strong> drawn
            onto the map — along the line, or across the middle of an area.{" "}
            <strong className="font-medium text-graphite">Card</strong> gives a drawn shape
            something to say when a visitor clicks it, the way a lot opens its panel; a shape with
            an empty card isn&rsquo;t clickable at all.
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of fc.features ?? []) {
      const g = f.geometry;
      const polys = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of polys)
        for (const ring of poly)
          for (const pt of ring) {
            const [x, y] = toMerc(pt as [number, number]);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
    }
    if (Number.isFinite(minX) && maxX > minX) {
      center = [(minX + maxX) / 2, (minY + maxY) / 2];
      // A touch of margin so the render's own border isn't clipped by the lots.
      halfW = ((maxX - minX) / 2) * 1.15;
      halfH = ((maxY - minY) / 2) * 1.15;
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

/** The meander both line swatches are drawn along. */
const SWATCH_LINE = "M3 21c5-1 5-13 11-13s6 9 11 11";

/**
 * Stands in for an image layer's thumbnail. Reads the way the shape renders — an
 * area as a wash at its own fill opacity, a line as a stroke at its own width,
 * a river as its three banded passes — so the row is identifiable at a glance
 * without opening the editor.
 */
function ShapeSwatch({ layer }: { layer: Layer }) {
  const kind = shapeKindOf(layer.geometry);
  const w = Math.max(1.5, Math.min(6, layer.style.width / 2));
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] border border-line bg-panel-2">
      {kind === "polygon" ? (
        <span
          className="h-7 w-7 rounded-[3px]"
          style={{ background: layer.style.color, opacity: Math.max(0.15, layer.style.fillOpacity) }}
        />
      ) : (
        <svg viewBox="0 0 28 28" className="h-7 w-7" fill="none" aria-hidden="true">
          {layer.style.look === "river" && (
            <path
              d={SWATCH_LINE}
              stroke={shade(layer.style.color, -0.45)}
              strokeWidth={w + 3}
              strokeLinecap="round"
              opacity={0.55}
            />
          )}
          <path d={SWATCH_LINE} stroke={layer.style.color} strokeWidth={w} strokeLinecap="round" />
          {layer.style.look === "river" && (
            <path
              d={SWATCH_LINE}
              stroke={shade(layer.style.color, 0.55)}
              strokeWidth={Math.max(0.6, w * 0.3)}
              strokeLinecap="round"
              opacity={0.55}
            />
          )}
        </svg>
      )}
    </span>
  );
}

/* ---- The card a shape opens when a visitor clicks it --------------------- */

const CARD_FIELDS: {
  key: keyof Pick<
    ShapeStyle,
    "infoTitle" | "infoBody" | "infoImage" | "infoVideo" | "infoLink" | "infoLinkLabel"
  >;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  max?: number;
  /** Goes into an href/src downstream — the server drops anything else. */
  url?: boolean;
  half?: boolean;
}[] = [
  { key: "infoTitle", label: "Heading", max: MAX_INFO_TITLE },
  { key: "infoBody", label: "Description", multiline: true, max: MAX_INFO_BODY },
  { key: "infoImage", label: "Image URL", placeholder: "https://…", url: true, half: true },
  { key: "infoVideo", label: "Video URL", placeholder: "YouTube, Vimeo, Loom…", url: true, half: true },
  { key: "infoLink", label: "Link URL", placeholder: "https://…", url: true, half: true },
  {
    key: "infoLinkLabel",
    label: "Link button text",
    placeholder: "Learn more",
    max: MAX_INFO_LINK_LABEL,
    half: true,
  },
];

/**
 * Fill any of these in and the shape becomes clickable on the map; leave them
 * all empty and it stays scenery, with clicks passing through to the lot
 * underneath. That's the whole switch — there isn't a separate "clickable"
 * checkbox to end up contradicting an empty card, or a filled-in card nobody
 * can reach.
 *
 * Commits on blur (like the layer-name field above it) rather than per keystroke:
 * a description is a paragraph, and one PATCH per character is noise.
 */
function ShapeCardEditor({
  layer,
  onCommit,
}: {
  layer: Layer;
  onCommit: (style: Partial<ShapeStyle>) => void;
}) {
  const [draft, setDraft] = useState(layer.style);
  // Fields the server would have thrown away. It drops any URL that isn't plain
  // http(s) — a card is rendered into `href`/`src` in the embed — and dropping
  // one silently would leave the operator looking at a pasted value that was
  // never stored, which is the one thing worse than refusing it.
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  const live = shapeInfo(layer.name, draft);

  function commit(f: (typeof CARD_FIELDS)[number]) {
    const v = (draft[f.key] ?? "").trim();
    if (f.url && v && !isHttpUrl(v)) {
      setRejected((r) => ({ ...r, [f.key]: true }));
      return;
    }
    setRejected((r) => (r[f.key] ? { ...r, [f.key]: false } : r));
    if (v === (layer.style[f.key] ?? "").trim()) return; // untouched — not a write
    onCommit({ [f.key]: v });
  }

  return (
    <div className="mt-2.5 border-t border-line-2 pt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CARD_FIELDS.map((f) => (
          <div key={f.key} className={f.half ? "" : "sm:col-span-2"}>
            <Field label={f.label}>
              {f.multiline ? (
                <textarea
                  value={draft[f.key] ?? ""}
                  maxLength={f.max}
                  rows={3}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() => commit(f)}
                  className={fieldClass("!h-auto resize-y py-2 leading-relaxed")}
                />
              ) : (
                <input
                  value={draft[f.key] ?? ""}
                  maxLength={f.max}
                  placeholder={f.key === "infoTitle" ? layer.name : f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() => commit(f)}
                  aria-invalid={rejected[f.key] || undefined}
                  className={fieldClass(rejected[f.key] ? "!border-danger/60" : "")}
                />
              )}
            </Field>
            {rejected[f.key] && (
              <p className="mt-1 text-[12px] text-danger">
                Not saved — the link has to start with http:// or https://
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="mt-2.5 text-[12px] leading-relaxed text-faint">
        {live ? (
          <>
            Visitors can click this {shapeKindOf(layer.geometry) === "polygon" ? "area" : "line"} to
            open a card headed{" "}
            <strong className="font-medium text-graphite">{live.title}</strong>. Check it in the
            preview — it goes live on publish.
          </>
        ) : (
          <>
            Empty, so this shape isn&rsquo;t clickable — clicks pass through to the lot underneath
            it. Fill in any field above to turn it into a click target.
          </>
        )}
      </p>
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
