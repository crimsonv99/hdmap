// ============================================================================
// City baker — turn a whole-city OSM extract into HD GeoJSON layers.
//
// osm2streets can't swallow an entire city at once (memory + it processes the
// whole network in one shot), so we TILE the city: cut the extract into a grid
// of small .osm files, run osm2streets on each, and stream the results out as
// newline-delimited GeoJSON (one feature per line) that tippecanoe bakes into
// vector tiles.
//
// Two correctness rules make tiling seamless:
//  1. COMPLETE WAYS. Each tile is cut with osmium `--strategy complete_ways`, so
//     a road crossing the tile edge comes in with its FULL geometry (not clipped)
//     — osm2streets needs the whole way to build lanes correctly.
//  2. CENTROID OWNERSHIP. Because complete-ways makes neighbouring tiles share
//     boundary roads, every output feature is kept by exactly ONE tile: the tile
//     whose CORE (un-buffered) cell contains the feature's centroid. No feature
//     is emitted twice, and each is emitted with correct geometry.
//
// Usage:
//   node bake-city.mjs <extract.osm.pbf> [S W N E] [tileDeg]
// Defaults to the Hanoi urban core and ~1.5 km tiles.
//
// Output: build/layers/{lanes,markings,intersections,turn_arrows,buildings}.ndjson
// Then bake with tippecanoe (see bake-tiles.sh / README).
// ============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initEngine, osmToLayers } from "../hdmap/build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dir, "build");
const tilesDir = join(buildDir, "tiles");
const layersDir = join(buildDir, "layers");

// ---- args ----
const pbf = process.argv[2] || join(buildDir, "vietnam-latest.osm.pbf");
// Hanoi urban core (S,W,N,E). ~13.5 x 15.5 km — the built-up districts.
const S = parseFloat(process.argv[3] ?? "20.955");
const W = parseFloat(process.argv[4] ?? "105.755");
const N = parseFloat(process.argv[5] ?? "21.095");
const E = parseFloat(process.argv[6] ?? "105.885");
const TILE = parseFloat(process.argv[7] ?? "0.015"); // ~1.6 km of latitude

if (!existsSync(pbf)) {
  console.error(`extract not found: ${pbf}\nDownload it first (see README).`);
  process.exit(1);
}

mkdirSync(tilesDir, { recursive: true });
mkdirSync(layersDir, { recursive: true });

// ---- geometry helpers ----
const centroidOf = (geom) => {
  let x = 0, y = 0, n = 0;
  const walk = (a) => { if (typeof a[0] === "number") { x += a[0]; y += a[1]; n++; } else a.forEach(walk); };
  walk(geom.coordinates);
  return [x / n, y / n];
};

// ---- build the tile grid ----
const tiles = [];
for (let lat = S, r = 0; lat < N; lat += TILE, r++) {
  for (let lon = W, c = 0; lon < E; lon += TILE, c++) {
    tiles.push({
      r, c,
      s: lat, w: lon,
      n: Math.min(lat + TILE, N),
      e: Math.min(lon + TILE, E),
      name: `t_${r}_${c}`,
    });
  }
}
console.log(`Grid: ${tiles.length} tiles over [${S},${W} .. ${N},${E}], tile=${TILE}°`);

// ---- 1a. clip the big country extract down to the city bbox ONCE ----
// (so the per-tile multi-extract below scans ~20 MB, not the whole country.)
const cityPbf = join(buildDir, "city.osm.pbf");
console.log(`Clipping city bbox from ${pbf} …`);
execFileSync("osmium", ["extract", "-b", `${W},${S},${E},${N}`,
  "--strategy", "complete_ways", "--overwrite", "-o", cityPbf, pbf], { stdio: "inherit" });

// ---- 1a'. classify service roads for the viewer's alley-vs-private display ----
// The viewer paints `highway=service` roads distinctly: an ALLEY (service=alley,
// the narrow Hanoi ngõ/hẻm — no 4-wheeler) vs a plain PRIVATE service road.
// osm2streets lanes don't carry the OSM `service` tag, only `osm_way_ids`, so we
// build a way_id -> kind map here (one cheap osmium pass) and stamp each lane
// feature below. This is DISPLAY only — routing is unaffected.
const svcOsm = join(buildDir, "service.tmp.osm");
execFileSync("osmium", ["tags-filter", cityPbf, "w/highway=service",
  "-o", svcOsm, "--overwrite"], { stdio: "inherit" });
