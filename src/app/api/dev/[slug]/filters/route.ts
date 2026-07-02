import { getDevelopment, getFilters, createFilter } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import type { Filter } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await getFilters(dev.id));
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  const body = (await req.json().catch(() => ({}))) as Partial<Filter>;
  const id = await createFilter(dev.id, body);
  return ok({ id });
}
