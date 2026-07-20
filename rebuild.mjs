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
import { initEngine, osmToLayers } from "./build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");
const osmFile = join(__dir, "live", "current.osm");

// `fetchedAt` records when the OSM data was pulled from Overpass; stamped fresh
// on fetch/reset and carried forward across tag-edit rebuilds so the viewer can
// show how stale the data is. version.json is written LAST (after every geojson)
// so the viewer never reloads a half-written layer set — it only reacts to `v`.
export function rebuildFiles(source, { fetchedAt } = {}) {
  const xml = readFileSync(osmFile, "utf8");
  const { lanes, markings, intersections, turnArrows, buildings, center, counts } = osmToLayers(xml);
  writeFileSync(join(dataDir, "lanes.geojson"), JSON.stringify(lanes));
  writeFileSync(join(dataDir, "markings.geojson"), JSON.stringify(markings));
  writeFileSync(join(dataDir, "intersections.geojson"), JSON.stringify(intersections));
  writeFileSync(join(dataDir, "turn_arrows.geojson"), JSON.stringify(turnArrows));
  writeFileSync(join(dataDir, "buildings.geojson"), JSON.stringify(buildings));
  if (center) {
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")); } catch {}
    writeFileSync(join(dataDir, "meta.json"), JSON.stringify({ ...meta, center }));
  }
  let prev = {};
  try { prev = JSON.parse(readFileSync(join(dataDir, "version.json"), "utf8")); } catch {}
  let fetched = fetchedAt ?? prev.fetchedAt;
  if (fetched == null) { try { fetched = statSync(osmFile).mtimeMs; } catch { fetched = Date.now(); } }
  const v = Date.now();
  writeFileSync(join(dataDir, "version.json"), JSON.stringify({ v, source, fetchedAt: fetched }));
  return { v, counts };
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
