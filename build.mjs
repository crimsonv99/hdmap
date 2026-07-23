// Shared osm2streets pipeline: OSM XML -> HD GeoJSON layers.
// Used by generate.mjs (Overpass fetch) and watch.mjs (JOSM file watch).

import init, { JsStreetNetwork } from "osm2streets-js/osm2streets_js.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const __dir = dirname(fileURLToPath(import.meta.url));

let ready = false;
export async function initEngine() {
  if (ready) return;
  const wasm = readFileSync(
    join(__dir, "node_modules/osm2streets-js/osm2streets_js_bg.wasm")
  );
  await init(wasm);
  ready = true;
}

const IMPORT_OPTIONS = {
  debug_each_step: false,
  dual_carriageway_experiment: false,
  sidepath_zipping_experiment: false,
  inferred_sidewalks: true,
  inferred_kerbs: true,
  osm2lanes: false,
  date_time: null,
  override_driving_side: "right", // Vietnam drives on the right
};

// ---- render-only class hierarchy (width + lane paint by highway class) ------
// osm2streets IGNORES the OSM `width` tag; the ONLY width lever it honours is the
// `lanes` COUNT (each Driving lane is 3 m, or 2 m on a `service` road), and its
// only built-in class differentiation is service=2 m vs everything-else=3 m — so
// an untagged residential, tertiary, secondary and primary all render at an
// identical 6 m. To give roads a width that reads by class, we inject a DEFAULT
// `lanes` count per class into the OSM fed to osm2streets, but ONLY when the way
// doesn't already tag lanes/oneway itself (real data always wins).
//
// This injection is done on an IN-MEMORY copy of the XML only — it is NEVER
// written to live/current.osm, so it can't pollute real OSM data or a JOSM
// upload. It's a rendering-inference layer, the same honesty as inferred widths
// and building heights elsewhere in this file.
//
// Tunable: edit these counts to taste. A class NOT listed here is left at the
// osm2streets default (2 lanes) — that's residential/tertiary/unclassified/
// living_street (6 m) and service/track (kept narrow at 2 m lanes).
//
// Two rules learned the hard way, keep them:
//  1. EVEN counts only. An odd count makes osm2streets split the carriageway
//     asymmetrically (e.g. lanes=3 -> 2 forward / 1 back), so the centre line
//     lands off-centre and the road looks lopsided.
//  2. Widen sparingly. Injecting a two-way multi-lane default onto an UNTAGGED
//     segment of a road that's really a ONE-WAY dual carriageway (very common
//     for city arterials — the tertiary/secondary/primary here are mostly
//     `oneway=yes` pairs) invents a back lane + yellow centre line and a width
//     bulge where the tagged neighbours are slim one-way roadways. So we do NOT
//     widen tertiary (its untagged connectors were the worst offenders) and only
//     nudge the genuinely-wide classes. Real `lanes`/`oneway` tags always win, so
//     properly-mapped arterials are untouched regardless.
// Counts >= 4 also make osm2streets paint dashed `lane separator` lines.
const LANES_BY_CLASS = {
  secondary: 4,   // 12 m
  primary: 4,     // 12 m
  trunk: 6,       // 18 m
  motorway: 6,    // 18 m
};

// Road classes that render as bare asphalt with NO painted markings at all — the
// centre line, lane separators AND turn arrows inside them are dropped (see the
// marking pass and the turn-arrow loop in osmToLayers). Small local access roads
// don't have road paint in reality.
const NO_LANE_LINE_CLASSES = new Set(["service", "track"]);

// tags that mean "the mapper already described this road's lane layout" — if any
// is present we do NOT inject a default `lanes`, so surveyed data always wins.
const LANE_TAGS = ["lanes", "oneway", "lanes:forward", "lanes:backward"];

/**
 * Return { xml, wayHighway }:
 *  - xml: the OSM XML with a default `lanes=<n>` injected onto highway ways that
 *    lack their own lane tags, per LANES_BY_CLASS (in-memory only).
 *  - wayHighway: { [wayId]: highwayValue } for every highway way, so the caller
 *    can key render decisions (e.g. marking suppression) on a road's class.
 * On any parse failure it falls back to the original XML with an empty map, so a
 * bad document degrades to "no class hierarchy" rather than breaking the build.
 */
