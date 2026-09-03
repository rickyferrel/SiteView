import { deleteParcel, updateParcel, setParcelGeometry } from "@/lib/repo";
import { DrawGeometryError } from "@/lib/geojson";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    patch?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    /** Reshaped outline from the draw tool. Kept off `patch` on purpose:
        geometry is validated + re-measured, never a whitelisted column write. */
    geometry?: unknown;
  };
  try {
    let acres: { parcel_acres: string } | null = null;
    if (body.geometry) acres = await setParcelGeometry(rowId, body.geometry);
    if (body.patch || body.properties) await updateParcel(rowId, body.patch ?? {}, body.properties);
    return ok(acres ? { ok: true, ...acres } : { ok: true });
  } catch (e) {
    // Geometry validation is the operator's mistake; every other failure —
    // including a write that blew up after validation passed — is the server's.
    if (e instanceof DrawGeometryError) return fail(e.message, 400);
    console.error("parcel PATCH failed", e);
    return fail((e as Error).message, 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  try {
    await deleteParcel(rowId);
    return ok();
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}
