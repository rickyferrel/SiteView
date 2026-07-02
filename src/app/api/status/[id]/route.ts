import { updateStatus, deleteStatus } from "@/lib/repo";
import { ok, fail } from "@/lib/http";
import type { Status } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<Status>;
  try {
    await updateStatus(id, body);
    return ok();
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteStatus(id);
  return ok();
}
