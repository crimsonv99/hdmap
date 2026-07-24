// HD map editor server (changeset-based staging editor — see plan.md).
//   - serves the viewer + generated GeoJSON
//   - GET  /api/way?id=<id>              -> current OSM tags for a way
//   - GET  /api/node?id=<id>             -> current OSM tags for a node
//   - POST /api/edit {wayId, tags}       -> single-way edit (legacy)
//   - POST /api/fetch {bbox:[w,s,e,n]}   -> pull area from Overpass, rebuild
//   - POST /api/reset {force?}           -> reload committed default area (data/default.osm), rebuild
//   - POST /api/rebuild-local            -> rebuild HD layers from existing current.osm (no Overpass)
//   - POST /api/changeset {edits:{key:{}}}-> batch-apply staged edits (key = "way:id"/"node:id"), rebuild
//
// Edits are written into live/current.osm as a normal JOSM-loadable .osm file
// (changed ways get action="modify"), so you review + Upload from JOSM. Nothing
// here talks to the OSM API — the push to OSM is done by you, in JOSM.

import { createServer } from "node:http";
import { readFile, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, appendFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { fork } from "node:child_process";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { initEngine, buildingsFromOsm, roadsFromOsm, landcoverFromOsm } from "./build.mjs";
import { rebuildFiles } from "./rebuild.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, "data");
const liveDir = join(__dir, "live");
if (!existsSync(liveDir)) mkdirSync(liveDir, { recursive: true });
const osmFile = join(liveDir, "current.osm");
// committed default area (Pham Hung interchange, Hanoi) used to seed a fresh
// checkout and to power "Reset to default area" — see deterministic-startup
// (roadmap #7). Prefer data/default.osm; fall back to data/raw.osm.
const defaultOsm = existsSync(join(dataDir, "default.osm")) ? join(dataDir, "default.osm")
  : existsSync(join(dataDir, "raw.osm")) ? join(dataDir, "raw.osm") : null;
const PORT = Number(process.env.PORT) || 8097;

// ---- per-session action log (for tracing problems back) --------------------
// Every live session appends to its own file logs/session-<start>.log — so each
// service start/restart begins a fresh file and the previous session's trace is
// preserved on disk. Writes are synchronous write-through (not an in-memory
// cache) so a crash still leaves a complete trace up to the failure.
const logsDir = join(__dir, "logs");
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
const startedAt = new Date();
const fileStamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-07-17T08-40-45
const logFile = join(logsDir, `session-${fileStamp}.log`);
function log(event, data) {
  const line = `${new Date().toISOString()}  ${event}` +
    (data !== undefined ? "  " + JSON.stringify(data) : "");
  try { appendFileSync(logFile, line + "\n"); } catch {}
  console.log(line);
}
log("session-start", { pid: process.pid, port: PORT, osmFile });
// flush a session-end marker on any exit path so the file clearly closes
let ended = false;
const endSession = (reason) => {
  if (ended) return; ended = true;
  log("session-end", { reason, uptimeMs: Date.now() - startedAt.getTime() });
};
process.on("SIGINT", () => { endSession("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { endSession("SIGTERM"); process.exit(0); });
process.on("exit", () => endSession("exit"));
process.on("uncaughtException", (e) => { log("uncaught", { msg: e.message }); endSession("crash"); process.exit(1); });

await initEngine();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".geojson": "application/json",
  ".osm": "application/xml",
};

// ---- Overpass with endpoint fallback --------------------------------------
// The main instance (overpass-api.de) is frequently overloaded and returns 504
// even for a tiny bbox. Rather than fail, try a list of mirrors in order until
// one answers 2xx. Override/re-order with OVERPASS_ENDPOINTS=url1,url2,… (comma
// or space separated). All serve identical OSM data.
const OVERPASS_ENDPOINTS = (process.env.OVERPASS_ENDPOINTS
  ? process.env.OVERPASS_ENDPOINTS.split(/[,\s]+/).filter(Boolean)
  : [
      "https://overpass-api.de/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]);
const OVERPASS_UA = "hdmap-demo/0.1 (osm2streets HD basemap experiment)";
// `timeoutMs` must exceed the [timeout:N] in the query itself, or we abort a
// request Overpass is still legitimately working on — a boundary fetch asking for
// 180s was previously killed at 50s, so its longer budget could never be used.
async function overpassFetch(query, timeoutMs = 70000) {
  let lastErr = "no endpoints";
  for (const ep of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs); // don't hang on a dead mirror
    try {
      const r = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OVERPASS_UA },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const text = await r.text();
        log("overpass-ok", { ep, bytes: text.length });
        return text;
      }
      lastErr = `HTTP ${r.status}`;
      log("overpass-fail", { ep, status: r.status });
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? "timeout" : e.message;
      log("overpass-fail", { ep, err: lastErr });
    }
  }
  throw new Error(`all Overpass endpoints failed (last: ${lastErr})`);
}

// ---- rebuild HD layers from the current .osm and bump the version stamp ----
// Synchronous (blocks the event loop for the whole osm2streets pass) — fine for
// startup / fetch / reset, where there's nothing to show until it's done. For a
// changeset we use bgRebuild() instead so Submit + the JOSM handoff stay instant.
function rebuild(source, opts = {}) {
  const { v, counts } = rebuildFiles(source, opts);
  log("rebuild", { source, v, counts });
  return { v, counts };
}

// ---- background rebuild (after a changeset) --------------------------------
// The rebuild reprocesses the WHOLE network through osm2streets (~tens of
// seconds on a big area) and would freeze this single-threaded server if run
// inline. So run it in a SEPARATE PROCESS: Submit writes current.osm and returns
// immediately (JOSM can import at once), this refreshes the HD geometry off the
// main thread, and version.json bumps when done so the viewer's poll reloads.
//
// Only one rebuild may own the derived outputs (data/*.geojson + version.json) at
// a time. A newer write op — another changeset, or a fetch/reset — SUPERSEDES an
// in-flight background rebuild: we kill it (killBgRebuild) before it can clobber
// the newer data with stale layers. Killing a CPU-bound subprocess mid-run is
// safe — SIGTERM terminates it and it simply never writes its now-stale output.
let bgChild = null;
function killBgRebuild(reason) {
  if (!bgChild) return;
  log("rebuild-bg-kill", { reason });
  try { bgChild.kill("SIGTERM"); } catch {}
  bgChild = null;
}
function bgRebuild(source) {
  killBgRebuild("superseded"); // the newest rebuild wins
  log("rebuild-bg-start", { source });
  const child = fork(join(__dir, "rebuild.mjs"), [source], { cwd: __dir });
  bgChild = child;
  child.on("message", (m) => log("rebuild-bg", m));
  child.on("exit", (code) => { if (bgChild === child) bgChild = null; log("rebuild-bg-exit", { code }); });
  child.on("error", (e) => { if (bgChild === child) bgChild = null; log("rebuild-bg-error", { msg: e.message }); });
}

// ---- OSM XML helpers ----
function loadDoc() {
  const xml = readFileSync(osmFile, "utf8");
  return new DOMParser().parseFromString(xml, "text/xml");
}
function findWay(doc, id) {
  const ways = doc.getElementsByTagName("way");
  for (let i = 0; i < ways.length; i++)
    if (ways[i].getAttribute("id") === String(id)) return ways[i];
  return null;
}
function findNode(doc, id) {
  const nodes = doc.getElementsByTagName("node");
  for (let i = 0; i < nodes.length; i++)
    if (nodes[i].getAttribute("id") === String(id)) return nodes[i];
  return null;
}
// resolve an edit key ("way:123" / "node:456"; bare number = legacy way) to its element
function findElement(doc, key) {
  const s = String(key);
  if (s.startsWith("node:")) return { el: findNode(doc, s.slice(5)), type: "node" };
  const id = s.startsWith("way:") ? s.slice(4) : s;
  return { el: findWay(doc, id), type: "way" };
}
function wayTags(way) {
  const tags = {};
  const nodes = way.getElementsByTagName("tag");
  for (let i = 0; i < nodes.length; i++)
    tags[nodes[i].getAttribute("k")] = nodes[i].getAttribute("v");
  return tags;
}
// MERGE a tag set onto an element: existing <tag>s not named in `tags` are kept;
// named ones are updated/added. An empty/null value means "leave unchanged"
// (skip) — bulk CSV cells left blank must not wipe a tag. (Full replacement is
// /api/edit + /api/changeset, which the interactive editor uses instead.)
// The tool's own GeoJSON export carries internal property names (osm_way_id,
// osm_type, base, min_level). They are NOT OSM tags, so if a CSV round-trips them
// they must never reach OSM. The client rewrites/strips them; this is the net that
// catches a hand-made CSV too.
const NON_OSM_KEYS = new Set(["osm_way_id", "osm_type", "osm_id", "base", "min_level", "height_source"]);
function mergeTags(doc, el, tags) {
  const existing = {};
  const tagEls = Array.from(el.getElementsByTagName("tag"));
  for (const t of tagEls) existing[t.getAttribute("k")] = t;
  for (const [k, v] of Object.entries(tags || {})) {
    if (k === "" || v == null || String(v).trim() === "") continue;
    if (NON_OSM_KEYS.has(k.toLowerCase())) continue; // internal, never upload
    if (existing[k]) existing[k].setAttribute("v", String(v));
    else {
      const t = doc.createElement("tag");
      t.setAttribute("k", k);
      t.setAttribute("v", String(v));
      el.appendChild(t);
    }
  }
}
// Build an Overpass poly filter body ("lat lon lat lon …") from a boundary ring
// given as [[lng,lat], …]. Every coord is Number()-validated so nothing from the
// uploaded GeoJSON is interpolated verbatim into the Overpass QL string.
function polyString(coords) {
  if (!Array.isArray(coords) || coords.length < 3)
    throw new Error("boundary needs a ring of >= 3 coords");
  const parts = [];
  for (const c of coords) {
    const lng = Number(c?.[0]), lat = Number(c?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("bad boundary coord");
    parts.push(`${lat} ${lng}`);
  }
  return parts.join(" ");
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // access log: one line per request (API calls + static), for full traceability
  const t0 = Date.now();
  res.on("finish", () => {
    // skip the noisy version.json poll (fires ~every 1.5s) to keep the log useful
    if (url.pathname === "/data/version.json") return;
    log("req", { m: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 });
  });

  // --- API: read a way's tags ---
  if (req.method === "GET" && url.pathname === "/api/way") {
    try {
      const id = url.searchParams.get("id");
      const way = findWay(loadDoc(), id);
      if (!way) return sendJSON(res, 404, { error: `way ${id} not found` });
      return sendJSON(res, 200, { id, tags: wayTags(way) });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // --- API: read a node's tags ---
  if (req.method === "GET" && url.pathname === "/api/node") {
    try {
      const id = url.searchParams.get("id");
      const node = findNode(loadDoc(), id);
      if (!node) return sendJSON(res, 404, { error: `node ${id} not found` });
      return sendJSON(res, 200, { id, tags: wayTags(node) }); // wayTags reads <tag> children — works for nodes too
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // --- API: download raw fetched data as GeoJSON (split road / building) ------
  // Returns the LAST-fetched OSM data as a GeoJSON FeatureCollection, one file
  // per kind so the two never mix:
  //   ?kind=road     -> highway ways from data/raw.osm as LineStrings (raw geom,
  //                     not the osm2streets-exploded lanes) + all their tags
  //   ?kind=building -> data/buildings.geojson (the polygonized building layer)
  // Sent as an attachment so the browser saves it straight to a .geojson file.
  if (req.method === "GET" && url.pathname === "/api/download") {
    try {
      const kind = url.searchParams.get("kind");
      let fc, filename;
      if (kind === "road") {
        const raw = join(dataDir, "raw.osm");
        if (!existsSync(raw)) return sendJSON(res, 404, { error: "no raw.osm — fetch roads first" });
        fc = roadsFromOsm(readFileSync(raw, "utf8"));
        filename = "roads.geojson";
      } else if (kind === "building") {
        const file = join(dataDir, "buildings.geojson");
        if (!existsSync(file)) return sendJSON(res, 404, { error: "no buildings.geojson — fetch buildings first" });
        const raw = JSON.parse(readFileSync(file, "utf8"));
        // Export with REAL OSM tag keys, not the tool's internal render property
        // names. The display layer needs `base`/`levels` for fill-extrusion, but a
        // download is meant to be edited and fed straight back into the bulk CSV —
        // and `base=0` / `osm_type=way` are not OSM tags, so exporting them made the
        // round-trip upload junk. `id` + `osm_type` stay as the identity columns the
        // bulk CSV reads (osm_type is the element type, never a tag).
        fc = {
          type: "FeatureCollection",
          features: (raw.features || []).map((f) => {
            const p = f.properties || {};
            const out = { id: p.osm_way_id, osm_type: p.osm_type || "way" };
            if (p.height != null) out.height = p.height;
            if (p.base) out.min_height = p.base;                       // omit a 0 base
            if (p.levels != null) out["building:levels"] = p.levels;
            if (p.min_level != null) out["building:min_level"] = p.min_level;
            if (p.building != null) out.building = p.building;
            if (p.name != null) out.name = p.name;
            // "tag" = real OSM value; "levels"/"default" = estimated by this tool.
            // Filter on this before bulk-uploading heights back to OSM.
            out.height_source = p.height_source || "unknown";
            return { ...f, properties: out };
          }),
        };
        filename = "buildings.geojson";
      } else {
        return sendJSON(res, 400, { error: "need ?kind=road|building" });
      }
      log("download", { kind, features: fc.features.length });
      const out = JSON.stringify(fc);
      res.writeHead(200, {
        "Content-Type": "application/geo+json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": Buffer.byteLength(out),
      });
      return res.end(out);
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // --- API: apply a tag edit ---
  if (req.method === "POST" && url.pathname === "/api/edit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { wayId, tags } = JSON.parse(body || "{}");
        if (!wayId || typeof tags !== "object")
          return sendJSON(res, 400, { error: "need { wayId, tags:{k:v} }" });

        const doc = loadDoc();
        const way = findWay(doc, wayId);
        if (!way) return sendJSON(res, 404, { error: `way ${wayId} not found` });

        // remove existing <tag> children
        const existing = Array.from(way.getElementsByTagName("tag"));
        existing.forEach((t) => way.removeChild(t));
        // add the submitted tag set (full replacement — the panel shows all tags)
        for (const [k, v] of Object.entries(tags)) {
          if (k === "" || v === "" || v == null) continue;
          const t = doc.createElement("tag");
          t.setAttribute("k", k);
          t.setAttribute("v", String(v));
          way.appendChild(t);
        }
        // mark modified so JOSM uploads it
        way.setAttribute("action", "modify");

        writeFileSync(osmFile, new XMLSerializer().serializeToString(doc));
        const { v, counts } = rebuild("tool-edit");
        return sendJSON(res, 200, { ok: true, version: v, counts, wayId });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: fetch OSM data for a bbox from Overpass (plan step 1) ---
  if (req.method === "POST" && url.pathname === "/api/fetch") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { bbox, force, poly, polys } = JSON.parse(body || "{}");
        // Area may be given as a viewport bbox OR one/many imported boundary rings
        // (poly = one [[lng,lat],…] ring; polys = an array of rings — e.g. every
        // feature in a boundary GeoJSON). Rings fetch strictly WITHIN the boundary.
        let ringStrs = null;
        const ringSrc = Array.isArray(polys) && polys.length ? polys : (poly ? [poly] : null);
        if (ringSrc) { try { ringStrs = ringSrc.map(polyString); } catch (e) { return sendJSON(res, 400, { error: e.message }); } }
        if (!ringStrs && (!Array.isArray(bbox) || bbox.length !== 4))
          return sendJSON(res, 400, { error: "need { bbox: [w, s, e, n] } or { polys: [[[lng,lat],…]] }" });
        // GUARD: a fetch overwrites current.osm. If it still holds un-uploaded
        // edits (action="modify"), refuse unless the client confirms (force).
        // This is exactly what silently dropped the 2 Pham Hung edits before.
        if (!force) {
          let pending = 0;
          try { pending = (readFileSync(osmFile, "utf8").match(/action="modify"/g) || []).length; }
          catch {}
          if (pending > 0) {
            log("fetch-blocked", { bbox, pendingModified: pending });
            return sendJSON(res, 409, { needsConfirm: true, pendingModified: pending });
          }
        }
        log("fetch", { bbox, polys: ringStrs ? ringStrs.length : 0, force: !!force });
        // [timeout] = explicit server-side budget; overpassFetch tries mirrors in
        // turn so one overloaded instance (504) doesn't fail the whole fetch.
        // highway-only: roads go through osm2streets. Buildings are a SEPARATE,
        // independent layer (POST /api/buildings) so a road fetch never touches
        // them and vice-versa. Rings clip to the boundary (union of all polygons);
        // bbox uses the view. (._;>;) then pulls child nodes for the whole set.
        const query = ringStrs
          ? `[timeout:180];(${ringStrs.map((s) => `way["highway"](poly:"${s}");`).join("")});(._;>;);out meta;`
          : (() => { const [w, s, e, n] = bbox; return `[timeout:60][bbox:${s},${w},${n},${e}];(way["highway"];>;);out meta;`; })();
        // boundary queries ask Overpass for [timeout:180], bbox for [timeout:60]
        const osmXml = await overpassFetch(query, ringStrs ? 190000 : 70000);
        killBgRebuild("fetch"); // a stale changeset rebuild must not clobber this area
        writeFileSync(join(dataDir, "raw.osm"), osmXml);
        writeFileSync(osmFile, osmXml);
        const { v, counts } = rebuild("overpass-fetch", { fetchedAt: Date.now() });
        return sendJSON(res, 200, { ok: true, version: v, counts });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: fetch BUILDINGS for a bbox as an independent layer ---------------
  // Buildings never go through osm2streets (we polygonize them straight from OSM
  // XML), so they are decoupled from the road pipeline: this pulls buildings only,
  // writes data/buildings.geojson, and touches NOTHING else — not current.osm, not
  // the road layers, not version.json. So you can load buildings for a view while
  // keeping the seed's road network, and a road fetch/reset won't wipe buildings.
  if (req.method === "POST" && url.pathname === "/api/buildings") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { bbox, poly, polys } = JSON.parse(body || "{}");
        let ringStrs = null;
        const ringSrc = Array.isArray(polys) && polys.length ? polys : (poly ? [poly] : null);
        if (ringSrc) { try { ringStrs = ringSrc.map(polyString); } catch (e) { return sendJSON(res, 400, { error: e.message }); } }
        if (!ringStrs && (!Array.isArray(bbox) || bbox.length !== 4))
          return sendJSON(res, 400, { error: "need { bbox: [w, s, e, n] } or { polys: [[[lng,lat],…]] }" });
        log("buildings-fetch", { bbox, polys: ringStrs ? ringStrs.length : 0 });
        // Buildings come in TWO shapes and we need both, or courtyard buildings
        // (schools/factories mapped as multipolygon relations, whose member ways are
        // untagged) render as nothing. `(._;>;)` pulls each relation's member ways
        // and their nodes so the rings can be assembled.
        // context layers: buildings + water + green land cover, in one fetch.
        const CTX = (area) =>
          `way["building"]${area};relation["building"]${area};` +
          `way["natural"="water"]${area};relation["natural"="water"]${area};` +
          `way["water"]${area};way["waterway"="riverbank"]${area};` +
          `way["landuse"~"reservoir|basin|grass|forest|meadow|village_green|cemetery|recreation_ground|orchard|farmland"]${area};` +
          `relation["landuse"~"reservoir|basin|grass|forest|meadow|cemetery|recreation_ground|orchard|farmland"]${area};` +
          `way["leisure"~"park|garden|recreation_ground|pitch|golf_course|nature_reserve"]${area};` +
          `relation["leisure"~"park|garden|recreation_ground|golf_course|nature_reserve"]${area};` +
          `way["natural"~"wood|scrub|grassland|heath"]${area};relation["natural"~"wood|scrub|grassland|heath"]${area};`;
        const query = ringStrs
          ? `[timeout:180];(${ringStrs.map((s) => CTX(`(poly:"${s}")`)).join("")});(._;>;);out;`
          : (() => {
              const [w, s, e, n] = bbox;
              return `[timeout:90][bbox:${s},${w},${n},${e}];(${CTX("")});(._;>;);out;`;
            })();
        const osmXml = await overpassFetch(query, ringStrs ? 190000 : 90000);
        const fc = buildingsFromOsm(osmXml);
        writeFileSync(join(dataDir, "buildings.geojson"), JSON.stringify(fc));
        const { water, green } = landcoverFromOsm(osmXml);
        writeFileSync(join(dataDir, "water.geojson"), JSON.stringify(water));
        writeFileSync(join(dataDir, "green.geojson"), JSON.stringify(green));
        log("buildings-fetch-done", { buildings: fc.features.length, water: water.features.length, green: green.features.length });
        return sendJSON(res, 200, { ok: true, count: fc.features.length, water: water.features.length, green: green.features.length });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: edit ONE building's inferred height/base (independent layer) ------
  // Buildings are a decoupled visual layer — they're NOT in current.osm or the
  // JOSM changeset pipeline — so a building edit just patches the matched feature
  // in data/buildings.geojson in place and rewrites it. No osm2streets rebuild,
  // no version bump: the viewer updates the source client-side and this persists
  // the change across reloads. (A later "Fetch buildings" re-pulls fresh OSM and
  // overwrites, as expected.)
  if (req.method === "POST" && url.pathname === "/api/building") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, type, height, base, props } = JSON.parse(body || "{}");
        if (id == null) return sendJSON(res, 400, { error: "need { id }" });
        const file = join(dataDir, "buildings.geojson");
        if (!existsSync(file)) return sendJSON(res, 404, { error: "no buildings.geojson" });
        const fc = JSON.parse(readFileSync(file, "utf8"));
        // match on (type, id) — ids are unique per element type, so a way and a
        // multipolygon relation can share the same number
        const wantType = String(type || "way");
        const f = fc.features.find((x) =>
          String(x.properties?.osm_way_id) === String(id) &&
          String(x.properties?.osm_type || "way") === wantType);
        if (!f) return sendJSON(res, 404, { error: `building ${wantType}/${id} not found` });
        if (Number.isFinite(height)) f.properties.height = height;
        if (Number.isFinite(base)) f.properties.base = base;
        if (props && typeof props === "object")
          for (const [k, v] of Object.entries(props)) f.properties[k] = v;
        writeFileSync(file, JSON.stringify(fc));
        log("building-edit", { id, height, base });
        return sendJSON(res, 200, { ok: true, id, height: f.properties.height, base: f.properties.base });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: BULK tag update from a CSV, by OSM id, handed to JOSM ------------
  // Instead of editing one element at a time in the viewport, the user supplies a
  // CSV of ids + tag columns. We fetch EXACTLY those elements from Overpass BY ID
  // (not a bbox), MERGE the CSV tags onto them (blank cell = leave unchanged),
  // mark them action="modify", and write a SEPARATE .osm file per kind:
  //   road     -> live/bulk-road.osm
  //   building -> live/bulk-building.osm
  // Road and building runs never share a file, so the two never conflict (and a
  // road bulk run never disturbs live/current.osm or the seed). The client then
  // opens the file in its own fresh JOSM layer to review + upload. For buildings
  // we ALSO refresh the display layer (data/buildings.geojson) so the new heights
  // show on the map immediately, consistent with the decoupled building layer.
  if (req.method === "POST" && url.pathname === "/api/bulk") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { kind, rows } = JSON.parse(body || "{}");
        if (kind !== "road" && kind !== "building")
          return sendJSON(res, 400, { error: "need { kind: 'road' | 'building' }" });
        if (!Array.isArray(rows) || !rows.length)
          return sendJSON(res, 400, { error: "need non-empty rows[]" });

        // Which OSM element a row refers to. Buildings are ways OR multipolygon
        // relations (courtyard buildings tag the relation, not its member ways);
        // roads are ways or nodes.
        const elemType = (r) => {
          const t = String(r?.type || "way").toLowerCase();
          if (kind === "building") return t === "relation" ? "relation" : "way";
          return t === "node" ? "node" : "way";
        };
        const wayIds = new Set(), nodeIds = new Set(), relIds = new Set();
        for (const r of rows) {
          const id = String(r?.id ?? "").trim();
          if (!/^\d+$/.test(id)) continue;
          const type = elemType(r);
          if (type === "node") nodeIds.add(id);
          else if (type === "relation") relIds.add(id);
          else wayIds.add(id);
        }
        if (!wayIds.size && !nodeIds.size && !relIds.size)
          return sendJSON(res, 400, { error: "no valid numeric ids in rows" });

        const parts = [];
        if (wayIds.size) parts.push(`way(id:${[...wayIds].join(",")});`);
        if (nodeIds.size) parts.push(`node(id:${[...nodeIds].join(",")});`);
        if (relIds.size) parts.push(`relation(id:${[...relIds].join(",")});`);
        // (._;>;) pulls the ways' child nodes so JOSM has full geometry; out meta
        // carries the version numbers an action="modify" upload requires.
        const query = `[timeout:120];(${parts.join("")});(._;>;);out meta;`;
        log("bulk-fetch", { kind, ways: wayIds.size, nodes: nodeIds.size });
        const osmXml = await overpassFetch(query, 130000); // query asks [timeout:120]

        const doc = new DOMParser().parseFromString(osmXml, "text/xml");
        const wayById = {}, nodeById = {}, relById = {};
        const wEls = doc.getElementsByTagName("way");
        for (let i = 0; i < wEls.length; i++) wayById[wEls[i].getAttribute("id")] = wEls[i];
        const nEls = doc.getElementsByTagName("node");
        for (let i = 0; i < nEls.length; i++) nodeById[nEls[i].getAttribute("id")] = nEls[i];
        const rEls = doc.getElementsByTagName("relation");
        for (let i = 0; i < rEls.length; i++) relById[rEls[i].getAttribute("id")] = rEls[i];

        // ---- SAFETY GUARD -----------------------------------------------------
        // OSM ids are only unique PER TYPE, so a wrong id/type (stale client, typo in
        // a CSV, way-vs-relation mix-up) resolves to a REAL but unrelated object —
        // e.g. way 13126086 is a residential road in Kansas while relation 13126086
        // is a school in Hanoi. Blindly merging tags there would silently vandalise
        // it. Refuse any element whose existing tags contradict the kind we're
        // editing, and report it instead of modifying it.
        const readElTags = (el) => {
          const t = {};
          const te = el.getElementsByTagName("tag");
          for (let i = 0; i < te.length; i++) t[te[i].getAttribute("k")] = te[i].getAttribute("v");
          return t;
        };
        const CONFLICTS_WITH_BUILDING = ["highway", "railway", "waterway", "aeroway", "natural"];
        const mismatchReason = (el) => {
          const t = readElTags(el);
          const isBuilding = (t.building && t.building !== "no") ||
            (t["building:part"] && t["building:part"] !== "no");
          if (kind === "building") {
            if (isBuilding) return null;
            const bad = CONFLICTS_WITH_BUILDING.find((k) => t[k]);
            if (bad) return `is a ${bad}=${t[bad]}, not a building`;
            return null; // untagged//plain area — allowed (you may be adding building=*)
          }
          // kind === "road": don't paste road tags onto a building
          if (isBuilding && !t.highway) return `is a building=${t.building}, not a road`;
          return null;
        };

        // Collapse rows targeting the SAME element (same type+id) into one, later
        // values winning. Without this, a CSV listing an id twice merged twice and
        // reported matched=2 for a single object, overstating what was applied.
        const byElem = new Map();
        for (const r of rows) {
          const id = String(r?.id ?? "").trim();
          if (!/^\d+$/.test(id)) continue;
          const key = `${elemType(r)}/${id}`;
          const prev = byElem.get(key);
          if (prev) prev.tags = { ...prev.tags, ...(r.tags || {}) };
          else byElem.set(key, { id, type: elemType(r), tags: { ...(r.tags || {}) } });
        }
        const dedupedRows = [...byElem.values()];

        let matched = 0; const missing = [], skipped = [];
        for (const r of dedupedRows) {
          const id = String(r?.id ?? "").trim();
          if (!/^\d+$/.test(id)) continue;
          const type = elemType(r);
          const el = type === "node" ? nodeById[id] : type === "relation" ? relById[id] : wayById[id];
          if (!el) { missing.push(id); continue; }
          const why = mismatchReason(el);
          if (why) { skipped.push({ id, type, reason: `${type} ${id} ${why}` }); continue; }
          mergeTags(doc, el, r.tags || {});
          el.setAttribute("action", "modify");
          matched++;
        }
        if (skipped.length) log("bulk-skipped", { kind, skipped });
        if (!matched)
          return sendJSON(res, 404, {
            error: skipped.length
              ? `refused: ${skipped[0].reason}` + (skipped.length > 1 ? ` (+${skipped.length - 1} more)` : "")
              : "none of the ids were found in OSM",
            missing, skipped,
          });

        const outName = kind === "road" ? "bulk-road.osm" : "bulk-building.osm";
        const serialized = new XMLSerializer().serializeToString(doc);
        writeFileSync(join(liveDir, outName), serialized);

        // buildings: also upsert the display layer so heights update on the map
        let displayUpdated = 0;
        if (kind === "building") {
          try {
            const fc = buildingsFromOsm(serialized); // heights recomputed from merged tags
            const bf = join(dataDir, "buildings.geojson");
            const cur = existsSync(bf)
              ? JSON.parse(readFileSync(bf, "utf8"))
              : { type: "FeatureCollection", features: [] };
            // key by TYPE/id — way 123 and relation 123 are different buildings
            const fkey = (f) => `${f.properties?.osm_type || "way"}/${f.properties?.osm_way_id}`;
            const idx = new Map(cur.features.map((f, i) => [fkey(f), i]));
            for (const f of fc.features) {
              const k = fkey(f);
              if (idx.has(k)) cur.features[idx.get(k)] = f;
              else { idx.set(k, cur.features.length); cur.features.push(f); }
              displayUpdated++;
            }
            writeFileSync(bf, JSON.stringify(cur));
          } catch (e) { log("bulk-building-display-fail", { msg: e.message }); }
        }

        log("bulk-done", { kind, matched, missing: missing.length, skipped: skipped.length, displayUpdated });
        return sendJSON(res, 200, {
          ok: true, kind, matched, missing, skipped,
          total: matched + missing.length + skipped.length,
          file: `/live/${outName}`, displayUpdated,
        });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: reset to the committed default area (roadmap #7) ---
  // Reloads the known-good default seed into current.osm — a reliable escape
  // hatch with NO Overpass call. Same guard as /api/fetch: refuses to discard
  // un-uploaded edits (action="modify") unless the client confirms (force).
  if (req.method === "POST" && url.pathname === "/api/reset") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { force } = JSON.parse(body || "{}");
        if (!defaultOsm) return sendJSON(res, 400, { error: "no default area committed (data/default.osm or data/raw.osm)" });
        if (!force) {
          let pending = 0;
          try { pending = (readFileSync(osmFile, "utf8").match(/action="modify"/g) || []).length; }
          catch {}
          if (pending > 0) {
            log("reset-blocked", { pendingModified: pending });
            return sendJSON(res, 409, { needsConfirm: true, pendingModified: pending });
          }
        }
        killBgRebuild("reset"); // a stale changeset rebuild must not clobber the reset
        copyFileSync(defaultOsm, osmFile);
        log("reset", { from: defaultOsm, force: !!force });
        const { v, counts } = rebuild("reset-default", { fetchedAt: Date.now() });
        return sendJSON(res, 200, { ok: true, version: v, counts });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- API: rebuild HD layers from the EXISTING current.osm (no Overpass) ---
  // Round-trips JOSM edits in server mode: after you Save current.osm from JOSM
  // (e.g. a way split), click "Reload local file" to re-render it here. Purely
  // additive — it never overwrites current.osm, so there's no un-uploaded-edit
  // guard. Runs in the background like a changeset (responds now, poll refreshes).
  if (req.method === "POST" && url.pathname === "/api/rebuild-local") {
    if (!existsSync(osmFile)) return sendJSON(res, 404, { error: "no current.osm to rebuild" });
    const pending = (() => { try { return (readFileSync(osmFile, "utf8").match(/action="modify"/g) || []).length; } catch { return 0; } })();
    log("rebuild-local", { pendingModified: pending });
    sendJSON(res, 200, { ok: true, rebuilding: true, pendingModified: pending });
    bgRebuild("reload-local");
    return;
  }

  // --- API: clear action="modify" markers (call after uploading in JOSM) ---
  // The tool marks tool-applied edits action="modify"; a JOSM upload does NOT clear
  // that (JOSM uploads from its own imported layer, never writing back here), so the
  // overwrite guard keeps nagging even after the edits are live in OSM. This lets the
  // user tell the tool "I've uploaded these" — it strips the markers so the state is
  // accurate again. Tag content is untouched, so geometry is identical → NO rebuild.
  if (req.method === "POST" && url.pathname === "/api/clear-modified") {
    if (!existsSync(osmFile)) return sendJSON(res, 404, { error: "no current.osm" });
    try {
      const doc = loadDoc();
      let cleared = 0;
      for (const tag of ["way", "node", "relation"]) {
        const els = doc.getElementsByTagName(tag);
        for (let i = 0; i < els.length; i++) {
          if (els[i].getAttribute("action") === "modify") {
            els[i].removeAttribute("action");
            cleared++;
          }
        }
      }
      if (cleared) writeFileSync(osmFile, new XMLSerializer().serializeToString(doc));
      log("clear-modified", { cleared });
      return sendJSON(res, 200, { ok: true, cleared });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // --- API: apply a batch of edits as one changeset (plan step 3) ---
  if (req.method === "POST" && url.pathname === "/api/changeset") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { edits } = JSON.parse(body || "{}");
        if (!edits || typeof edits !== "object")
          return sendJSON(res, 400, { error: "need { edits: { wayId: {k:v} } }" });

        const doc = loadDoc();
        let changed = 0;
        // keys are "way:<id>" / "node:<id>" (bare number = legacy way)
        for (const [key, tags] of Object.entries(edits)) {
          const { el } = findElement(doc, key);
          if (!el) continue;
          const existing = Array.from(el.getElementsByTagName("tag"));
          existing.forEach((t) => el.removeChild(t));
          for (const [k, v] of Object.entries(tags)) {
            if (k === "" || v === "" || v == null) continue;
            const t = doc.createElement("tag");
            t.setAttribute("k", k);
            t.setAttribute("v", String(v));
            el.appendChild(t);
          }
          el.setAttribute("action", "modify"); // JOSM uploads these
          changed++;
        }
        log("changeset", { keys: Object.keys(edits), changed });
        if (!changed) return sendJSON(res, 200, { ok: true, changed: 0 });
        writeFileSync(osmFile, new XMLSerializer().serializeToString(doc));
        // current.osm is written — JOSM can import it NOW. Respond immediately and
        // refresh the HD geometry off the main thread (version.json bumps when the
        // background rebuild finishes; the viewer's poll reloads the layers then).
        let prev = {};
        try { prev = JSON.parse(readFileSync(join(dataDir, "version.json"), "utf8")); } catch {}
        sendJSON(res, 200, { ok: true, changed, version: prev.v ?? null, rebuilding: true });
        bgRebuild("tool-changeset");
        return;
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    });
    return;
  }

  // --- static files ---
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const filePath = normalize(join(__dir, p));
  if (!filePath.startsWith(__dir)) { res.writeHead(403); return res.end("forbidden"); }
  readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
});

// deterministic startup (roadmap #7): if there's no working file yet, seed it
// from the committed default area so a fresh checkout ALWAYS boots to the same
// known-good region without any live Overpass call (Overpass is only hit on an
// explicit Fetch).
if (!existsSync(osmFile) && defaultOsm) {
  copyFileSync(defaultOsm, osmFile);
  log("seed-default", { from: defaultOsm });
}
// initial build so the viewer has data on first load
if (existsSync(osmFile)) { const { counts } = rebuild("startup"); console.log("built:", counts); }
else console.log(`no ${osmFile} and no default seed — copy data/raw.osm or Save from JOSM`);

server.listen(PORT, () => {
  console.log(`HD editor server on http://localhost:${PORT}`);
  console.log(`  editing: ${osmFile}`);
  console.log(`  edits are marked action="modify" — review + Upload from JOSM.`);
});
