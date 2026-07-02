"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { devPath } from "@/lib/const";
import { jget } from "@/lib/client";
import type { MapConfig } from "@/lib/types";
import OpeningViewEditor from "@/components/OpeningViewEditor";
import { PageHeader } from "@/components/ui";

// Add-flow step: after importing parcels the operator frames the shot visitors
// land on. Saving the view advances to the overview; skipping keeps auto-fit.
export default function OpeningViewStep() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [config, setConfig] = useState<MapConfig | null>(null);

  useEffect(() => {
    jget<MapConfig>(`/api/dev/${slug}/config?state=draft`).then(setConfig).catch(() => {});
  }, [slug]);

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-5">
      <PageHeader
        eyebrow={`Opening view · ${config?.development.name ?? "…"}`}
        title="Set the opening view"
        description="This is the camera the public map lands on when it first loads. Pan, zoom, tilt and rotate to frame the development, then save. You can change it anytime in Map Design."
        actions={
          <Link
            href={devPath(slug)}
            className="inline-flex h-9 select-none items-center justify-center rounded-[var(--radius-sm)] px-4 text-sm font-medium tracking-[-0.01em] text-graphite transition hover:bg-panel-2 hover:text-ink"
          >
            Skip for now
          </Link>
        }
      />

      <div className="min-h-0 flex-1">
        <OpeningViewEditor
          slug={slug}
          className="h-full w-full"
          onSaved={() => router.push(devPath(slug))}
        />
      </div>
    </div>
  );
}
