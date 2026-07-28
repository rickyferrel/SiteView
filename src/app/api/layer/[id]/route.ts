import { updateLayer, deleteLayer } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import { validCorners } from "@/lib/layers";
import type { ShapeStyle } from "@/lib/types";

export const runtime = "nodejs";

type Patch = {
  name?: unknown;
  visible?: unknown;
  opacity?: unknown;
  above_lots?: unknown;
  visitor_toggle?: unknown;
  corners?: unknown;
  geometry?: unknown;
  style?: Partial<ShapeStyle>;
};

// PATCH /api/layer/{id} — position, styling and stacking. Every field is
// optional; only what's present is written, so the positioning editor can stream
// corner updates without echoing the rest of the row back.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Patch | null;
  if (!body) return fail("invalid JSON body");

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 120) || "Untitled layer";
  if (typeof body.visible === "boolean") patch.visible = body.visible;
  if (typeof body.above_lots === "boolean") patch.above_lots = body.above_lots;
  if (typeof body.visitor_toggle === "boolean") patch.visitor_toggle = body.visitor_toggle;
  if (body.opacity !== undefined) {
    const n = Number(body.opacity);
    if (!Number.isFinite(n)) return fail("opacity must be a number");
    patch.opacity = Math.max(0, Math.min(1, n));
  }
  if (body.corners !== undefined) {
    // Corners feed a Mapbox image source, which bowtie-warps on bad input rather
    // than erroring — so a malformed set must never reach the DB.
    if (!validCorners(body.corners)) return fail("corners must be four [lng,lat] pairs");
    patch.corners = body.corners;
  }
  if (body.geometry !== undefined) {
    const g = body.geometry as GeoJSON.Geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "LineString")) {
      return fail("geometry must be a Polygon or LineString");
    }
    patch.geometry = g;
  }
  if (body.style !== undefined) patch.style = body.style;

  if (Object.keys(patch).length === 0) return fail("nothing to update");

  try {
    const layer = await updateLayer(id, patch);
    if (!layer) return fail("layer not found", 404);
    return ok(layer);
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

// DELETE /api/layer/{id} — drops the layer only. Its asset row stays: published
// snapshots still point at that asset_id and would otherwise render blank.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteLayer(id);
  return ok();
}