function prepareRoads(osmXml) {
  try {
    const doc = new DOMParser().parseFromString(osmXml, "text/xml");
    const ways = doc.getElementsByTagName("way");
    const wayHighway = {};
    let injected = 0;
    for (let i = 0; i < ways.length; i++) {
      const way = ways[i];
      const tagEls = way.getElementsByTagName("tag");
      const tags = {};
      for (let j = 0; j < tagEls.length; j++)
        tags[tagEls[j].getAttribute("k")] = tagEls[j].getAttribute("v");
      const hw = tags.highway;
      if (!hw) continue;
      wayHighway[way.getAttribute("id")] = hw;
      const want = LANES_BY_CLASS[hw];
      if (want == null) continue;                       // class not widened
      if (LANE_TAGS.some((k) => tags[k] != null)) continue; // respect real tags
      const el = doc.createElement("tag");
      el.setAttribute("k", "lanes");
      el.setAttribute("v", String(want));
      way.appendChild(el);
      injected++;
    }
    const xml = new XMLSerializer().serializeToString(doc);
    return { xml, wayHighway, injected };
  } catch (e) {
    return { xml: osmXml, wayHighway: {}, injected: 0, error: String(e) };
  }
}

// ---- geometry helpers (point-in-polygon for the one-way centre-line filter) ----
// NOTE: this is the vertex *average*, not a true area centroid, so on a concave
// polygon it can fall outside. It's only used as a representative point for the
// thin, convex centre-line dashes (and the arrow-to-lane hit test) where the
// average always lands inside — good enough, and cheaper than a real centroid.
const centroidOf = (geom) => {
  let x = 0, y = 0, n = 0;
  const walk = (a) => {
    if (typeof a[0] === "number") { x += a[0]; y += a[1]; n++; }
    else a.forEach(walk);
  };
  walk(geom.coordinates);
  return [x / n, y / n];
};
// axis-aligned bbox [minX,minY,maxX,maxY] of any geometry — used to cheaply reject
// non-overlapping polygons before the O(vertices) point-in-polygon test.
const geomBbox = (geom) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (a) => {
    if (typeof a[0] === "number") {
      if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
      if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
    } else a.forEach(walk);
  };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
};
const inBbox = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];
const inRing = (pt, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
};
const inPolygon = (pt, geom) => {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  return polys.some((rings) => inRing(pt, rings[0]));
};

const boundsOf = (features) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(walk);
  };
  features.forEach((f) => walk(f.geometry.coordinates));
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
};

// ---- buildings (3D context extrusions — see plan.md §5 Phase 2) ------------
// osm2streets is a STREETS engine — it ignores building ways entirely. So we
// parse them straight from the OSM XML and polygonize the closed ways ourselves,
// attaching an INFERRED height (estimated, not survey — same honesty as our
// inferred lane widths):
//   height tag (m)  ->  building:levels x LEVEL_M  ->  DEFAULT_HEIGHT_M
// plus an optional base from min_height / building:min_level.
//
// BOTH shapes of OSM building are handled, so anything mapped as a building renders:
//   1. a closed WAY tagged building=* / building:part=*
//   2. a multipolygon RELATION tagged building=* whose member ways are usually
//      UNTAGGED (the tag lives on the relation). These are the courtyard/atrium
//      buildings — schools, factories, temples. Their `inner` members become real
//      GeoJSON holes, and several `outer` rings become a MultiPolygon.
const LEVEL_M = 3;          // assumed storey height when only levels are tagged
const DEFAULT_HEIGHT_M = 6; // ~2 storeys, when a building has no height signal
const parseMeters = (s) => {
  if (s == null) return null;
  const m = String(s).match(/-?\d+(?:\.\d+)?/); // "12", "12 m", "12.5m"
  return m ? parseFloat(m[0]) : null;
};

