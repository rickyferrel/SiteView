"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { devPath } from "@/lib/const";
import { jsend } from "@/lib/client";
import { normalizeGeoJSON, roundGeometry, type NormalizedParcel, type NormalizeResult } from "@/lib/geojson";
import { isShapefileUpload, shapefileToGeoJSON } from "@/lib/shapefile";
import GeoJsonTrimMap from "@/components/GeoJsonTrimMap";
import { cx, Eyebrow } from "@/components/ui";

// The file itself never leaves the browser — it's parsed here and only the
// confirmed lots are uploaded in batches — so the size guard only protects the
// browser's JSON parser. A whole-county export is fine.
const MAX_BYTES = 250 * 1024 * 1024;
// Ceiling on what one development imports. Files with more than this go
// through the trim map, where the operator selects the community's lots.
const IMPORT_MAX = 2_000;
// Keep each POST comfortably under the ~6 MB request ceiling of the prod
// hosting layer (Amplify SSR Lambda).
const BATCH_TARGET_BYTES = 3 * 1024 * 1024;

type Parsed = { fileName: string; result: NormalizeResult };
type Stage = "summary" | "trim";

/**
 * The "bring your own geometry" path of the add-parcels step. Drop a GeoJSON
 * export or an Esri Shapefile (zipped, or .shp + .dbf + .prj together — CAD/
 * county exports in State Plane/UTM reproject via the .prj) — even a full
 * county: it's parsed in the browser, oversized files route through a map step
 * to trim the selection down to the community, and the confirmed lots (max
 * 2,000) upload in ~3 MB batches with their derived parcel IDs stamped, so the
 * server resolves the same IDs per batch.
 */
