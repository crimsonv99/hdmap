// ============================================================================
// Routing-graph baker — emit data/graph.json for client-side navigation.
//
// Vector tiles are clipped at tile borders, so we can't route on them. Instead
// we build a routable graph from the OSM road ways (which carry node refs, hence
// exact shared-node connectivity) and ship it as one compact static file the
// browser loads lazily and runs A* over.
//
// Source : build/city.osm.pbf  (the clipped city extract from bake-city.mjs)
// Output : data/graph.json      (committed + served, like data/hanoi-meta.json)
//
// Pipeline: osmium tags-filter (w/highway) -> parse -> split ways at junction
// nodes -> compact index-based encoding.
//
// Usage: node bake-graph.mjs
// ============================================================================
import { execFileSync } from "node:child_process";
import { createReadStream, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PBF = join(__dir, "build", "city.osm.pbf");
const TMP = join(__dir, "build", "roads.tmp.osm");
const OUT = join(__dir, "data", "graph.json");

if (!existsSync(PBF)) { console.error(`missing ${PBF} — run bake-city.mjs first`); process.exit(1); }

// highway values we do NOT route on (pedestrian-only / non-vehicular)
const SKIP = new Set(["footway","path","steps","pedestrian","cycleway","bridleway",
  "corridor","platform","construction","proposed","raceway","track"]);

// Reference free-flow speeds (km/h) by highway class — used by the browser A*
// cost function. Shipped in meta so bake + client agree. `service` is slow on
// purpose so it's only chosen for first/last-meters access, not through-routes.
const SPEED_KMH = {
  motorway: 90, trunk: 70, primary: 50, secondary: 45, tertiary: 40,
  unclassified: 35, residential: 30, living_street: 15, service: 20,
  busway: 30, ladder: 10,
  motorway_link: 60, trunk_link: 45, primary_link: 35,
  secondary_link: 32, tertiary_link: 28,
};

// ---- 1. filter highways to XML (preserves <nd ref> connectivity) ----
console.log("filtering highways with osmium…");
execFileSync("osmium", ["tags-filter", PBF, "w/highway", "-o", TMP, "--overwrite"], { stdio: "inherit" });

// ---- 2. parse nodes + ways (streaming, line-oriented) ----
const nodeLat = new Map(), nodeLon = new Map();
const ways = [];
let cur = null;
const attr = (line, name) => { const m = line.match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null; };

const rl = createInterface({ input: createReadStream(TMP), crlfDelay: Infinity });
for await (const line of rl) {
  const s = line.trimStart();
  if (s.startsWith("<node ")) { const id = attr(s,"id"); nodeLat.set(id,+attr(s,"lat")); nodeLon.set(id,+attr(s,"lon")); }
  else if (s.startsWith("<way")) cur = { id: attr(s, "id"), refs: [], tags: {} };
  else if (s.startsWith("<nd ")) { if (cur) cur.refs.push(attr(s,"ref")); }
  else if (s.startsWith("<tag ")) { if (cur) cur.tags[attr(s,"k")] = attr(s,"v"); }
  else if (s.startsWith("</way")) { if (cur) ways.push(cur); cur = null; }
}
const roadWays = ways.filter(w => { const h = w.tags.highway; return h && !SKIP.has(h) && w.refs.length >= 2; });
console.log(`parsed ${roadWays.length} routable road ways`);

// ---- 3. junction nodes: shared by >=2 ways, or a way endpoint ----
const refCount = new Map();
for (const w of roadWays) for (const r of w.refs) refCount.set(r, (refCount.get(r)||0)+1);
const isJunction = (r, w, i) => i === 0 || i === w.refs.length-1 || (refCount.get(r)||0) >= 2;

const R = 6371000, rad = d => d*Math.PI/180;
const dist = (aLat,aLon,bLat,bLon) => {
  const dLat = rad(bLat-aLat), dLon = rad(bLon-aLon);
  const s = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
};
const r6 = x => Math.round(x*1e6)/1e6;

// ---- 4. compact encoders: node index table + class/name string tables ----
const nodeIdx = new Map(), nodeXY = [];     // OSM id -> index, flat [lon,lat,...]
const getNode = (id) => {
  let i = nodeIdx.get(id);
  if (i === undefined) { i = nodeXY.length/2; nodeIdx.set(id, i); nodeXY.push(r6(nodeLon.get(id)), r6(nodeLat.get(id))); }
  return i;
};
const classes = [], classIdx = new Map();
const getClass = (c) => { let i = classIdx.get(c); if (i===undefined){ i=classes.length; classIdx.set(c,i); classes.push(c);} return i; };
const names = [], nameIdx = new Map();
const getName = (n) => { if (!n) return -1; let i = nameIdx.get(n); if (i===undefined){ i=names.length; nameIdx.set(n,i); names.push(n);} return i; };

// oneway code: 0 = both ways, 1 = a->b only, 2 = b->a only
const onewayCode = (t) => {
  if (t.junction === "roundabout") return 1;
  const o = t.oneway;
  if (o === "yes" || o === "true" || o === "1") return 1;
  if (o === "-1" || o === "reverse") return 2;
  return 0;
};

// ---- 5. split ways into edges ----
const edges = [];
const wayids = []; // parallel to edges: OSM way id each edge came from (as number)
let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
for (const w of roadWays) {
  const o = onewayCode(w.tags), c = getClass(w.tags.highway), nm = getName(w.tags.name);
  const wid = Number(w.id);
  let start = 0;
  for (let i = 1; i < w.refs.length; i++) {
    if (!isJunction(w.refs[i], w, i)) continue;
    const seg = w.refs.slice(start, i+1);
    let len = 0;
    for (let k = 1; k < seg.length; k++)
      len += dist(nodeLat.get(seg[k-1]),nodeLon.get(seg[k-1]),nodeLat.get(seg[k]),nodeLon.get(seg[k]));
    const a = seg[0], b = seg[seg.length-1];
    if (a !== b && len > 0) {
      const ai = getNode(a), bi = getNode(b);
      // interior shape points (exclude the two junction endpoints)
      const interior = [];
      for (let k = 1; k < seg.length-1; k++) interior.push(r6(nodeLon.get(seg[k])), r6(nodeLat.get(seg[k])));
      edges.push([ai, bi, Math.max(1, Math.round(len)), c, o, nm, ...interior]);
      wayids.push(wid);
      for (const id of [a,b]) {
        const x = nodeLon.get(id), y = nodeLat.get(id);
        if (x<minx)minx=x; if (x>maxx)maxx=x; if (y<miny)miny=y; if (y>maxy)maxy=y;
      }
    }
    start = i;
  }
}
const nodeCount = nodeXY.length/2;
console.log(`graph: ${nodeCount} nodes, ${edges.length} edges, ${classes.length} classes, ${names.length} names`);

// ---- 6. emit ----
const graph = {
  meta: {
    bbox: [r6(minx), r6(miny), r6(maxx), r6(maxy)],
    center: [r6((minx+maxx)/2), r6((miny+maxy)/2)],
    nodes: nodeCount, edges: edges.length,
    speeds_kmh: SPEED_KMH,
    // edge tuple layout: [aIdx, bIdx, length_m, classIdx, onewayCode, nameIdx, ...interiorLonLat]
    edge_layout: ["a","b","len_m","cls","oneway","name",".. interior lon,lat pairs"],
    service_penalty: 4, // suggested A* cost multiplier for service roads (see Task 5)
  },
  classes, names, nodes: nodeXY, edges,
  wayids, // parallel to edges: OSM way id (for matching HD lanes to the route, Task 11)
};
const json = JSON.stringify(graph);
writeFileSync(OUT, json);
rmSync(TMP, { force: true });
const mb = n => (n/1e6).toFixed(2)+" MB";
console.log(`\nwrote ${OUT}`);
console.log(`  ${mb(statSync(OUT).size)} raw, ${mb(gzipSync(Buffer.from(json)).length)} gzipped`);
