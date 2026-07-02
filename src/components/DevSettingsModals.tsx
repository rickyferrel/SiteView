"use client";

// Edit + Delete surfaces for a development, opened from the atlas cards and from
// the dashboard command band. Both wire straight to the /api/dev/{slug} contract
// and route the operator afterward: a slug change moves the live embed, so we
// send them to the new path; a delete drops them back on the atlas.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { devPath, slugify } from "@/lib/const";
import { jsend } from "@/lib/client";
import type { Development, DevelopmentSummary } from "@/lib/types";
import { Modal } from "@/components/Modal";
import { Field, TextInput, Button, SaveState, cx } from "@/components/ui";

// jsend throws "409: {...}" — lift the operator-facing message back out.
function errText(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e);
  const m = raw.match(/"error":"([^"]+)"/);
  return m ? m[1] : raw;
}

/* ---- Edit ---------------------------------------------------------------- */

type EditProps = {
  dev: DevelopmentSummary;
  open: boolean;
  onClose: () => void;
  // Parent refreshes its list with the returned row (name/slug may have moved).
  onSaved?: (updated: Development) => void;
  // When provided, surfaces a "Delete" affordance that hands off to the guarded
  // delete flow (the parent swaps this modal for the delete one).
  onRequestDelete?: () => void;
};

// The body carries all form state, initialized straight from props. Its wrapper
// only mounts it while open (with a per-dev key), so every open starts fresh —
// no reset effect, no cascading setState.
export function EditDevelopmentModal({ open, dev, ...rest }: EditProps) {
  if (!open) return null;
  return <EditDevelopmentBody key={dev.slug} open dev={dev} {...rest} />;
}

function EditDevelopmentBody({ dev, onClose, onSaved, onRequestDelete }: EditProps) {
  const router = useRouter();
  const [name, setName] = useState(dev.name);
  const [style, setStyle] = useState("");
  const [token, setToken] = useState("");
  const [slug, setSlug] = useState(dev.slug);
  const [editingSlug, setEditingSlug] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const nextSlug = slugify(slug);
  const slugMoved = editingSlug && nextSlug !== dev.slug && nextSlug !== "";
  const dirty =
    name.trim() !== dev.name || slugMoved || style.trim() !== "" || token.trim() !== "";

  async function save() {
    if (!name.trim()) {
      setError("Give the development a name.");
      return;
    }
    setState("saving");
    setError(null);
    try {
      const patch: Record<string, string> = { name: name.trim() };
      if (slugMoved) patch.slug = nextSlug;
      if (style.trim()) patch.mapbox_style = style.trim();
      if (token.trim()) patch.mapbox_token = token.trim();

      const updated = await jsend<Development>(`/api/dev/${dev.slug}`, "PATCH", patch);
      setState("saved");
      onSaved?.(updated);

      // A moved slug moves the live URL — take the operator to the new path.
      if (updated.slug !== dev.slug) {
        onClose();
        router.push(devPath(updated.slug));
        return;
      }
      // Settle the "saved" flash, then close.
      setTimeout(onClose, 650);
    } catch (e) {
      setState("idle");
      setError(errText(e));
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Site settings" title={`Edit ${dev.name}`}>
      <div className="space-y-5">
        <Field label="Development name">
          <TextInput value={name} onChange={setName} placeholder="e.g. Cedar Ridge" />
        </Field>

        <Field label="Mapbox style URL">
          <TextInput value={style} onChange={setStyle} placeholder="Leave blank to keep the current style" />
        </Field>

        <Field label="Mapbox token">
          <TextInput value={token} onChange={setToken} placeholder="Leave blank to keep the current token" />
        </Field>

        {/* Slug is deliberately locked. Editing it re-points the live embed, so
            it hides behind an explicit affordance and a plain-spoken warning. */}
        <div className="rounded-[var(--radius)] border border-line-2 bg-panel-2/40 p-4">
          {!editingSlug ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="eyebrow !tracking-[0.12em]">Embed URL</span>
                <div className="mt-1 truncate font-mono text-[13px] text-ink-1">
                  /embed/<span className="text-brass-ink">{dev.slug}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingSlug(true)}
                className="shrink-0 text-[12px] font-medium text-graphite transition hover:text-ink"
              >
                Change URL slug
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="URL slug">
                <TextInput value={slug} onChange={setSlug} placeholder={dev.slug} />
              </Field>
              <div className="font-mono text-[12px] text-faint">
                /embed/<span className={cx(nextSlug ? "text-brass-ink" : "text-faint")}>{nextSlug || "your-slug"}</span>
              </div>
              {slugMoved && (
                <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-danger-ink">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                  <span>
                    This moves the live embed URL. Update your WordPress iframe to{" "}
                    <span className="font-mono">/embed/{nextSlug}</span> after saving, or the map will 404.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-4">
          <SaveState state={state} />
          <div className="flex items-center gap-2">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="brass" onClick={save} disabled={state === "saving" || !dirty || !name.trim()}>
              {state === "saving" ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>

        {onRequestDelete && (
          <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-4">
            <span className="text-[12.5px] text-faint">Removing this site is permanent.</span>
            <button
              type="button"
              onClick={onRequestDelete}
              className="text-[13px] font-medium text-danger-ink transition hover:underline"
            >
              Delete development
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---- Delete -------------------------------------------------------------- */

type DeleteProps = {
  dev: DevelopmentSummary;
  open: boolean;
  onClose: () => void;
  // Parent decides where to go; the atlas drops the card, the dashboard routes home.
  onDeleted?: () => void;
};

export function DeleteDevelopmentModal({ open, dev, ...rest }: DeleteProps) {
  if (!open) return null;
  return <DeleteDevelopmentBody key={dev.slug} open dev={dev} {...rest} />;
}

function DeleteDevelopmentBody({ dev, onClose, onDeleted }: DeleteProps) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = confirm.trim() === dev.name;

  async function remove() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await jsend(`/api/dev/${dev.slug}`, "DELETE");
      onDeleted?.();
    } catch (e) {
      setBusy(false);
      setError(errText(e));
    }
  }

  const lots = dev.parcel_count;

  return (
    <Modal open onClose={onClose} eyebrow="Danger zone" title={`Delete ${dev.name}`}>
      <div className="space-y-5">
        <p className="text-[14px] leading-relaxed text-ink-1">
          Deletes {lots === 1 ? "1 lot" : `all ${lots} lots`}, its statuses, filters, custom fields, and its entire
          publish history. The live <span className="font-mono text-[13px]">/embed/{dev.slug}</span>{" "}
          stops rendering. This can&apos;t be undone.
        </p>

        <Field label={`Type the name to confirm — ${dev.name}`}>
          <TextInput value={confirm} onChange={setConfirm} placeholder={dev.name} />
        </Field>

        {error && (
          <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger-ink">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-line-2 pt-4">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={remove}
            disabled={!armed || busy}
            className={cx(
              "inline-flex h-9 select-none items-center justify-center gap-2 rounded-[var(--radius-sm)] px-4 text-sm font-medium tracking-[-0.01em] text-white transition",
              "bg-[linear-gradient(180deg,#c05046,#a13b31)] hover:brightness-[1.06] shadow-[0_1px_2px_rgba(150,58,49,0.45)]",
              "disabled:pointer-events-none disabled:opacity-45"
            )}
          >
            {busy ? "Deleting…" : "Delete development"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
