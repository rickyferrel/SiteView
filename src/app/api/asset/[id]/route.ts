import { getAsset } from "@/lib/repo";
import { fail } from "@/lib/http";

export const runtime = "nodejs";

// GET /api/asset/{id} — raw overlay image bytes.
//
// Assets are immutable: editing an overlay's image mints a new asset id rather
// than rewriting these bytes, so this can be cached forever. That's what keeps
// the bytes out of the publish snapshot affordable — the embed re-fetches the
// same URL on every load and the CDN/browser answers it.
//
// This is the *only* place (besides the layer_assets table) that knows bytes are
// in Postgres. Moving to S3 later means redirecting from here; nothing upstream
// of an opaque asset id has to change.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) return fail("asset not found", 404);

  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "content-type": asset.mime,
      "content-length": String(asset.bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      // The embed runs cross-origin inside a customer's site; Mapbox pulls this
      // into a WebGL texture, which needs the image to be CORS-readable.
      "access-control-allow-origin": "*",
    },
  });
}
