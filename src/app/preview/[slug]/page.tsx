// Customer-facing preview: a polished, view-only presentation of a
// development's draft map, meant to be sent as a link. It deliberately
// carries no navigation back into the operator portal — just the map,
// framed. Reads the DRAFT state so it always shows the latest work.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDevelopment } from "@/lib/repo";
import { Logomark } from "@/components/ui";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  return {
    title: dev ? `${dev.name} — interactive map` : "Map preview",
    description: dev ? `Interactive 3D lot map preview for ${dev.name}.` : undefined,
    robots: { index: false, follow: false },
  };
}

export default async function CustomerPreviewPage({ params }: Params) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) notFound();

  return (
    <div className="flex h-dvh w-full flex-col bg-stage">
      <header className="contour-whisper flex items-center justify-between gap-4 border-b border-white/[0.08] px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-white/[0.14] bg-white/[0.04] text-brass">
            <Logomark className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-white">
              {dev.name}
            </h1>
            <p className="font-mono text-[10px] uppercase leading-tight tracking-[0.18em] text-white/40">
              Interactive 3D lot map
            </p>
          </div>
        </div>
        <span className="hidden shrink-0 rounded-[var(--radius-sm)] border border-brass/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-brass sm:block">
          Preview
        </span>
      </header>

      <main className="min-h-0 flex-1">
        <iframe
          src={`/embed/${slug}?state=draft&ribbon=0`}
          title={`${dev.name} interactive map`}
          allow="geolocation"
          className="h-full w-full border-0"
        />
      </main>

      <footer className="flex items-center justify-between gap-3 border-t border-white/[0.08] px-4 py-2 sm:px-6">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
          Click a lot for details · Drag to explore
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-white/25">
          Preview — subject to change
        </span>
      </footer>
    </div>
  );
}
