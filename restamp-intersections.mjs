// ============================================================================
// restamp-intersections.mjs — stamp a `layer` onto build/layers/intersections.ndjson.
//
// osm2streets doesn't give intersections a `layer`, so in the vector tiles they all
// default to layer 0 and render at ground — including the ones up on a flyover, which
// then sit orphaned as flat gray blobs UNDER the 3D deck. This stamps each intersection
// with the layer of the junction it sits at, using the SAME node-altitude model as the
// 3D deck (./lib/elevation.mjs), joined by the intersection's osm_node_ids. A junction is
// elevated only when its node is off the ground (nz > 0 — i.e. every road there is a
// bridge; a ramp foot with any ground road stays 0). The viewer's `layer < 1` filter
// then drops the elevated ones and the deck's junction slab covers them instead.
//
// Cheap: one `osmium tags-filter` pass + an in-place rewrite — NO osm2streets re-run.
// Pipeline: bake-city.mjs  ->  restamp-intersections.mjs  ->  bake-tiles.sh
// Usage: node restamp-intersections.mjs
// ============================================================================
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { roadLevel, nodeAltitudes, LAYER_HEIGHT } from "./lib/elevation.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PBF = join(__dir, "build", "city.osm.pbf");
const NDJSON = join(__dir, "build", "layers", "intersections.ndjson");
const TMP = join(__dir, "build", "roads.stamp.osm");
if (!existsSync(PBF) || !existsSync(NDJSON)) {
  console.error(`need ${PBF} + ${NDJSON} — run bake-city.mjs first`);
  process.exit(1);
}

// ---- node altitudes from the highway ways (same model as bake-graph / the deck) ----
console.log("filtering highways with osmium…");
execFileSync("osmium", ["tags-filter", PBF, "w/highway", "-o", TMP, "--overwrite"], { stdio: "inherit" });
const ways = [];
let cur = null;
const attr = (line, name) => { const m = line.match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null; };
const rl = createInterface({ input: createReadStream(TMP), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trimStart();
  if (s.startsWith("<way")) cur = { refs: [], tags: {} };
  else if (s.startsWith("<nd ")) { if (cur) cur.refs.push(attr(s, "ref")); }
  else if (s.startsWith("<tag ")) { if (cur) cur.tags[attr(s, "k")] = attr(s, "v"); }
  else if (s.startsWith("</way")) { if (cur) ways.push(cur); cur = null; }
}
rmSync(TMP, { force: true });
const nz = nodeAltitudes(ways.map((w) => ({
  nodeIds: w.refs, layer: roadLevel(w.tags), link: /_link$/.test(w.tags.highway || ""),
})));
console.log(`node altitudes for ${nz.size} junction nodes`);

// ---- re-stamp the intersections ndjson in place ----
const lines = readFileSync(NDJSON, "utf8").split("\n").filter(Boolean);
let nElev = 0;
const out = lines.map((ln) => {
  const f = JSON.parse(ln);
  const ids = (f.properties && f.properties.osm_node_ids) || [];
  const zs = ids.map((id) => nz.get(String(id)) || 0);
  // elevated only if every node of this junction is off the ground (a bridge junction)
  const isElev = zs.length > 0 && zs.every((z) => z > 0.6);
  const layer = isElev ? Math.max(1, Math.round(Math.min(...zs) / LAYER_HEIGHT)) : 0;
  (f.properties || (f.properties = {})).layer = layer;
  if (layer > 0) nElev++;
  return JSON.stringify(f);
});
writeFileSync(NDJSON, out.join("\n") + "\n");
console.log(`re-stamped ${lines.length} intersections; ${nElev} marked elevated (layer>0) → dropped at ground`);
