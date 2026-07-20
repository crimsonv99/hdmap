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
import { initEngine } from "./build.mjs";
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
async function overpassFetch(query) {
  let lastErr = "no endpoints";
  for (const ep of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 50000); // don't hang on a dead mirror
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
        const { bbox, force } = JSON.parse(body || "{}");
        if (!Array.isArray(bbox) || bbox.length !== 4)
          return sendJSON(res, 400, { error: "need { bbox: [w, s, e, n] }" });
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
        log("fetch", { bbox, force: !!force });
        const [w, s, e, n] = bbox;
        // [timeout:60] = explicit server-side budget; overpassFetch tries mirrors
        // in turn so one overloaded instance (504) doesn't fail the whole fetch.
        // buildings included for 3D context extrusions (build.mjs polygonizes them)
        const query = `[timeout:60][bbox:${s},${w},${n},${e}];(way["highway"];way["building"];>;);out meta;`;
        const osmXml = await overpassFetch(query);
        killBgRebuild("fetch"); // a stale changeset rebuild must not clobber this area
        writeFileSync(join(dataDir, "raw.osm"), osmXml);
        writeFileSync(osmFile, osmXml);
        const { v, counts } = rebuild("overpass-fetch", { fetchedAt: Date.now() });
        return sendJSON(res, 200, { ok: true, version: v, counts });
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
