// Convert an uploaded Esri Shapefile — a zipped bundle or loose .shp/.dbf/.prj
// sidecars — into GeoJSON for the same normalizeGeoJSON pipeline the .geojson
// path uses. The .prj is what makes CAD/county exports work here: shpjs feeds
// it to proj4 and reprojects State Plane/UTM coordinates to WGS84, which the
// GeoJSON path can only reject. Client-only by nature (takes Files), and shpjs
// (which drags in proj4) is imported lazily so it ships to the browser only
// when a shapefile is actually dropped.

const SHAPEFILE_SIDECAR_RE = /\.(shp|dbf|prj|cpg|shx)$/i;

/** True when the selection should take the shapefile path instead of JSON. */
export function isShapefileUpload(files: File[]): boolean {
  return files.some((f) => /\.(zip|shp)$/i.test(f.name)) ||
    // .dbf/.prj without their .shp still belong to this path — it owns the
    // "you forgot the .shp" error instead of the JSON parser's.
    files.every((f) => SHAPEFILE_SIDECAR_RE.test(f.name));
}

export type ShapefileResult = {
  geojson: GeoJSON.FeatureCollection;
  /** The .shp (or .zip) the features came from — shown as the upload's name. */
  fileName: string;
  warnings: string[];
};

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLowerCase();
}

// Prefer the sidecar sharing the .shp's basename (parcels.shp → parcels.dbf) so
// a multi-select spanning two shapefiles doesn't pair mismatched files; fall
// back to the only file of that extension.
function sidecar(files: File[], base: string, ext: string): File | null {
  const matching = files.filter((f) => f.name.toLowerCase().endsWith(ext));
  return matching.find((f) => baseName(f.name) === base) ?? (matching.length === 1 ? matching[0] : null);
}

/**
 * Parse the dropped files with shpjs. A .zip is handed over whole (it resolves
 * the bundle, applies the .prj, and may contain several layers — merged here
 * with a warning). Loose files pair the first .shp with its .dbf/.prj/.cpg.
 * Throws user-readable messages on hard failures.
 */
export async function shapefileToGeoJSON(files: File[]): Promise<ShapefileResult> {
  const shp = (await import("shpjs")).default;
  const warnings: string[] = [];

  const zip = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
  if (zip) {
    let out;
    try {
      out = await shp(await zip.arrayBuffer());
    } catch (e) {
      throw new Error(friendly(e, `Couldn't read a shapefile out of ${zip.name}`));
    }
    const layers = Array.isArray(out) ? out : [out];
    if (layers.length > 1) {
      const names = layers.map((l) => l.fileName ?? "unnamed").join(", ");
      warnings.push(`The zip contained ${layers.length} layers (${names}) — all of them were combined.`);
    }
    return {
      geojson: { type: "FeatureCollection", features: layers.flatMap((l) => l.features) },
      fileName: zip.name,
      warnings,
    };
  }

  const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
  if (!shpFile) {
    throw new Error(
      "A shapefile needs its .shp file — upload the whole set (.shp, .dbf, .prj) together, or zip the folder and drop the .zip."
    );
  }
  const base = baseName(shpFile.name);
  const dbf = sidecar(files, base, ".dbf");
  const prj = sidecar(files, base, ".prj");
  if (!dbf) warnings.push("No .dbf included — lot IDs and fields can't be read, so sequential IDs will be generated.");
  if (!prj) warnings.push("No .prj included — coordinates are assumed to already be longitude/latitude (WGS84).");

  let geojson;
  try {
    geojson = (await shp({
      shp: await shpFile.arrayBuffer(),
      dbf: dbf ? await dbf.arrayBuffer() : undefined,
      prj: prj ? await prj.text() : undefined,
      cpg: (await sidecar(files, base, ".cpg")?.text()) ?? undefined,
    })) as GeoJSON.FeatureCollection;
  } catch (e) {
    throw new Error(friendly(e, `Couldn't parse ${shpFile.name}`));
  }
  return { geojson, fileName: shpFile.name, warnings };
}

// shpjs's own errors ("no layers founds", 'I don't know shp type "…"',
// but-unzip's numeric codes) aren't written for operators — wrap them with
// what to do about it.
function friendly(e: unknown, context: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no layers/i.test(msg)) return `${context} — the zip has no .shp inside. Zip the shapefile's folder contents, not a folder of something else.`;
  if (/shp type/i.test(msg)) return `${context} — unsupported shapefile geometry type. Lots must be polygons.`;
  if (/but-unzip/i.test(msg)) return `${context} — it doesn't look like a valid zip archive.`;
  return `${context}: ${msg}`;
}
