import { getDevelopment, updateDefaultView } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import type { ViewState } from "@/lib/types";

export const runtime = "nodejs";

// GET /api/dev/{slug}/view — the current opening camera + whether it's locked.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok({ default_view: dev.default_view, view_locked: dev.view_locked });
}

// PATCH /api/dev/{slug}/view — save a hand-framed opening view (locks it so the
// embed opens here instead of auto-fitting the lots).
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);

  const body = (await req.json().catch(() => ({}))) as Partial<ViewState>;
  const view = sanitizeView(body);
  if (!view) return fail("A valid center, zoom, pitch and bearing are required");

  await updateDefaultView(dev.id, view, true);
  return ok({ default_view: view, view_locked: true });
}

// DELETE /api/dev/{slug}/view — drop the hand-framed view; the embed goes back
// to auto-fitting the lot cluster on open. Keeps the stored center/zoom as-is.
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  await updateDefaultView(dev.id, dev.default_view, false);
  return ok({ default_view: dev.default_view, view_locked: false });
}

// Coerce + range-check an incoming view. Rejects anything non-finite so a bad
// payload can never brick the embed's camera.
function sanitizeView(b: Partial<ViewState>): ViewState | null {
  const c = b.center;
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [lng, lat] = [Number(c[0]), Number(c[1])];
  const zoom = Number(b.zoom);
  const pitch = Number(b.pitch);
  const bearing = Number(b.bearing);
  if (![lng, lat, zoom, pitch, bearing].every(Number.isFinite)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return {
    center: [lng, lat],
    zoom: clamp(zoom, 0, 22),
    pitch: clamp(pitch, 0, 85),
    bearing: ((bearing % 360) + 360) % 360,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
