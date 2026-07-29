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

// ============================================================================
// Valhalla-style per-edge speed assignment (adapted from valhalla/valhalla's
// lua/graph.lua + src/mjolnir/{pbfgraphparser,graphenhancer,speed_assigner}).
// Priority per edge:  tagged OSM maxspeed (rough-surface reduced)  >  urban/rural
// class default (by a simplified road-density "urban" flag)  >  ramp/roundabout/
// service adjustments.  Result is stored per edge in km/h (data/graph.json
// .edge_speeds), so the router + drive HUD use a real per-road limit instead of a
// single per-class number. NOTE simplifications vs Valhalla: no country/state
// config, no live/predicted traffic, no separate truck speed, and a coarse
// grid-based density rather than the full per-node density model.
// ----------------------------------------------------------------------------
// road_class 0..7 (motorway .. service/other); rural + urban baselines (kph)
const ROAD_CLASS = { motorway:0, motorway_link:0, trunk:1, trunk_link:1,
  primary:2, primary_link:2, secondary:3, secondary_link:3, tertiary:4, tertiary_link:4,
  busway:4, unclassified:5, residential:6, living_street:6, service:7, ladder:7, elevator:7 };
const RURAL_KPH = [105, 90, 75, 60, 50, 40, 35, 25];
const URBAN_KPH = [ 89, 73, 57, 49, 40, 35, 30, 20];
const MAX_ASSUMED = 120;   // sanity cap (kph)
const URBAN_ROAD_M = 18000; // road-metres within a ~1km² neighbourhood ⇒ "urban"

// normalize any maxspeed-family value to kph (mph→kph, none/walk sentinels, junk<10 dropped)
const normSpeed = (v) => {
  if (v == null) return null;
  v = String(v).trim().toLowerCase();
  if (v === "none") return MAX_ASSUMED;
  if (v === "walk") return 5;
  const m = v.match(/(\d+(?:\.\d+)?)\s*(mph|kmh|km\/h|kph)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === "mph") n = Math.round(n * 1.609344);
  return n >= 10 ? n : null;
};
const taggedSpeed = (t) => normSpeed(t.maxspeed) ?? normSpeed(t["maxspeed:forward"]) ?? normSpeed(t["maxspeed:backward"]);
const isRough = (t) => !!t.surface && /unpaved|gravel|ground|dirt|sand|compacted|fine_gravel|earth|mud|grass|cobblestone|\bsett\b|pebblestone/.test(t.surface);

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
const edgeMid = [];  // parallel: [lon,lat] midpoint (for density)
const edgeTags = []; // parallel: source way's tag object (for speed assignment)
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
      edgeMid.push([(nodeLon.get(a)+nodeLon.get(b))/2, (nodeLat.get(a)+nodeLat.get(b))/2]);
      edgeTags.push(w.tags);
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

// ---- 5b. per-edge speed (Valhalla-style) ----------------------------------
// density grid: total road length per ~330m cell → urban if the 3×3 neighbourhood
// (~1km²) exceeds URBAN_ROAD_M (Valhalla's "density>8 ⇒ urban", simplified).
const CELL = 0.003;
const cellKey = (lon, lat) => Math.floor(lon / CELL) + "," + Math.floor(lat / CELL);
const cellLen = new Map();
for (let e = 0; e < edges.length; e++) {
  const k = cellKey(edgeMid[e][0], edgeMid[e][1]);
  cellLen.set(k, (cellLen.get(k) || 0) + edges[e][2]);
}
const hoodLen = (lon, lat) => {
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL); let s = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) s += cellLen.get((cx + dx) + "," + (cy + dy)) || 0;
  return s;
};
let nTagged = 0, nUrban = 0;
const edge_speeds = edges.map((ed, e) => {
  const t = edgeTags[e], clsName = classes[ed[3]], rc = ROAD_CLASS[clsName] ?? 7;
  let sp;
  const tag = taggedSpeed(t);
  if (tag != null) {                                   // (a) tagged maxspeed wins
    nTagged++; sp = tag;
    if (isRough(t)) sp = sp >= 50 ? sp - 10 : sp > 15 ? sp - 5 : sp;
  } else {                                             // (b) class default, urban-adjusted
    const urban = hoodLen(edgeMid[e][0], edgeMid[e][1]) > URBAN_ROAD_M;
    if (urban) nUrban++;
    sp = urban ? URBAN_KPH[rc] : RURAL_KPH[rc];
    if (/_link$/.test(clsName)) sp = Math.round(sp * 0.85); // ramps/links
    if (isRough(t)) sp = Math.round(sp * 0.5);
  }
  if (t.junction === "roundabout") sp = Math.round(sp * 0.5);
  if (clsName === "living_street") sp = Math.min(sp, 20);
  if (clsName === "service") sp = Math.min(sp, 25);
  return Math.max(5, Math.min(MAX_ASSUMED, Math.round(sp)));
});
console.log(`speeds: ${nTagged} tagged, ${nUrban} urban-default, ${edges.length - nTagged - nUrban} rural-default`);

// ---- 6. emit ----
const graph = {
  meta: {
    bbox: [r6(minx), r6(miny), r6(maxx), r6(maxy)],
    center: [r6((minx+maxx)/2), r6((miny+maxy)/2)],
    nodes: nodeCount, edges: edges.length,
    speeds_kmh: SPEED_KMH, // per-class fallback (used only if edge_speeds is absent)
    // edge tuple layout: [aIdx, bIdx, length_m, classIdx, onewayCode, nameIdx, ...interiorLonLat]
    edge_layout: ["a","b","len_m","cls","oneway","name",".. interior lon,lat pairs"],
    service_penalty: 4, // suggested A* cost multiplier for service roads (see Task 5)
    speed_source: "valhalla-style: tagged maxspeed > urban/rural class default > adjustments",
  },
  classes, names, nodes: nodeXY, edges,
  wayids, // parallel to edges: OSM way id (for matching HD lanes to the route, Task 11)
  edge_speeds, // parallel to edges: assigned speed (km/h), Valhalla-style
};
const json = JSON.stringify(graph);
writeFileSync(OUT, json);
rmSync(TMP, { force: true });
const mb = n => (n/1e6).toFixed(2)+" MB";
console.log(`\nwrote ${OUT}`);
console.log(`  ${mb(statSync(OUT).size)} raw, ${mb(gzipSync(Buffer.from(json)).length)} gzipped`);
