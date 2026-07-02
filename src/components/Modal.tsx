"use client";

// One shared modal shell for the operator console. Closes on Escape and on
// backdrop click (mirroring the ClientSwitcher popover), moves focus into the
// panel on open and restores it on close, and traps Tab within the panel so a
// keyboard user can't wander behind the scrim. Motion rides the existing
// `pop-in` keyframe, which is already stilled under prefers-reduced-motion.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Eyebrow, cx } from "@/components/ui";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  eyebrow,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    const restoreTo = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    // Pull focus in — first real control, else the panel itself.
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null
        );
        if (items.length === 0) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    // Hold the page still behind the scrim.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreTo?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        // Backdrop click only — ignore drags that start inside the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fixed inset-0 bg-[color-mix(in_srgb,var(--ink)_46%,transparent)] backdrop-blur-[2px]" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "pop-in relative z-10 my-auto w-full max-w-md overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel shadow-[var(--shadow-pop)] focus:outline-none",
          className
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line-2 px-6 py-4">
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 id={titleId} className="mt-1.5 font-display text-[19px] font-bold tracking-[-0.02em] text-ink">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] text-faint transition hover:bg-panel-2 hover:text-ink"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
