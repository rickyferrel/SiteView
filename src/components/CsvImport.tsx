"use client";

// CSV lot enrichment wizard: Upload → Match rows → Map columns → Review & apply.
// The file never leaves the browser; a resolved plan (row → lot assignments,
// column → field mappings, conflict decisions) is what gets POSTed, so the
// review numbers are exactly what the server applies. Blank cells never write,
// and everything lands in the draft — the public map changes only on publish.

import { useMemo, useRef, useState } from "react";
import { jsend } from "@/lib/client";
import { Modal } from "@/components/Modal";
import { Button, Eyebrow, TextInput, cx, fieldClass } from "@/components/ui";
import type { FieldType, MapConfig } from "@/lib/types";
import {
  parseCsv,
  buildLotIndex,
  matchLot,
  bestMatchColumn,
  guessCoreTarget,
  guessFieldType,
  fieldKeyFromLabel,
  parseCsvBool,
  normKey,
  CORE_TARGETS,
  RESERVED_FIELD_KEYS,
  type ParsedCsv,
  type LotRef,
  type CoreKey,
} from "@/lib/csv";

type LotRow = Record<string, unknown>;

type Target =
  | { kind: "skip" }
  | { kind: "core"; key: CoreKey }
  | { kind: "status" }
  | { kind: "field"; key: string } // existing custom field
  | { kind: "new"; label: string; type: FieldType; options: string[] | null };

type Step = "upload" | "match" | "map" | "review" | "done";

type RowState = "matched" | "manual" | "ambiguous" | "unmatched" | "duplicate" | "skipped";

type ApplyResult = { updated: number; fieldsCreated: number; statusesCreated: number };

const FIELD_TYPES: Array<{ key: FieldType; label: string }> = [
  { key: "text", label: "Text" },
  { key: "number", label: "Number" },
  { key: "money", label: "Money" },
  { key: "url", label: "URL" },
  { key: "select", label: "Select" },
  { key: "bool", label: "Yes / No" },
];

const CHANGE_PREVIEW_CAP = 200;

