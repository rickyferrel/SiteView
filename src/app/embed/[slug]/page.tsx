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
  // ribbon=0 hides the draft ribbon (customer-facing /preview/{slug} page).
  // edit=1 (portal Preview & Publish draft iframe only) enables the lot panel's
  // Remove-lot tool; MapView ignores it on published data.
  return <MapView slug={slug} state={state} stop={stop} ribbon={sp.ribbon !== "0"} edit={sp.edit === "1"} />;
}
