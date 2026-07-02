"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget, jsend } from "@/lib/client";
import { money } from "@/lib/format";
import type { MapConfig, FieldDef, Status } from "@/lib/types";
import {
  PageHeader,
  Section,
  Button,
  Field,
  TextInput,
  Dot,
  Eyebrow,
  EmptyState,
  Skeleton,
  fieldClass,
} from "@/components/ui";

type Props = Record<string, unknown>;
const CORE = ["lot_number", "property_address", "list_price", "parcel_acres", "image_url", "video_url", "lot_page_url"] as const;

export default function LotsPage() {
  const { slug } = useParams<{ slug: string }>();
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [rows, setRows] = useState<Props[] | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Props | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, fc] = await Promise.all([
      jget<MapConfig>(`/api/dev/${slug}/config?state=draft`),
      jget<GeoJSON.FeatureCollection>(`/api/dev/${slug}/parcels?state=draft`),
    ]);
    setConfig(c);
    setRows(fc.features.map((f) => f.properties as Props));
  }, [slug]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const statusId = useCallback(
    (name: string | null) => config?.statuses.find((s) => s.name === name)?.id ?? null,
    [config]
  );

  async function setStatus(row: Props, name: string) {
    const id = statusId(name);
    await jsend(`/api/parcel/${row.rowId}`, "PATCH", { patch: { status_id: id } });
    const color = config?.statuses.find((s) => s.name === name)?.color ?? null;
    setRows((rs) => (rs ?? []).map((r) => (r.rowId === row.rowId ? { ...r, status: name, status_color: color } : r)));
  }

  async function removeParcel(rowId: string) {
    setRemoving(rowId);
    try {
      await jsend(`/api/parcel/${rowId}`, "DELETE");
      setRows((rs) => (rs ?? []).filter((r) => r.rowId !== rowId));
      setEditing((e) => (e?.rowId === rowId ? null : e));
    } finally {
      setRemoving(null);
      setConfirmRemove(null);
    }
  }

  const all = useMemo(() => rows ?? [], [rows]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter((r) =>
      [r.lot_number, r.parcel_id, r.property_address, r.status].some((v) => String(v ?? "").toLowerCase().includes(s))
    );
  }, [all, q]);

  // Per-status tally, derived from rows in config order (like the Overview breakdown).
  const tally = useMemo(() => {
    if (!config) return [] as Array<{ status: Status; count: number }>;
    return config.statuses
      .map((status) => ({ status, count: all.filter((r) => r.status === status.name).length }))
      .filter((t) => t.count > 0);
  }, [config, all]);

  const search = (
    <div className="relative">
      <svg
        viewBox="0 0 16 16"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search lot #, address, status…"
        className={fieldClass("w-72 pl-9")}
      />
    </div>
  );

  const loading = rows === null;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Inventory · ${config?.development.name ?? "…"}`}
        title="Lots"
        description="Click a status to change it instantly, or open a lot to edit its details."
        actions={search}
      />

      {/* Per-status tally strip — a scannable gauge of inventory state. */}
      {!loading && tally.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
          {tally.map(({ status, count }) => (
            <div key={status.id} className="flex items-center gap-2">
              <Dot color={status.color} />
              <span className="text-[13px] text-graphite">{status.name}</span>
              <span className="font-mono text-[13px] font-medium text-ink tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      )}

      <Section
        title="Inventory"
        action={
          !loading && all.length > 0 ? (
            <span className="font-mono text-[11px] tracking-[0.1em] text-faint tabular-nums">
              SHOWING {filtered.length} OF {all.length}
            </span>
          ) : undefined
        }
        className="p-0"
      >
        <div className="-m-5">
          {loading ? (
            <div className="space-y-px p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-1.5">
                  <Skeleton className="h-3.5 w-12" />
                  <Skeleton className="h-3.5 w-56" />
                  <Skeleton className="ml-auto h-3.5 w-16" />
                  <Skeleton className="h-7 w-28 rounded-[var(--radius-sm)]" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            all.length === 0 ? (
              <EmptyState
                title="No lots yet"
                hint="Lots appear here once you bring parcels in from the county. Add parcels to start managing status, price, and details."
                action={
                  <a href={devPath(slug, "parcels")}>
                    <Button variant="brass" size="sm">
                      Add parcels
                    </Button>
                  </a>
                }
              />
            ) : (
              <EmptyState
                title="No matches"
                hint={`Nothing matches “${q.trim()}”. Try a different lot number, address, or status.`}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setQ("")}>
                    Clear search
                  </Button>
                }
              />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-panel-2/70 text-left">
                    <th className="py-3 pl-5 pr-4">
                      <span className="eyebrow">Lot</span>
                    </th>
                    <th className="px-4 py-3">
                      <span className="eyebrow">Address</span>
                    </th>
                    <th className="px-4 py-3 text-right">
                      <span className="eyebrow">Acres</span>
                    </th>
                    <th className="px-4 py-3 text-right">
                      <span className="eyebrow">Price</span>
                    </th>
                    <th className="px-4 py-3">
                      <span className="eyebrow">Status</span>
                    </th>
                    <th className="py-3 pl-4 pr-5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-2">
                  {filtered.map((r) => {
                    const color = String(r.status_color ?? "#cbd5e1");
                    const rawPrice = String(r.list_price ?? "");
                    const price = money(rawPrice) || rawPrice;
                    return (
                      <tr key={String(r.rowId)} className="group relative transition hover:bg-panel-2/50">
                        <td className="relative py-2.5 pl-5 pr-4">
                          {/* Status rail — inventory state scannable down the left edge. */}
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-1 left-0 w-[3px] rounded-full"
                            style={{ background: color }}
                          />
                          <span className="font-mono text-[13px] font-medium text-ink tabular-nums">
                            {String(r.lot_number ?? r.parcel_id ?? "—")}
                          </span>
                        </td>
                        <td className="max-w-xs truncate px-4 py-2.5 text-graphite">
                          {String(r.property_address ?? "") || <span className="text-faint">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[13px] text-ink-1 tabular-nums">
                          {String(r.parcel_acres ?? "") || <span className="text-faint">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[13px] tabular-nums">
                          {price ? (
                            <span className="text-ink-1">{price}</span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-transparent pl-2.5 pr-1.5 transition hover:border-line hover:bg-panel-2 has-[:focus-visible]:border-line has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink/10">
                            <Dot color={color} />
                            <select
                              value={String(r.status ?? "")}
                              onChange={(e) => setStatus(r, e.target.value)}
                              className="h-8 cursor-pointer appearance-none bg-transparent pr-1 text-[13px] text-ink-1 focus:outline-none"
                            >
                              {config?.statuses.map((s) => (
                                <option key={s.id} value={s.name}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                            <svg
                              viewBox="0 0 12 12"
                              className="pointer-events-none h-3 w-3 text-faint"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                        </td>
                        <td className="py-2.5 pl-4 pr-5">
                          <div
                            className="flex items-center justify-end gap-1.5"
                            onMouseLeave={() => setConfirmRemove((c) => (c === r.rowId ? null : c))}
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(r)}
                              className="opacity-70 group-hover:opacity-100"
                            >
                              Edit
                            </Button>
                            {confirmRemove === r.rowId ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={removing === r.rowId}
                                onClick={() => removeParcel(String(r.rowId))}
                                className="border-danger/40 bg-danger/5 text-danger-ink hover:border-danger/60 hover:bg-danger/10"
                              >
                                {removing === r.rowId ? "Removing…" : "Confirm"}
                              </Button>
                            ) : (
                              <Button
                                variant="subtle"
                                size="sm"
                                onClick={() => setConfirmRemove(String(r.rowId))}
                                className="text-faint opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-danger-ink"
                              >
                                Remove
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {editing && config && (
        <EditDrawer
          row={editing}
          fields={config.fields}
          statuses={config.statuses.map((s) => s.name)}
          saving={saving}
          removing={removing === editing.rowId}
          onDelete={() => removeParcel(String(editing.rowId))}
          onClose={() => setEditing(null)}
          onSave={async (patch, properties, statusName) => {
            setSaving(true);
            try {
              const body: { patch: Record<string, unknown>; properties: Record<string, unknown> } = {
                patch: { ...patch },
                properties,
              };
              if (statusName !== undefined) body.patch.status_id = statusId(statusName);
              await jsend(`/api/parcel/${editing.rowId}`, "PATCH", body);
              await load();
              setEditing(null);
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </div>
  );
}

/* ---- Drawer sub-section label: mono eyebrow sitting over a hairline rule --- */
function DrawerGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div>
        <Eyebrow>{label}</Eyebrow>
        <div className="rule mt-2" />
      </div>
      {children}
    </div>
  );
}

function EditDrawer({
  row,
  fields,
  statuses,
  saving,
  removing,
  onClose,
  onSave,
  onDelete,
}: {
  row: Props;
  fields: FieldDef[];
  statuses: string[];
  saving: boolean;
  removing: boolean;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>, properties: Record<string, unknown>, statusName?: string) => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState<Props>({ ...row });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  function save() {
    const patch: Record<string, unknown> = {};
    for (const k of CORE) patch[k] = form[k] ?? null;
    const properties: Record<string, unknown> = {};
    for (const fd of fields) properties[fd.key] = form[fd.key] ?? null;
    onSave(patch, properties, String(form.status ?? ""));
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-line bg-panel shadow-[var(--shadow-pop)]">
        <div className="flex items-center justify-between border-b border-line-2 px-6 py-4">
          <div>
            <Eyebrow>Edit lot</Eyebrow>
            <h2 className="mt-1 font-display text-lg font-bold tracking-[-0.02em] text-ink">
              Lot {String(form.lot_number ?? form.parcel_id ?? "")}
            </h2>
          </div>
          <Button variant="subtle" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
          <DrawerGroup label="Status & identity">
            <Field label="Status">
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                >
                  <Dot color={String(row.status_color ?? "#cbd5e1")} />
                </span>
                <select
                  value={String(form.status ?? "")}
                  onChange={(e) => set("status", e.target.value)}
                  className={fieldClass("pl-8")}
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="Lot number">
              <TextInput value={form.lot_number} onChange={(v) => set("lot_number", v)} />
            </Field>
            <Field label="Address">
              <TextInput value={form.property_address} onChange={(v) => set("property_address", v)} />
            </Field>
          </DrawerGroup>

          <DrawerGroup label="Pricing">
            <div className="grid grid-cols-2 gap-3">
              <Field label="List price">
                <TextInput value={form.list_price} onChange={(v) => set("list_price", v)} />
              </Field>
              <Field label="Acres">
                <TextInput value={form.parcel_acres} onChange={(v) => set("parcel_acres", v)} />
              </Field>
            </div>
          </DrawerGroup>

          <DrawerGroup label="Media & links">
            <Field label="Image URL">
              <TextInput value={form.image_url} onChange={(v) => set("image_url", v)} />
            </Field>
            <Field label="Video URL">
              <TextInput value={form.video_url} onChange={(v) => set("video_url", v)} />
            </Field>
            <Field label="Lot page URL">
              <TextInput value={form.lot_page_url} onChange={(v) => set("lot_page_url", v)} />
            </Field>
          </DrawerGroup>

          {fields.length > 0 && (
            <DrawerGroup label="Custom fields">
              {fields.map((fd) => (
                <Field key={fd.id} label={fd.label}>
                  {fd.type === "select" ? (
                    <select
                      value={String(form[fd.key] ?? "")}
                      onChange={(e) => set(fd.key, e.target.value)}
                      className={fieldClass(String(form[fd.key] ?? "") ? "" : "text-faint")}
                    >
                      <option value="">Not set</option>
                      {(fd.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : fd.type === "bool" ? (
                    <label className="inline-flex items-center gap-2 text-sm text-ink-1">
                      <input
                        type="checkbox"
                        checked={!!form[fd.key]}
                        onChange={(e) => set(fd.key, e.target.checked)}
                        className="h-4 w-4 accent-[color:var(--color-ink)]"
                      />
                      Enabled
                    </label>
                  ) : (
                    <TextInput value={form[fd.key]} onChange={(v) => set(fd.key, v)} />
                  )}
                </Field>
              ))}
            </DrawerGroup>
          )}
        </div>

        <div className="space-y-3 border-t border-line-2 px-6 py-4">
          <Button variant="primary" onClick={save} disabled={saving || removing} className="w-full">
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {confirmingDelete ? (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-3.5 py-2.5">
              <span className="text-[12.5px] leading-snug text-danger-ink">
                Remove this lot from the map? Its status, price, and details are deleted with it.
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="subtle" size="sm" onClick={() => setConfirmingDelete(false)} disabled={removing}>
                  Keep
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  disabled={removing}
                  className="border-danger/40 bg-danger/5 text-danger-ink hover:border-danger/60 hover:bg-danger/10"
                >
                  {removing ? "Removing…" : "Remove"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-[13px] font-medium text-danger-ink transition hover:underline"
              >
                Remove lot from map
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
