import { getParcels, createDrawnParcel, type DrawnParcelInput } from "@/lib/repo";
import { DrawGeometryError } from "@/lib/geojson";
import { parseState, dataJson, ok, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = parseState(req);
  const fc = await getParcels(slug, state);
  if (!fc) return fail("development not found", 404);
  return dataJson(fc, state);
}

/**
 * Create one hand-drawn lot. The draw tool calls this the moment a polygon
 * closes, so the lot exists in the draft before the operator starts the next
 * one. Validation errors come back as 400 with the message the tool shows.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<DrawnParcelInput>;
  if (!body.geometry) return fail("geometry required");
  try {
    const res = await createDrawnParcel(slug, body as DrawnParcelInput);
    return ok(res);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "development not found") return fail(msg, 404);
    // Only a bad shape is the operator's fault. Anything else (a missing
    // column, a dead connection) is ours — don't dress it up as "invalid shape".
    if (e instanceof DrawGeometryError) return fail(msg, 400);
    console.error("createDrawnParcel failed", e);
    return fail("Couldn't save that lot — the server hit an error.", 500);
  }
}
