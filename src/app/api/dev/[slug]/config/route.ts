import { getConfig } from "@/lib/repo";
import { parseState, dataJson, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = parseState(req);
  const config = await getConfig(slug, state);
  if (!config) return fail(state === "published" ? "not published yet" : "development not found", 404);
  return dataJson(config, state);
}
