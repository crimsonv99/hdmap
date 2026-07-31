// ============================================================================
// bake-buildings.mjs — regenerate ONLY build/layers/buildings.ndjson.
//
// The full bake-city.mjs runs osm2streets on ~90 tiles and cuts the whole city
// with complete_ways in one osmium pass — heavy enough to OOM the sandbox. But
// buildings don't need osm2streets at all (build.mjs polygonises them straight
// from OSM XML), so this baker:
//   1. shrinks city.osm.pbf to a buildings-only pbf with `osmium tags-filter`
//      (referenced nodes/ways/relation-members come along automatically) — the
//      cut below then runs on a few MB instead of the whole city, so no OOM;
//   2. cuts that into the SAME tile grid (complete_ways so edge buildings arrive
//      whole) and runs buildingsFromOsm() per tile — pure JS, fast;
//   3. keeps each feature by centroid ownership (identical rule to bake-city) so
//      complete_ways overlap never double-emits a building.
//
// Use this whenever build.mjs's buildingProps changes (e.g. the detailed-3D roof
// tags) — no need to re-run the expensive road pipeline.
// Pipeline: bake-buildings.mjs  ->  bake-tiles.sh
// Usage: node bake-buildings.mjs        (reads bbox/tile from build/bake-meta.json)
// ============================================================================
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, createWriteStream, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildingsFromOsm } from "./lib/build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dir, "build");
const layersDir = join(buildDir, "layers");
const tilesDir = join(buildDir, "btiles"); // own scratch dir, never collides with bake-city
const cityPbf = join(buildDir, "city.osm.pbf");

if (!existsSync(cityPbf)) {
  console.error(`missing ${cityPbf} — run bake-city.mjs first (it writes the city extract).`);
  process.exit(1);
}
mkdirSync(layersDir, { recursive: true });
mkdirSync(tilesDir, { recursive: true });

// ---- bbox + tile size: match bake-city so features line up with the road tiles.
let W = 105.755, S = 20.955, E = 105.885, N = 21.095, TILE = 0.015;
try {
  const meta = JSON.parse(readFileSync(join(buildDir, "bake-meta.json"), "utf8"));
  if (Array.isArray(meta.bbox)) [W, S, E, N] = meta.bbox;
  if (meta.tile) TILE = meta.tile;
  console.log(`bbox from bake-meta.json: [${S},${W} .. ${N},${E}] tile=${TILE}`);
} catch { console.log("no bake-meta.json — using Hanoi defaults"); }

// ---- 1. shrink to a buildings-only pbf (tiny → the cut below won't OOM) ------
const bldgPbf = join(buildDir, "buildings.osm.pbf");
console.log("filtering buildings with osmium…");
execFileSync("osmium", [
  "tags-filter", cityPbf,
  "w/building", "w/building:part", "r/building", "r/building:part",
  "-o", bldgPbf, "--overwrite",
], { stdio: "inherit" });

// ---- build the tile grid (same rule as bake-city) ---------------------------
const tiles = [];
for (let lat = S, r = 0; lat < N; lat += TILE, r++)
  for (let lon = W, c = 0; lon < E; lon += TILE, c++)
    tiles.push({ r, c, s: lat, w: lon, n: Math.min(lat + TILE, N), e: Math.min(lon + TILE, E), name: `b_${r}_${c}` });
console.log(`Grid: ${tiles.length} tiles`);

// ---- 2. cut all tiles in ONE osmium multi-extract (complete_ways) -----------
const cfg = { directory: tilesDir, extracts: tiles.map((t) => ({ output: `${t.name}.osm`, bbox: [t.w, t.s, t.e, t.n] })) };
const cfgPath = join(buildDir, "bextracts.json");
writeFileSync(cfgPath, JSON.stringify(cfg));
console.log("Cutting building tiles with osmium (complete_ways)…");
execFileSync("osmium", ["extract", "-c", cfgPath, "--strategy", "complete_ways", "--overwrite", bldgPbf], { stdio: "inherit" });

// ---- 3. polygonise per tile, keep by centroid ownership ---------------------
const centroidOf = (geom) => {
  let x = 0, y = 0, n = 0;
  const walk = (a) => { if (typeof a[0] === "number") { x += a[0]; y += a[1]; n++; } else a.forEach(walk); };
  walk(geom.coordinates);
  return [x / n, y / n];
};
const out = createWriteStream(join(layersDir, "buildings.ndjson"));
let kept = 0, seen = 0, roofed = 0, coloured = 0;
for (const t of tiles) {
  const path = join(tilesDir, `${t.name}.osm`);
  if (!existsSync(path)) continue; // osmium skips empty cells
  let xml;
  try { xml = readFileSync(path, "utf8"); } catch { continue; }
  if (!xml.includes("<way")) continue;
  const fc = buildingsFromOsm(xml);
  for (const f of fc.features) {
    seen++;
    const [x, y] = centroidOf(f.geometry);
    if (x < t.w || x >= t.e || y < t.s || y >= t.n) continue; // owned by another tile
    out.write(JSON.stringify(f) + "\n");
    kept++;
    if (f.properties.roof_shape) roofed++;
    if (f.properties.colour || f.properties.roof_colour) coloured++;
  }
}
out.end();
rmSync(tilesDir, { recursive: true, force: true });
rmSync(cfgPath, { force: true });
console.log(`\nbuildings.ndjson: kept ${kept}/${seen} features`);
console.log(`  detailed: ${roofed} with roof:shape, ${coloured} with a colour tag`);
console.log("Next: ./bake-tiles.sh");
