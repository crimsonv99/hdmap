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
import { roadLevel, nodeAltitudes, elevateSegment, LAYER_HEIGHT, deckWidth } from "./lib/elevation.mjs";

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

// ---- 5c. per-vertex altitude (shared elevation.mjs) -----------------------
// OSM `layer` -> altitude; junctions sit at the lowest layer meeting there; each
// edge cruises at its way's layer and ramps to its endpoints. Emitted SPARSE: only
// the edges that actually leave the ground carry a z array (everything else flat).
const nz = nodeAltitudes(roadWays.map(w => ({ nodeIds: w.refs, layer: roadLevel(w.tags),
  link: /_link$/.test(w.tags.highway || "") })));
const nodeZ = new Array(nodeCount).fill(0);        // node index -> altitude (m)
for (const [osmId, idx] of nodeIdx) nodeZ[idx] = nz.get(osmId) || 0;

// ---- 5d. procedural DECK MARKINGS (edge lines + dashed lane dividers) ------
// The elevated deck is otherwise a bare gray ribbon. We draw edge lines + dashed lane
// dividers along EVERY elevated deck, sampled from the SAME z-profile as the deck so
// they sit exactly on it — smooth ramps included. This is the sole elevated-road
// detail (the flat osm2streets HD overlay was dropped: its per-way altitude can't ramp,
// so it floated / left cliffs where the deck slopes).
const DECK_WIDTH_SCALE = 0.9; // MUST match the client deck mesh width
const MER = 111320;
const rz = (c) => [r6(c[0]), r6(c[1]), Math.round(c[2] * 100) / 100];
// offset a [lng,lat] polyline by `off` metres (+ = left of travel), carrying per-vertex z
const offsetLine = (coords, z, off) => coords.map((c, i) => {
  const a = coords[Math.max(0, i - 1)], b = coords[Math.min(coords.length - 1, i + 1)];
  const cosLat = Math.cos(c[1] * Math.PI / 180) || 1e-6;
  const dx = (b[0] - a[0]) * cosLat * MER, dy = (b[1] - a[1]) * MER, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L; // unit left-normal (metres)
  return [c[0] + nx * off / (cosLat * MER), c[1] + ny * off / MER, z[i]];
});
// keep only the runs of a [lng,lat,z] polyline that are genuinely ABOVE the ground
// (z >= minZ), interpolating the crossing points. Stops deck markings from drawing on
// the near-ground ramp feet (where they'd double the flat ground-tile markings) and
// from appearing underground on tunnel dips (z < 0).
const clipByZ = (line, minZ) => {
  const runs = []; let cur = [];
  const cross = (q, p) => { const t = (minZ - (q[2] || 0)) / ((p[2] || 0) - (q[2] || 0));
    return [q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, minZ]; };
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if ((p[2] || 0) >= minZ) {
      if (!cur.length && i > 0) cur.push(cross(line[i - 1], p)); // entering: add crossing
      cur.push(p);
    } else if (cur.length) {
      cur.push(cross(line[i - 1], p)); // leaving: add crossing then close the run
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
};
const MIN_MARK_Z = 0.6; // metres — only mark the elevated part of a deck
// trim a centreline (coords[[lng,lat]] + parallel z[]) back by `sa`/`sb` metres from its
// two ends, interpolating new endpoints. Used to pull deck markings OUT of a junction
// where ways of different layers meet, so the per-edge offset lines stop before the
// intersection instead of crossing each other across it. Returns null if nothing is left.
const trimEnds = (coords, z, sa, sb) => {
  const n = coords.length, cum = [0];
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dLL(coords[i - 1], coords[i]);
  const total = cum[n - 1], lo = sa, hi = total - sb;
  if (hi - lo < 2) return null;
  const at = (d) => {
    for (let i = 1; i < n; i++) if (cum[i] >= d) {
      const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
              coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
              z[i - 1] + (z[i] - z[i - 1]) * t];
    }
    return [coords[n - 1][0], coords[n - 1][1], z[n - 1]];
  };
  const oc = [], oz = [], a = at(lo); oc.push([a[0], a[1]]); oz.push(a[2]);
  for (let i = 0; i < n; i++) if (cum[i] > lo && cum[i] < hi) { oc.push(coords[i]); oz.push(z[i]); }
  const b = at(hi); oc.push([b[0], b[1]]); oz.push(b[2]);
  return { coords: oc, z: oz };
};
// split a [lng,lat,z] polyline into dash segments (dash/gap in metres)
const dLL = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * MER;
const dashLine = (line, on, off) => {
  const segs = []; let acc = 0, drawing = true, cur = [line[0]];
  for (let i = 1; i < line.length; i++) {
    let a = line[i - 1]; const b = line[i]; let segLen = dLL(a, b);
    while (segLen > 1e-6) {
      const need = (drawing ? on : off) - acc;
      if (need >= segLen) { acc += segLen; if (drawing) cur.push(b); break; }
      const t = need / segLen;
      const mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (drawing) { cur.push(mid); if (cur.length >= 2) segs.push(cur); cur = []; } else cur = [mid];
      drawing = !drawing; acc = 0; a = mid; segLen = dLL(a, b);
    }
  }
  if (drawing && cur.length >= 2) segs.push(cur);
  return segs;
};

