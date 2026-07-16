// HD map data generator
// OSM (Overpass) -> osm2streets (WASM) -> GeoJSON lane/intersection/marking polygons
//
// Usage:
//   node generate.mjs                       # default Hanoi bbox
//   node generate.mjs S W N E               # custom bbox (south west north east)
//   BBOX="21.0255,105.8470,21.0303,105.8540" node generate.mjs

import init, { JsStreetNetwork } from "osm2streets-js/osm2streets_js.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");

// --- bbox: south,west,north,east ---
const argBox = process.argv.slice(2);
const bbox =
  argBox.length === 4
    ? argBox.join(",")
    : process.env.BBOX || "21.0255,105.8470,21.0303,105.8540"; // small area around 21.02788,105.850312 (Hanoi)

console.log(`[1/3] Fetching OSM data from Overpass for bbox=${bbox} ...`);
const query = `[bbox:${bbox}];(way["highway"];>;);out meta;`;
const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "hdmap-demo/0.1 (osm2streets HD basemap experiment)",
  },
  body: "data=" + encodeURIComponent(query),
});
if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
const osmXml = await res.text();
writeFileSync(join(dataDir, "raw.osm"), osmXml);
console.log(`      got ${(osmXml.length / 1024).toFixed(0)} KB of OSM XML`);

console.log("[2/3] Running osm2streets (WASM) ...");
const wasm = readFileSync(
  join(__dir, "node_modules/osm2streets-js/osm2streets_js_bg.wasm")
);
await init(wasm);

const importOptions = {
  debug_each_step: false,
  dual_carriageway_experiment: false,
  sidepath_zipping_experiment: false,
  inferred_sidewalks: true,
  inferred_kerbs: true,
  osm2lanes: false,
  date_time: null,
  override_driving_side: "right", // Vietnam drives on the right
};

const net = new JsStreetNetwork(osmXml, "", importOptions);

// toGeojsonPlain() carries the real intersection AREA polygons (type:"intersection").
// toIntersectionMarkingsGeojson() only has sidewalk corners / crossings — those are
// markings, not the junction fill, so they go into the markings layer instead.
const plain = JSON.parse(net.toGeojsonPlain());
const intersections = {
  type: "FeatureCollection",
  features: plain.features.filter((f) => f.properties?.type === "intersection"),
};

const laneMarkings = JSON.parse(net.toLaneMarkingsGeojson());
const interMarkings = JSON.parse(net.toIntersectionMarkingsGeojson());

// osm2streets draws a yellow "center line" at the boundary between travel
// directions. On a ONE-WAY road every lane points the same way, so that
// boundary lands at the carriageway EDGE, not the middle — which reads as a
// misplaced line. Real one-way streets have no yellow centre line, so drop
// center-line markings that don't belong to a genuinely two-way road.
const lanesFC = JSON.parse(net.toLanePolygonsGeojson());
const roadDrivingDirs = {}; // road id -> Set<direction> of its Driving lanes
for (const f of lanesFC.features) {
  const p = f.properties;
  if (p.type === "Driving")
    (roadDrivingDirs[p.road] ||= new Set()).add(p.direction);
}
const oneWayRoadPolys = plain.features.filter((f) => {
  if (f.properties.type !== "road") return false;
  const dirs = roadDrivingDirs[f.properties.id];
  const twoWay = dirs && dirs.has("Fwd") && dirs.has("Back");
  return !twoWay; // roads that should NOT carry a yellow centre line
});

const centroidOf = (geom) => {
  let x = 0, y = 0, n = 0;
  const walk = (a) => {
    if (typeof a[0] === "number") { x += a[0]; y += a[1]; n++; }
    else a.forEach(walk);
  };
  walk(geom.coordinates);
  return [x / n, y / n];
};
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

let dropped = 0;
const keptMarkings = laneMarkings.features.filter((f) => {
  if (f.properties.type !== "center line") return true;
  const c = centroidOf(f.geometry);
  if (oneWayRoadPolys.some((r) => inPolygon(c, r.geometry))) { dropped++; return false; }
  return true;
});
console.log(`      dropped ${dropped} centre-line markings on one-way roads`);

const markings = {
  type: "FeatureCollection",
  features: [...keptMarkings, ...interMarkings.features],
};

const outputs = {
  "lanes.geojson": net.toLanePolygonsGeojson(),
  "markings.geojson": JSON.stringify(markings),
  "intersections.geojson": JSON.stringify(intersections),
};

console.log("[3/3] Writing GeoJSON ...");
for (const [file, geojson] of Object.entries(outputs)) {
  writeFileSync(join(dataDir, file), geojson);
  const n = JSON.parse(geojson).features.length;
  console.log(`      data/${file.padEnd(22)} ${n} features`);
}

// stash the map center (centroid of actual lane geometry, so the view lands on roads)
const [s, w, n, e] = bbox.split(",").map(Number);
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const walk = (coords) => {
  if (typeof coords[0] === "number") {
    minX = Math.min(minX, coords[0]); maxX = Math.max(maxX, coords[0]);
    minY = Math.min(minY, coords[1]); maxY = Math.max(maxY, coords[1]);
  } else coords.forEach(walk);
};
JSON.parse(outputs["lanes.geojson"]).features.forEach((f) => walk(f.geometry.coordinates));
const center = Number.isFinite(minX)
  ? [(minX + maxX) / 2, (minY + maxY) / 2]
  : [(w + e) / 2, (s + n) / 2];
writeFileSync(
  join(dataDir, "meta.json"),
  JSON.stringify({ center, bbox: [w, s, e, n] }, null, 2)
);
console.log("Done. Open index.html with a static server to view.");
