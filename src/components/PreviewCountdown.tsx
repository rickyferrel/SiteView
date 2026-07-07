"use client";

// The customer preview link's clock, in three pieces:
//  - PreviewCountdown: the ticking chip in the preview page's top banner.
//  - PreviewExpiredCurtain: covers the map the moment the countdown hits zero,
//    so a page left open behaves exactly like a fresh load of a dead link.
//  - PreviewExpiredNotice: the shared "this link is closed" composition, also
//    rendered server-side when someone arrives on an expired or bad token.

import { useEffect, useState } from "react";
import { Logomark, cx } from "@/components/ui";

const DAY_MS = 24 * 60 * 60 * 1000;

// Milliseconds until expiry, re-sampled every second. Null until mounted so the
// server-rendered placeholder never mismatches the client's clock.
function useRemaining(expiresAt: string): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const firstTick = window.setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(firstTick);
      clearInterval(id);
    };
  }, []);
  return now === null ? null : new Date(expiresAt).getTime() - now;
}

// 612345678ms → "7d 02:11:18"; under a day → "02:11:18".
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(total / 86400);
  const clock = `${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function PreviewCountdown({ expiresAt }: { expiresAt: string }) {
  const remaining = useRemaining(expiresAt);
  const expired = remaining !== null && remaining <= 0;
  const closing = remaining !== null && !expired && remaining < DAY_MS;

  return (
    <span
      className={cx(
        "flex shrink-0 items-baseline gap-2.5 rounded-[var(--radius-sm)] border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em]",
        expired ? "border-danger/50 text-danger" : closing ? "border-danger/40 text-white/40" : "border-brass/40 text-white/40"
      )}
    >
      <span className="hidden sm:inline">{expired ? "Preview" : "Preview · expires in"}</span>
      <span className={cx("tabular-nums tracking-[0.08em]", expired ? "text-danger" : closing ? "text-danger" : "text-brass")}>
        {remaining === null ? "—" : expired ? "Expired" : formatRemaining(remaining)}
      </span>
    </span>
  );
}

/** Swaps the map for the closed notice the second the link's clock runs out. */
export function PreviewExpiredCurtain({ expiresAt }: { expiresAt: string }) {
  const remaining = useRemaining(expiresAt);
  if (remaining === null || remaining > 0) return null;
  return (
    <div className="absolute inset-0 z-10 bg-stage">
      <PreviewExpiredNotice />
    </div>
  );
}

/** The closed-link composition — fills whatever stage-dark box it's placed in. */
export function PreviewExpiredNotice() {
  return (
    <div className="contour-whisper grid h-full w-full place-items-center px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="grid h-12 w-12 place-items-center rounded-[var(--radius-sm)] border border-white/[0.12] bg-white/[0.03] text-white/30">
          <Logomark className="h-6 w-6" />
        </span>
        <p className="mt-6 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          Preview link · expired
        </p>
        <h2 className="mt-3 font-display text-[26px] font-bold leading-tight tracking-[-0.02em] text-white">
          This preview has expired
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-white/55">
          Preview links stay live for seven days, then close. Ask whoever sent you this one for a fresh link.
        </p>
      </div>
    </div>
  );
}
