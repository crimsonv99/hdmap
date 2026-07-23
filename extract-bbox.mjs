// Clip the whole-city NDGeoJSON layers (build/layers/*.ndjson) down to a small
// fixed bbox and write them as plain GeoJSON FeatureCollections in data/. Small
// enough to load DIRECTLY as a maplibre geojson source (no PMTiles protocol) —
// which is the proven-to-render path for a fixed area.
//
// Usage: node extract-bbox.mjs  W S E N   (defaults to the central-Hanoi lock)
import { readFileSync, writeFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const layersDir = join(__dir, "build", "layers");
const dataDir = join(__dir, "data");

const W = parseFloat(process.argv[2] ?? "105.828");
const S = parseFloat(process.argv[3] ?? "21.012");
const E = parseFloat(process.argv[4] ?? "105.872");
const N = parseFloat(process.argv[5] ?? "21.050");

const centroidOf = (geom) => {
  let x = 0, y = 0, n = 0;
  const walk = (a) => { if (typeof a[0] === "number") { x += a[0]; y += a[1]; n++; } else a.forEach(walk); };
  walk(geom.coordinates);
  return [x / n, y / n];
};

const LAYERS = ["lanes", "markings", "intersections", "turn_arrows", "buildings"];
const counts = {};

for (const layer of LAYERS) {
  const src = join(layersDir, `${layer}.ndjson`);
  const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  const kept = [];
  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    const [x, y] = centroidOf(f.geometry);
    if (x >= W && x <= E && y >= S && y <= N) kept.push(f);
  }
  writeFileSync(join(dataDir, `c_${layer}.geojson`),
    JSON.stringify({ type: "FeatureCollection", features: kept }));
  counts[layer] = kept.length;
  console.log(`c_${layer}.geojson: ${kept.length} features`);
}

writeFileSync(join(dataDir, "c_meta.json"),
  JSON.stringify({ bbox: [W, S, E, N], center: [(W + E) / 2, (S + N) / 2], counts }, null, 2));
console.log("bbox", [W, S, E, N], "->", counts);
