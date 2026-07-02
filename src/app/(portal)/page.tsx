"use client";

// The atlas — the operator's portfolio of survey sites. Every development gets a
// plate: name, its /embed coordinate, a big mono lot count, and the same
// proportional status-mix rule the dashboard draws. Primary action opens the
// site; Edit and Delete ride on the same /api/dev/{slug} contract via modals.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget } from "@/lib/client";
import type { DevelopmentSummary, MapConfig } from "@/lib/types";
import { Eyebrow, Button, EmptyState, Skeleton, cx } from "@/components/ui";
import { EditDevelopmentModal, DeleteDevelopmentModal } from "@/components/DevSettingsModals";

type Modal = { kind: "edit" | "delete"; dev: DevelopmentSummary } | null;

export default function AtlasPage() {
  const [devs, setDevs] = useState<DevelopmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevs(await jget<DevelopmentSummary[]>("/api/dev"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setDevs([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const total = devs?.length ?? 0;
  const totalLots = devs?.reduce((n, d) => n + d.parcel_count, 0) ?? 0;

  return (
    <div className="space-y-8">
      {/* Command band — the portfolio header, over the contour field. */}
      <section className="contour-field rise overflow-hidden rounded-[var(--radius-lg)] border border-line text-white shadow-[var(--shadow-pop)]">
        <div className="flex flex-wrap items-end justify-between gap-6 p-7 sm:p-9">
          <div className="max-w-xl">
            <Eyebrow className="!text-white/55">Multi-site · Atlas</Eyebrow>
            <h1 className="mt-3 font-display text-[30px] font-bold leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
              Every development you operate
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-white/65">
              Each site is one live WordPress embed. Open one to edit its lots and map, or spin up a new one.
            </p>
          </div>

          <div className="flex items-center gap-6">
            <Metric label="Sites" value={devs ? total : "—"} />
            <span className="h-9 w-px bg-white/15" aria-hidden="true" />
            <Metric label="Lots" value={devs ? totalLots : "—"} />
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Eyebrow className="!text-graphite">Your sites</Eyebrow>
          {devs && <span className="font-mono text-[11px] text-faint tabular-nums">{total}</span>}
        </div>
        <Link href="/new">
          <Button variant="brass">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            New development
          </Button>
        </Link>
      </div>
      <div className="rule -mt-4" />

      {error && (
        <div className="flex items-start gap-2.5 rounded-[var(--radius)] border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
          <span>Couldn&apos;t load your developments. Refresh to try again. ({error})</span>
        </div>
      )}

      {devs === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card min-h-[180px] p-5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-40" />
              <Skeleton className="mt-6 h-1.5 w-full rounded-full" />
              <Skeleton className="mt-6 h-8 w-full" />
            </div>
          ))}
        </div>
      ) : devs.length === 0 && !error ? (
        <div className="card">
          <EmptyState
            title="No developments yet"
            hint="Spin up your first site — name it, pick its parcels off the map, and publish a live embed for WordPress."
            action={
              <Link href="/new">
                <Button variant="brass">New development</Button>
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {devs.map((d, i) => (
            <SiteCard
              key={d.id}
              dev={d}
              index={i}
              onEdit={() => setModal({ kind: "edit", dev: d })}
              onDelete={() => setModal({ kind: "delete", dev: d })}
            />
          ))}
        </div>
      )}

      {modal?.kind === "edit" && (
        <EditDevelopmentModal
          dev={modal.dev}
          open
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal?.kind === "delete" && (
        <DeleteDevelopmentModal
          dev={modal.dev}
          open
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-right">
      <div className="font-mono text-[28px] font-medium leading-none tracking-[-0.04em] tabular-nums">{value}</div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{label}</div>
    </div>
  );
}

/* ---- Site card — the signature plate ------------------------------------- */

type Seg = { name: string; n: number; color: string };

function SiteCard({
  dev,
  index,
  onEdit,
  onDelete,
}: {
  dev: DevelopmentSummary;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  // Status mix loads lazily per card so the grid paints instantly on parcel_count.
  const [segments, setSegments] = useState<Seg[] | null>(null);

  useEffect(() => {
    let alive = true;
    async function loadMix() {
      if (dev.parcel_count === 0) {
        if (alive) setSegments([]);
        return;
      }
      try {
        const [config, fc] = await Promise.all([
          jget<MapConfig>(`/api/dev/${dev.slug}/config?state=draft`),
          jget<GeoJSON.FeatureCollection>(`/api/dev/${dev.slug}/parcels?state=draft`),
        ]);
        const counts = new Map<string, number>();
        for (const f of fc.features) {
          const s = (f.properties?.status as string) ?? "—";
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const segs = (config.statuses.length
          ? config.statuses.map((s) => ({ name: s.name, n: counts.get(s.name) ?? 0, color: s.color }))
          : [...counts.entries()].map(([n, c]) => ({ name: n, n: c, color: "#9aa3b2" }))
        ).sort((a, b) => b.n - a.n);
        if (alive) setSegments(segs);
      } catch {
        if (alive) setSegments([]);
      }
    }
    loadMix();
    return () => {
      alive = false;
    };
  }, [dev.slug, dev.parcel_count]);

  const total = dev.parcel_count;

  // The whole plate opens the site; the action row stops propagation so its
  // buttons don't also navigate. Keyboard-openable via Enter/Space.
  function open() {
    router.push(devPath(dev.slug));
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
      className={cx(
        "card rise group relative flex cursor-pointer flex-col p-5 transition",
        "hover:border-[color:var(--color-panel-3)] hover:shadow-[var(--shadow-pop)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-ink)]"
      )}
    >
      {/* brass corner tick — a survey plate's registration mark */}
      <span className="absolute right-5 top-5 h-2 w-2 rounded-full bg-brass ring-2 ring-brass-wash" aria-hidden="true" />

      <div className="min-w-0 pr-6">
        <h3 className="truncate font-display text-[19px] font-bold leading-tight tracking-[-0.02em] text-ink">
          {dev.name}
        </h3>
        <div className="mt-1 truncate font-mono text-[11px] tracking-[0.02em] text-faint">/embed/{dev.slug}</div>
      </div>

      {/* Lot count + the proportional status-mix rule. */}
      <div className="mt-5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[26px] font-medium leading-none tracking-[-0.04em] text-ink tabular-nums">
            {total}
          </span>
          <span className="text-[12px] text-graphite">{total === 1 ? "lot" : "lots"}</span>
        </div>
        <div className="mt-3">
          {segments === null ? (
            <Skeleton className="h-1.5 w-full rounded-full" />
          ) : total === 0 ? (
            <div className="h-1.5 w-full rounded-full bg-panel-2" />
          ) : (
            <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
              {segments
                .filter((s) => s.n > 0)
                .map((s) => (
                  <span
                    key={s.name}
                    title={`${s.name}: ${s.n}`}
                    style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
                  />
                ))}
            </span>
          )}
        </div>
      </div>

      {/* Action row — Open is the plate itself; these are the secondaries. */}
      <div
        className="mt-5 flex items-center gap-2 border-t border-line-2 pt-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Link
          href={devPath(dev.slug)}
          className="text-[13px] font-medium text-ink transition hover:text-brass-ink"
        >
          Open <span aria-hidden="true">→</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] font-medium text-graphite transition hover:bg-panel-2 hover:text-ink"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] font-medium text-graphite transition hover:bg-danger/5 hover:text-danger-ink"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
