"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { jget, jsend } from "@/lib/client";
import type { Status, FieldDef, Filter, FieldType, MapAppearance } from "@/lib/types";
import { BASEMAP_OPTIONS } from "@/lib/types";
import OpeningViewEditor from "@/components/OpeningViewEditor";
import {
  PageHeader,
  Section,
  Button,
  Eyebrow,
  Field,
  Dot,
  Chip,
  SaveState,
  EmptyState,
  Skeleton,
  fieldClass,
  cx,
} from "@/components/ui";

type SavePhase = "idle" | "saving" | "saved";

/* A small shared hook so every onBlur/onChange mutation on this page reports
   through one SaveState instrument with consistent timing + timestamp. */
function useSaveState() {
  const [state, setState] = useState<SavePhase>("idle");
  const [at, setAt] = useState<string | undefined>();
  const seq = useRef(0);

  const run = useCallback(async (fn: () => Promise<void>) => {
    const id = ++seq.current;
    setState("saving");
    try {
      await fn();
      if (seq.current !== id) return;
      setAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
      );
      setState("saved");
    } catch (err) {
      if (seq.current === id) setState("idle");
      throw err;
    }
  }, []);

  return { state, at, run };
}

export default function DesignPage() {
  const { slug } = useParams<{ slug: string }>();
  const [name, setName] = useState<string>("");
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [appearance, setAppearance] = useState<MapAppearance | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [cfg, s, f, fl, ap] = await Promise.all([
      jget<{ development: { name: string } }>(`/api/dev/${slug}/config?state=draft`),
      jget<Status[]>(`/api/dev/${slug}/statuses`),
      jget<FieldDef[]>(`/api/dev/${slug}/fields`),
      jget<Filter[]>(`/api/dev/${slug}/filters`),
      jget<MapAppearance>(`/api/dev/${slug}/appearance`),
    ]);
    setName(cfg.development.name);
    setStatuses(s);
    setFields(f);
    setFilters(fl);
    setAppearance(ap);
    setLoaded(true);
  }, [slug]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (active) console.error(err);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={`Map design · ${name || "…"}`}
        title="Map Design"
        description="Statuses, custom fields, public filters, and how the basemap renders. Changes apply on the next preview or publish."
      />

      {/* ── HOW IT RENDERS ── the map's physical look */}
      <SubSection eyebrow="How it renders" caption="Appearance">
        <MapAppearanceSection slug={slug} appearance={appearance} loaded={loaded} reload={load} />
      </SubSection>

      {/* ── WHERE IT OPENS ── the camera the public map lands on */}
      <SubSection eyebrow="Where it opens" caption="Opening view">
        <Section
          title="Opening view"
          hint="The camera the public map lands on. Frame it below, then save — leave it on auto-fit to always frame the lot cluster."
        >
          <OpeningViewEditor slug={slug} className="h-[440px] w-full" />
        </Section>
      </SubSection>

      {/* ── WHAT THE DATA MEANS ── statuses lead (they paint the fill), then the field/filter pair */}
      <SubSection eyebrow="What the data means" caption="Statuses, fields & filters">
        <div className="space-y-4">
          <Statuses slug={slug} statuses={statuses} loaded={loaded} reload={load} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Fields slug={slug} fields={fields} loaded={loaded} reload={load} />
            <Filters slug={slug} filters={filters} fields={fields} loaded={loaded} reload={load} />
          </div>
        </div>
      </SubSection>
    </div>
  );
}

/* ---- Sub-section label: mono eyebrow over a hairline rule ----------------- */

function SubSection({
  eyebrow,
  caption,
  children,
}: {
  eyebrow: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow>{eyebrow}</Eyebrow>
          <span className="font-mono text-[11px] tracking-[0.04em] text-faint">{caption}</span>
        </div>
        <div className="rule mt-2" />
      </div>
      {children}
    </section>
  );
}

/* ---- Map appearance ------------------------------------------------------ */

