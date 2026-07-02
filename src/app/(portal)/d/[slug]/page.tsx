"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DEV_SLUG, devPath } from "@/lib/const";
import { jget, jsend } from "@/lib/client";
import type { MapConfig } from "@/lib/types";
import { Eyebrow, Card, Section, Readout, Dot, Button, EmptyState, Skeleton, cx } from "@/components/ui";
import { EditDevelopmentModal, DeleteDevelopmentModal } from "@/components/DevSettingsModals";
import type { DevelopmentSummary } from "@/lib/types";

type Pub = { id: string; note: string | null; published_at: string };

// Compact relative time for the activity rail, e.g. "3h ago" / "just now".
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

const darkBtn =
  "inline-flex h-9 select-none items-center justify-center gap-2 rounded-[9px] border " +
  "border-white/15 bg-white/[0.06] px-4 text-sm font-medium text-white/90 transition " +
  "hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-45";

export default function Dashboard() {
  const { slug } = useParams<{ slug: string }>();
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [fc, setFc] = useState<GeoJSON.FeatureCollection | null>(null);
  const [pubs, setPubs] = useState<Pub[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<"edit" | "delete" | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    const [c, p, pub] = await Promise.all([
      jget<MapConfig>(`/api/dev/${slug}/config?state=draft`),
      jget<GeoJSON.FeatureCollection>(`/api/dev/${slug}/parcels?state=draft`),
      jget<Pub[]>(`/api/dev/${slug}/publish`),
    ]);
    setConfig(c);
    setFc(p);
    setPubs(pub);
  }, [slug]);

  useEffect(() => {
    load().catch((e) => setMsg(String(e)));
  }, [load]);

  async function runImport() {
    setBusy("import");
    setMsg(null);
    try {
      const r = await jsend<{ imported: number; matched: number }>(`/api/dev/${slug}/import`, "POST", {});
      setMsg(`Imported ${r.imported} parcels (matched ${r.matched} from the live map).`);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy("publish");
    setMsg(null);
    try {
      const r = await jsend<{ count: number }>(`/api/dev/${slug}/publish`, "POST", { note: "from overview" });
      setMsg(`Published ${r.count} parcels. The live map now matches your draft.`);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  }

  const counts = new Map<string, number>();
  for (const f of fc?.features ?? []) {
    const s = (f.properties?.status as string) ?? "—";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const total = fc?.features.length ?? 0;
  const empty = fc !== null && total === 0;
  const lastPub = pubs[0]?.published_at ? new Date(pubs[0].published_at).toLocaleString() : "never";
  const name = config?.development.name ?? "Workspace";
  // A summary row for the settings modals — the shape they take everywhere.
  const settingsDev: DevelopmentSummary | null = config
    ? { id: config.development.id, slug: config.development.slug, name: config.development.name, parcel_count: total }
    : null;
  const view = config?.development.default_view;
  const coords = view
    ? `${view.center[1].toFixed(4)}°N · ${Math.abs(view.center[0]).toFixed(4)}°W`
    : null;

  // The draft has unpublished edits if nothing's published yet (and lots exist),
  // or the newest publish predates this session's working draft.
  const draftAhead = total > 0 && pubs.length === 0;

  // Join the full status config with live counts so zero-count statuses still
  // appear as dimmed legend chips — keeping "Map statuses 4" honest. Fall back
  // to whatever statuses the parcels report if config hasn't loaded.
  const configured = config?.statuses ?? [];
  const segments = (
    configured.length
      ? configured.map((s) => ({ name: s.name, n: counts.get(s.name) ?? 0, color: s.color }))
      : [...counts.entries()].map(([n, c]) => ({ name: n, n: c, color: "#9aa3b2" }))
  ).sort((a, b) => b.n - a.n);

  return (
    <div className="space-y-8">
      {/* Command band — the operator's mission control, over a faint contour field */}
      <section className="contour-field rise overflow-hidden rounded-[var(--radius-lg)] border border-line text-white shadow-[var(--shadow-pop)]">
        <div className="flex flex-wrap items-start justify-between gap-7 p-7 sm:p-9">
          <div className="max-w-xl">
            <Eyebrow className="!text-white/55">{name} · Draft workspace</Eyebrow>
            <h1 className="mt-3 font-display text-[30px] font-bold leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
              The single source of truth for your live map
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-white/65">
              Edit lots and map design here, preview the exact WordPress embed, then publish to push it live.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <Button variant="brass" onClick={publish} disabled={!!busy || empty} title={empty ? "Add parcels before publishing" : undefined}>
                {busy === "publish" ? "Publishing…" : "Publish to live"}
              </Button>
              <Link href={devPath(slug, "parcels")} className={darkBtn}>
                + Add parcels
              </Link>
              {slug === DEV_SLUG && (
                <button onClick={runImport} disabled={!!busy} className={darkBtn}>
                  {busy === "import" ? "Importing…" : "Refresh from county"}
                </button>
              )}
              <a href={`/embed/${slug}`} target="_blank" rel="noreferrer" className={darkBtn}>
                Open live embed ↗
              </a>
            </div>
          </div>

          <div className="w-full max-w-[236px] rounded-[var(--radius)] border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-center justify-between gap-2">
              <Eyebrow className="!text-white/45">Deployment</Eyebrow>
              <button
                type="button"
                onClick={() => setSettings("edit")}
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/45 transition hover:text-white/80"
              >
                Settings
              </button>
            </div>
            <div className="mt-3.5">
              <DeployRow tone="bg-brass ring-brass/25" label="Working draft" value="You're editing this now" />
              <div className="ml-[5px] my-1 h-4 w-px bg-white/15" />
              <DeployRow
                tone="bg-white ring-white/20"
                label="Published live"
                value={lastPub === "never" ? "Not published yet" : lastPub}
                mono
              />
            </div>
            {coords && <div className="mt-3.5 border-t border-white/10 pt-3 font-mono text-[10px] tracking-[0.04em] text-white/40">{coords}</div>}
          </div>
        </div>
      </section>

      {msg && (
        <div className="rise flex items-start gap-2.5 rounded-[var(--radius)] border border-line bg-panel px-4 py-3 text-sm text-ink-1 shadow-[var(--shadow-card)]">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brass" />
          <span>{msg}</span>
        </div>
      )}

      {/* Empty state: a new site with no parcels yet. */}
      {empty ? (
        <Card>
          <EmptyState
            title="No parcels yet"
            hint={`Search an address, select the lots that belong to ${name}, and import them. Publishing unlocks once the map has parcels.`}
            action={
              <Link href={devPath(slug, "parcels")}>
                <Button variant="brass">Add parcels</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* AT A GLANCE — the instrument gauges */}
          <div className="space-y-3">
            <Eyebrow className="!text-graphite">At a glance</Eyebrow>
            <div className="rule" />
            <div className="grid gap-4 pt-1 sm:grid-cols-3">
              {/* Lots — a thin proportional status rule ties the count to its mix. */}
              <Link
                href={devPath(slug, "lots")}
                className="card block min-h-[136px] p-5 transition hover:border-[color:var(--color-panel-3)]"
              >
                <Readout
                  label="Lots under management"
                  value={fc ? total : "—"}
                  sub={
                    fc === null ? (
                      <Skeleton className="h-1.5 w-full rounded-full" />
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
                    )
                  }
                />
              </Link>

              {/* Map statuses — the actual status dots: where data color belongs. */}
              <Link
                href={devPath(slug, "design")}
                className="card block min-h-[136px] p-5 transition hover:border-[color:var(--color-panel-3)]"
              >
                <Readout
                  label="Map statuses"
                  value={config ? config.statuses.length : "—"}
                  sub={
                    fc === null ? (
                      <Skeleton className="h-2 w-24" />
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {segments.map((s) => (
                          <Dot key={s.name} color={s.color} size={10} />
                        ))}
                      </span>
                    )
                  }
                />
              </Link>

              {/* Publishes — last-published timestamp + a faint draft-ahead tick. */}
              <Card className="min-h-[136px] p-5">
                <Readout
                  label="Publishes"
                  value={pubs.length}
                  sub={
                    <span className="flex flex-col gap-1.5">
                      <span className="font-mono text-[11px] tracking-[0.06em] text-faint tabular-nums">
                        LAST · {lastPub}
                      </span>
                      {draftAhead && (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-graphite">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden="true" />
                          Draft ahead of live
                        </span>
                      )}
                    </span>
                  }
                />
              </Card>
            </div>
          </div>

          {/* ACTIVITY — breakdown gauge + the deploy log */}
          <div className="space-y-3">
            <Eyebrow className="!text-graphite">Activity</Eyebrow>
            <div className="rule" />
            <div className="grid gap-4 pt-1 lg:grid-cols-12">
              {/* Status breakdown */}
              <Section
                title="Status breakdown"
                className="lg:col-span-7"
                action={<span className="font-mono text-xs text-faint tabular-nums">{total} lots</span>}
              >
                {fc === null ? (
                  <div className="space-y-4">
                    <Skeleton className="h-2.5 rounded-full" />
                    <div className="flex flex-wrap gap-x-5 gap-y-2.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                  </div>
                ) : segments.length === 0 ? (
                  <p className="text-sm text-faint">No statuses configured yet.</p>
                ) : (
                  <>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-panel-2">
                      {segments
                        .filter((s) => s.n > 0)
                        .map((s) => (
                          <span
                            key={s.name}
                            title={`${s.name}: ${s.n}`}
                            style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
                          />
                        ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2.5">
                      {segments.map((s) => (
                        <div
                          key={s.name}
                          className={cx("flex items-center gap-2 text-sm", s.n === 0 && "opacity-45")}
                        >
                          <Dot color={s.color} />
                          <span className="text-ink-1">{s.name}</span>
                          <span className="font-mono text-xs text-faint tabular-nums">{s.n}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Section>

              {/* Recent publishes — the deploy log */}
              <Section
                title="Recent publishes"
                className="lg:col-span-5"
                action={
                  pubs.length > 0 ? (
                    <Link
                      href={devPath(slug, "preview")}
                      className="font-mono text-[11px] tracking-[0.06em] text-graphite transition hover:text-ink"
                    >
                      VIEW HISTORY
                    </Link>
                  ) : undefined
                }
              >
                {pubs.length === 0 ? (
                  <p className="text-sm text-faint">
                    Nothing published yet. Publishing snapshots your draft to the live map.
                  </p>
                ) : (
                  <ul className="-my-2.5">
                    {pubs.slice(0, 6).map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center gap-3 border-t border-line-2 py-2.5 first:border-t-0"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brass/70" aria-hidden="true" />
                        <span className="font-mono text-[13px] text-ink tabular-nums">
                          {relTime(p.published_at)}
                        </span>
                        {p.note && (
                          <span className="ml-auto truncate text-[13px] text-faint">{p.note}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        </>
      )}

      {config && settingsDev && (
        <>
          <EditDevelopmentModal
            dev={settingsDev}
            open={settings === "edit"}
            onClose={() => setSettings(null)}
            onSaved={() => {
              setSettings(null);
              load();
            }}
            onRequestDelete={() => setSettings("delete")}
          />
          <DeleteDevelopmentModal
            dev={settingsDev}
            open={settings === "delete"}
            onClose={() => setSettings(null)}
            onDeleted={() => router.push("/")}
          />
        </>
      )}
    </div>
  );
}

function DeployRow({ tone, label, value, mono }: { tone: string; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={cx("mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full ring-2", tone)} />
      <div className="leading-tight">
        <div className="text-[13px] font-medium text-white/90">{label}</div>
        <div className={cx("mt-0.5 text-[11px] text-white/45", mono && "font-mono tabular-nums")}>{value}</div>
      </div>
    </div>
  );
}
