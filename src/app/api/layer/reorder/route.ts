import { getDevelopment, reorderLayers, getLayers } from "@/lib/repo";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

// POST /api/layer/reorder — one write for a whole drag-reorder, so the stack
// never renders half-applied. `ids` is the new bottom-to-top order.
//
// This sits above /api/layer/[id] in Next's routing (a static segment beats a
// dynamic one); layer ids are UUIDs, so "reorder" can never shadow a real row.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { slug?: string; ids?: unknown } | null;
  if (!body?.slug) return fail("slug required");
  if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== "string")) {
    return fail("ids must be an array of layer ids");
  }

  const dev = await getDevelopment(body.slug);
  if (!dev) return fail("development not found", 404);

  try {
    // Scoped to this development, so a stray id from another map is a no-op.
    await reorderLayers(dev.id, body.ids as string[]);
    return ok(await getLayers(dev.id));
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
