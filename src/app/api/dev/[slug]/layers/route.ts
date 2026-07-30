import { getDevelopment, getLayers, createLayer, putAsset } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import { validCorners } from "@/lib/layers";
import { validShapeGeometry, sanitizeShapeStyle } from "@/lib/shapes";
import { MAX_LAYER_IMAGE_BYTES, LAYER_IMAGE_MIMES } from "@/lib/const";
import type { Corners, ShapeStyle } from "@/lib/types";

export const runtime = "nodejs";
// An overlay upload is a few MB of base64 through the JSON body; give it the
// same generous ceiling the parcel import gets rather than the default.
export const maxDuration = 60;

type ImageBody = {
  kind?: string;
  name?: string;
  corners?: unknown;
  above_lots?: unknown;
  visitor_toggle?: unknown;
  opacity?: unknown;
  image?: { data?: string; mime?: string; width?: unknown; height?: unknown };
  geometry?: unknown;
  style?: Partial<ShapeStyle>;
};

// GET /api/dev/{slug}/layers — the draft layer stack, bottom to top.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await getLayers(dev.id));
}

// POST /api/dev/{slug}/layers — create an image overlay (bytes as base64) or a
// drawn shape. Image bytes are stored once in layer_assets and referenced by id.
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);

  const body = (await req.json().catch(() => null)) as ImageBody | null;
  if (!body) return fail("invalid JSON body");

  const name = String(body.name ?? "").trim().slice(0, 120) || "Untitled layer";
  const common = {
    name,
    above_lots: body.above_lots === true,
    visitor_toggle: body.visitor_toggle === true,
    opacity: clamp01(body.opacity, 1),
  };

  try {
    if (body.kind === "shape") {
      if (!validShapeGeometry(body.geometry)) {
        return fail("shape layers need a Polygon or LineString geometry with enough points");
      }
      const layer = await createLayer(dev.id, {
        ...common,
        kind: "shape",
        geometry: body.geometry,
        style: sanitizeShapeStyle(body.style),
      });
      return ok(layer);
    }

    // Default: image overlay.
    const img = body.image;
    if (!img?.data) return fail("image data required");
    const mime = String(img.mime ?? "");
    if (!(LAYER_IMAGE_MIMES as readonly string[]).includes(mime)) {
      return fail(`unsupported image type "${mime}" — use PNG, JPEG or WebP`);
    }
    const width = Math.round(Number(img.width));
    const height = Math.round(Number(img.height));
    if (!(width > 0 && height > 0)) return fail("image width and height required");

    const bytes = Buffer.from(stripDataUrl(img.data), "base64");
    if (bytes.byteLength === 0) return fail("image data could not be decoded");
    if (bytes.byteLength > MAX_LAYER_IMAGE_BYTES) {
      return fail(
        `image is ${mb(bytes.byteLength)} MB after encoding — the limit is ${mb(MAX_LAYER_IMAGE_BYTES)} MB`,
        413
      );
    }

    if (!validCorners(body.corners)) return fail("four valid corner coordinates required");

    const asset = await putAsset({ mime, bytes, width, height });
    const layer = await createLayer(dev.id, {
      ...common,
      kind: "image",
      asset_id: asset.id,
      corners: body.corners as Corners,
    });
    return ok(layer);
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

// Accepts either a bare base64 payload or a full `data:image/png;base64,...` URL,
// so a caller that pasted a canvas.toDataURL() result straight through still works.
function stripDataUrl(s: string): string {
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}

function clamp01(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}
