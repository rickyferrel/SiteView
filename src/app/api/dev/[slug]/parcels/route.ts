import { getParcels } from "@/lib/repo";
import { parseState, dataJson, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = parseState(req);
  const fc = await getParcels(slug, state);
  if (!fc) return fail("development not found", 404);
  return dataJson(fc, state);
}
