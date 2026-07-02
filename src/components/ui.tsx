// Shared design-system primitives for the Map Portal operator console.
// Cool monochrome chrome, one restrained brass accent, cartographic mono labels.

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---- Logomark: a topographic "peak" drawn as elevation contours ---------- */

export function Logomark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 22 L14 5.5 L25.5 22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
      <path d="M6.5 22 L14 11 L21.5 22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
      <path d="M10.5 22 L14 16.5 L17.5 22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---- Eyebrow: mono uppercase micro-label --------------------------------- */

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={cx("eyebrow", className)}>{children}</span>;
}

/* ---- Buttons ------------------------------------------------------------- */

type Variant = "primary" | "brass" | "ghost" | "subtle";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink-1 shadow-[0_1px_0_rgba(13,19,32,0.6)_inset,0_1px_2px_rgba(13,19,32,0.25)]",
  brass:
    "text-white bg-[linear-gradient(180deg,#8b6d3d,#6a5230)] hover:brightness-[1.08] shadow-[0_1px_2px_rgba(122,96,52,0.45)]",
  ghost: "border border-line bg-panel text-ink-1 hover:bg-panel-2 hover:border-[color:var(--color-panel-3)]",
  subtle: "text-graphite hover:bg-panel-2 hover:text-ink",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
};

export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium tracking-[-0.01em] transition",
        "disabled:pointer-events-none disabled:opacity-45",
        SIZE[size],
        VARIANT[variant],
        className
      )}
    >
      {children}
    </button>
  );
}

/* ---- Surfaces ------------------------------------------------------------ */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={cx("card", className)}>{children}</div>;
}

/* A titled config section: mono eyebrow header + optional right-side action. */
export function Section({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("card overflow-hidden", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5">
        <div>
          <h2 className="eyebrow !text-graphite">{title}</h2>
          {hint && <p className="mt-1 text-[13px] text-faint">{hint}</p>}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ---- Page header --------------------------------------------------------- */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-2 font-display text-[28px] font-bold leading-none tracking-[-0.03em] text-ink">{title}</h1>
        {description && <p className="mt-2.5 max-w-xl text-sm text-graphite">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---- Instrument readout: a big mono metric ------------------------------- */

export function Readout({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>{label}</Eyebrow>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[34px] font-medium leading-none tracking-[-0.04em] text-ink tabular-nums">{value}</span>
        {unit && <span className="font-mono text-sm text-faint">{unit}</span>}
      </div>
      {sub && <div className="text-[13px] text-graphite">{sub}</div>}
    </div>
  );
}

/* ---- Status dot ---------------------------------------------------------- */

export function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full ring-1 ring-inset ring-black/10"
      style={{ width: size, height: size, background: color }}
    />
  );
}

/* ---- Form fields --------------------------------------------------------- */

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow !tracking-[0.12em]">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const FIELD_BASE =
  "w-full rounded-[var(--radius-sm)] border border-line bg-panel px-3 text-sm text-ink placeholder:text-faint " +
  "transition focus:border-ink/30 focus:ring-2 focus:ring-ink/10 focus-visible:outline-none";

export function TextInput({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: unknown;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cx(FIELD_BASE, "h-9", className)}
    />
  );
}

export const fieldClass = (extra = "") => cx(FIELD_BASE, "h-9", extra);

/* ---- SaveState: the one shared save-feedback instrument ------------------- */
/* Every onBlur-saving surface routes mutation feedback through this so a save
   always *feels* acknowledged the same way. Purely presentational — it renders
   derived state, it does not own any. */

export function SaveState({
  state,
  at,
  className = "",
}: {
  state: "idle" | "saving" | "saved";
  at?: string;
  className?: string;
}) {
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.1em] tabular-nums", className)}
      aria-live="polite"
    >
      {state === "saving" ? (
        <>
          <span
            className="save-spin inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-faint border-t-transparent"
            aria-hidden="true"
          />
          <span className="text-faint">SAVING</span>
        </>
      ) : state === "saved" ? (
        <>
          <span
            key={at /* re-mount on each save so the pulse replays */}
            className="save-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-brass ring-1 ring-inset ring-black/10"
            aria-hidden="true"
          />
          <span className="text-graphite">{at ? `SAVED ${at}` : "SAVED"}</span>
        </>
      ) : (
        <>
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-panel-3" aria-hidden="true" />
          <span className="text-faint">SAVED</span>
        </>
      )}
    </span>
  );
}

/* ---- EmptyState: an empty surface is an invitation to act ----------------- */

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  hint: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-12 text-center", className)}>
      <span className="text-brass opacity-30">
        {icon ?? <Logomark className="h-9 w-9" />}
      </span>
      <h3 className="mt-4 font-display text-[17px] font-bold tracking-[-0.02em] text-ink">{title}</h3>
      <p className="mt-1.5 max-w-[34ch] text-[13px] leading-relaxed text-graphite">{hint}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ---- Skeleton: holds layout for async bodies ----------------------------- */
/* Compose rows of these at real element heights instead of flashing a bare
   "Loading…" or a false-empty. Shimmer is stilled under reduced-motion. */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={cx("skeleton h-4 w-full", className)} />;
}

/* ---- Chip: one shared tag treatment -------------------------------------- */
/* Unifies the filter pill / field-type tag / status chip. `data` tone colors
   itself from a status value already in hand — pass it via style/className from
   the caller (e.g. style={{ color, borderColor }}). */

type ChipTone = "neutral" | "ink" | "data";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "border border-line bg-panel-2 text-graphite",
  ink: "border border-transparent bg-ink text-white",
  data: "border bg-transparent",
};

export function Chip({
  tone = "neutral",
  className = "",
  children,
  style,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-0.5 font-mono text-[11px] tracking-[0.04em]",
        CHIP_TONE[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
