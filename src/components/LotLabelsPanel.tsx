"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { FieldDef, LabelWeight, LotLabels, MapAppearance, MapConfig, Status } from "@/lib/types";
import { resolveMapStyle, hideLegacyLotLayers, applySatelliteTint, DEFAULT_APPEARANCE, STANDARD_CONFIG } from "@/lib/types";
import { syncLayers } from "@/lib/mapLayers";
import {
  CUSTOM_LABEL,
  CUSTOM_LABEL2,
  LABEL_FONTS,
  LABEL_PRESETS,
  LABEL_WEIGHTS,
  applyLotLabels,
  fontFor,
  hasTypedLabel,
  labelFieldOptions,
  lotLabelLayer,
  lotLabelText,
  readLotLabels,
  withLotLabels,
} from "@/lib/lotLabels";
import { devPath } from "@/lib/const";
import { jsend } from "@/lib/client";
import { Section, Eyebrow, Field, SaveState, Skeleton, Toggle, fieldClass, cx } from "@/components/ui";

// Map Design's "Lot labels" section: what each lot says and how it's lettered,
// beside a live map of the development's own draft lots. Every control restyles
// that map on the spot and saves itself a moment later — the preview draws
// through the same lib/lotLabels.ts builder the embed does, so there is no
// separate idea of "what it will look like" to drift from what visitors get.

const HINT = "What's printed on each lot, and how it's lettered. Saves as you go; visitors see it on the next publish.";

export default function LotLabelsPanel({
  slug,
  appearance,
  fields,
  onSaved,
}: {
  slug: string;
  appearance: MapAppearance | null;
  fields: FieldDef[];
  onSaved?: (labels: LotLabels) => void;
}) {
  if (!appearance) {
    return (
      <Section title="Lot labels" hint={HINT}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <div className="rule" />
            <Skeleton className="h-[120px] w-full rounded-[var(--radius-sm)]" />
          </div>
          <Skeleton className="h-[360px] rounded-[var(--radius-lg)] lg:h-[520px]" />
        </div>
      </Section>
    );
  }
  return (
    <LabelEditor
      slug={slug}
      initial={readLotLabels(appearance.lotLabels)}
      basemap={appearance.basemap}
      fields={fields}
      onSaved={onSaved}
    />
  );
}

/* ---- The editor ---------------------------------------------------------- */

// "Show labels from" stops, named for what's on screen. Mapbox zoom numbers
// mean nothing to an operator; "street" does.
const ZOOM_STOPS: { value: number; label: string }[] = [
  { value: 0, label: "Always" },
  { value: 15, label: "Neighborhood" },
  { value: 16, label: "Street" },
  { value: 17, label: "Close up" },
];

const TEXT_SWATCHES = ["#ffffff", "#fff4df", "#d8b26a", "#141a26"];
const HALO_SWATCHES = ["#000000", "#1b2433", "#3a2a14", "#ffffff"];

const CSS_WEIGHT: Record<LabelWeight, number> = { regular: 400, medium: 500, bold: 700 };

// The picker shows each face from Google Fonts, subset to the characters the
// tiles actually print, so nineteen families cost a few KB. Only the picker uses
// these; the map draws Mapbox's own glyphs of the same faces.
const PICKER_FONTS_HREF = (() => {
  const families = [...new Set(LABEL_FONTS.map((f) => f.css))]
    .map((c) => `family=${c.replace(/ /g, "+")}:wght@400;700`)
    .join("&");
  const text = [...new Set(`${LABEL_FONTS.map((f) => f.family).join("")}Lot 0123456789`)].join("");
  return `https://fonts.googleapis.com/css2?${families}&text=${encodeURIComponent(text)}&display=swap`;
})();

function cssFamily(family: string): string {
  const f = fontFor(family);
  const fallback = f.kind === "Serif" ? "serif" : f.kind === "Mono" ? "monospace" : "sans-serif";
  return `"${f.css}", ${fallback}`;
}

