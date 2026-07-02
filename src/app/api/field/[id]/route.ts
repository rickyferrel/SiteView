import { deleteField } from "@/lib/repo";
import { ok } from "@/lib/http";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteField(id);
  return ok();
}
