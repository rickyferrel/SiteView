// The default development the bare "/" redirects into. Every portal page now
// lives under /d/[slug]; this is only the landing default, not a hard pin.
export const DEV_SLUG = "summit-creek";

// Shared agency Mapbox token, prefilled when creating a new development. It's a
// public `pk.` token that Mapbox GL needs client-side, so it must be a
// NEXT_PUBLIC_ var (inlined into the browser bundle at build time). Set
// NEXT_PUBLIC_MAPBOX_TOKEN in .env.local for dev and in the Amplify environment
// for prod; see .env.example.
export const AGENCY_MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

// Mapbox Standard — the default branded style for a brand-new development until
// the operator pastes their own tuned style URL.
export const DEFAULT_MAP_STYLE = "mapbox://styles/mapbox/standard";

// Parcel acquisition is gated on zoom so each ArcGIS request stays in the
// hundreds (a neighborhood), never the whole 283k-parcel state.
export const PICKER_MIN_ZOOM = 15;

// Ceiling for an overlay image *after* the browser downscales it. An upload is
// one indivisible blob — unlike GeoJSON import it can't be batched — and the
// Amplify SSR Lambda drops request bodies over ~6 MB. Base64 inflates bytes by
// 4/3, so 3.5 MB of image is ~4.7 MB on the wire, leaving headroom for the JSON
// envelope. Enforced client-side (with a clear message) and again on the route,
// because a silently dropped body reads to the operator as "upload is broken".
export const MAX_LAYER_IMAGE_BYTES = 3_500_000;

// What a browser can decode to a canvas and Mapbox can hand to WebGL.
export const LAYER_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

// Build the portal path for a development, e.g. devPath("acme", "lots").
export function devPath(slug: string, sub = ""): string {
  return sub ? `/d/${slug}/${sub}` : `/d/${slug}`;
}

// Pull the active development slug out of a portal pathname (/d/{slug}/...).
export function slugFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/d\/([^/]+)/);
  return m ? m[1] : null;
}

// name → url-safe slug.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