// per-node set of road LAYERS meeting there — a node is "mixed" when ways of different
// layers meet (an interchange where the deck markings would otherwise cross). We trim
// markings back from mixed nodes; straight same-layer junctions stay continuous.
const nodeLayerSet = new Map();
for (let e = 0; e < edges.length; e++) {
  const L = roadLevel(edgeTags[e]);
  for (const ni of [edges[e][0], edges[e][1]]) {
    let s = nodeLayerSet.get(ni); if (!s) { s = new Set(); nodeLayerSet.set(ni, s); } s.add(L);
  }
}
const mixedNode = (ni) => { const s = nodeLayerSet.get(ni); return s && s.size > 1; };

// corner points of an edge's node-end stub: the node pushed `inset` m along the road,
// offset ±hw sideways. All stubs at a node → a junction polygon (its convex hull).
const stubCorners = (node, nxt, hw, inset) => {
  const cosLat = Math.cos(node[1] * Math.PI / 180) || 1e-6;
  let dx = (nxt[0] - node[0]) * cosLat * MER, dy = (nxt[1] - node[1]) * MER;
  const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
  const cx = node[0] + dx * inset / (cosLat * MER), cy = node[1] + dy * inset / MER;
  const ox = -dy * hw / (cosLat * MER), oy = dx * hw / MER;
  return [[cx + ox, cy + oy], [cx - ox, cy - oy]];
};
// convex hull (Andrew's monotone chain) of [lng,lat] points → ring (no closing point)
const hull = (pts) => {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = []; for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop(); return lo.concat(up);
};

const edge_z = {}; // edgeIndex -> [z per vertex], non-flat only
const roads3d = []; // [lng,lat,z] deck centrelines (browse-view ribbon)
const deckMarks = []; // procedural deck edge/divider lines
const deckJunc = []; // junction slabs covering interchanges (osm2streets-style)

// PASS 1 — collect elevated edges + per-node stubs (degree + node-end geometry)
const elev = [];
const nodeStubs = new Map();
const addStub = (ni, node, nxt, hw, z) => { let a = nodeStubs.get(ni); if (!a) { a = []; nodeStubs.set(ni, a); } a.push({ node, nxt, hw, z }); };
for (let e = 0; e < edges.length; e++) {
  const ed = edges[e], ai = ed[0], bi = ed[1];
  const za = nodeZ[ai], zb = nodeZ[bi], layer = roadLevel(edgeTags[e]);
  if (za === 0 && zb === 0 && layer === 0) continue; // fully on the ground — skip
  const coords = [[nodeXY[ai * 2], nodeXY[ai * 2 + 1]]];
  for (let k = 6; k < ed.length; k += 2) coords.push([ed[k], ed[k + 1]]);
  coords.push([nodeXY[bi * 2], nodeXY[bi * 2 + 1]]);
  const z = elevateSegment(coords, za, zb, layer).map(v => Math.round(v * 100) / 100);
  if (!z.some(v => v !== 0)) continue;
  edge_z[e] = z;
  const hw = deckWidth(classes[ed[3]]) * DECK_WIDTH_SCALE;
  elev.push({ e, cls: classes[ed[3]], coords, z, ai, bi, hw });
  addStub(ai, coords[0], coords[1], hw, z[0]);
  addStub(bi, coords[coords.length - 1], coords[coords.length - 2], hw, z[z.length - 1]);
}
const junctionNode = (ni) => (nodeStubs.get(ni) ? nodeStubs.get(ni).length : 0) >= 3;

