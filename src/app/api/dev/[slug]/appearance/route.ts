import { getDevelopment, updateAppearance } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import { BASEMAP_PRESETS, type Basemap, type MapAppearance } from "@/lib/types";

export const runtime = "nodejs";

const VALID = new Set<Basemap>(["custom", ...(Object.keys(BASEMAP_PRESETS) as Basemap[])]);

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(dev.map_appearance);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);

  const body = (await req.json().catch(() => ({}))) as Partial<MapAppearance>;
  const next: MapAppearance = {
    basemap: VALID.has(body.basemap as Basemap) ? (body.basemap as Basemap) : dev.map_appearance.basemap,
    terrain: typeof body.terrain === "boolean" ? body.terrain : dev.map_appearance.terrain,
    terrainExaggeration: clamp(body.terrainExaggeration, dev.map_appearance.terrainExaggeration ?? 1.5, 0, 3),
    satelliteHueRotate: clamp(body.satelliteHueRotate, dev.map_appearance.satelliteHueRotate ?? 0, -180, 180),
    satelliteSaturation: clamp(body.satelliteSaturation, dev.map_appearance.satelliteSaturation ?? 0, -1, 1),
  };
  await updateAppearance(dev.id, next);
  return ok(next);
}

function clamp(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
