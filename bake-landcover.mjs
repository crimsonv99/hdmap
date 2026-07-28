// ============================================================================
// Landcover baker — emit build/layers/{water,green}.ndjson for the viewer's
// context fills (blue water, green parks/forest) under the HD roads.
//
// WHY THIS EXISTS (and why not the hdmap tool's per-way parser):
// Big rivers and parks are OSM *multipolygon relations* whose outer-ring ways
// run outside the city bbox. A plain per-way parse — or an `osmium extract
// --strategy complete_ways` — only captures the fragments inside the bbox, so a
// large river like Sông Hồng (the Red River) assembles into disconnected edge
// pieces and its main channel renders as EMPTY GROUND. The fix: extract with
// `--strategy smart` (which completes multipolygon relations, pulling their
// members even outside the bbox) and let `osmium export` ASSEMBLE the full
// polygons. tippecanoe then clips them back to the bbox at bake time
// (--clip-bounding-box in bake-tiles.sh), so no stray out-of-bbox tiles.
//
// Categorisation matches hdmap/build.mjs landcoverFromOsm (isWater/isGreen).
//
// Usage:  node bake-landcover.mjs [extract.osm.pbf] [S W N E]
//   defaults: build/vietnam-latest.osm.pbf + the Hanoi urban-core bbox.
// Output:  build/layers/{water,green}.ndjson   (then run ./bake-tiles.sh)
// ============================================================================
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const build = join(__dir, "build");
const layers = join(build, "layers");

const pbf = process.argv[2] || join(build, "vietnam-latest.osm.pbf");
// Hanoi urban core (S,W,N,E) — same defaults as bake-city.mjs.
const S = parseFloat(process.argv[3] ?? "20.955");
const W = parseFloat(process.argv[4] ?? "105.755");
const N = parseFloat(process.argv[5] ?? "21.095");
const E = parseFloat(process.argv[6] ?? "105.885");

if (!existsSync(pbf)) { console.error(`extract not found: ${pbf}`); process.exit(1); }

const smart = join(build, "landcover-smart.osm.pbf");
const lc = join(build, "landcover.osm.pbf");
const seq = join(build, "landcover.geojsonseq");

// 1. smart extract → completes multipolygon relations (the whole point)
console.log("extracting landcover bbox with --strategy smart (completes relations)…");
execFileSync("osmium", ["extract", "-b", `${W},${S},${E},${N}`, "--strategy", "smart",
  "--overwrite", "-o", smart, pbf], { stdio: "inherit" });

// 2. narrow to landcover-ish tags (keeps the export small), then ASSEMBLE areas
execFileSync("osmium", ["tags-filter", smart, "nwr/natural", "nwr/landuse",
  "nwr/leisure", "nwr/water", "nwr/waterway", "-o", lc, "--overwrite"], { stdio: "inherit" });
execFileSync("osmium", ["export", lc, "-f", "geojsonseq",
  "--geometry-types=polygon", "-o", seq, "--overwrite"], { stdio: "inherit" });

// 3. categorise (mirrors hdmap/build.mjs isWaterTags / isGreenTags; water wins)
const isWater = (t) => t.natural === "water" || t.water != null ||
  t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin";
const GREEN_LEISURE = new Set(["park", "garden", "recreation_ground", "pitch", "golf_course", "nature_reserve"]);
const GREEN_LANDUSE = new Set(["grass", "forest", "meadow", "village_green", "cemetery", "recreation_ground", "orchard", "farmland"]);
const GREEN_NATURAL = new Set(["wood", "scrub", "grassland", "heath"]);
const isGreen = (t) => GREEN_LEISURE.has(t.leisure) || GREEN_LANDUSE.has(t.landuse) || GREEN_NATURAL.has(t.natural);

const wOut = createWriteStream(join(layers, "water.ndjson"));
const gOut = createWriteStream(join(layers, "green.ndjson"));
let nw = 0, ng = 0;
const rl = createInterface({ input: createReadStream(seq), crlfDelay: Infinity });
for await (let line of rl) {
  line = line.replace(/^\x1e/, "").trim(); // geojsonseq RS separator
  if (!line) continue;
  let f; try { f = JSON.parse(line); } catch { continue; }
  const g = f.geometry;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
  const t = f.properties || {};
  // strip properties: the viewer paints flat blue/green and the tile KEEP list
  // drops everything anyway — smaller ndjson, smaller tiles.
  if (isWater(t)) { wOut.write(JSON.stringify({ type: "Feature", geometry: g, properties: {} }) + "\n"); nw++; }
  else if (isGreen(t)) { gOut.write(JSON.stringify({ type: "Feature", geometry: g, properties: {} }) + "\n"); ng++; }
}
await new Promise((r) => wOut.end(r));
await new Promise((r) => gOut.end(r));
for (const f of [smart, lc, seq]) rmSync(f, { force: true });
console.log(`\nwrote build/layers/water.ndjson (${nw}) + green.ndjson (${ng})`);
console.log("next: ./bake-tiles.sh  (clips these back to the bbox)");