// A rough CSS stand-in for Mapbox's text halo, for the preset plates only.
function haloShadow(color: string, width: number): string {
  if (!width) return "none";
  return [`0 0 ${width}px ${color}`, `0 0 ${width}px ${color}`, `0 0 ${width * 2}px ${color}`].join(", ");
}

function isDark(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

function LabelEditor({
  slug,
  initial,
  basemap,
  fields,
  onSaved,
}: {
  slug: string;
  initial: LotLabels;
  basemap: string;
  fields: FieldDef[];
  onSaved?: (labels: LotLabels) => void;
}) {
  const [labels, setLabels] = useState<LotLabels>(initial);
  const labelsRef = useRef(initial);
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [at, setAt] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [lots, setLots] = useState<Record<string, unknown>[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  async function save(next: LotLabels) {
    const id = ++seq.current;
    try {
      await jsend(`/api/dev/${slug}/appearance`, "PATCH", { lotLabels: next });
      if (seq.current !== id) return;
      setAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
      setPhase("saved");
      setError(null);
      onSaved?.(next);
    } catch (e) {
      if (seq.current !== id) return;
      setPhase("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Every control lands here: the preview restyles at once, and the save waits
  // for a pause so a dragged slider is one request, not sixty.
  function update(p: Partial<LotLabels>) {
    const next = { ...labelsRef.current, ...p };
    if (p.font && !fontFor(p.font).weights[next.weight]) next.weight = "regular";
    labelsRef.current = next;
    setLabels(next);
    setPhase("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save(next);
    }, 450);
  }

  // Leaving the page mid-pause still saves the last change.
  useEffect(() => {
    const pending = timer;
    const latest = labelsRef;
    return () => {
      if (!pending.current) return;
      clearTimeout(pending.current);
      void jsend(`/api/dev/${slug}/appearance`, "PATCH", { lotLabels: latest.current }).catch(() => {});
    };
  }, [slug]);

  const options = useMemo(() => labelFieldOptions(fields), [fields]);
  const fieldValue = options.some((o) => o.key === labels.field) ? labels.field : "lot_number";
  const fieldName = options.find((o) => o.key === fieldValue)?.label.toLowerCase() ?? "value";
  const customOnly = fieldValue === CUSTOM_LABEL;

  // A real lot to show the wording on — one with both lines when there are two,
  // and not one with its own typed label, which would show the exception, not the rule.
  const sample = useMemo(() => {
    let fallback: [string, string] | null = null;
    for (const p of lots) {
      if (labels.field !== CUSTOM_LABEL && hasTypedLabel(p)) continue;
      const t = lotLabelText(p, labels, fields);
      if (!t[0]) continue;
      if (!labels.field2 || t[1]) return t;
      fallback ??= t;
    }
    return fallback;
  }, [lots, labels, fields]);

  const font = fontFor(labels.font);
  const activePreset = LABEL_PRESETS.find((p) =>
    Object.entries(p.style).every(([k, v]) => labels[k as keyof LotLabels] === v)
  );

  return (
    <Section
      title="Lot labels"
      hint={HINT}
      className="!overflow-visible"
      action={<SaveState state={phase} at={at} />}
    >
      {/* React 19 hoists this into <head>, once, however often the panel mounts. */}
      <link rel="stylesheet" href={PICKER_FONTS_HREF} precedence="default" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Preview first in the DOM, so on a phone you see what you're changing. */}
        <div className="lg:sticky lg:top-[76px] lg:order-2 lg:self-start">
          <LabelPreview key={basemap} slug={slug} labels={labels} fields={fields} onLots={setLots} />
          <p className="mt-2 text-[12px] text-faint">
            Your draft lots on your basemap — scroll with Ctrl/⌘ held to zoom in and out.
          </p>
        </div>

        <div className="space-y-6 lg:order-1">
          {error && (
            <p className="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">
              Couldn&apos;t save: {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-4">
            <div>
              <Eyebrow>Show labels</Eyebrow>
              <p className="mt-1 text-[13px] text-graphite">
                Turn off for a clean map where lots read by color alone.
              </p>
            </div>
            <Toggle checked={labels.show} onChange={(v) => update({ show: v })} label="Show lot labels" />
          </div>

          <fieldset
            disabled={!labels.show}
            className={cx("min-w-0 space-y-6 transition-opacity", !labels.show && "opacity-45")}
          >
            {/* ── What it says ── */}
            <Group title="What it says">
              <div className={cx("grid gap-3", !customOnly && "sm:grid-cols-[minmax(0,1fr)_9rem]")}>
                <Field label="Label each lot with">
                  <select
                    value={fieldValue}
                    onChange={(e) => update({ field: e.target.value })}
                    className={fieldClass()}
                  >
                    {options.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {/* Typed labels print exactly as typed, so a prefix has nothing to attach to. */}
                {!customOnly && (
                  <Field label="Text before it">
                    <input
                      value={labels.prefix}
                      onChange={(e) => update({ prefix: e.target.value })}
                      placeholder="e.g. Lot"
                      maxLength={24}
                      className={fieldClass()}
                    />
                  </Field>
                )}
              </div>
              <Field label="Second line (smaller)">
                <select
                  value={labels.field2}
                  onChange={(e) => update({ field2: e.target.value })}
                  className={fieldClass()}
                >
                  <option value="">Nothing — one line</option>
                  {options
                    .filter((o) => o.key !== fieldValue && o.key !== CUSTOM_LABEL)
                    .map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                </select>
              </Field>

              <div className="flex items-baseline gap-3 rounded-[var(--radius-sm)] border border-line-2 bg-panel-2 px-3 py-2.5">
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Reads as</span>
                {sample ? (
                  <span className="min-w-0 text-[13px] text-ink">
                    <strong className="font-semibold">{sample[0]}</strong>
                    {sample[1] && <span className="text-graphite"> / {sample[1]}</span>}
                  </span>
                ) : (
                  <span className="text-[13px] text-faint">
                    {customOnly ? "No lot has a custom label yet." : `No lot has a ${fieldName} yet.`}
                  </span>
                )}
              </div>
              <p className="text-[12px] leading-relaxed text-faint">
                {customOnly
                  ? "Only lots you've typed a label for show one. "
                  : "Want one lot to say something else, like “Model home” or “Clubhouse”? "}
                <strong className="font-medium text-graphite">Click any lot on the preview to type its own label</strong>
                {" "}and a second line under it, or set <em>Custom map label</em> on the{" "}
                <Link href={devPath(slug, "lots")} className="text-graphite underline decoration-line underline-offset-2 hover:text-ink">
                  Lots page
                </Link>
                . A typed line always replaces that lot&apos;s usual one.
              </p>
            </Group>

            {/* ── Look ── */}
            <Group title="Start from a look">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {LABEL_PRESETS.map((p) => {
                  const s = { ...labels, ...p.style };
                  const active = activePreset?.name === p.name;
                  return (
                    <button
                      key={p.name}
                      type="button"
                      title={p.hint}
                      aria-pressed={active}
                      onClick={() => update(p.style)}
                      className={cx(
                        "relative rounded-[var(--radius-sm)] border p-1.5 text-left transition",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
                        active ? "border-ink bg-panel-2" : "border-line bg-panel hover:border-[color:var(--color-panel-3)] hover:bg-panel-2"
                      )}
                    >
                      <span
                        className="flex h-11 items-center justify-center rounded-[3px]"
                        style={{ background: isDark(s.color) ? "#e6e1d3" : "#4f6147" }}
                        aria-hidden="true"
                      >
                        <span
                          style={{
                            fontFamily: cssFamily(s.font),
                            fontWeight: CSS_WEIGHT[s.weight],
                            fontSize: Math.min(s.size, 16),
                            letterSpacing: `${s.letterSpacing}em`,
                            textTransform: s.uppercase ? "uppercase" : "none",
                            color: s.color,
                            textShadow: haloShadow(s.haloColor, s.haloWidth),
                          }}
                        >
                          Lot 12
                        </span>
                      </span>
                      <span className="mt-1.5 block px-0.5 text-[12px] font-medium text-ink">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            </Group>

            <Group title="Typeface">
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {LABEL_FONTS.map((f) => {
                  const active = labels.font === f.family;
                  return (
                    <button
                      key={f.family}
                      type="button"
                      aria-pressed={active}
                      title={`${f.family} · ${f.kind}`}
                      onClick={() => update({ font: f.family })}
                      className={cx(
                        "relative flex h-10 items-center rounded-[var(--radius-sm)] border px-3 text-left transition",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
                        active ? "border-ink bg-panel-2" : "border-line bg-panel hover:border-[color:var(--color-panel-3)] hover:bg-panel-2"
                      )}
                    >
                      {/* The face is its own label — sans, serif and mono read at a glance. */}
                      <span
                        className="truncate text-[14px] leading-none text-ink"
                        style={{ fontFamily: cssFamily(f.family), fontWeight: CSS_WEIGHT[labels.weight] }}
                      >
                        {f.family}
                      </span>
                      {active && (
                        <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brass" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <SubLabel>Weight</SubLabel>
                  <Segmented
                    value={labels.weight}
                    onChange={(v) => update({ weight: v })}
                    options={LABEL_WEIGHTS.map((w) => ({
                      value: w.value,
                      label: w.label,
                      disabled: !font.weights[w.value],
                      title: font.weights[w.value] ? undefined : `${font.family} doesn't come in ${w.label.toLowerCase()}`,
                    }))}
                  />
                </div>
                <div>
                  <SubLabel>Case</SubLabel>
                  <Segmented
                    value={labels.uppercase}
                    onChange={(v) => update({ uppercase: v })}
                    options={[
                      { value: false, label: "As typed" },
                      { value: true, label: "CAPITALS" },
                    ]}
                  />
                </div>
              </div>

              <Slider
                label="Size"
                min={8}
                max={36}
                step={1}
                value={labels.size}
                format={(v) => `${v} px`}
                onChange={(v) => update({ size: v })}
              />
              <Slider
                label="Letter spacing"
                min={0}
                max={0.3}
                step={0.01}
                value={labels.letterSpacing}
                format={(v) => (v === 0 ? "normal" : `+${v.toFixed(2)} em`)}
                onChange={(v) => update({ letterSpacing: v })}
              />
            </Group>

            <Group title="Color">
              <ColorRow label="Text" value={labels.color} swatches={TEXT_SWATCHES} onChange={(c) => update({ color: c })} />
              <ColorRow
                label="Outline"
                value={labels.haloColor}
                swatches={HALO_SWATCHES}
                onChange={(c) => update({ haloColor: c })}
              />
              <Slider
                label="Outline width"
                min={0}
                max={4}
                step={0.1}
                value={labels.haloWidth}
                format={(v) => (v === 0 ? "none" : `${v.toFixed(1)} px`)}
                onChange={(v) => update({ haloWidth: v })}
              />
              <Slider
                label="Opacity"
                min={0.2}
                max={1}
                step={0.05}
                value={labels.opacity}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => update({ opacity: v })}
              />
            </Group>

            <Group title="When it shows">
              <div>
                <SubLabel>Show labels from</SubLabel>
                <Segmented value={labels.minZoom} onChange={(v) => update({ minZoom: v })} options={ZOOM_STOPS} />
                <p className="mt-1.5 text-[12px] text-faint">
                  Zoomed out past this, lots show color only — keeps a wide view uncluttered.
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[13px] font-medium text-ink">Show every label</div>
                  <p className="mt-0.5 text-[12px] text-faint">
                    Off, labels that would collide are dropped so the rest stay readable. On, every lot gets
                    one, even if they overlap.
                  </p>
                </div>
                <Toggle
                  checked={labels.allowOverlap}
                  onChange={(v) => update({ allowOverlap: v })}
                  label="Show every label"
                />
              </div>
            </Group>
          </fieldset>
        </div>
      </div>
    </Section>
  );
}

/* ---- Small controls ------------------------------------------------------ */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <Eyebrow>{title}</Eyebrow>
        <div className="rule mt-2" />
      </div>
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 font-mono text-[11px] tracking-[0.04em] text-faint">{children}</div>;
}

function Segmented<T extends string | number | boolean>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
}) {
  return (
    <div className="flex rounded-[var(--radius-sm)] border border-line bg-panel-2 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "h-8 flex-1 rounded-[5px] px-2 text-[12px] font-medium transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
              "disabled:cursor-not-allowed disabled:opacity-35",
              active ? "bg-panel text-ink shadow-[0_1px_2px_rgba(13,19,32,0.12)]" : "text-graphite hover:text-ink"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="font-mono text-[11px] tracking-[0.04em] text-faint">{label}</span>
        <span className="font-mono text-xs text-graphite tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="instrument mt-2.5"
        aria-label={label}
      />
    </label>
  );
}

function ColorRow({
  label,
  value,
  swatches,
  onChange,
}: {
  label: string;
  value: string;
  swatches: string[];
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-16 shrink-0 font-mono text-[11px] tracking-[0.04em] text-faint">{label}</span>
      <div className="flex items-center gap-1.5">
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`${label} ${c}`}
            aria-pressed={value === c}
            title={c.toUpperCase()}
            className={cx(
              "h-6 w-6 rounded-full border transition",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
              value === c ? "border-ink ring-2 ring-ink/15" : "border-line hover:border-[color:var(--color-panel-3)]"
            )}
            style={{ background: c }}
          />
        ))}
      </div>
      <label
        title="Pick any color"
        className={cx(
          "relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-panel px-2 transition",
          "hover:border-[color:var(--color-panel-3)] hover:bg-panel-2 focus-within:ring-2 focus-within:ring-ink/15"
        )}
      >
        <span
          className="inline-block h-4 w-4 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
          style={{ background: value }}
        />
        <span className="font-mono text-[11px] tracking-[0.04em] text-graphite tabular-nums">{value.toUpperCase()}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={`${label} color`}
        />
      </label>
    </div>
  );
}

/* ---- Live preview -------------------------------------------------------- */

const FILL = "ll-fill";
const LINE = "ll-line";
const LABEL = "ll-label";
const PICKED = "ll-picked";
const NONE = ["==", ["get", "rowId"], "___none___"] as unknown as mapboxgl.FilterSpecification;

// The lot whose own label is being typed in the preview's command bar.
type Editing = { rowId: string; name: string; value: string; value2: string; usual: string; usual2: string };

const LABEL_INPUT =
  "w-full rounded-[var(--radius-sm)] border border-white/15 bg-white/[0.06] px-2.5 text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none";

/** Outlines the lot being labelled (or nothing). */
function pick(map: mapboxgl.Map, rowId: string | null) {
  if (!map.getLayer(PICKED)) return;
  map.setFilter(PICKED, rowId ? (["==", ["get", "rowId"], rowId] as unknown as mapboxgl.FilterSpecification) : NONE);
}

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

// Same robust cluster framing the embed uses, so the preview opens on the lots
// rather than on one far-flung outlier.
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

// Only these change the label *text*; everything else is a paint/layout tweak
// that doesn't need the source re-stamped.
function textKeyOf(l: LotLabels, fields: FieldDef[]): string {
  return JSON.stringify([l.field, l.field2, l.prefix, fields.map((f) => [f.key, f.type])]);
}

const FIT = { padding: 48, maxZoom: 17 };

function LabelPreview({
  slug,
  labels,
  fields,
  onLots,
}: {
  slug: string;
  labels: LotLabels;
  fields: FieldDef[];
  onLots: (lots: Record<string, unknown>[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fcRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const boundsRef = useRef<mapboxgl.LngLatBounds | null>(null);
  const labelsRef = useRef(labels);
  const fieldsRef = useRef(fields);
  const stampedRef = useRef("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [empty, setEmpty] = useState(false);
  const [canFit, setCanFit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);

  function stopEditing() {
    setEditing(null);
    setLabelError(null);
    if (mapRef.current) pick(mapRef.current, null);
  }

  // One lot's own label goes straight onto its (draft) row, then the preview
  // re-stamps from the edited collection so the change shows without a reload.
  async function saveLabel() {
    const fc = fcRef.current;
    if (!editing || !fc) return;
    const typed = { [CUSTOM_LABEL]: editing.value.trim() || null, [CUSTOM_LABEL2]: editing.value2.trim() || null };
    setSavingLabel(true);
    setLabelError(null);
    try {
      await jsend(`/api/parcel/${editing.rowId}`, "PATCH", { patch: typed });
      const next: GeoJSON.FeatureCollection = {
        ...fc,
        features: fc.features.map((f) =>
          String(f.properties?.rowId) === editing.rowId ? { ...f, properties: { ...f.properties, ...typed } } : f
        ),
      };
      fcRef.current = next;
      (mapRef.current?.getSource("parcels") as mapboxgl.GeoJSONSource | undefined)?.setData(
        withLotLabels(next, labelsRef.current, fieldsRef.current)
      );
      onLots(next.features.map((f) => (f.properties ?? {}) as Record<string, unknown>));
      stopEditing();
    } catch (e) {
      setLabelError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingLabel(false);
    }
  }

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
      onLots(fc.features.map((f) => (f.properties ?? {}) as Record<string, unknown>));
      setEmpty(fc.features.length === 0);

      mapboxgl.accessToken = cfg.development.mapbox_token;
      const appearance = cfg.development.map_appearance ?? DEFAULT_APPEARANCE;
      const bounds = lotClusterBounds(fc);
      boundsRef.current = bounds;
      setCanFit(!!bounds);
      const view = cfg.development.default_view;

      // Flat and north-up: this map is for judging lettering, and Mapbox draws
      // lot labels screen-aligned, so tilt would change nothing but the framing.
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: resolveMapStyle(cfg.development.mapbox_style, appearance.basemap),
        ...(bounds
          ? { bounds, fitBoundsOptions: FIT }
          : { center: view.center, zoom: view.zoom }),
        pitch: 0,
        bearing: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // It sits mid-page: a plain scroll must scroll the page, not zoom the map.
        cooperativeGestures: true,
      });
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

      const syncZoom = () => {
        if (map) setZoom(map.getZoom());
      };
      map.on("zoom", syncZoom);

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

        const l = labelsRef.current;
        stampedRef.current = textKeyOf(l, fieldsRef.current);
        map.addSource("parcels", {
          type: "geojson",
          data: withLotLabels(fc, l, fieldsRef.current),
          promoteId: "parcel_id",
        });
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
          id: PICKED,
          type: "line",
          source: "parcels",
          paint: { "line-color": "#ffffff", "line-width": 3, "line-opacity": 0.95 },
          filter: NONE,
        });
        map.addLayer(lotLabelLayer(LABEL, "parcels", l));
        // Site plans and drawn shapes too — a label that's legible on bare lots
        // can still disappear over a render.
        syncLayers(map, cfg.layers ?? [], { fill: FILL, label: LABEL });

        map.on("mouseenter", FILL, () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", FILL, () => {
          if (map) map.getCanvas().style.cursor = "";
        });
        map.on("click", FILL, (e) => {
          const p = (e.features?.[0]?.properties ?? {}) as Record<string, unknown>;
          if (p.rowId == null || !map) return;
          const rowId = String(p.rowId);
          pick(map, rowId);
          setLabelError(null);
          setEditing({
            rowId,
            name: p.lot_number ? `Lot ${p.lot_number}` : String(p.parcel_id ?? "This lot"),
            value: p.map_label == null ? "" : String(p.map_label),
            value2: p.map_label2 == null ? "" : String(p.map_label2),
            // What each line says when its box is left blank — the placeholders.
            // Line two is read under a typed line one, since that's when it shows.
            usual: lotLabelText({ ...p, map_label: null, map_label2: null }, labelsRef.current, fieldsRef.current)[0],
            usual2: lotLabelText({ ...p, map_label: "_", map_label2: null }, labelsRef.current, fieldsRef.current)[1],
          });
        });

        syncZoom();
        setReady(true);
        setTimeout(() => map?.resize(), 200);
      });
    })().catch((err) => {
      if (!cancelled) setError(String(err));
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [slug, onLots]);

  useEffect(() => {
    labelsRef.current = labels;
    fieldsRef.current = fields;
    const map = mapRef.current;
    const fc = fcRef.current;
    if (!ready || !map || !fc || !map.getLayer(LABEL)) return;
    const key = textKeyOf(labels, fields);
    if (key !== stampedRef.current) {
      stampedRef.current = key;
      (map.getSource("parcels") as mapboxgl.GeoJSONSource | undefined)?.setData(withLotLabels(fc, labels, fields));
    }
    applyLotLabels(map, LABEL, labels);
  }, [labels, fields, ready]);

  const hiddenByZoom = labels.show && ready && zoom < labels.minZoom;
  const stop = ZOOM_STOPS.find((s) => s.value === labels.minZoom)?.label.toLowerCase();

  return (
    <div className="relative h-[360px] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)] lg:h-[520px]">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute left-3 top-3 z-20">
        <span className="glass-dark block rounded-[var(--radius-sm)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70">
          Live preview · draft
        </span>
      </div>

      {error && (
        <div className="glass-dark pop-in absolute inset-x-3 top-12 z-30 rounded-[var(--radius)] px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">Preview unavailable</div>
          <p className="mt-1 text-[12px] leading-relaxed text-white/70">{error}</p>
        </div>
      )}

      {empty && !error && (
        <div className="absolute inset-0 z-20 grid place-items-center p-6">
          <div className="glass-dark max-w-[260px] rounded-[var(--radius)] px-4 py-3 text-center text-[12px] leading-relaxed text-white/75">
            No lots yet. Add some on the Parcels page and their labels will preview here.
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 z-20 p-3">
        {editing ? (
          <form
            className="glass-dark pop-in rounded-[var(--radius)] px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void saveLabel();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") stopEditing();
            }}
          >
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/50">
              {editing.name} · its own label
            </div>
            <div className="mt-1.5 flex items-end gap-2">
              {/* The second box is a size down, the way line two prints on the map. */}
              <div className="min-w-0 flex-1 space-y-1.5">
                <input
                  autoFocus
                  aria-label={`${editing.name} label`}
                  value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  placeholder={editing.usual ? `Usual label: ${editing.usual}` : "e.g. Model home"}
                  maxLength={60}
                  className={cx(LABEL_INPUT, "h-8 text-[13px]")}
                />
                <input
                  aria-label={`${editing.name} second line`}
                  value={editing.value2}
                  onChange={(e) => setEditing({ ...editing, value2: e.target.value })}
                  placeholder={
                    editing.usual2 ? `Usual second line: ${editing.usual2}` : "Second line, optional — e.g. Opens spring 2027"
                  }
                  maxLength={60}
                  className={cx(LABEL_INPUT, "h-7 text-[12px]")}
                />
              </div>
              <button
                type="submit"
                disabled={savingLabel}
                className="inline-flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-3 text-[12px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {savingLabel ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={stopEditing}
                className="inline-flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] px-2 text-[12px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white"
              >
                Cancel
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-white/50">
              {labelError ? (
                <span className="text-danger-ink">Couldn&apos;t save: {labelError}</span>
              ) : (
                "Saved to this lot's draft. Clear a box and save to go back to that line's usual text."
              )}
            </p>
          </form>
        ) : (
          <div className="glass-dark flex items-center gap-3 rounded-[var(--radius)] px-3 py-2">
            <span className="flex flex-col gap-0.5 font-mono tabular-nums">
              <span className="text-[9px] uppercase tracking-[0.16em] text-white/40">Zoom</span>
              <span className="text-[13px] leading-none text-white">{zoom.toFixed(1)}</span>
            </span>
            <span className="h-6 w-px bg-white/15" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-white/70">
              {!labels.show
                ? "Labels are off."
                : hiddenByZoom
                  ? `Labels hidden — they appear from ${stop ?? `zoom ${labels.minZoom}`} in.`
                  : "Click any lot to type its own label."}
            </span>
            {canFit && (
              <button
                type="button"
                onClick={() => boundsRef.current && mapRef.current?.fitBounds(boundsRef.current, { ...FIT, duration: 600 })}
                className="inline-flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] px-2.5 text-[12px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white"
              >
                Fit lots
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
