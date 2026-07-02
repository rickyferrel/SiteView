"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget, jsend } from "@/lib/client";
import type { MapConfig } from "@/lib/types";
import { PageHeader, Card, Button, Eyebrow, Readout, EmptyState, Logomark, cx } from "@/components/ui";

// Brass CTA inset-highlight recipe, shared with the other deploy surfaces.
const PUBLISH_CTA =
  "px-6 shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_1px_2px_rgba(122,96,52,0.45)]";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} yr ago`;
}

export default function PreviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const [tab, setTab] = useState<"draft" | "published">("draft");
  const [nonce, setNonce] = useState(0);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; count: number } | { ok: false; error: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, fc] = await Promise.all([
      jget<MapConfig>(`/api/dev/${slug}/config?state=draft`),
      jget<GeoJSON.FeatureCollection>(`/api/dev/${slug}/parcels?state=draft`),
    ]);
    setName(c.development.name);
    setCount(fc.features.length);
    setPublishedAt(c.published_at);
  }, [slug]);

  useEffect(() => {
    setOrigin(window.location.origin);
    load().catch((e) => setResult({ ok: false, error: String(e) }));
  }, [load]);

  const loaded = count !== null;
  const empty = count === 0;
  const src = tab === "draft" ? `/embed/${slug}?state=draft&_=${nonce}` : `/embed/${slug}?_=${nonce}`;

  // Deploy status. Without a backend-provided draft-vs-published diff count we
  // can only distinguish "never published" from "published"; treat any published
  // snapshot as up to date until a /status diff endpoint exists (see notes).
  const deployState: "unpublished" | "current" | "unknown" = !loaded
    ? "unknown"
    : publishedAt
      ? "current"
      : "unpublished";

  async function publish() {
    setBusy(true);
    setResult(null);
    try {
      const r = await jsend<{ count: number }>(`/api/dev/${slug}/publish`, "POST", { note: "from preview" });
      setResult({ ok: true, count: r.count });
      setPublishedAt(new Date().toISOString());
      setTab("published");
      setNonce((n) => n + 1);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const snippet = `<iframe
  src="${origin || "https://your-portal-domain.com"}/embed/${slug}"
  style="width:100%;height:90vh;min-height:780px;border:0;border-radius:16px"
  allow="geolocation"
  loading="lazy"
  title="${name || "Map"}"></iframe>`;

  function copy() {
    navigator.clipboard?.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Deploy · ${name || "…"}`}
        title="Preview & publish"
        description="See exactly what WordPress will show, then publish your draft to make it live."
        actions={
          <>
            <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
              Refresh
            </Button>
            <Button
              variant="brass"
              className={PUBLISH_CTA}
              onClick={publish}
              disabled={busy || empty}
              title={empty ? "Add parcels before publishing" : undefined}
            >
              {busy ? "Publishing…" : "Publish to live"}
            </Button>
          </>
        }
      />

      {/* Deploy readout strip — the gauges that frame this deployment. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <Readout label="Lots in draft" value={loaded ? count : "—"} sub="Staged for publish" />
        </Card>
        <Card className="p-5">
          <Readout
            label="Last published"
            value={
              publishedAt ? (
                <span className="text-[22px]">{new Date(publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              ) : (
                "—"
              )
            }
            sub={publishedAt ? `${new Date(publishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${relativeTime(publishedAt)}` : "Not published yet"}
          />
        </Card>
        <Card className="p-5">
          <div className="flex flex-col gap-2">
            <Eyebrow>Status</Eyebrow>
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  "h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10",
                  deployState === "current" ? "bg-brass" : deployState === "unpublished" ? "bg-panel-3" : "bg-panel-3"
                )}
              />
              <span className="font-mono text-[22px] font-medium leading-none tracking-[-0.03em] text-ink">
                {deployState === "current" ? "Up to date" : deployState === "unpublished" ? "Unpublished" : "—"}
              </span>
            </div>
            <div className="text-[13px] text-graphite">
              {deployState === "current"
                ? "Live map matches your last publish"
                : deployState === "unpublished"
                  ? "Nothing has gone live yet"
                  : "Checking…"}
            </div>
          </div>
        </Card>
      </div>

      {/* The map stage — the deployment target, carrying the contour signature. */}
      <section className="contour-whisper overflow-hidden rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-pop)]">
        {/* Stage top bar — the segmented control drives the viewport directly. */}
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-3 py-2">
          <div className="flex">
            {(["draft", "published"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={cx(
                  "relative rounded-[var(--radius-sm)] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition",
                  tab === t ? "text-white" : "text-white/40 hover:text-white/70"
                )}
              >
                {t === "draft" ? "Draft" : "Live"}
                {tab === t && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-brass" />}
              </button>
            ))}
          </div>
          <span className="truncate font-mono text-[11px] text-white/35">
            /embed/{slug}
            {tab === "draft" ? "?state=draft" : ""}
          </span>
        </div>

        {!loaded ? (
          <div className="grid h-[72vh] w-full place-items-center">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/35">Loading preview…</span>
          </div>
        ) : empty ? (
          <EmptyState
            className="h-[72vh] justify-center [&_h3]:text-white [&_p]:text-white/55"
            icon={<Logomark className="h-9 w-9" />}
            title="Nothing to publish yet"
            hint="This development has no parcels, so there's nothing to put on the live map. Add parcels to get started."
            action={
              <Link href={devPath(slug, "parcels")}>
                <Button variant="brass" className={PUBLISH_CTA}>
                  Add parcels
                </Button>
              </Link>
            }
          />
        ) : (
          <iframe key={`${tab}-${nonce}`} src={src} title="Map preview" allow="geolocation" className="h-[72vh] w-full" />
        )}

        {/* Console event — publish acknowledgement, anchored to the stage it changed. */}
        {result && (
          <div
            className={cx(
              "flex items-start gap-2.5 border-t px-4 py-3 text-[13px]",
              result.ok ? "border-white/[0.08] text-white/80" : "border-danger/40 bg-danger/[0.08] text-white/85"
            )}
          >
            {result.ok ? (
              <>
                <span className="save-pulse mt-[3px] h-2 w-2 shrink-0 rounded-full bg-brass ring-1 ring-inset ring-black/20" />
                <span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brass">Published</span>
                  <span className="ml-2 text-white/70">
                    {result.count} lot{result.count === 1 ? "" : "s"} are now live. The embed below matches your draft.
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full bg-danger" />
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/60">Publish failed</span>
                    <span className="ml-2 text-white/70">{result.error}</span>
                  </span>
                  <button
                    onClick={publish}
                    disabled={busy}
                    className="rounded-[var(--radius-sm)] border border-white/20 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-white/80 transition hover:bg-white/10 disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                  >
                    Try again
                  </button>
                </span>
              </>
            )}
          </div>
        )}
      </section>

      {/* The handoff artifact — paste once into WordPress, controlled here forever. */}
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5">
          <div>
            <h2 className="eyebrow !text-graphite">WordPress embed code</h2>
            <p className="mt-1 max-w-xl text-[13px] text-faint">
              Paste this once into a Custom HTML block, replacing your current map. After that, every change is controlled here — just publish.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? "Copied" : "Copy snippet"}
          </Button>
        </header>
        <div className="p-5">
          <pre className="contour-whisper overflow-x-auto rounded-[var(--radius)] border border-white/[0.06] bg-stage p-4 font-mono text-[12px] leading-relaxed text-white/85">
            {snippet}
          </pre>
        </div>
      </section>
    </div>
  );
}
