import { importSummitCreek, importByBbox, importByParcelIds, importGeoJSON } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import type { Bbox } from "@/lib/arcgis";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    mode?: string;
    bbox?: Bbox;
    ids?: string[];
    county?: string;
    geojson?: unknown;
  };
  try {
    if (body.mode === "geojson") {
      if (!body.geojson) return fail("geojson required");
      const res = await importGeoJSON(slug, body.geojson);
      return ok(res);
    }
    if (body.mode === "ids") {
      if (!Array.isArray(body.ids) || body.ids.length === 0) return fail("ids required");
      const res = await importByParcelIds(slug, body.ids, body.county);
      return ok(res);
    }
    if (body.mode === "bbox") {
      if (!Array.isArray(body.bbox) || body.bbox.length !== 4) return fail("bbox required");
      const res = await importByBbox(slug, body.bbox);
      return ok(res);
    }
    // Default: migrate Summit Creek from the live tileset + ArcGIS geometry.
    const res = await importSummitCreek(slug);
    return ok(res);
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