// A multipolygon boundary may be SPLIT across several member ways, in any order and
// any direction. Chain them end-to-end (by shared node id) into closed rings.
function assembleRings(memberWayIds, ways, nodes) {
  const segs = [];
  for (const id of memberWayIds) {
    const w = ways.get(id);
    if (w && w.refs.length >= 2) segs.push(w.refs.slice());
  }
  const rings = [];
  while (segs.length) {
    let chain = segs.shift();
    let grew = true;
    // keep absorbing segments that touch either end until the chain closes
    while (grew && chain[0] !== chain[chain.length - 1]) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = chain[chain.length - 1], start = chain[0];
        if (s[0] === end) { chain = chain.concat(s.slice(1)); }
        else if (s[s.length - 1] === end) { chain = chain.concat(s.slice(0, -1).reverse()); }
        else if (s[s.length - 1] === start) { chain = s.slice(0, -1).concat(chain); }
        else if (s[0] === start) { chain = s.slice(1).reverse().concat(chain); }
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    if (chain[0] !== chain[chain.length - 1]) continue; // unclosed → not a valid ring
    const ring = [];
    for (const ref of chain) { const p = nodes.get(ref); if (p) ring.push(p); }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// ray-casting point-in-polygon, used to decide which outer ring a hole belongs to
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// shared height/base inference + property bag for both ways and relations
function buildingProps(tags, id, osmType) {
  const lvl = parseMeters(tags["building:levels"]);
  const minLvl = parseMeters(tags["building:min_level"]);
  const tagH = parseMeters(tags.height);
  // Record WHERE the height came from. Only "tag" is real OSM data — the others are
  // this tool's estimates, and mass-uploading estimates back into OSM as if surveyed
  // is exactly what the automated-edits code of conduct warns against.
  const height_source = tagH != null ? "tag" : lvl != null ? "levels" : "default";
  return {
    osm_way_id: id,     // kept as the generic element id (see osm_type)
    osm_type: osmType,  // "way" | "relation" — the osm.org link + JOSM push need this
    height: tagH ?? (lvl != null ? lvl * LEVEL_M : null) ?? DEFAULT_HEIGHT_M,
    height_source,
    base: parseMeters(tags.min_height) ?? (minLvl != null ? minLvl * LEVEL_M : 0),
    name: tags.name ?? null,
    levels: tags["building:levels"] ?? null,
    min_level: tags["building:min_level"] ?? null,
    building: tags.building ?? tags["building:part"] ?? null,
  };
}

const isBuildingTags = (tags) =>
  (tags.building && tags.building !== "no") ||
  (tags["building:part"] && tags["building:part"] !== "no");

const readTags = (el) => {
  const tags = {};
  const tagEls = el.getElementsByTagName("tag");
  for (let j = 0; j < tagEls.length; j++)
    tags[tagEls[j].getAttribute("k")] = tagEls[j].getAttribute("v");
  return tags;
};
export function buildingsFromOsm(osmXml) {
  const doc = new DOMParser().parseFromString(osmXml, "text/xml");
  // node id -> [lon, lat]
  const nodes = new Map();
  const nodeEls = doc.getElementsByTagName("node");
  for (let i = 0; i < nodeEls.length; i++) {
    const n = nodeEls[i];
    const id = n.getAttribute("id");
    const lon = parseFloat(n.getAttribute("lon")), lat = parseFloat(n.getAttribute("lat"));
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
  }
  // index every way once: id -> { refs (node ids), tags }
  const ways = new Map();
  const wayEls = doc.getElementsByTagName("way");
  for (let i = 0; i < wayEls.length; i++) {
    const w = wayEls[i];
    const refs = [];
    const ndEls = w.getElementsByTagName("nd");
    for (let j = 0; j < ndEls.length; j++) refs.push(ndEls[j].getAttribute("ref"));
    ways.set(w.getAttribute("id"), { refs, tags: readTags(w) });
  }

  const features = [];
  // ways already drawn as part of a building relation — don't draw them twice
  // (old-style tagging sometimes repeats building=* on the outer way)
  const consumed = new Set();

  // ---- 1. multipolygon building RELATIONS (courtyards / holes) --------------
  const relEls = doc.getElementsByTagName("relation");
  for (let i = 0; i < relEls.length; i++) {
    const r = relEls[i];
    const tags = readTags(r);
    if (!isBuildingTags(tags)) continue;
    // type=multipolygon carries the geometry; type=building (S3DB) groups parts
    if (tags.type !== "multipolygon" && tags.type !== "building") continue;
    const outerIds = [], innerIds = [];
    const memEls = r.getElementsByTagName("member");
    for (let j = 0; j < memEls.length; j++) {
      const m = memEls[j];
      if (m.getAttribute("type") !== "way") continue;
      const ref = m.getAttribute("ref");
      const role = m.getAttribute("role") || "outer"; // blank role = outer by convention
      if (role === "inner") innerIds.push(ref);
      else outerIds.push(ref);
      consumed.add(ref);
    }
    const outers = assembleRings(outerIds, ways, nodes);
    if (!outers.length) continue;
    const inners = assembleRings(innerIds, ways, nodes);
    // each outer ring starts its own polygon; holes go to the outer that contains them
    const polys = outers.map((o) => [o]);
    for (const hole of inners) {
      const idx = polys.findIndex((p) => pointInRing(hole[0], p[0]));
      if (idx >= 0) polys[idx].push(hole); // orphan holes are dropped, not mis-assigned
    }
    features.push({
      type: "Feature",
      geometry: polys.length === 1
        ? { type: "Polygon", coordinates: polys[0] }
        : { type: "MultiPolygon", coordinates: polys },
      properties: buildingProps(tags, r.getAttribute("id"), "relation"),
    });
  }

  // ---- 2. plain closed WAYS tagged building=* / building:part=* -------------
  for (const [id, w] of ways) {
    if (consumed.has(id)) continue;
    if (!isBuildingTags(w.tags)) continue;
    const ring = [];
    for (const ref of w.refs) { const p = nodes.get(ref); if (p) ring.push(p); }
    if (ring.length < 3) continue; // not enough points for an area
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]); // close it
    if (ring.length < 4) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: buildingProps(w.tags, id, "way"),
    });
  }
  return { type: "FeatureCollection", features };
}

