import { getDevelopment, getPreviewLink, mintPreviewLink, previewLinkIsLive } from "@/lib/repo";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

// GET /api/dev/{slug}/preview-link — the active customer preview link. Mints a
// fresh 7-day token when none exists or the stored one has lapsed, so the
// portal's link card always holds a working link.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);

  const link = await getPreviewLink(dev.id);
  return ok(previewLinkIsLive(link) ? link : await mintPreviewLink(dev.id));
}

// POST /api/dev/{slug}/preview-link — force a new link. The old token stops
// working immediately, so this is also the "revoke what I already sent" tool.
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await mintPreviewLink(dev.id));
}
