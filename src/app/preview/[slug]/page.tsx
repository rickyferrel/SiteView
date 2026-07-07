// Customer-facing preview: a polished, view-only presentation of a
// development's draft map, meant to be sent as a link. It deliberately
// carries no navigation back into the operator portal — just the map,
// framed. Reads the DRAFT state so it always shows the latest work.
//
// The page only answers to a live preview token (?k=…, minted on the portal's
// Preview & Publish page, good for 7 days). A missing, stale, or regenerated
// token gets the closed notice instead of the map.

import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getDevelopment, getPreviewLink, previewLinkIsLive } from "@/lib/repo";
import { PreviewCountdown, PreviewExpiredCurtain, PreviewExpiredNotice } from "@/components/PreviewCountdown";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ k?: string | string[] }>;
};

function MpcgWordmark({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/mpcg-logo.png"
      alt="MPCG"
      width={1453}
      height={355}
      preload
      className={className}
    />
  );
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  return {
    title: dev ? `${dev.name} — interactive map` : "Map preview",
    description: dev ? `Interactive 3D lot map preview for ${dev.name}.` : undefined,
    robots: { index: false, follow: false },
  };
}

export default async function CustomerPreviewPage({ params, searchParams }: Params) {
  const { slug } = await params;
  const { k } = await searchParams;
  const dev = await getDevelopment(slug);
  if (!dev) notFound();

  const link = await getPreviewLink(dev.id);
  const open = previewLinkIsLive(link) && typeof k === "string" && k === link.token;

  return (
    <div className="flex h-dvh w-full flex-col bg-stage">
      <header className="contour-whisper flex min-h-[88px] items-center justify-between gap-5 border-b border-white/[0.08] px-6 py-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-6">
          <div className="flex h-[36px] w-[146px] shrink-0 items-center overflow-visible">
            <MpcgWordmark className="h-auto w-full object-contain" />
          </div>
          <span className="h-11 w-px shrink-0 bg-white/[0.12]" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate font-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-white">
              {dev.name}
            </h1>
            <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.18em] text-white/40">
              Interactive 3D lot map
            </p>
          </div>
        </div>
        {open ? (
          <PreviewCountdown expiresAt={link.expires_at} />
        ) : (
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-danger/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-danger">
            Expired
          </span>
        )}
      </header>

      <main className="relative min-h-0 flex-1">
        {open ? (
          <>
            <iframe
              src={`/embed/${slug}?state=draft&ribbon=0`}
              title={`${dev.name} interactive map`}
              allow="geolocation"
              className="h-full w-full border-0"
            />
            <PreviewExpiredCurtain expiresAt={link.expires_at} />
          </>
        ) : (
          <PreviewExpiredNotice />
        )}
      </main>

      <footer className="flex items-center justify-between gap-3 border-t border-white/[0.08] px-4 py-2 sm:px-6">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
          {open ? "Click a lot for details · Drag to explore" : "This link has closed"}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-white/25">
          Preview — subject to change
        </span>
      </footer>
    </div>
  );
}
