import { getDevelopment, getPreviewLink, mintPreviewLink, renewPreviewLink } from "@/lib/repo";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

// GET /api/dev/{slug}/preview-link — the stored customer preview link. Mints the
// first token only; expired links stay visible so the portal can renew the timer
// without changing the URL.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);

  const link = await getPreviewLink(dev.id);
  return ok(link ?? await mintPreviewLink(dev.id));
}

// POST /api/dev/{slug}/preview-link — force a new link. The old token stops
// working immediately, so this is also the "revoke what I already sent" tool.
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await mintPreviewLink(dev.id));
}

// PATCH /api/dev/{slug}/preview-link — keep the current URL, but restart its
// 7-day clock from now. If no token exists yet, mint the first one.
export async function PATCH(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await renewPreviewLink(dev.id));
}
