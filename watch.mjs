// Live JOSM sync: watch a .osm file and rebuild HD GeoJSON whenever it changes.
//
// Workflow: in JOSM, edit your data, then Save (Cmd+S) to the watched file.
// This regenerates data/*.geojson; the browser viewer polls version.json and
// re-renders in place (~1s), preserving your current pan/zoom.
//
// Usage:
//   node watch.mjs                       # watches live/current.osm
//   node watch.mjs /path/to/your.osm     # watch a specific file

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { initEngine, osmToLayers } from "./build.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");
const liveDir = join(__dir, "live");
if (!existsSync(liveDir)) mkdirSync(liveDir, { recursive: true });

const srcFile = resolve(process.argv[2] || join(liveDir, "current.osm"));
const watchDir = dirname(srcFile);
const watchBase = basename(srcFile);

await initEngine();

let building = false;
let queued = false;
let lastSig = "";

async function rebuild(reason) {
  if (building) { queued = true; return; }
  building = true;
  try {
    if (!existsSync(srcFile)) {
      console.log(`… waiting for ${watchBase} to appear (save from JOSM to ${srcFile})`);
      return;
    }
    const xml = readFileSync(srcFile, "utf8");
    // skip empty / half-written saves
    if (!xml.includes("<osm")) { console.log("… file not ready, skipping"); return; }
    const sig = createHash("md5").update(xml).digest("hex");
    if (sig === lastSig && reason !== "startup") { return; }
    lastSig = sig;

    const t0 = Date.now();
    const { lanes, markings, intersections, turnArrows, center, counts } = osmToLayers(xml);
    writeFileSync(join(dataDir, "lanes.geojson"), JSON.stringify(lanes));
    writeFileSync(join(dataDir, "markings.geojson"), JSON.stringify(markings));
    writeFileSync(join(dataDir, "intersections.geojson"), JSON.stringify(intersections));
    writeFileSync(join(dataDir, "turn_arrows.geojson"), JSON.stringify(turnArrows));
    if (center) {
      // keep bbox from existing meta if present; only refresh center hint
      let meta = { bbox: null };
      try { meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")); } catch {}
      writeFileSync(join(dataDir, "meta.json"), JSON.stringify({ ...meta, center }));
    }
    writeFileSync(join(dataDir, "version.json"), JSON.stringify({ v: Date.now(), source: "josm" }));
    console.log(
      `↻ ${reason}: lanes ${counts.lanes}, markings ${counts.markings}, ` +
      `intersections ${counts.intersections}  (${Date.now() - t0}ms)`
    );
  } catch (e) {
    console.error(`✗ build failed (${reason}):`, e.message);
  } finally {
    building = false;
    if (queued) { queued = false; setTimeout(() => rebuild("requeued"), 50); }
  }
}

// debounce filesystem events (editors write in bursts / via temp+rename)
let timer = null;
function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(reason), 400);
}

console.log(`osm2streets live watcher`);
console.log(`  watching: ${srcFile}`);
console.log(`  outputs:  ${dataDir}/*.geojson`);
console.log(`  → in JOSM, Save (Cmd+S) to that file to refresh the HD map.\n`);

await rebuild("startup");

// watch the directory (survives atomic temp+rename saves) and filter the file
watch(watchDir, (_event, filename) => {
  if (!filename || filename === watchBase) schedule("save");
});
