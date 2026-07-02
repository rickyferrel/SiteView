import { publish, getDevelopment, listPublications } from "@/lib/repo";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await listPublications(dev.id));
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as { note?: string };
  try {
    return ok(await publish(slug, body.note));
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
