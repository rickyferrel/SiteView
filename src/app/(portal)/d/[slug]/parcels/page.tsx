"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget } from "@/lib/client";
import type { MapConfig } from "@/lib/types";
import ParcelPicker from "@/components/ParcelPicker";
import GeoJsonUpload from "@/components/GeoJsonUpload";
import ParcelDrawEditor from "@/components/ParcelDrawEditor";
import { Eyebrow, Logomark, PageHeader, cx } from "@/components/ui";

// Where the lot geometry comes from: the county-records picker (ArcGIS LIR
// API), an operator-supplied file (GeoJSON or Esri Shapefile), or drawn by hand
// over the imagery when the plat never became a file at all.
type Source = "map" | "file" | "draw";

const BLURB: Record<Source, string> = {
  map: "Search an address to fly there, then click parcels or drag a box to select the lots that belong to this development. Importing pulls clean county geometry in with your default status.",
  file: "Upload your lot polygons as GeoJSON or an Esri Shapefile (.zip or .shp + .dbf + .prj) — from GIS software, a survey, or a CAD export. Big county-wide files are fine: you'll trim the selection down to your community on a map before importing.",
  draw: "Draw lots straight onto the imagery — for the plat that never became a file. Search your site, pin the developer's render to trace off if you have one, then trace corners, drag rectangles, split a block, or copy a lot along the street.",
};

export default function AddParcelsPage() {
  const { slug } = useParams<{ slug: string }>();
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("map");

  useEffect(() => {
    jget<MapConfig>(`/api/dev/${slug}/config?state=draft`)
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, [slug]);

  return (
    <div className="flex h-[calc(100vh-8.25rem)] min-h-[540px] flex-col gap-4">
      <PageHeader
        eyebrow={`Acquire · ${config?.development.name ?? "…"}`}
        title="Add parcels"
        description={BLURB[source]}
        actions={
          <div className="flex items-center gap-3">
            <div className="flex rounded-[var(--radius-sm)] border border-line bg-panel-2/60 p-0.5">
              <SourceTab active={source === "map"} onClick={() => setSource("map")}>
                County records
              </SourceTab>
              <SourceTab active={source === "file"} onClick={() => setSource("file")}>
                Upload file
              </SourceTab>
              <SourceTab active={source === "draw"} onClick={() => setSource("draw")}>
                Draw by hand
              </SourceTab>
            </div>
            <Link
              href={devPath(slug)}
              className="inline-flex h-9 select-none items-center justify-center rounded-[var(--radius-sm)] px-4 text-sm font-medium tracking-[-0.01em] text-graphite transition hover:bg-panel-2 hover:text-ink"
            >
              Back to overview
            </Link>
          </div>
        }
      />

      <div className="min-h-0 flex-1">
        {source === "file" && config ? (
          <GeoJsonUpload slug={slug} token={config.development.mapbox_token} />
        ) : source === "draw" && config ? (
          <ParcelDrawEditor slug={slug} />
        ) : error ? (
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

function SourceTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "inline-flex h-8 select-none items-center rounded-[calc(var(--radius-sm)-2px)] px-3 text-[13px] font-medium tracking-[-0.01em] transition",
        active ? "bg-ink text-white shadow-sm" : "text-graphite hover:text-ink"
      )}
    >
      {children}
    </button>
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