// PASS 2 — deck centrelines + procedural markings (trimmed out of junctions, which a
// filled SLAB covers instead)
for (const { e, cls, coords, z, ai, bi, hw } of elev) {
  // [lng,lat,z] centerline for the 3D deck mesh (a ribbon whose top SLOPES with z)
  roads3d.push({ type: "Feature",
    geometry: { type: "LineString", coordinates: coords.map((c, k) => [c[0], c[1], z[k]]) },
    properties: { highway: cls } });
  let lanes = parseInt(edgeTags[e].lanes, 10);
  if (!Number.isFinite(lanes) || lanes < 1) lanes = 2;
  lanes = Math.min(lanes, 8);
  // pull markings back from interchange (degree≥3) and mixed-layer junctions so the
  // per-edge offset lines don't cross each other over the intersection
  const trimA = mixedNode(ai) || junctionNode(ai), trimB = mixedNode(bi) || junctionNode(bi);
  const set = hw + 3;
  const trimmed = (trimA || trimB) ? trimEnds(coords, z, trimA ? set : 0, trimB ? set : 0) : { coords, z };
  if (!trimmed) continue;
  const mc = trimmed.coords, mz = trimmed.z;
  // NOTE: no solid edge/border lines — the deck's curb walls already define the road
  // edge, and the two solid strokes collided messily at forks/roundabouts. Only the
  // dashed lane dividers are drawn (they read cleanly even where they cross).
  const laneW = (2 * hw) / lanes;
  for (let li = 1; li < lanes; li++) // dashed lane dividers (elevated part only)
    for (const run of clipByZ(offsetLine(mc, mz, -hw + li * laneW), MIN_MARK_Z))
      for (const seg of dashLine(run, 2.5, 3.5))
        deckMarks.push({ type: "Feature", properties: { style: "divider" },
          geometry: { type: "LineString", coordinates: seg.map(rz) } });
}

// JUNCTION SLABS — one filled deck polygon per elevated interchange (mimics osm2streets'
// intersection polygons): the convex hull of the connecting edges' node-end corners, at
// the junction's (elevated) height. Fills the gaps/overlaps the per-edge ribbons leave at
// forks/merges so the deck reads as one continuous surface.
for (const [ni, stubs] of nodeStubs) {
  if (!(stubs.length >= 3 || mixedNode(ni))) continue;
  const zj = Math.max(...stubs.map(s => s.z));
  if (zj < MIN_MARK_Z) continue; // ground-level junction — the flat tiles own it
  const corners = [];
  // inset matches the marking trim (hw+3) so the slab reaches exactly to where the lane
  // lines resume — no uncovered band between the slab and the ribbons
  for (const s of stubs) for (const c of stubCorners(s.node, s.nxt, s.hw, s.hw + 3)) corners.push(c);
  const poly = hull(corners);
  if (poly.length < 3) continue;
  poly.push(poly[0]);
  deckJunc.push({ type: "Feature", properties: { z: zj },
    geometry: { type: "Polygon", coordinates: [poly.map(([x, y]) => [r6(x), r6(y)])] } });
}

console.log(`elevation: ${elev.length} of ${edges.length} edges elevated (LAYER_HEIGHT=${LAYER_HEIGHT}m)`);
writeFileSync(join(__dir, "data", "roads_3d.geojson"), JSON.stringify({ type: "FeatureCollection", features: roads3d }));
writeFileSync(join(__dir, "data", "deck_markings.geojson"), JSON.stringify({ type: "FeatureCollection", features: deckMarks }));
writeFileSync(join(__dir, "data", "deck_junctions.geojson"), JSON.stringify({ type: "FeatureCollection", features: deckJunc }));
console.log(`deck markings: ${deckMarks.length} lines, ${deckJunc.length} junction slabs`);

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
    layer_height: LAYER_HEIGHT, // metres of altitude per OSM `layer` step
  },
  classes, names, nodes: nodeXY, edges,
  wayids, // parallel to edges: OSM way id (for matching HD lanes to the route, Task 11)
  edge_speeds, // parallel to edges: assigned speed (km/h), Valhalla-style
  edge_z, // sparse: edgeIndex -> [z per vertex, m] for elevated edges (layer!=0 or ramping)
};
const json = JSON.stringify(graph);
writeFileSync(OUT, json);
rmSync(TMP, { force: true });
const mb = n => (n/1e6).toFixed(2)+" MB";
console.log(`\nwrote ${OUT}`);
console.log(`  ${mb(statSync(OUT).size)} raw, ${mb(gzipSync(Buffer.from(json)).length)} gzipped`);
