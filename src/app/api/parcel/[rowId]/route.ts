import { deleteParcel, updateParcel } from "@/lib/repo";
import { ok, fail } from "@/lib/http";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    patch?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  };
  try {
    await updateParcel(rowId, body.patch ?? {}, body.properties);
    return ok();
  } catch (e) {
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