// Raw road network straight from OSM XML: one LineString per highway way, with
// its OSM id + all tags carried over verbatim. This is the RAW fetched geometry
// (not the osm2streets-exploded lanes/markings) — used for the "download roads
// as GeoJSON" export so what you get back matches what was pulled from Overpass.
export function roadsFromOsm(osmXml) {
  const doc = new DOMParser().parseFromString(osmXml, "text/xml");
  const nodes = new Map();
  const nodeEls = doc.getElementsByTagName("node");
  for (let i = 0; i < nodeEls.length; i++) {
    const n = nodeEls[i];
    const id = n.getAttribute("id");
    const lon = parseFloat(n.getAttribute("lon")), lat = parseFloat(n.getAttribute("lat"));
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
  }
  const features = [];
  const wayEls = doc.getElementsByTagName("way");
  for (let i = 0; i < wayEls.length; i++) {
    const w = wayEls[i];
    const tags = {};
    const tagEls = w.getElementsByTagName("tag");
    for (let j = 0; j < tagEls.length; j++)
      tags[tagEls[j].getAttribute("k")] = tagEls[j].getAttribute("v");
    if (!tags.highway) continue; // roads only
    const ndEls = w.getElementsByTagName("nd");
    const line = [];
    for (let j = 0; j < ndEls.length; j++) {
      const p = nodes.get(ndEls[j].getAttribute("ref"));
      if (p) line.push(p);
    }
    if (line.length < 2) continue; // not enough points for a line
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line },
      properties: { osm_way_id: w.getAttribute("id"), ...tags },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Turn OSM XML into the HD layers plus a suggested map centre.
 * Returns { lanes, markings, intersections, turnArrows, buildings, center, counts }.
 */
export function osmToLayers(osmXml) {
  // Inject per-class default `lanes` (width hierarchy) into an in-memory copy of
  // the XML before osm2streets runs, and get back each way's highway class so we
  // can suppress lane paint on the no-line classes below. Buildings/road-download
  // still parse the ORIGINAL osmXml — this only shapes the osm2streets geometry.
  const { xml: netXml, wayHighway } = prepareRoads(osmXml);
  const net = new JsStreetNetwork(netXml, "", IMPORT_OPTIONS);

  const plain = JSON.parse(net.toGeojsonPlain());
  const intersections = {
    type: "FeatureCollection",
    features: plain.features.filter((f) => f.properties?.type === "intersection"),
  };

  const lanes = JSON.parse(net.toLanePolygonsGeojson());
  const laneMarkings = JSON.parse(net.toLaneMarkingsGeojson());
  const interMarkings = JSON.parse(net.toIntersectionMarkingsGeojson());

  // Drop yellow centre lines on non-two-way roads (they'd sit at the carriageway
  // edge instead of the middle). A road is two-way only if it has both a Fwd and
  // a Back Driving lane.
  const roadDrivingDirs = {};
  for (const f of lanes.features) {
    const p = f.properties;
    if (p.type === "Driving")
      (roadDrivingDirs[p.road] ||= new Set()).add(p.direction);
  }
  // precompute each one-way road's bbox once so the centre-line test below can
  // reject non-overlapping roads with a cheap bbox check before the O(vertices)
  // point-in-polygon — keeps this pass from being markings × roads × vertices.
  const oneWayRoadPolys = plain.features
    .filter((f) => {
      if (f.properties.type !== "road") return false;
      const dirs = roadDrivingDirs[f.properties.id];
      return !(dirs && dirs.has("Fwd") && dirs.has("Back"));
    })
    .map((r) => ({ geom: r.geometry, bbox: geomBbox(r.geometry) }));

  // Roads whose highway class renders with NO painted lane lines (service/track):
  // resolve each road's class from its lanes' osm_way_ids, then keep the polygons
  // of the no-line classes so the marking pass below can drop every centre line
  // and lane separator that falls inside one. Same bbox-precompute trick.
  const roadClass = {}; // road index -> highway value
  for (const f of lanes.features) {
    if (roadClass[f.properties.road] != null) continue;
    for (const id of f.properties.osm_way_ids || []) {
      const hw = wayHighway[id];
      if (hw) { roadClass[f.properties.road] = hw; break; }
    }
  }
  const noLineRoadPolys = plain.features
    .filter((f) => f.properties.type === "road" && NO_LANE_LINE_CLASSES.has(roadClass[f.properties.id]))
    .map((r) => ({ geom: r.geometry, bbox: geomBbox(r.geometry) }));
  const inAny = (c, polys) => polys.some((r) => inBbox(c, r.bbox) && inPolygon(c, r.geom));

  // osm2streets only draws STRAIGHT arrows. We replace them with directional
  // turn arrows: pair each straight arrow to the Driving lane under it, read that
  // lane's allowed_turns, and emit a point (position + travel bearing + turn key)
  // that the viewer renders as a ↑ / ↰ / ↱ glyph. So drop straight arrows here.
  // Also drop lane paint (centre line on one-way OR no-line-class roads; any lane
  // line at all inside a no-line-class road).
  const keptMarkings = laneMarkings.features.filter((f) => {
    const t = f.properties.type;
    if (t === "lane arrow") return false; // replaced by turn arrows
    if (t !== "center line" && t !== "lane separator") return true;
    const c = centroidOf(f.geometry);
    if (inAny(c, noLineRoadPolys)) return false; // service/track: no lines at all
    if (t === "center line" && inAny(c, oneWayRoadPolys)) return false; // one-way: no centre line
    return true;
  });

  const markings = {
    type: "FeatureCollection",
    features: [...keptMarkings, ...interMarkings.features],
  };

  // ---- directional turn arrows ----
  const drivingLanes = lanes.features.filter((f) => f.properties.type === "Driving");
  const canonTurn = (t) =>
    /left/.test(t) ? "left" : /right/.test(t) ? "right" : t === "through" ? "through" : null;
  const turnsKey = (allowed) => {
    const s = new Set((allowed || []).map(canonTurn).filter(Boolean));
    const parts = ["left", "through", "right"].filter((d) => s.has(d));
    return parts.length ? parts.join("_") : "through";
  };
  // bearing (deg, 0=north, clockwise) from arrow centroid to its farthest vertex (tip)
  const arrowBearing = (geom) => {
    const c = centroidOf(geom);
    const pts = [];
    const walk = (a) => { if (typeof a[0] === "number") pts.push(a); else a.forEach(walk); };
    walk(geom.coordinates);
    let tip = pts[0], best = -1;
    for (const p of pts) {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
      if (d > best) { best = d; tip = p; }
    }
    return ((Math.atan2(tip[0] - c[0], tip[1] - c[1]) * 180) / Math.PI + 360) % 360;
  };

  // Real road paint shows ONE turn arrow per lane near the intersection, not
  // repeated down the lane. So per lane-segment, keep only the arrow farthest
  // downstream (max projection onto the travel-direction vector).
  const perLane = new Map(); // "road:index" -> best candidate
  for (const a of laneMarkings.features) {
    if (a.properties.type !== "lane arrow") continue;
    const c = centroidOf(a.geometry);
    const lane = drivingLanes.find((l) => inPolygon(c, l.geometry));
    if (!lane) continue;
    // no-line classes (service/track) render as bare asphalt — no turn arrows either
    if (NO_LANE_LINE_CLASSES.has(roadClass[lane.properties.road])) continue;
    const bearing = arrowBearing(a.geometry);
    const th = (bearing * Math.PI) / 180;
    const score = c[0] * Math.sin(th) + c[1] * Math.cos(th); // distance along travel dir
    const key = `${lane.properties.road}:${lane.properties.index}`;
    const prev = perLane.get(key);
    if (!prev || score > prev.score)
      perLane.set(key, {
        c, score, bearing,
        turns: turnsKey(lane.properties.allowed_turns),
        layer: lane.properties.layer ?? 0,
      });
  }
  const turnArrows = {
    type: "FeatureCollection",
    features: [...perLane.values()].map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: v.c },
      properties: { turns: v.turns, bearing: v.bearing, layer: v.layer },
    })),
  };

  const buildings = buildingsFromOsm(osmXml);

  const b = boundsOf(lanes.features);
  const center = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;

  return {
    lanes,
    markings,
    intersections,
    turnArrows,
    buildings,
    center,
    counts: {
      lanes: lanes.features.length,
      markings: markings.features.length,
      intersections: intersections.features.length,
      turnArrows: turnArrows.features.length,
      buildings: buildings.features.length,
    },
  };
}
