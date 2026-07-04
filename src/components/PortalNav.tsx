"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { devPath, slugFromPath } from "@/lib/const";
import { jget } from "@/lib/client";
import type { DevelopmentSummary } from "@/lib/types";
import { Logomark, cx } from "@/components/ui";

const SUBS = [
  { sub: "", label: "Overview" },
  { sub: "lots", label: "Lots" },
  { sub: "design", label: "Map Design" },
  { sub: "preview", label: "Preview & Publish" },
];

export default function PortalNav() {
  const pathname = usePathname();
  const slug = slugFromPath(pathname);

  const links = SUBS.map((s) => ({
    href: slug ? devPath(slug, s.sub) : "/",
    label: s.label,
    active: slug
      ? s.sub === ""
        ? pathname === devPath(slug)
        : pathname.startsWith(devPath(slug, s.sub))
      : false,
  }));

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--color-panel)_88%,transparent)] backdrop-blur-md">
      {/* a single hairline of brass — the only warm note in the chrome.
          Its 42% stop lands roughly over the logomark + wordmark column. */}
      <div className="h-[2px] w-full bg-[linear-gradient(90deg,var(--color-brass),transparent_42%)]" />
      <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-4 px-6">
        <Link href={slug ? devPath(slug) : "/"} className="flex items-center gap-2.5">
          <span className="contour-whisper grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] border border-line bg-panel text-brass shadow-[var(--shadow-card)]">
            <Logomark className="h-[18px] w-[18px]" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-display text-[15px] font-bold tracking-[-0.02em] text-ink">Map Portal</span>
            <span className="mt-0.5 font-mono text-[10px] tracking-[0.14em] text-faint">OPERATOR CONSOLE</span>
          </span>
        </Link>

        {/* hairline seam — splits identity from navigation */}
        <span className="hidden h-6 w-px bg-line md:block" />

        {slug && (
          <nav className="hidden items-center gap-0.5 md:flex">
            {links.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                aria-current={l.active ? "page" : undefined}
                className={cx(
                  "relative rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition-colors",
                  l.active ? "text-ink" : "text-graphite hover:bg-panel-2 hover:text-ink"
                )}
              >
                {l.label}
                {l.active && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brass" />}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto">
          <ClientSwitcher activeSlug={slug} />
        </div>
      </div>

      {/* Mobile nav strip — the inline nav is hidden under md */}
      {slug && (
        <nav className="flex gap-0.5 overflow-x-auto border-t border-line-2 px-4 py-2 md:hidden">
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              aria-current={l.active ? "page" : undefined}
              className={cx(
                "relative shrink-0 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium transition-colors",
                l.active ? "text-ink" : "text-graphite hover:bg-panel-2 hover:text-ink"
              )}
            >
              {l.label}
              {l.active && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brass" />}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

/* The real client switcher: a popover fed by GET /api/dev, with a route into the
   "create a development" flow. This is the seam where multi-site becomes real. */
function ClientSwitcher({ activeSlug }: { activeSlug: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [devs, setDevs] = useState<DevelopmentSummary[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The nav lives in the layout and never remounts, so lot counts go stale the
  // moment an import lands. Refetch on every route change and on popover open.
  useEffect(() => {
    let alive = true;
    jget<DevelopmentSummary[]>("/api/dev")
      .then((d) => alive && setDevs(d))
      .catch(() => alive && setDevs((prev) => prev ?? []));
    return () => {
      alive = false;
    };
  }, [pathname, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = devs?.find((d) => d.slug === activeSlug) ?? null;
  const label = active?.name ?? (activeSlug ? activeSlug : "New development");
  const sub = active ? `${active.parcel_count} lots` : activeSlug ? "" : "Set up a site";

  function go(slug: string) {
    setOpen(false);
    router.push(devPath(slug));
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="group inline-flex h-9 items-center gap-2.5 rounded-[var(--radius-sm)] border border-line bg-panel pl-2.5 pr-2 transition hover:bg-panel-2"
      >
        <span className="h-2 w-2 rounded-full bg-brass ring-2 ring-brass-wash" />
        <span className="flex max-w-[160px] flex-col text-left leading-none">
          <span className="truncate text-[13px] font-medium text-ink">{label}</span>
          {sub && <span className="mt-1 font-mono text-[10px] tracking-[0.04em] text-faint">{sub}</span>}
        </span>
        <svg viewBox="0 0 16 16" className={cx("h-3.5 w-3.5 text-faint transition", open && "text-graphite")} fill="none" aria-hidden="true">
          <path d="M5 6.5 8 3.5 11 6.5M5 9.5 8 12.5 11 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="pop-in absolute right-0 top-[calc(100%+8px)] z-40 w-72 overflow-hidden rounded-[var(--radius)] border border-line bg-panel shadow-[var(--shadow-pop)]"
        >
          <div className="flex items-center justify-between border-b border-line-2 px-3.5 py-2.5">
            <span className="eyebrow">Developments</span>
            {devs && <span className="font-mono text-[10px] text-faint tabular-nums">{devs.length}</span>}
          </div>

          <div className="max-h-[min(60vh,360px)] overflow-y-auto p-1.5">
            {!devs ? (
              <p className="px-2.5 py-3 text-[13px] text-faint">Loading…</p>
            ) : devs.length === 0 ? (
              <p className="px-2.5 py-3 text-[13px] text-faint">No developments yet.</p>
            ) : (
              devs.map((d) => {
                const isActive = d.slug === activeSlug;
                return (
                  <button
                    key={d.id}
                    role="menuitem"
                    onClick={() => go(d.slug)}
                    className={cx(
                      "flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left transition",
                      isActive ? "bg-panel-2" : "hover:bg-panel-2"
                    )}
                  >
                    <span className={cx("h-2 w-2 shrink-0 rounded-full", isActive ? "bg-brass ring-2 ring-brass-wash" : "bg-panel-3")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{d.name}</span>
                      <span className="block truncate font-mono text-[10px] text-faint">{d.slug}</span>
                    </span>
                    <span className="font-mono text-[11px] text-faint tabular-nums">{d.parcel_count}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t border-line-2">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="flex items-center gap-2 px-3.5 py-3 text-[13px] font-medium text-graphite transition hover:bg-panel-2 hover:text-ink"
            >
              <span className="grid h-5 w-5 place-items-center text-faint">
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                  <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              Manage developments
            </Link>
            <Link
              href="/new"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="flex items-center gap-2 border-t border-line-2 px-3.5 py-3 text-[13px] font-medium text-ink transition hover:bg-panel-2"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full border border-line bg-panel text-brass">
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
                  <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              New development
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* Slug-aware footer — the matched bracket to the header. Same brass top
   hairline, same identity column, same environment tick. */
export function PortalFooter() {
  const slug = slugFromPath(usePathname());
  return (
    <footer className="border-t border-line">
      {/* brass top hairline, mirroring the header's top edge */}
      <div className="h-px w-full bg-[linear-gradient(90deg,var(--color-brass),transparent_42%)]" />
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="flex items-center gap-2.5">
          <Logomark className="h-[18px] w-[18px] text-brass opacity-40" />
          <span className="flex flex-col leading-none">
            <span className="font-mono text-[11px] tracking-[0.14em] text-graphite">MAP&nbsp;PORTAL</span>
            <span className="mt-1 font-mono text-[10px] tracking-[0.12em] text-faint">SINGLE SOURCE OF TRUTH</span>
          </span>
        </div>
        <span className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-faint">
          <span className="h-1.5 w-1.5 rounded-full bg-brass ring-2 ring-brass-wash" aria-hidden="true" />
          {slug ? `DEV · ${slug.toUpperCase()}` : "MULTI-SITE OPERATOR"}
        </span>
      </div>
    </footer>
  );
}
