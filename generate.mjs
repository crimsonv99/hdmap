// HD map data generator (one-shot, from Overpass)
// OSM (Overpass) -> osm2streets (WASM) -> GeoJSON lane/intersection/marking polygons
//
// Usage:
//   node generate.mjs                       # default Hanoi bbox
//   node generate.mjs S W N E               # custom bbox (south west north east)
//   BBOX="21.0255,105.8470,21.0303,105.8540" node generate.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initEngine, osmToLayers, landcoverFromOsm, elevatedRoadsFromOsm } from "./build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");

// --- bbox: south,west,north,east ---
const argBox = process.argv.slice(2);
const bbox =
  argBox.length === 4
    ? argBox.join(",")
    : process.env.BBOX || "21.0255,105.8470,21.0303,105.8540";

try {
  console.log(`[1/3] Fetching OSM data from Overpass for bbox=${bbox} ...`);
  // buildings + water + green land cover come along for context (osm2streets
  // ignores them; we polygonize them ourselves in build.mjs). `>` recurses to
  // every way's nodes.
  const query = `[bbox:${bbox}];(` +
    `way["highway"];way["building"];relation["building"];` +
    // Simple 3D Buildings: `building:part` is a SEPARATE OSM key — a standalone part
    // carries no `building=*` tag at all, so ["building"] misses every one of them. Then
    // build.mjs's S3DB rule sees no parts, never suppresses or clips an outline, and the
    // detailed 3D geometry silently doesn't exist on this path. server.mjs's ctxArea has
    // always pulled these; generate.mjs did not, so the one-shot fetch and the editor
    // disagreed about what a building is. Keep the two queries in step.
    `way["building:part"];relation["building:part"];` +
    `way["natural"~"water|wood|scrub|grassland|heath"];relation["natural"~"water|wood|scrub|grassland|heath"];` +
    `way["water"];way["waterway"="riverbank"];` +
    `way["landuse"~"reservoir|basin|grass|forest|meadow|village_green|cemetery|recreation_ground|orchard|farmland"];relation["landuse"~"reservoir|basin|grass|forest|meadow|cemetery|recreation_ground|orchard|farmland"];` +
    `way["leisure"~"park|garden|recreation_ground|pitch|golf_course|nature_reserve"];relation["leisure"~"park|garden|recreation_ground|golf_course|nature_reserve"];` +
    `>;);out meta;`;
  let res;
  try {
    res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "hdmap-demo/0.1 (osm2streets HD basemap experiment)",
      },
      body: "data=" + encodeURIComponent(query),
    });
  } catch (e) {
    throw new Error(`could not reach Overpass (network/DNS): ${e.message}`);
  }
  // Overpass signals overload with 429/504 (and the public instance does so often).
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} — likely overloaded; retry shortly`);
  const osmXml = await res.text();
  // Overpass sometimes answers 200 with an HTML error/remark page instead of OSM
  // XML; feeding that to the WASM parser throws a cryptic error, so catch it here.
  if (!osmXml.includes("<osm"))
    throw new Error(
      "Overpass returned a non-OSM response (probably a rate-limit or error page). " +
      "Wait a minute and retry, or shrink the bbox."
    );
  writeFileSync(join(dataDir, "raw.osm"), osmXml);
  console.log(`      got ${(osmXml.length / 1024).toFixed(0)} KB of OSM XML`);

  console.log("[2/3] Running osm2streets (WASM) ...");
  await initEngine();
  const { lanes, markings, intersections, turnArrows, buildings, center, counts } = osmToLayers(osmXml);

  console.log("[3/3] Writing GeoJSON ...");
  writeFileSync(join(dataDir, "lanes.geojson"), JSON.stringify(lanes));
  writeFileSync(join(dataDir, "markings.geojson"), JSON.stringify(markings));
  writeFileSync(join(dataDir, "intersections.geojson"), JSON.stringify(intersections));
  writeFileSync(join(dataDir, "turn_arrows.geojson"), JSON.stringify(turnArrows));
  writeFileSync(join(dataDir, "buildings.geojson"), JSON.stringify(buildings));
  const { water, green } = landcoverFromOsm(osmXml);
  writeFileSync(join(dataDir, "water.geojson"), JSON.stringify(water));
  writeFileSync(join(dataDir, "green.geojson"), JSON.stringify(green));
  writeFileSync(join(dataDir, "roads_3d.geojson"), JSON.stringify(elevatedRoadsFromOsm(osmXml)));
  for (const [k, v] of Object.entries(counts))
    console.log(`      ${k.padEnd(14)} ${v} features`);

  const [s, w, n, e] = bbox.split(",").map(Number);
  writeFileSync(
    join(dataDir, "meta.json"),
    JSON.stringify({ center: center || [(w + e) / 2, (s + n) / 2], bbox: [w, s, e, n] }, null, 2)
  );
  // version stamp so the live viewer can detect changes uniformly
  writeFileSync(join(dataDir, "version.json"), JSON.stringify({ v: Date.now(), source: "overpass" }));
  console.log("Done. Serve index.html to view.");
} catch (e) {
  console.error("\nGenerate failed:", e.message);
  process.exit(1);
}
