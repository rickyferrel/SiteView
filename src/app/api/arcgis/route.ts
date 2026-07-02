import { NextResponse } from "next/server";
import { countyForBbox, fetchArcgisByBbox, parcelInfo, type Bbox } from "@/lib/arcgis";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/arcgis?bbox=west,south,east,north
// Live parcels intersecting a viewport, for the Add-parcels picker. Capped to a
// few pages: callers gate on zoom so a request only ever covers a neighborhood.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("bbox");
  if (!raw) return fail("bbox required");
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fail("bad bbox");

  try {
    // LIR parcels are per-county services; resolve which county this viewport
    // is in, and stamp it on each feature so import can query the same layer.
    const county = await countyForBbox(parts as Bbox);
    const feats = await fetchArcgisByBbox(parts as Bbox, 4, county);
    const features: GeoJSON.Feature[] = feats.flatMap((f) => {
      const pid = (f.properties.PARCEL_ID as string) ?? "";
      if (!pid) return [];
      const info = parcelInfo(f.properties);
      return [
        {
          type: "Feature" as const,
          id: pid,
          geometry: f.geometry,
          // Attributes the picker shows in its hover card. Kept flat + JSON-safe
          // so Mapbox GL feature-state round-trips them without loss.
          properties: {
            PARCEL_ID: pid,
            address: info.address,
            acres: info.acres,
            market_value: info.marketValue,
            land_value: info.landValue,
            prop_class: info.propClass,
            subdivision: info.subdivision,
            built_yr: info.builtYr,
            bldg_sqft: info.bldgSqft,
            county,
          },
        },
      ];
    });
    return NextResponse.json(
      { type: "FeatureCollection", features },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return fail((e as Error).message, 502);
  }
}