export default function CsvImport({
  slug,
  config,
  lots,
  onClose,
  onDone,
}: {
  slug: string;
  config: MapConfig;
  lots: LotRow[];
  onClose: () => void;
  /** Called after a successful apply so the page refetches config + lots. */
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [matchCol, setMatchCol] = useState(0);
  // Per-row manual assignment: rowId, or "" for "skip this row".
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [mappings, setMappings] = useState<Target[]>([]);
  const [overwrite, setOverwrite] = useState(true);
  // Unknown status value → create it? Absent means yes (the default).
  const [statusCreate, setStatusCreate] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  const lotRefs = useMemo<LotRef[]>(
    () =>
      lots.map((r) => ({
        rowId: String(r.rowId),
        parcel_id: String(r.parcel_id ?? ""),
        lot_number: r.lot_number == null ? null : String(r.lot_number),
        property_address: r.property_address == null ? null : String(r.property_address),
      })),
    [lots]
  );
  const byRowId = useMemo(() => new Map(lots.map((r) => [String(r.rowId), r])), [lots]);
  const index = useMemo(() => buildLotIndex(lotRefs), [lotRefs]);
  const fieldsByKey = useMemo(() => new Map(config.fields.map((f) => [f.key, f])), [config.fields]);
  const statusCanonical = useMemo(
    () => new Map(config.statuses.map((s) => [s.name.toLowerCase(), s.name])),
    [config.statuses]
  );

  function lotLabel(ref: { lot_number: string | null; parcel_id: string; property_address?: string | null }) {
    const id = ref.lot_number ? `Lot ${ref.lot_number}` : ref.parcel_id;
    return ref.property_address ? `${id} — ${ref.property_address}` : id;
  }

  // ---- Upload ---------------------------------------------------------------

  function columnValues(parsed: ParsedCsv, c: number, cap = 200): string[] {
    const out: string[] = [];
    for (const r of parsed.rows) {
      const v = r[c];
      if (v) out.push(v);
      if (out.length >= cap) break;
    }
    return out;
  }

  function initialMapping(parsed: ParsedCsv, c: number, idCol: number): Target {
    if (c === idCol) return { kind: "skip" }; // it identifies the lot
    const vals = columnValues(parsed, c);
    if (vals.length === 0) return { kind: "skip" };
    const core = guessCoreTarget(parsed.headers[c]);
    if (core === "status") return { kind: "status" };
    if (core) return { kind: "core", key: core };
    const h = normKey(parsed.headers[c]);
    const existing = config.fields.find((f) => normKey(f.label) === h || normKey(f.key) === h);
    if (existing) return { kind: "field", key: existing.key };
    return { kind: "new", label: parsed.headers[c], ...guessFieldType(vals) };
  }

  async function readFile(file: File) {
    setError(null);
    try {
      const parsed = parseCsv(await file.text());
      // Sample the first 500 rows to pick the identifier column — plenty to win.
      const idCol = bestMatchColumn(parsed.headers, parsed.rows.slice(0, 500), index);
      setCsv(parsed);
      setFileName(file.name);
      setMatchCol(idCol);
      setMappings(parsed.headers.map((_, c) => initialMapping(parsed, c, idCol)));
      setOverrides({});
      setStatusCreate({});
      setOnlyIssues(true);
      setStep("match");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function changeMatchCol(next: number) {
    if (!csv) return;
    const prev = matchCol;
    setMatchCol(next);
    setOverrides({});
    // The new identifier column stops being data; the old one gets a fresh guess.
    setMappings((ms) =>
      ms.map((m, c) => (c === next ? { kind: "skip" } : c === prev ? initialMapping(csv, c, next) : m))
    );
  }

  // ---- Row assignment ---------------------------------------------------------

  const rowAssign = useMemo(() => {
    if (!csv) return [];
    const out: Array<{ state: RowState; rowId: string | null; ambiguous: LotRef[] }> = [];
    const used = new Set<string>();
    for (let i = 0; i < csv.rows.length; i++) {
      const ov = overrides[i];
      let state: RowState;
      let rowId: string | null = null;
      let ambiguous: LotRef[] = [];
      if (ov === "") {
        state = "skipped";
      } else if (ov) {
        state = "manual";
        rowId = ov;
      } else {
        const m = matchLot(index, csv.rows[i][matchCol] ?? "");
        if (m.lot) {
          state = "matched";
          rowId = m.lot.rowId;
        } else if (m.ambiguous.length > 0) {
          state = "ambiguous";
          ambiguous = m.ambiguous;
        } else {
          state = "unmatched";
        }
      }
      // Two CSV rows on the same lot: first one wins, the rest are flagged.
      if (rowId) {
        if (used.has(rowId)) {
          state = "duplicate";
        } else {
          used.add(rowId);
        }
      }
      out.push({ state, rowId, ambiguous });
    }
    return out;
  }, [csv, matchCol, overrides, index]);

  const matchStats = useMemo(() => {
    let matched = 0;
    let issues = 0;
    let skipped = 0;
    for (const a of rowAssign) {
      if ((a.state === "matched" || a.state === "manual") && a.rowId) matched++;
      else if (a.state === "skipped") skipped++;
      else issues++;
    }
    return { matched, issues, skipped };
  }, [rowAssign]);

  // ---- Column mapping validation ------------------------------------------------

  const mappingProblems = useMemo(() => {
    const byTarget = new Map<string, number[]>();
    const problems = new Map<number, string>();
    mappings.forEach((m, c) => {
      if (m.kind === "skip") return;
      const id =
        m.kind === "core" ? `core:${m.key}` : m.kind === "status" ? "status" : m.kind === "field" ? `field:${m.key}` : `new:${normKey(m.label)}`;
      const a = byTarget.get(id);
      if (a) a.push(c);
      else byTarget.set(id, [c]);
      if (m.kind === "new" && !m.label.trim()) problems.set(c, "Give this new field a name.");
    });
    for (const cols of byTarget.values()) {
      if (cols.length > 1) for (const c of cols) problems.set(c, "Two columns point at the same field — skip one.");
    }
    return problems;
  }, [mappings]);

  const mappedCount = mappings.filter((m) => m.kind !== "skip").length;

  // ---- The plan: exactly what Apply will send ------------------------------------

  const plan = useMemo(() => {
    const empty = {
      updates: [] as Array<{ rowId: string; core?: Record<string, string>; statusName?: string; properties?: Record<string, unknown> }>,
      newFields: [] as Array<{ key: string; label: string; type: FieldType; options: string[] | null }>,
      unknownStatuses: [] as string[],
      newStatuses: [] as string[],
      cellsWritten: 0,
      cellsKept: 0,
      cellsUnchanged: 0,
      rowsSkipped: 0,
      changes: [] as Array<{ lot: string; field: string; from: string; to: string }>,
      changesTotal: 0,
    };
    if (!csv) return empty;

    // Mint keys for new-field columns up front so properties + defs agree.
    const taken = new Set<string>([...config.fields.map((f) => f.key), ...RESERVED_FIELD_KEYS]);
    const newKeyByCol = new Map<number, string>();
    mappings.forEach((m, c) => {
      if (m.kind !== "new") return;
      const key = fieldKeyFromLabel(m.label, taken);
      taken.add(key);
      newKeyByCol.set(c, key);
    });

    const p = empty;
    const usedNewCols = new Set<number>();
    const unknownSeen = new Set<string>();
    const newStatusSet = new Set<string>();

    for (let i = 0; i < csv.rows.length; i++) {
      const a = rowAssign[i];
      if (!a || !a.rowId || (a.state !== "matched" && a.state !== "manual")) {
        p.rowsSkipped++;
        continue;
      }
      const lot = byRowId.get(a.rowId);
      if (!lot) {
        p.rowsSkipped++;
        continue;
      }
      const label = lot.lot_number ? `Lot ${lot.lot_number}` : String(lot.parcel_id ?? a.rowId);
      const core: Record<string, string> = {};
      const properties: Record<string, unknown> = {};
      let statusName: string | undefined;

      for (let c = 0; c < csv.headers.length; c++) {
        const m = mappings[c];
        if (!m || m.kind === "skip") continue;
        const raw = csv.rows[i][c];
        if (!raw) continue; // blanks never write, never erase

        const push = (field: string, from: string, to: string) => {
          p.cellsWritten++;
          p.changesTotal++;
          if (p.changes.length < CHANGE_PREVIEW_CAP) p.changes.push({ lot: label, field, from: from || "—", to });
        };

        if (m.kind === "status") {
          const cur = String(lot.status ?? "");
          const existing = statusCanonical.get(raw.toLowerCase());
          if (!existing && !unknownSeen.has(raw)) {
            unknownSeen.add(raw);
            p.unknownStatuses.push(raw);
          }
          if (!overwrite && cur) {
            p.cellsKept++;
            continue;
          }
          if (existing) {
            if (existing.toLowerCase() === cur.toLowerCase()) p.cellsUnchanged++;
            else {
              statusName = existing;
              push("Status", cur, existing);
            }
          } else if (statusCreate[raw] ?? true) {
            newStatusSet.add(raw);
            statusName = raw;
            push("Status", cur, raw);
          }
          continue;
        }

        let key: string;
        let fieldLabel: string;
        let cur: unknown;
        let isBool = false;
        if (m.kind === "core") {
          key = m.key;
          fieldLabel = CORE_TARGETS.find((t) => t.key === m.key)?.label ?? m.key;
          cur = lot[key];
        } else if (m.kind === "field") {
          key = m.key;
          const fd = fieldsByKey.get(m.key);
          fieldLabel = fd?.label ?? m.key;
          isBool = fd?.type === "bool";
          cur = lot[key];
        } else {
          key = newKeyByCol.get(c) ?? m.label;
          fieldLabel = m.label;
          isBool = m.type === "bool";
          cur = undefined;
        }

        const value: string | boolean = isBool ? parseCsvBool(raw) : raw;
        const curStr = cur == null ? "" : String(cur);
        if (!overwrite && curStr !== "") {
          p.cellsKept++;
          continue;
        }
        if (String(value) === curStr) {
          p.cellsUnchanged++;
          continue;
        }
        if (m.kind === "core") core[key] = raw;
        else properties[key] = value;
        if (m.kind === "new") usedNewCols.add(c);
        push(fieldLabel, curStr, String(value));
      }

      const u: (typeof p.updates)[number] = { rowId: a.rowId };
      if (Object.keys(core).length) u.core = core;
      if (Object.keys(properties).length) u.properties = properties;
      if (statusName !== undefined) u.statusName = statusName;
      if (u.core || u.properties || u.statusName !== undefined) p.updates.push(u);
    }

    mappings.forEach((m, c) => {
      if (m.kind === "new" && usedNewCols.has(c)) {
        p.newFields.push({
          key: newKeyByCol.get(c)!,
          label: m.label.trim(),
          type: m.type,
          options: m.type === "select" ? m.options : null,
        });
      }
    });
    p.newStatuses = [...newStatusSet];
    return p;
  }, [csv, rowAssign, mappings, overwrite, statusCreate, byRowId, fieldsByKey, statusCanonical, config.fields]);

  // ---- Apply ---------------------------------------------------------------------

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const res = await jsend<ApplyResult>(`/api/dev/${slug}/import`, "POST", {
        mode: "csv",
        csv: { newFields: plan.newFields, newStatuses: plan.newStatuses, updates: plan.updates },
      });
      setResult(res);
      setStep("done");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  // ---- UI --------------------------------------------------------------------------

  const steps: Array<{ key: Step; label: string }> = [
    { key: "upload", label: "Upload" },
    { key: "match", label: "Match rows" },
    { key: "map", label: "Map columns" },
    { key: "review", label: "Review" },
  ];

  const visibleRows = useMemo(() => {
    if (!csv) return [];
    const idxs = csv.rows.map((_, i) => i);
    if (!onlyIssues) return idxs;
    return idxs.filter((i) => {
      const s = rowAssign[i]?.state;
      return s === "ambiguous" || s === "unmatched" || s === "duplicate";
    });
  }, [csv, onlyIssues, rowAssign]);

  const stateChip: Record<RowState, { label: string; cls: string }> = {
    matched: { label: "Matched", cls: "bg-[color-mix(in_srgb,#5e8c61_14%,transparent)] text-[#3d6440]" },
    manual: { label: "Assigned", cls: "bg-[color-mix(in_srgb,#5e8c61_14%,transparent)] text-[#3d6440]" },
    ambiguous: { label: "Ambiguous", cls: "bg-[color-mix(in_srgb,#c6a75e_18%,transparent)] text-[#7a5f22]" },
    unmatched: { label: "No match", cls: "bg-danger/10 text-danger-ink" },
    duplicate: { label: "Duplicate", cls: "bg-[color-mix(in_srgb,#c6a75e_18%,transparent)] text-[#7a5f22]" },
    skipped: { label: "Skipped", cls: "bg-panel-2 text-faint" },
  };

  function targetValue(m: Target): string {
    if (m.kind === "skip") return "skip";
    if (m.kind === "status") return "status";
    if (m.kind === "core") return `core:${m.key}`;
    if (m.kind === "field") return `field:${m.key}`;
    return "new";
  }

  function setTarget(c: number, v: string) {
    if (!csv) return;
    setMappings((ms) =>
      ms.map((m, i) => {
        if (i !== c) return m;
        if (v === "skip") return { kind: "skip" };
        if (v === "status") return { kind: "status" };
        if (v.startsWith("core:")) return { kind: "core", key: v.slice(5) as CoreKey };
        if (v.startsWith("field:")) return { kind: "field", key: v.slice(6) };
        return { kind: "new", label: csv.headers[c], ...guessFieldType(columnValues(csv, c)) };
      })
    );
  }

  function setNewField(c: number, patch: Partial<{ label: string; type: FieldType }>) {
    if (!csv) return;
    setMappings((ms) =>
      ms.map((m, i) => {
        if (i !== c || m.kind !== "new") return m;
        const type = patch.type ?? m.type;
        const options =
          type === "select"
            ? m.options ?? [...new Set(columnValues(csv, c))].slice(0, 24)
            : null;
        return { ...m, ...patch, type, options };
      })
    );
  }

  const busy = applying;

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      eyebrow="Lots · Spreadsheet"
      title="Import from CSV"
      className="!max-w-3xl"
    >
      <div className="space-y-5">
        {/* Step rail */}
        {step !== "done" && (
          <div className="flex items-center gap-2">
            {steps.map((s, i) => {
              const activeIdx = steps.findIndex((x) => x.key === step);
              const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
              return (
                <div key={s.key} className="flex items-center gap-2">
                  {i > 0 && <div className="h-px w-5 bg-line" />}
                  <span
                    className={cx(
                      "font-mono text-[10.5px] uppercase tracking-[0.14em]",
                      state === "active" ? "text-ink" : state === "done" ? "text-graphite" : "text-faint"
                    )}
                  >
                    {i + 1} · {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ---- Step: upload ---- */}
        {step === "upload" && (
          <div className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv,.txt,.tsv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
            {lots.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-graphite">
                There are no lots to update yet — a CSV enriches lots that already exist. Import
                parcels first, then bring your spreadsheet.
              </p>
            ) : (
              <>
                <button
                  onClick={() => inputRef.current?.click()}
                  className="flex w-full flex-col items-center gap-2.5 rounded-[var(--radius-lg)] border-2 border-dashed border-line bg-panel-2/40 px-8 py-10 text-center transition hover:border-ink/30 hover:bg-panel-2/70"
                >
                  <svg viewBox="0 0 24 24" className="h-7 w-7 text-faint" fill="none" aria-hidden="true">
                    <path d="M12 16V5m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <span className="text-[14px] font-semibold text-ink">Choose a .csv file</span>
                  <span className="max-w-md text-[12.5px] leading-relaxed text-faint">
                    Export from Excel or Google Sheets. One row per lot, with a column that
                    identifies the lot — a lot number, parcel ID, or address. You&apos;ll match rows
                    and map columns before anything changes.
                  </span>
                </button>
                <p className="text-[12px] leading-relaxed text-faint">
                  {lots.length.toLocaleString()} lot{lots.length === 1 ? "" : "s"} available to
                  match. Updates land in your draft — the public map changes only when you publish.
                </p>
              </>
            )}
          </div>
        )}

        {/* ---- Step: match rows ---- */}
        {step === "match" && csv && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="block">
                <span className="eyebrow !tracking-[0.12em]">Lot identifier column</span>
                <select
                  value={matchCol}
                  onChange={(e) => changeMatchCol(Number(e.target.value))}
                  className={cx(fieldClass(), "mt-1.5 w-64")}
                >
                  {csv.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pb-1 font-mono text-[12px] text-graphite tabular-nums">
                <span className="font-medium text-ink">{matchStats.matched}</span> of {csv.rows.length} rows
                matched
                {matchStats.issues > 0 && (
                  <span className="text-[#7a5f22]"> · {matchStats.issues} need attention</span>
                )}
              </div>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-graphite">
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(e) => setOnlyIssues(e.target.checked)}
                className="h-3.5 w-3.5 accent-[color:var(--color-ink)]"
              />
              Only show rows that need attention
            </label>

            <div className="max-h-[44vh] overflow-auto rounded-[var(--radius)] border border-line">
              {visibleRows.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-faint">
                  {onlyIssues ? "Every row is matched — nothing needs attention." : "No rows."}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-panel-2">
                    <tr className="border-b border-line text-left">
                      <th className="py-2 pl-4 pr-3"><span className="eyebrow">CSV row</span></th>
                      <th className="px-3 py-2"><span className="eyebrow">Match</span></th>
                      <th className="px-3 py-2"><span className="eyebrow">Lot</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-2">
                    {visibleRows.map((i) => {
                      const a = rowAssign[i];
                      const chip = stateChip[a.state];
                      return (
                        <tr key={i} className="align-middle">
                          <td className="max-w-[180px] truncate py-2 pl-4 pr-3 font-mono text-[12.5px] text-ink">
                            {csv.rows[i][matchCol] || <span className="text-faint">(empty)</span>}
                          </td>
                          <td className="px-3 py-2">
                            <span className={cx("inline-block rounded-full px-2 py-0.5 text-[11px] font-medium", chip.cls)}>
                              {chip.label}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={a.rowId ?? "__none"}
                              onChange={(e) =>
                                setOverrides((o) => ({ ...o, [i]: e.target.value === "__none" ? "" : e.target.value }))
                              }
                              className={cx(fieldClass("h-8 text-[12.5px]"), "w-full max-w-[340px]")}
                            >
                              <option value="__none">{a.state === "ambiguous" ? "Choose a lot…" : "Skip this row"}</option>
                              {a.ambiguous.length > 0 && (
                                <optgroup label="Possible matches">
                                  {a.ambiguous.map((l) => (
                                    <option key={l.rowId} value={l.rowId}>
                                      {lotLabel(l)}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              <optgroup label={a.ambiguous.length > 0 ? "All lots" : "Lots"}>
                                {lotRefs.map((l) => (
                                  <option key={l.rowId} value={l.rowId}>
                                    {lotLabel(l)}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {rowAssign.some((a) => a.state === "duplicate") && (
              <p className="text-[12px] leading-relaxed text-faint">
                Duplicate rows point at a lot another row already updates — the first row wins and
                the duplicates are skipped, unless you reassign them.
              </p>
            )}
          </div>
        )}

        {/* ---- Step: map columns ---- */}
        {step === "map" && csv && (
          <div className="space-y-4">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-1">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                className="h-3.5 w-3.5 accent-[color:var(--color-ink)]"
              />
              Overwrite existing values
              <span className="text-[12px] text-faint">— off: only fill blanks. Empty cells never erase data.</span>
            </label>

            <div className="max-h-[48vh] space-y-2 overflow-auto pr-1">
              {csv.headers.map((h, c) => {
                const m = mappings[c];
                const problem = mappingProblems.get(c);
                const samples = [...new Set(columnValues(csv, c, 40))].slice(0, 3);
                return (
                  <div
                    key={c}
                    className={cx(
                      "rounded-[var(--radius)] border px-3.5 py-3",
                      problem ? "border-danger/40 bg-danger/5" : "border-line bg-panel"
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-[12.5px] font-medium text-ink">{h}</span>
                          {c === matchCol && (
                            <span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10.5px] font-medium text-faint">
                              identifier
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-faint">
                          {samples.length ? samples.join(" · ") : "(all cells empty)"}
                        </div>
                      </div>
                      <select
                        value={targetValue(m)}
                        onChange={(e) => setTarget(c, e.target.value)}
                        className={cx(fieldClass("h-8 text-[12.5px]"), "w-56 shrink-0")}
                      >
                        <option value="skip">Don&apos;t import</option>
                        <optgroup label="Lot fields">
                          {CORE_TARGETS.map((t) => (
                            <option key={t.key} value={`core:${t.key}`}>
                              {t.label}
                            </option>
                          ))}
                          <option value="status">Status</option>
                        </optgroup>
                        {config.fields.length > 0 && (
                          <optgroup label="Custom fields">
                            {config.fields.map((f) => (
                              <option key={f.key} value={`field:${f.key}`}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="new">＋ New field…</option>
                      </select>
                    </div>
                    {m.kind === "new" && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line-2 pt-2.5">
                        <TextInput
                          value={m.label}
                          onChange={(v) => setNewField(c, { label: v })}
                          placeholder="Field name"
                          className="!h-8 w-52 text-[12.5px]"
                        />
                        <select
                          value={m.type}
                          onChange={(e) => setNewField(c, { type: e.target.value as FieldType })}
                          className={cx(fieldClass("h-8 text-[12.5px]"), "w-32")}
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        {m.type === "select" && m.options && (
                          <span className="min-w-0 flex-1 truncate text-[12px] text-faint">
                            Options: {m.options.join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                    {problem && <p className="mt-2 text-[12px] font-medium text-danger-ink">{problem}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- Step: review ---- */}
        {step === "review" && csv && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Lots updated", value: plan.updates.length },
                { label: "Values written", value: plan.cellsWritten },
                {
                  label: overwrite ? "Already up to date" : "Existing kept",
                  value: overwrite ? plan.cellsUnchanged : plan.cellsKept + plan.cellsUnchanged,
                },
                { label: "Rows skipped", value: plan.rowsSkipped },
              ].map((s) => (
                <div key={s.label} className="rounded-[var(--radius)] border border-line bg-panel-2/50 px-3.5 py-3">
                  <div className="font-mono text-[22px] font-medium leading-none tracking-[-0.02em] text-ink tabular-nums">
                    {s.value.toLocaleString()}
                  </div>
                  <div className="mt-1.5 text-[11.5px] text-faint">{s.label}</div>
                </div>
              ))}
            </div>

            {plan.newFields.length > 0 && (
              <div>
                <Eyebrow>New fields</Eyebrow>
                <ul className="mt-2 space-y-1">
                  {plan.newFields.map((f) => (
                    <li key={f.key} className="text-[13px] text-ink-1">
                      <span className="font-medium text-ink">{f.label}</span>
                      <span className="text-faint"> — {FIELD_TYPES.find((t) => t.key === f.type)?.label ?? f.type}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.unknownStatuses.length > 0 && (
              <div>
                <Eyebrow>New statuses</Eyebrow>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-faint">
                  These status values don&apos;t exist yet. Checked ones are created (you can recolor
                  them in Map Design); unchecked values are skipped.
                </p>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
                  {plan.unknownStatuses.map((v) => (
                    <label key={v} className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-1">
                      <input
                        type="checkbox"
                        checked={statusCreate[v] ?? true}
                        onChange={(e) => setStatusCreate((s) => ({ ...s, [v]: e.target.checked }))}
                        className="h-3.5 w-3.5 accent-[color:var(--color-ink)]"
                      />
                      Create “{v}”
                    </label>
                  ))}
                </div>
              </div>
            )}

            {plan.changes.length > 0 ? (
              <div>
                <Eyebrow>Changes</Eyebrow>
                <div className="mt-2 max-h-[30vh] overflow-auto rounded-[var(--radius)] border border-line">
                  <table className="w-full text-[12.5px]">
                    <tbody className="divide-y divide-line-2">
                      {plan.changes.map((ch, i) => (
                        <tr key={i}>
                          <td className="whitespace-nowrap py-1.5 pl-3.5 pr-3 font-mono text-ink">{ch.lot}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-graphite">{ch.field}</td>
                          <td className="w-full px-3 py-1.5">
                            <span className="text-faint line-through decoration-line">{ch.from}</span>
                            <span className="mx-1.5 text-faint">→</span>
                            <span className="font-medium text-ink">{ch.to}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {plan.changesTotal > plan.changes.length && (
                  <p className="mt-1.5 text-[12px] text-faint">
                    +{(plan.changesTotal - plan.changes.length).toLocaleString()} more changes not shown.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed text-graphite">
                Nothing to change — every mapped value already matches
                {overwrite ? "" : ", or the lot already has a value and overwrite is off"}.
              </p>
            )}

            <p className="text-[12px] leading-relaxed text-faint">
              Changes apply to your draft. The public map updates when you publish.
            </p>
          </div>
        )}

        {/* ---- Step: done ---- */}
        {step === "done" && result && (
          <div className="space-y-4 py-2 text-center">
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[color-mix(in_srgb,#5e8c61_14%,transparent)]">
              <svg viewBox="0 0 20 20" className="h-5 w-5 text-[#3d6440]" fill="none" aria-hidden="true">
                <path d="m5 10.5 3.5 3.5L15 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h3 className="font-display text-[17px] font-bold tracking-[-0.02em] text-ink">
                {result.updated.toLocaleString()} lot{result.updated === 1 ? "" : "s"} updated
              </h3>
              <p className="mt-1 text-[13px] text-graphite">
                {[
                  result.fieldsCreated > 0 && `${result.fieldsCreated} new field${result.fieldsCreated === 1 ? "" : "s"}`,
                  result.statusesCreated > 0 && `${result.statusesCreated} new status${result.statusesCreated === 1 ? "" : "es"}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "From " + fileName}
              </p>
              <p className="mt-2 text-[12px] text-faint">
                Everything landed in your draft — review it in Preview &amp; Publish to push it live.
              </p>
            </div>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        )}

        {error && (
          <p className="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-3.5 py-2.5 text-[12.5px] leading-snug text-danger-ink">
            {error}
          </p>
        )}

        {/* Footer nav */}
        {step !== "upload" && step !== "done" && (
          <div className="flex items-center justify-between border-t border-line-2 pt-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setStep(step === "match" ? "upload" : step === "map" ? "match" : "map")}
            >
              Back
            </Button>
            {step === "match" && (
              <Button variant="primary" size="sm" disabled={matchStats.matched === 0} onClick={() => setStep("map")}>
                Next · Map columns
              </Button>
            )}
            {step === "map" && (
              <Button
                variant="primary"
                size="sm"
                disabled={mappingProblems.size > 0 || mappedCount === 0}
                onClick={() => setStep("review")}
              >
                Next · Review
              </Button>
            )}
            {step === "review" && (
              <Button variant="primary" size="sm" disabled={busy || plan.updates.length === 0} onClick={() => void apply()}>
                {applying
                  ? "Updating…"
                  : `Update ${plan.updates.length.toLocaleString()} lot${plan.updates.length === 1 ? "" : "s"}`}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
