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

type PreviewLink = { token: string; expires_at: string };

// Future-tense counterpart to relativeTime, for the preview link's 7-day clock.
function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs} hr`;
  return `in ${Math.round(hrs / 24)} days`;
}

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
  const [linkCopied, setLinkCopied] = useState(false);
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [previewLink, setPreviewLink] = useState<PreviewLink | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [renewBusy, setRenewBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [c, fc, pl] = await Promise.all([
      jget<MapConfig>(`/api/dev/${slug}/config?state=draft`),
      jget<GeoJSON.FeatureCollection>(`/api/dev/${slug}/parcels?state=draft`),
      // Mints the first token only. Expired links stay visible so they can be renewed.
      jget<PreviewLink>(`/api/dev/${slug}/preview-link`),
    ]);
    setName(c.development.name);
    setCount(fc.features.length);
    setPublishedAt(c.published_at);
    setPreviewLink(pl);
  }, [slug]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setOrigin(window.location.origin);
      load().catch((e) => setResult({ ok: false, error: String(e) }));
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // The draft tab gets edit=1: the embed's lot panel grows a Remove-lot tool.
  // Deletions inside the iframe post `sc:parcel-deleted` back up; reload the
  // readouts so "Lots in draft" tracks what the operator just did.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if ((e.data as { type?: string } | null)?.type === "sc:parcel-deleted") load().catch(() => {});
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);

  const loaded = count !== null;
  const empty = count === 0;
  const src = tab === "draft" ? `/embed/${slug}?state=draft&edit=1&_=${nonce}` : `/embed/${slug}?_=${nonce}`;

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

  // Shareable customer preview: a standalone, view-only page with no way back
  // into the portal. Reads the draft, so it always shows the latest work. The
  // token gates it to 7 days; renewal reopens the same URL, while regenerating
  // kills every copy of the old link.
  const previewUrl = previewLink
    ? `${origin || "https://your-portal-domain.com"}/preview/${slug}?k=${previewLink.token}`
    : null;
  const previewExpiry = previewLink ? new Date(previewLink.expires_at).getTime() : null;
  const previewExpired = previewExpiry !== null && (!Number.isFinite(previewExpiry) || previewExpiry <= now);

  function copyPreviewLink() {
    if (!previewUrl || previewExpired) return;
    navigator.clipboard?.writeText(previewUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1600);
  }

  async function regeneratePreviewLink() {
    setRegenBusy(true);
    try {
      const pl = await jsend<PreviewLink>(`/api/dev/${slug}/preview-link`, "POST", {});
      setPreviewLink(pl);
      setLinkCopied(false);
    } catch {
      // Leave the current link in place; the next page load retries via load().
    } finally {
      setRegenBusy(false);
    }
  }

  async function renewPreviewLink() {
    setRenewBusy(true);
    try {
      const pl = await jsend<PreviewLink>(`/api/dev/${slug}/preview-link`, "PATCH", {});
      setPreviewLink(pl);
      setLinkCopied(false);
      setNow(Date.now());
    } catch {
      // Leave the current link in place; the next page load retries via load().
    } finally {
      setRenewBusy(false);
    }
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

      {/* Customer preview link — a polished, view-only page safe to send out. */}
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5">
          <div>
            <h2 className="eyebrow !text-graphite">Customer preview link</h2>
            <p className="mt-1 max-w-xl text-[13px] text-faint">
              Send this to a customer to show off the map. It&apos;s a polished, view-only page — just the map with your
              development&apos;s name on it, no way into this portal. It always shows your current draft, and the link
              stays live for 7 days.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {previewUrl && !previewExpired ? (
              <a href={previewUrl} target="_blank" rel="noreferrer">
                <Button variant="ghost" size="sm">
                  Open preview
                </Button>
              </a>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled
                title={previewExpired ? "Reset the timer to reopen the preview" : undefined}
              >
                Open preview
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={copyPreviewLink}
              disabled={!previewUrl || previewExpired}
              title={previewExpired ? "Reset the timer before copying this link" : undefined}
            >
              {linkCopied ? "Link copied" : "Copy link"}
            </Button>
          </div>
        </header>
        <div className="space-y-3 p-5">
          <div className="contour-whisper flex items-center justify-between gap-3 overflow-x-auto rounded-[var(--radius)] border border-white/[0.06] bg-stage px-4 py-3">
            <span className="whitespace-nowrap font-mono text-[12px] leading-relaxed text-white/85">
              {previewUrl ?? "Preparing link…"}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-graphite">
              {previewLink ? (
                previewExpired ? (
                  <>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-danger ring-1 ring-inset ring-black/10" />
                    Expired · {new Date(previewLink.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-brass ring-1 ring-inset ring-black/10" />
                    Live · expires{" "}
                    {new Date(previewLink.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                    {expiresIn(previewLink.expires_at, now)}
                  </>
                )
              ) : (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-panel-3" />
                  Checking link…
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              {previewExpired && (
                <Button
                  variant="brass"
                  size="sm"
                  onClick={renewPreviewLink}
                  disabled={renewBusy || !previewLink}
                  title="Keeps this URL and restarts its 7-day clock."
                >
                  {renewBusy ? "Resetting…" : "Reset 7 days"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={regeneratePreviewLink}
                disabled={regenBusy || renewBusy || !previewLink}
                title="Issues a fresh 7-day link. Any copy of the current link stops working."
              >
                {regenBusy ? "Issuing…" : "New link"}
              </Button>
            </div>
          </div>
        </div>
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