export default function GeoJsonUpload({ slug, token }: { slug: string; token: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [stage, setStage] = useState<Stage>("summary");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function readFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setParsed(null);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (bytes > MAX_BYTES) {
      setError(`That upload is ${(bytes / 1024 / 1024).toFixed(0)} MB — too large to parse in the browser (limit ${MAX_BYTES / 1024 / 1024} MB). Simplify the geometry or split the file.`);
      return;
    }
    setReading(true);
    try {
      // Yield a frame so the "Reading…" state paints before the parse blocks.
      await new Promise((r) => setTimeout(r, 30));
      let raw: unknown;
      let fileName: string;
      let extraWarnings: string[] = [];
      if (isShapefileUpload(files)) {
        const sf = await shapefileToGeoJSON(files);
        raw = sf.geojson;
        fileName = sf.fileName;
        extraWarnings = sf.warnings;
      } else {
        fileName = files[0].name;
        try {
          raw = JSON.parse(await files[0].text());
        } catch {
          throw new Error("That file isn't valid JSON.");
        }
      }
      const result = normalizeGeoJSON(raw);
      result.warnings.unshift(...extraWarnings);
      setParsed({ fileName, result });
      // Too many lots to be one development → straight to the trim map.
      setStage(result.parcels.length > IMPORT_MAX ? "trim" : "summary");
    } catch (e) {
      let msg = String(e instanceof Error ? e.message : e);
      // A shapefile that trips the WGS84 check is usually just missing its .prj.
      if (isShapefileUpload(files) && msg.includes("longitude/latitude")) {
        msg += " If the shapefile came with a .prj file, include it — coordinates convert automatically.";
      }
      setError(msg);
    } finally {
      setReading(false);
    }
  }

  // Re-emit the chosen parcels as features — derived parcel_id stamped so every
  // batch resolves the same IDs server-side, vertices rounded to shed excess
  // precision — and group them into ~3 MB FeatureCollections.
  function buildBatches(subset: NormalizedParcel[]): GeoJSON.FeatureCollection[] {
    const batches: GeoJSON.FeatureCollection[] = [];
    let cur: GeoJSON.Feature[] = [];
    let size = 0;
    for (const p of subset) {
      const f: GeoJSON.Feature = {
        type: "Feature",
        properties: { ...p.properties, parcel_id: p.parcel_id },
        geometry: roundGeometry(p.geometry),
      };
      const len = JSON.stringify(f).length;
      if (cur.length > 0 && size + len > BATCH_TARGET_BYTES) {
        batches.push({ type: "FeatureCollection", features: cur });
        cur = [];
        size = 0;
      }
      cur.push(f);
      size += len;
    }
    if (cur.length > 0) batches.push({ type: "FeatureCollection", features: cur });
    return batches;
  }

  async function confirm(subset: NormalizedParcel[]) {
    if (subset.length === 0 || subset.length > IMPORT_MAX) return;
    setProgress({ done: 0, total: subset.length });
    setError(null);
    let done = 0;
    try {
      for (const batch of buildBatches(subset)) {
        await jsend(`/api/dev/${slug}/import`, "POST", { mode: "geojson", geojson: batch });
        done += batch.features.length;
        setProgress({ done, total: subset.length });
      }
      // Next step in the add-flow: frame the camera the public map opens on.
      router.push(devPath(slug, "opening-view"));
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setError(
        done > 0
          ? `${msg} — ${done.toLocaleString()} of ${subset.length.toLocaleString()} lots were imported before the error. Importing the same selection again is safe; lots upsert by ID.`
          : msg
      );
      setProgress(null);
    }
  }

  function discard() {
    setParsed(null);
    setError(null);
    setStage("summary");
  }

  const parcels = parsed?.result.parcels ?? [];
  const sampleIds = parcels.slice(0, 6).map((p) => p.parcel_id);
  const importing = progress !== null;

  // Trim stage: full-bleed selection map; the error box floats above it.
  if (parsed && stage === "trim") {
    return (
      <div className="relative h-full w-full">
        <GeoJsonTrimMap
          token={token}
          parcels={parcels}
          cap={IMPORT_MAX}
          fileName={parsed.fileName}
          progress={progress}
          onImport={confirm}
          onDiscard={discard}
        />
        {error && <ErrorBox message={error} className="absolute inset-x-6 bottom-24 z-40 mx-auto max-w-[520px]" />}
      </div>
    );
  }

  return (
    <div
      className="contour-field relative grid h-full place-items-center overflow-auto rounded-[var(--radius-lg)] border border-line bg-stage p-6 shadow-[var(--shadow-card)]"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void readFiles(Array.from(e.dataTransfer.files ?? []));
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".geojson,.json,.zip,.shp,.dbf,.prj,.cpg,.shx,application/geo+json,application/json,application/zip"
        className="hidden"
        onChange={(e) => {
          void readFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {!parsed ? (
        <button
          onClick={() => inputRef.current?.click()}
          disabled={reading}
          className={cx(
            "glass-dark flex w-[min(460px,100%)] flex-col items-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed px-8 py-12 text-center transition",
            dragging ? "border-brass/80 bg-brass/10" : "border-white/20 hover:border-white/40",
            reading && "pointer-events-none opacity-70"
          )}
        >
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-white/50" fill="none" aria-hidden="true">
            <path d="M12 16V5m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <Eyebrow className="!text-white/55">Upload · GeoJSON or Shapefile</Eyebrow>
          <span className="text-[15px] font-semibold text-white">
            {reading ? "Reading file…" : "Drop a .geojson or shapefile here, or click to browse"}
          </span>
          <span className="max-w-sm text-[12px] leading-relaxed text-white/50">
            GeoJSON, or an Esri Shapefile as a .zip (or the .shp, .dbf, and .prj selected together). Shapefiles in a
            projected system (State Plane, UTM) convert automatically when the .prj is included; GeoJSON must already
            be longitude/latitude (WGS84). Lot IDs, acreage, and addresses are picked up from feature properties.
            County-wide exports are fine — you&apos;ll trim to your community on a map next.
          </span>
        </button>
      ) : (
        <div className="glass-dark w-[min(520px,100%)] rounded-[var(--radius-lg)] p-6">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow className="!text-white/55">Ready to import</Eyebrow>
              <div className="mt-1 truncate font-mono text-[12px] text-white/60">{parsed.fileName}</div>
            </div>
            <span className="shrink-0 font-mono text-[26px] font-medium leading-none tracking-[-0.03em] text-white tabular-nums">
              {parcels.length.toLocaleString()}
              <span className="ml-1.5 align-middle font-sans text-[12px] font-normal text-white/50">
                lot{parcels.length === 1 ? "" : "s"}
              </span>
            </span>
          </div>

          {sampleIds.length > 0 && (
            <div className="mt-4">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">Parcel IDs</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {sampleIds.map((id) => (
                  <span key={id} className="rounded-[var(--radius-sm)] border border-white/15 bg-white/[0.06] px-2 py-1 font-mono text-[11px] text-white/80">
                    {id}
                  </span>
                ))}
                {parcels.length > sampleIds.length && (
                  <span className="px-1 py-1 text-[11px] text-white/45">+{(parcels.length - sampleIds.length).toLocaleString()} more</span>
                )}
              </div>
            </div>
          )}

          {parsed.result.warnings.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {parsed.result.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-[12px] leading-snug text-white/60">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brass/80" />
                  {w}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
            <div className="flex items-center gap-3">
              <button
                onClick={discard}
                disabled={importing}
                className="text-[13px] font-medium text-white/60 transition hover:text-white disabled:pointer-events-none disabled:opacity-40"
              >
                Choose a different file
              </button>
              <button
                onClick={() => setStage("trim")}
                disabled={importing}
                className="text-[13px] font-medium text-white/60 transition hover:text-white disabled:pointer-events-none disabled:opacity-40"
              >
                Trim on the map
              </button>
            </div>
            <button
              onClick={() => void confirm(parcels)}
              disabled={importing}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] px-5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(122,96,52,0.45)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
            >
              {progress
                ? `Importing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                : `Import ${parcels.length.toLocaleString()} lot${parcels.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {error && <ErrorBox message={error} className="absolute inset-x-6 bottom-6 mx-auto max-w-[520px]" />}
    </div>
  );
}

function ErrorBox({ message, className }: { message: string; className: string }) {
  return (
    <div className={cx("glass-dark pop-in rounded-[var(--radius)] px-4 py-3", className)}>
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger-ink">Couldn&apos;t use that file</div>
      <p className="mt-1 text-[12px] leading-relaxed text-white/70">{message}</p>
    </div>
  );
}
