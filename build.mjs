// Shared osm2streets pipeline: OSM XML -> HD GeoJSON layers.
// Used by generate.mjs (Overpass fetch) and watch.mjs (JOSM file watch).

import init, { JsStreetNetwork } from "osm2streets-js/osm2streets_js.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/**
 * Turn OSM XML into the three HD layers plus a suggested map centre.
 * Returns { lanes, markings, intersections, center, counts }.
 */
export function osmToLayers(osmXml) {
  const net = new JsStreetNetwork(osmXml, "", IMPORT_OPTIONS);

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
  // osm2streets only draws STRAIGHT arrows. We replace them with directional
  // turn arrows: pair each straight arrow to the Driving lane under it, read that
  // lane's allowed_turns, and emit a point (position + travel bearing + turn key)
  // that the viewer renders as a ↑ / ↰ / ↱ glyph. So drop straight arrows here.
  const keptMarkings = laneMarkings.features.filter((f) => {
    if (f.properties.type === "lane arrow") return false; // replaced by turn arrows
    if (f.properties.type !== "center line") return true;
    const c = centroidOf(f.geometry);
    return !oneWayRoadPolys.some((r) => inBbox(c, r.bbox) && inPolygon(c, r.geom));
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

  const b = boundsOf(lanes.features);
  const center = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;

  return {
    lanes,
    markings,
    intersections,
    turnArrows,
    center,
    counts: {
      lanes: lanes.features.length,
      markings: markings.features.length,
      intersections: intersections.features.length,
      turnArrows: turnArrows.features.length,
    },
  };
}
