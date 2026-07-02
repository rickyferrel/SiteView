import MapView from "@/components/MapView";
import type { DataState } from "@/lib/types";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SP>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // WordPress loads the bare URL → published. Portal preview adds ?state=draft.
  const state: DataState = sp.state === "draft" ? "draft" : "published";
  const stop = typeof sp.stop === "string" ? sp.stop : undefined;
  return <MapView slug={slug} state={state} stop={stop} />;
}
