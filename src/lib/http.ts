import { NextResponse } from "next/server";
import type { DataState } from "./types";

export function parseState(req: Request): DataState {
  const url = new URL(req.url);
  return url.searchParams.get("state") === "published" ? "published" : "draft";
}

// Published data may be CDN-cached briefly (drives "updates within seconds on
// refresh"); draft data is always fresh for the in-portal preview.
export function dataJson(body: unknown, state: DataState) {
  return NextResponse.json(body, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control":
        state === "published"
          ? "public, max-age=15, s-maxage=60, stale-while-revalidate=120"
          : "no-store",
    },
  });
}

export function ok(body: unknown = { ok: true }) {
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
