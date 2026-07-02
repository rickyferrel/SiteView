"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { devPath, slugify, DEFAULT_MAP_STYLE } from "@/lib/const";
import { jsend } from "@/lib/client";
import type { Development } from "@/lib/types";
import { Eyebrow, Field, TextInput, Button, cx } from "@/components/ui";

export default function NewDevelopmentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [style, setStyle] = useState("");
  const [token, setToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = useMemo(() => (slugTouched ? slugify(slug) : slugify(name)), [name, slug, slugTouched]);

  async function create() {
    if (!name.trim()) {
      setError("Give the development a name first.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const dev = await jsend<Development>("/api/dev", "POST", {
        name: name.trim(),
        slug: effectiveSlug,
        mapbox_style: style.trim() || undefined,
        mapbox_token: token.trim() || undefined,
      });
      router.push(devPath(dev.slug, "parcels"));
    } catch (e) {
      // jsend throws "409: {..}" — surface a clean message.
      const raw = String(e instanceof Error ? e.message : e);
      const m = raw.match(/"error":"([^"]+)"/);
      setError(m ? m[1] : raw);
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      {/* Intro band — the same contour field used on the overview, scaled down */}
      <section className="contour-field rise overflow-hidden rounded-[var(--radius-lg)] border border-line px-7 py-7 text-white shadow-[var(--shadow-pop)]">
        <Eyebrow className="!text-white/55">Multi-site · New development</Eyebrow>
        <h1 className="mt-3 font-display text-[26px] font-bold leading-[1.05] tracking-[-0.03em]">
          Spin up a development
        </h1>
        <p className="mt-2.5 max-w-md text-[14px] leading-relaxed text-white/65">
          Name it, and we&apos;ll stand up its workspace with a working status palette. Next you&apos;ll search an address and
          select its parcels — Summit Creek stays untouched.
        </p>
      </section>

      <div className="card rise mt-5 p-6" style={{ animationDelay: "60ms" }}>
        <div className="space-y-5">
          <Field label="Development name">
            <TextInput value={name} onChange={setName} placeholder="e.g. Cedar Ridge" />
          </Field>

          {/* Live slug preview — the URL this site will live at. */}
          <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-panel-2/60 px-3.5 py-2.5">
            <span className="eyebrow !tracking-[0.12em]">URL</span>
            <span className="font-mono text-[13px] text-ink-1">
              /d/<span className={cx(effectiveSlug ? "text-brass-ink" : "text-faint")}>{effectiveSlug || "your-development"}</span>
            </span>
            {!advanced && (
              <button
                onClick={() => setAdvanced(true)}
                className="ml-auto text-[12px] font-medium text-faint transition hover:text-ink"
              >
                Customize
              </button>
            )}
          </div>

          {advanced && (
            <div className="space-y-4 rounded-[var(--radius)] border border-line-2 bg-panel-2/40 p-4">
              <Field label="URL slug">
                <TextInput
                  value={slugTouched ? slug : effectiveSlug}
                  onChange={(v) => {
                    setSlug(v);
                    setSlugTouched(true);
                  }}
                  placeholder="cedar-ridge"
                />
              </Field>
              <Field label="Mapbox style URL">
                <TextInput value={style} onChange={setStyle} placeholder={DEFAULT_MAP_STYLE} />
              </Field>
              <Field label="Mapbox token">
                <TextInput value={token} onChange={setToken} placeholder="Uses the shared agency token" />
              </Field>
              <p className="text-[12px] text-faint">
                Leave blank to use Mapbox Standard and the shared agency token. You can paste a tuned style anytime in
                Map Design.
              </p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-5">
            <Link href="/" className="text-[13px] font-medium text-graphite transition hover:text-ink">
              Cancel
            </Link>
            <Button variant="brass" onClick={create} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create and add parcels"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
