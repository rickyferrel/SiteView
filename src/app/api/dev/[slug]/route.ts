import { getDevelopment, updateDevelopment, deleteDevelopment } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import { slugify } from "@/lib/const";
import type { ViewState } from "@/lib/types";

export const runtime = "nodejs";

// GET /api/dev/[slug] — the full development row (name, style, token, view).
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("No development at that slug", 404);
  return ok(dev);
}

// PATCH /api/dev/[slug] — rename or re-point a development.
// Changing the slug moves the live embed URL, so the client warns first.
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    mapbox_token?: string;
    mapbox_style?: string;
    default_view?: ViewState;
  };

  const patch: { name?: string; slug?: string; mapbox_token?: string; mapbox_style?: string } = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return fail("Name can't be empty");
    patch.name = name;
  }

  if (body.slug !== undefined) {
    const next = slugify(body.slug);
    if (!next) return fail("Could not derive a slug — add letters or numbers");
    if (next !== slug && (await getDevelopment(next))) {
      return fail(`The slug “${next}” is already taken`, 409);
    }
    patch.slug = next;
  }

  if (body.mapbox_token !== undefined) patch.mapbox_token = body.mapbox_token.trim();
  if (body.mapbox_style !== undefined) patch.mapbox_style = body.mapbox_style.trim();

  try {
    const dev = await updateDevelopment(slug, patch);
    if (!dev) return fail("No development at that slug", 404);
    return ok(dev);
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

// DELETE /api/dev/[slug] — tear down the development and everything under it.
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const removed = await deleteDevelopment(slug);
  if (!removed) return fail("No development at that slug", 404);
  return ok();
}
