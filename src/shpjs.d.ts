// shpjs ships no type declarations; this mirrors the slice of its v6 API that
// src/lib/shapefile.ts uses (same pattern as geojson.d.ts).
declare module "shpjs" {
  /** parseZip tags each layer's FeatureCollection with the shapefile's basename. */
  export type ShapefileLayer = GeoJSON.FeatureCollection & { fileName?: string };

  /**
   * An ArrayBuffer/view is treated as a zipped shapefile bundle; the object
   * form takes loose sidecar buffers (`prj`/`cpg` may be text). A zip holding
   * several shapefiles resolves to one layer per shapefile.
   */
  export default function shp(
    input:
      | ArrayBuffer
      | Uint8Array
      | { shp: ArrayBuffer; dbf?: ArrayBuffer; prj?: ArrayBuffer | string; cpg?: ArrayBuffer | string }
  ): Promise<ShapefileLayer | ShapefileLayer[]>;
}
