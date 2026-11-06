import { readFile } from "node:fs/promises";
import path from "node:path";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";

// Fiji's coastline from Natural Earth (world-atlas), for the built-in
// outline map used when no tile style is configured.
export const dynamic = "force-static";

export async function GET() {
  const file = path.join(process.cwd(), "node_modules/world-atlas/countries-10m.json");
  const topo = JSON.parse(await readFile(file, "utf8")) as Topology;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = feature(topo, topo.objects.countries as any) as unknown as GeoJSON.FeatureCollection;
  const fiji = all.features.filter((f) => f.id === "242" || f.properties?.name === "Fiji");
  return Response.json({ type: "FeatureCollection", features: fiji }, { headers: { "Cache-Control": "public, max-age=86400" } });
}