const svcKind = new Map(); // OSM way id (number) -> "alley" | "private"
{
  const xml = readFileSync(svcOsm, "utf8");
  const attr = (s, k) => { const m = s.match(new RegExp(`${k}="([^"]*)"`)); return m ? m[1] : null; };
  let id = null, alley = false;
  for (const raw of xml.split("\n")) {
    const s = raw.trimStart();
    if (s.startsWith("<way")) { id = attr(s, "id"); alley = false; }
    else if (s.startsWith("<tag ") && id) { if (attr(s, "k") === "service" && attr(s, "v") === "alley") alley = true; }
    if (id && (s.startsWith("</way") || (s.startsWith("<way") && s.endsWith("/>")))) {
      svcKind.set(Number(id), alley ? "alley" : "private"); id = null;
    }
  }
}
rmSync(svcOsm, { force: true });
console.log(`service roads classified: ${svcKind.size} (alley + private)`);

// stamp `svc` onto a lane feature if its way is a service road (first match wins)
const stampSvc = (feat) => {
  const ids = feat.properties?.osm_way_ids;
  if (!Array.isArray(ids)) return;
  for (const w of ids) { const k = svcKind.get(Number(w)); if (k) { feat.properties.svc = k; break; } }
};

// ---- 1b. cut all tiles in ONE osmium pass (config-based multi-extract) ----
// complete_ways so boundary roads arrive whole; .osm extension → XML out.
const cfg = {
  directory: tilesDir,
  extracts: tiles.map((t) => ({
    output: `${t.name}.osm`,
    bbox: [t.w, t.s, t.e, t.n], // [left, bottom, right, top]
  })),
};
const cfgPath = join(buildDir, "extracts.json");
writeFileSync(cfgPath, JSON.stringify(cfg));
console.log("Cutting tiles with osmium (complete_ways)…");
execFileSync("osmium", ["extract", "-c", cfgPath, "--strategy", "complete_ways",
  "--overwrite", cityPbf], { stdio: "inherit" });

// ---- 2. run osm2streets per tile, stream features out ----
await initEngine();

const LAYERS = ["lanes", "markings", "intersections", "turn_arrows", "buildings"];
const out = {};
for (const l of LAYERS) out[l] = createWriteStream(join(layersDir, `${l}.ndjson`));

// keep a feature only if its centroid is inside the CORE cell → each feature is
// owned by exactly one tile even though tiles overlap via complete_ways.
const write = (stream, feat, t) => {
  const [x, y] = centroidOf(feat.geometry);
  if (x < t.w || x >= t.e || y < t.s || y >= t.n) return 0;
  stream.write(JSON.stringify(feat) + "\n");
  return 1;
};

const totals = { lanes: 0, markings: 0, intersections: 0, turn_arrows: 0, buildings: 0 };
let done = 0, failed = 0;
const t0 = Date.now();

for (const t of tiles) {
  done++;
  const path = join(tilesDir, `${t.name}.osm`);
  if (!existsSync(path)) continue; // osmium skips empty cells
  let xml;
  try {
    xml = readFileSync(path, "utf8");
    if (!xml.includes("<way")) continue; // no roads/buildings here (water, fields)
    const { lanes, markings, intersections, turnArrows, buildings } = osmToLayers(xml);
    const src = { lanes, markings, intersections, turn_arrows: turnArrows, buildings };
    for (const l of LAYERS)
      for (const f of src[l].features) {
        if (l === "lanes") stampSvc(f); // alley/private display flag
        totals[l] += write(out[l], f, t);
      }
  } catch (e) {
    failed++;
    console.warn(`  ! ${t.name}: ${String(e).slice(0, 120)}`);
    continue;
  }
  if (done % 10 === 0 || done === tiles.length) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const rate = (done / (Date.now() - t0) * 1000).toFixed(1);
    console.log(`  [${done}/${tiles.length}] ${secs}s  ${rate}/s  ` +
      `lanes=${totals.lanes} bldg=${totals.buildings} mark=${totals.markings}  failed=${failed}`);
  }
}

for (const l of LAYERS) out[l].end();
// free the per-tile XML (tens of MB of small files); keep layers/ + config
rmSync(tilesDir, { recursive: true, force: true });

writeFileSync(join(buildDir, "bake-meta.json"), JSON.stringify({
  bbox: [W, S, E, N], center: [(W + E) / 2, (S + N) / 2],
  tile: TILE, tiles: tiles.length, failed, totals,
}, null, 2));

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Tiles ok=${tiles.length - failed} failed=${failed}`);
console.log("Totals:", totals);
console.log(`Layers → ${layersDir}/*.ndjson`);
console.log("Next: bake to PMTiles →  ./bake-tiles.sh");
