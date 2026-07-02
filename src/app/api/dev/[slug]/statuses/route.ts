import { getDevelopment, getStatuses, createStatus } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import type { Status } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  return ok(await getStatuses(dev.id));
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dev = await getDevelopment(slug);
  if (!dev) return fail("development not found", 404);
  const body = (await req.json().catch(() => ({}))) as Partial<Status>;
  const id = await createStatus(dev.id, body);
  return ok({ id });
}