function MapAppearanceSection({
  slug,
  appearance,
  loaded,
  reload,
}: {
  slug: string;
  appearance: MapAppearance | null;
  loaded: boolean;
  reload: () => Promise<void>;
}) {
  const save = useSaveState();
  const [drag, setDrag] = useState<number | null>(null);

  function patch(p: Partial<MapAppearance>) {
    save
      .run(async () => {
        await jsend(`/api/dev/${slug}/appearance`, "PATCH", p);
        await reload();
      })
      .catch(console.error);
  }

  return (
    <Section
      title="Map appearance"
      hint="How the public 3D map renders. Applies on next preview / publish."
      action={<SaveState state={save.state} at={save.at} />}
    >
      {!loaded || !appearance ? (
        <div className="space-y-5">
          <Skeleton className="h-3.5 w-20" />
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[58px] rounded-[var(--radius-sm)]" />
            ))}
          </div>
          <div className="rule" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <Eyebrow>Basemap</Eyebrow>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {BASEMAP_OPTIONS.map((o) => {
                const active = appearance.basemap === o.key;
                return (
                  <button
                    key={o.key}
                    onClick={() => patch({ basemap: o.key })}
                    aria-pressed={active}
                    className={cx(
                      "relative flex flex-col rounded-[var(--radius-sm)] border px-3.5 py-3 text-left transition",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
                      active
                        ? "border-ink bg-panel-2"
                        : "border-line bg-panel hover:bg-panel-2 hover:border-[color:var(--color-panel-3)]"
                    )}
                  >
                    {active && (
                      <span
                        className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brass"
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-[13px] font-medium text-ink">{o.label}</span>
                    <span className="mt-0.5 text-[12px] text-faint">{o.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rule" />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Eyebrow>3D terrain</Eyebrow>
              <p className="mt-1 text-[13px] text-graphite">Raise the mesh to reveal real elevation.</p>
            </div>
            <Toggle checked={appearance.terrain} onChange={(v) => patch({ terrain: v })} />
          </div>

          {appearance.terrain && (
            <div>
              <div className="flex items-center justify-between">
                <Eyebrow>Terrain exaggeration</Eyebrow>
                <span className="font-mono text-xs text-faint tabular-nums">
                  {(drag ?? appearance.terrainExaggeration).toFixed(1)}×
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={3}
                step={0.1}
                value={drag ?? appearance.terrainExaggeration}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={() => {
                  if (drag != null) {
                    patch({ terrainExaggeration: drag });
                    setDrag(null);
                  }
                }}
                onKeyUp={() => {
                  if (drag != null) {
                    patch({ terrainExaggeration: drag });
                    setDrag(null);
                  }
                }}
                className="instrument mt-3"
                aria-label="Terrain exaggeration"
              />
              <div className="mt-1.5 flex justify-between font-mono text-[10px] tracking-[0.08em] text-faint tabular-nums">
                <span>1×</span>
                <span>2×</span>
                <span>3×</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-6 w-11 shrink-0 rounded-full border transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15",
        checked ? "border-ink bg-ink" : "border-line bg-panel-2"
      )}
    >
      <span
        className={cx(
          "absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(13,19,32,0.3)] transition-all",
          checked ? "left-[22px]" : "left-[2px]"
        )}
      />
    </button>
  );
}

/* ---- Delete affordance: consistent subtle danger control ----------------- */

function DeleteButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-faint transition",
        "hover:bg-panel-2 hover:text-danger",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/25"
      )}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
        <path
          d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.5 8.3c0 .4.4.7.8.7h3.4c.4 0 .8-.3.8-.7L11 4.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ---- Statuses ------------------------------------------------------------ */

function Statuses({
  slug,
  statuses,
  loaded,
  reload,
}: {
  slug: string;
  statuses: Status[];
  loaded: boolean;
  reload: () => Promise<void>;
}) {
  const save = useSaveState();

  function mutate(fn: () => Promise<void>) {
    save.run(fn).catch(console.error);
  }

  return (
    <Section
      title="Statuses & colors"
      hint="Each status paints the map's fill-color. The default colors any lot that doesn't match another, and can't be deleted."
      action={
        <div className="flex items-center gap-3">
          <SaveState state={save.state} at={save.at} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              mutate(async () => {
                await jsend(`/api/dev/${slug}/statuses`, "POST", { name: "New status", color: "#7c8698" });
                await reload();
              })
            }
          >
            Add status
          </Button>
        </div>
      }
    >
      {!loaded ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[52px] rounded-[var(--radius-sm)]" />
          ))}
        </div>
      ) : statuses.length === 0 ? (
        <EmptyState
          title="No statuses yet"
          hint="Statuses produce the map's fill-color. Add one to start coloring lots."
          action={
            <Button
              variant="brass"
              size="sm"
              onClick={() =>
                mutate(async () => {
                  await jsend(`/api/dev/${slug}/statuses`, "POST", { name: "New status", color: "#7c8698" });
                  await reload();
                })
              }
            >
              Add status
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {statuses.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-line bg-panel px-3 py-2.5 transition hover:border-[color:var(--color-panel-3)]"
            >
              {/* Color is the identity: a swatch input dressed as the status dot */}
              <label className="relative inline-flex shrink-0 cursor-pointer items-center" title="Status color">
                <Dot color={s.color} size={16} />
                <input
                  type="color"
                  defaultValue={s.color}
                  onBlur={(e) =>
                    e.target.value !== s.color &&
                    mutate(async () => {
                      await jsend(`/api/status/${s.id}`, "PATCH", { color: e.target.value });
                      await reload();
                    })
                  }
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Status color"
                />
              </label>
              <input
                defaultValue={s.name}
                onBlur={(e) =>
                  e.target.value !== s.name &&
                  mutate(async () => {
                    await jsend(`/api/status/${s.id}`, "PATCH", { name: e.target.value });
                    await reload();
                  })
                }
                className={fieldClass("!h-8 min-w-[10rem] flex-1 font-medium")}
                aria-label="Status name"
              />
              <Chip tone="data" style={{ color: s.color, borderColor: s.color }}>
                {s.color.toUpperCase()}
              </Chip>
              <label className="flex items-center gap-1.5 text-[13px] text-graphite">
                <input
                  type="checkbox"
                  defaultChecked={s.show_in_filter}
                  onChange={(e) =>
                    mutate(async () => {
                      await jsend(`/api/status/${s.id}`, "PATCH", { show_in_filter: e.target.checked });
                      await reload();
                    })
                  }
                  className="h-4 w-4 accent-[color:var(--color-ink)]"
                />
                filterable
              </label>
              {s.is_default ? (
                <Chip tone="neutral">default</Chip>
              ) : (
                <DeleteButton
                  label={`Delete ${s.name}`}
                  onClick={() =>
                    mutate(async () => {
                      await jsend(`/api/status/${s.id}`, "DELETE");
                      await reload();
                    })
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ---- Custom fields ------------------------------------------------------- */

function Fields({
  slug,
  fields,
  loaded,
  reload,
}: {
  slug: string;
  fields: FieldDef[];
  loaded: boolean;
  reload: () => Promise<void>;
}) {
  const save = useSaveState();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");

  function add() {
    if (!label.trim()) return;
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    save
      .run(async () => {
        await jsend(`/api/dev/${slug}/fields`, "POST", {
          label: label.trim(),
          key,
          type,
          options: type === "select" ? options.split(",").map((o) => o.trim()).filter(Boolean) : null,
          filterable: true,
        });
        setLabel("");
        setOptions("");
        await reload();
      })
      .catch(console.error);
  }

  function remove(id: Filter["id"]) {
    save
      .run(async () => {
        await jsend(`/api/field/${id}`, "DELETE");
        await reload();
      })
      .catch(console.error);
  }

  return (
    <Section
      title="Custom fields"
      hint="Extra attributes that show on the lot panel and can drive filters."
      className="flex flex-col"
      action={<SaveState state={save.state} at={save.at} />}
    >
      <div className="space-y-2">
        {!loaded ? (
          Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[44px] rounded-[var(--radius-sm)]" />
          ))
        ) : fields.length === 0 ? (
          <EmptyState
            title="No custom fields yet"
            hint="Custom fields add attributes — like HOA dues or square footage — to every lot panel, and can drive filters."
          />
        ) : (
          fields.map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-line bg-panel px-3 py-2.5 text-sm transition hover:border-[color:var(--color-panel-3)]"
            >
              <span className="font-medium text-ink">{f.label}</span>
              <Chip tone="neutral">{f.type}</Chip>
              <code className="font-mono text-[12px] text-faint">{f.key}</code>
              {f.options && <span className="text-[12px] text-faint">[{f.options.join(", ")}]</span>}
              <span className="ml-auto">
                <DeleteButton label={`Delete ${f.label}`} onClick={() => remove(f.id)} />
              </span>
            </div>
          ))
        )}
      </div>

      {/* delineated add band */}
      <div className="-mx-5 -mb-5 mt-4 border-t border-line-2 bg-panel-2 px-5 py-4">
        <Eyebrow>Add a field</Eyebrow>
        <div className="mt-3 grid grid-cols-2 items-end gap-3">
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. HOA dues"
              className={fieldClass()}
            />
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={fieldClass()}>
              {(["text", "number", "money", "url", "select", "bool"] as FieldType[]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          {type === "select" && (
            <Field label="Options (comma-separated)">
              <input
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder="e.g. Low, Medium, High"
                className={fieldClass()}
              />
            </Field>
          )}
          <div className={cx(type === "select" ? "" : "col-span-2", "flex justify-end")}>
            <Button variant="ghost" size="md" onClick={add}>
              Add field
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---- Filters ------------------------------------------------------------- */

function Filters({
  slug,
  filters,
  fields,
  loaded,
  reload,
}: {
  slug: string;
  filters: Filter[];
  fields: FieldDef[];
  loaded: boolean;
  reload: () => Promise<void>;
}) {
  const save = useSaveState();
  const [label, setLabel] = useState("");
  const [fieldKey, setFieldKey] = useState("status");
  const [values, setValues] = useState("");

  const fieldOptions = [
    { key: "status", label: "Status" },
    ...fields.filter((f) => f.filterable).map((f) => ({ key: f.key, label: f.label })),
  ];

  function add() {
    if (!label.trim()) return;
    save
      .run(async () => {
        await jsend(`/api/dev/${slug}/filters`, "POST", {
          label: label.trim(),
          field_key: fieldKey,
          match_values: values.split(",").map((v) => v.trim()).filter(Boolean),
        });
        setLabel("");
        setValues("");
        await reload();
      })
      .catch(console.error);
  }

  function remove(id: Filter["id"]) {
    save
      .run(async () => {
        await jsend(`/api/filter/${id}`, "DELETE");
        await reload();
      })
      .catch(console.error);
  }

  return (
    <Section
      title="Map filters"
      hint="Buttons that appear on the public map to narrow which lots show."
      className="flex flex-col"
      action={<SaveState state={save.state} at={save.at} />}
    >
      <div className="space-y-2">
        {!loaded ? (
          Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[44px] rounded-[var(--radius-sm)]" />
          ))
        ) : filters.length === 0 ? (
          <EmptyState
            title="No filters yet"
            hint="Filters are buttons on the public map that narrow which lots show — like a View available toggle."
          />
        ) : (
          filters.map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-line bg-panel px-3 py-2.5 text-sm transition hover:border-[color:var(--color-panel-3)]"
            >
              <Chip tone="ink">{f.label}</Chip>
              <span className="font-mono text-[12px] text-faint">
                {f.field_key} in [{f.match_values.join(", ")}]
              </span>
              <span className="ml-auto">
                <DeleteButton label={`Delete ${f.label}`} onClick={() => remove(f.id)} />
              </span>
            </div>
          ))
        )}
      </div>

      {/* delineated add band */}
      <div className="-mx-5 -mb-5 mt-4 border-t border-line-2 bg-panel-2 px-5 py-4">
        <Eyebrow>Add a filter</Eyebrow>
        <div className="mt-3 grid grid-cols-2 items-end gap-3">
          <Field label="Button label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. View available"
              className={fieldClass()}
            />
          </Field>
          <Field label="Field">
            <select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} className={fieldClass()}>
              {fieldOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Match values (comma-separated)">
            <input
              value={values}
              onChange={(e) => setValues(e.target.value)}
              placeholder="e.g. Available"
              className={fieldClass()}
            />
          </Field>
          <div className="flex justify-end">
            <Button variant="ghost" size="md" onClick={add}>
              Add filter
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}
