import { listDevelopments, createDevelopment, getDevelopment } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import { AGENCY_MAPBOX_TOKEN, DEFAULT_MAP_STYLE, slugify } from "@/lib/const";
import type { ViewState } from "@/lib/types";

export const runtime = "nodejs";

// GET /api/dev — every development, for the switcher.
export async function GET() {
  return ok(await listDevelopments());
}

// POST /api/dev — create a development. Returns the new row; 409 on slug clash.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    mapbox_token?: string;
    mapbox_style?: string;
    default_view?: ViewState;
  };

  const name = (body.name ?? "").trim();
  if (!name) return fail("Name is required");
  const slug = (body.slug?.trim() || slugify(name)).trim();
  if (!slug) return fail("Could not derive a slug from that name — add letters or numbers");

  if (await getDevelopment(slug)) return fail(`The slug “${slug}” is already taken`, 409);

  try {
    const dev = await createDevelopment({
      name,
      slug,
      mapbox_token: (body.mapbox_token ?? "").trim() || AGENCY_MAPBOX_TOKEN,
      mapbox_style: (body.mapbox_style ?? "").trim() || DEFAULT_MAP_STYLE,
      default_view: body.default_view,
    });
    return ok(dev);
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
