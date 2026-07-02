// Client-side address lookup via the Mapbox Search Box API. A session token
// groups suggest→retrieve calls into one billed session. Used by the Add-parcels
// picker to fly the map to an address before parcels are selected.

const BASE = "https://api.mapbox.com/search/searchbox/v1";

export type Suggestion = {
  mapbox_id: string;
  name: string;
  place_formatted: string;
};

// A fresh session token per picker mount (suggest + retrieve share it).
export function newSessionToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export async function suggestAddress(
  q: string,
  token: string,
  session: string,
  proximity?: [number, number]
): Promise<Suggestion[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  const params = new URLSearchParams({
    q: query,
    access_token: token,
    session_token: session,
    country: "us",
    language: "en",
    limit: "6",
    types: "address,street,neighborhood,place,postcode",
  });
  if (proximity) params.set("proximity", proximity.join(","));
  const r = await fetch(`${BASE}/suggest?${params}`);
  if (!r.ok) return [];
  const j = (await r.json()) as { suggestions?: Array<Record<string, string>> };
  return (j.suggestions ?? []).map((s) => ({
    mapbox_id: s.mapbox_id,
    name: s.name,
    place_formatted: s.place_formatted ?? s.full_address ?? "",
  }));
}

// Resolve a suggestion to a coordinate to fly to. Returns [lng, lat] or null.
export async function retrieveSuggestion(
  id: string,
  token: string,
  session: string
): Promise<[number, number] | null> {
  const params = new URLSearchParams({ access_token: token, session_token: session });
  const r = await fetch(`${BASE}/retrieve/${id}?${params}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
  const c = j.features?.[0]?.geometry?.coordinates;
  return Array.isArray(c) && c.length >= 2 ? [c[0], c[1]] : null;
}
