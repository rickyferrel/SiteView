"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget } from "@/lib/client";
import type { MapConfig } from "@/lib/types";
import ParcelPicker from "@/components/ParcelPicker";
import { Eyebrow, Logomark, PageHeader } from "@/components/ui";

export default function AddParcelsPage() {
  const { slug } = useParams<{ slug: string }>();
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jget<MapConfig>(`/api/dev/${slug}/config?state=draft`)
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, [slug]);

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-5">
      <PageHeader
        eyebrow={`Acquire · ${config?.development.name ?? "…"}`}
        title="Add parcels"
        description="Search an address to fly there, then click parcels or drag a box to select the lots that belong to this development. Importing pulls clean county geometry in with your default status."
        actions={
          <Link
            href={devPath(slug)}
            className="inline-flex h-9 select-none items-center justify-center rounded-[var(--radius-sm)] px-4 text-sm font-medium tracking-[-0.01em] text-graphite transition hover:bg-panel-2 hover:text-ink"
          >
            Back to overview
          </Link>
        }
      />

      <div className="min-h-0 flex-1">
        {error ? (
          <StagePlaceholder>
            <div className="glass-dark max-w-sm rounded-[var(--radius)] px-5 py-4 text-left">
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">
                Couldn&apos;t load county geometry
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-white/70">{error}</p>
              <p className="mt-2 text-[12px] text-white/45">Reload the page to retry.</p>
            </div>
          </StagePlaceholder>
        ) : config ? (
          <ParcelPicker slug={slug} token={config.development.mapbox_token} initialView={config.development.default_view} />
        ) : (
          <StagePlaceholder>
            <span className="save-pulse text-brass">
              <Logomark className="h-10 w-10" />
            </span>
            <Eyebrow className="!text-white/55">Acquiring · county geometry</Eyebrow>
          </StagePlaceholder>
        )}
      </div>
    </div>
  );
}

/* Dark satellite-stage placeholder that mirrors the picker's own framing so the
   loading/error moments read as the same instrument coming online. */
function StagePlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="contour-field grid h-full place-items-center rounded-[var(--radius-lg)] border border-line bg-stage shadow-[var(--shadow-card)]">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  );
}
