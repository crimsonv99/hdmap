// Zero-dependency static file server for the 3D City Map MVP.
//   node serve.mjs           -> http://localhost:8100
//   node serve.mjs 9000      -> http://localhost:9000
// A server is required (not just opening index.html): the page fetches the
// GeoJSON layers from ./data, and browsers block fetch() over file://.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8100;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".pbf": "application/x-protobuf",
};

const server = createServer(async (req, res) => {
  try {
    // strip query string, prevent path traversal, default to index.html
    let path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/") path = "/index.html";
    const abs = normalize(join(ROOT, path));
    if (!abs.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }

    const s = await stat(abs).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end("not found"); return; }

    const ext = extname(abs);
    const type = MIME[ext] || "application/octet-stream";
    const full = await readFile(abs);

    // Vector tiles (.pbf) are stored UNcompressed so they render on any static
    // host (incl. GitHub Pages) with no special headers — MapLibre reads raw MVT
    // directly, and errors on gzipped tiles unless the server sets Content-Encoding
    // (which Pages can't do for .pbf). Keeping them raw makes local == cloud.

    // HTTP Range support — REQUIRED for PMTiles, which fetches byte ranges out of
    // the .pmtiles archive rather than downloading the whole file.
    const range = req.headers.range;
    const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      let start = m[1] === "" ? s.size - Number(m[2]) : Number(m[1]);
      let end = m[2] === "" ? s.size - 1 : Number(m[2]);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= s.size) {
        res.writeHead(416, { "content-range": `bytes */${s.size}` }).end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${s.size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "cache-control": "no-cache",
      });
      res.end(full.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-length": s.size,
      "cache-control": "no-cache",
    });
    res.end(full);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`3D City Map MVP  ->  http://localhost:${PORT}`);
  console.log(`serving ${ROOT}`);
});
