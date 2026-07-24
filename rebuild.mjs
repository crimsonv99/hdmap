// Shared rebuild step: live/current.osm -> HD GeoJSON layers + version stamp.
//
// Importable as `rebuildFiles()` (used by server.mjs for startup / fetch / reset,
// where waiting is fine) AND runnable as a SUBPROCESS:  node rebuild.mjs <source>
// [fetchedAt].  server.mjs forks it after a changeset so the heavy osm2streets
// rebuild runs off the main thread — the server stays responsive (JOSM fetch,
// version polls) and the viewer refreshes when version.json bumps.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initEngine, osmToLayers, roadsFromOsm } from "./build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");
const osmFile = join(__dir, "live", "current.osm");

// ---- LOD gateway ----------------------------------------------------------
// osm2streets cost grows ~super-linearly with road count (≈3k ways→20s,
// 7.6k→110s, 60k→never), so running it on a big area freezes the editor. The
// gateway caps it: at or under WAY_LIMIT highway ways we render the full HD
// scene (lanes/markings/turn-arrows/intersections); over it we SKIP osm2streets
// and render the RAW OSM roads (one line per way) instead — instant at any size.
// The viewer flips between the two on the `mode` field. Tune with HDMAP_WAY_LIMIT.
const WAY_LIMIT = Number(process.env.HDMAP_WAY_LIMIT || 4000);
const EMPTY = { type: "FeatureCollection", features: [] };

const centerOf = (fc) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
    } else c.forEach(walk);
  };
  for (const f of fc.features) if (f.geometry) walk(f.geometry.coordinates);
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
};

// `fetchedAt` records when the OSM data was pulled from Overpass; stamped fresh
// on fetch/reset and carried forward across tag-edit rebuilds so the viewer can
// show how stale the data is. version.json is written LAST (after every geojson)
// so the viewer never reloads a half-written layer set — it only reacts to `v`.
export function rebuildFiles(source, { fetchedAt } = {}) {
  const xml = readFileSync(osmFile, "utf8");
  // buildings are an independent layer (POST /api/buildings) — the road rebuild
  // deliberately does NOT write buildings.geojson, so fetching/resetting roads
  // never wipes buildings the user pulled separately.

  // Raw roads (one line per highway way) are cheap — no osm2streets. Their count
  // is the gateway parameter: decide HD vs raw BEFORE spending osm2streets.
  const rawRoads = roadsFromOsm(xml);
  const roadCount = rawRoads.features.length;
  const mode = roadCount <= WAY_LIMIT ? "hd" : "raw";

  let center, counts;
  if (mode === "hd") {
    // full HD scene
    const hd = osmToLayers(xml);
    writeFileSync(join(dataDir, "lanes.geojson"), JSON.stringify(hd.lanes));
    writeFileSync(join(dataDir, "markings.geojson"), JSON.stringify(hd.markings));
    writeFileSync(join(dataDir, "intersections.geojson"), JSON.stringify(hd.intersections));
    writeFileSync(join(dataDir, "turn_arrows.geojson"), JSON.stringify(hd.turnArrows));
    writeFileSync(join(dataDir, "raw_roads.geojson"), JSON.stringify(EMPTY)); // no raw overlay in HD
    center = hd.center;
    counts = hd.counts;
  } else {
    // OVER the limit: skip osm2streets, render raw roads. Clear the HD layers so
    // no stale lanes/markings from a previous small area linger underneath.
    writeFileSync(join(dataDir, "raw_roads.geojson"), JSON.stringify(rawRoads));
    for (const f of ["lanes", "markings", "intersections", "turn_arrows"])
      writeFileSync(join(dataDir, `${f}.geojson`), JSON.stringify(EMPTY));
    center = centerOf(rawRoads);
    counts = { rawRoads: roadCount, lanes: 0, markings: 0, intersections: 0, turnArrows: 0 };
  }

  {
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")); } catch {}
    writeFileSync(join(dataDir, "meta.json"),
      JSON.stringify({ ...meta, ...(center ? { center } : {}), mode, roads: roadCount, limit: WAY_LIMIT }));
  }
  let prev = {};
  try { prev = JSON.parse(readFileSync(join(dataDir, "version.json"), "utf8")); } catch {}
  let fetched = fetchedAt ?? prev.fetchedAt;
  if (fetched == null) { try { fetched = statSync(osmFile).mtimeMs; } catch { fetched = Date.now(); } }
  const v = Date.now();
  writeFileSync(join(dataDir, "version.json"), JSON.stringify({ v, source, fetchedAt: fetched, mode, roads: roadCount }));
  return { v, mode, counts };
}

// subprocess entry: `node rebuild.mjs <source> [fetchedAt]`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = process.argv[2] || "subprocess";
  const fetchedAt = process.argv[3] ? Number(process.argv[3]) : undefined;
  await initEngine();
  try {
    const r = rebuildFiles(source, { fetchedAt });
    process.send?.({ ok: true, ...r });
    console.log("rebuilt:", r.counts);
    process.exit(0);
  } catch (e) {
    process.send?.({ ok: false, error: e.message });
    console.error("rebuild failed:", e.message);
    process.exit(1);
  }
}
