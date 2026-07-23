# hdmap → mobile: research handoff

You've been handed the full source of **hdmap**, a local desktop tool that turns raw
OpenStreetMap data into a lane-level HD map you can view and tag-edit. This file is the
orientation for the question *"what would it take to make this a mobile app?"* — it maps
each piece to its mobile equivalent and flags the parts that **don't** port.

Read [`README.md`](README.md) first for what the tool actually does. This document only
covers the port.

---

## 1. What the thing is, architecturally

Two processes, talking over `http://localhost:8097`:

```
┌─ server.mjs (Node ≥18, ESM) ────────────┐        ┌─ index.html (browser) ─────────┐
│  • static file server                   │        │  MapLibre GL JS 5.24.0         │
│  • /api/* JSON endpoints                │◄──────►│  (loaded from unpkg CDN)       │
│  • Overpass HTTP fetch                  │  fetch │  all UI, styling, editing,     │
│  • build.mjs: OSM XML → GeoJSON         │        │  staging, layer toggles        │
│      via osm2streets-js (WASM)          │        │  ~3.4k lines, ONE inline       │
│  • reads/writes .osm + .geojson on disk │        │  <script>, no build step       │
└─────────────────────────────────────────┘        └────────────────────────────────┘
                     │                                            │
              live/current.osm                        JOSM Remote Control
              data/*.geojson                          127.0.0.1:8111  (desktop only)
```

There is **no build step, no framework, no bundler, no TypeScript**. `index.html` is a
single self-contained file. That's good news for a port: all the rendering logic is
readable in one place, and none of it is entangled with a framework you'd have to unpick.

**Files worth reading, in order:**

| File | Lines | Why it matters to you |
|---|---|---|
| `index.html` | ~3.4k | The entire client. Map style, layer definitions, interactions, editor UI. **This is the thing you are porting.** |
| `build.mjs` | ~500 | OSM XML → GeoJSON layers. The heavy geometry work. Calls osm2streets WASM. Also the standalone building/multipolygon parser. |
| `server.mjs` | ~1.1k | HTTP + `/api/*`. Overpass queries, file I/O, tag merging, JOSM handoff. |
| `rebuild.mjs` | ~90 | Subprocess wrapper around `build.mjs` so a rebuild doesn't block the server. |
| `README.md` | — | Behaviour, endpoints, workflows. |

---

## 2. The three things that decide the whole port

### 2.1 The renderer — this part ports well

The client uses **MapLibre GL JS**. There are first-class native ports:

- **MapLibre Native** — iOS (Swift/ObjC) and Android (Kotlin/Java)
- **`@maplibre/maplibre-react-native`** — React Native bindings over MapLibre Native
- Flutter: `maplibre_gl` (community-maintained; check its health before committing)

The map style is expressed as **plain JSON layer specs** (`fill-extrusion`, `fill`,
`line`, `symbol`) with data-driven expressions. Those specs are **portable verbatim** —
the same JSON works in MapLibre Native. That's the single biggest asset here: you can
lift the styling wholesale rather than reimplement it.

**Caveats to verify early, because they're where GL-JS and Native diverge:**

- **Expression parity.** The style leans on `match` / `coalesce` / `%` / `concat`
  expressions (e.g. per-building colour keyed off `["%", ["to-number", ["get","osm_way_id"], 0], 6]`).
  Most are supported natively, but confirm rather than assume.
- **`fill-extrusion-vertical-gradient`** and per-feature `fill-extrusion-base` — used for
  the 3-D buildings. Check support on your target MapLibre Native version.
- **Runtime `setFilter` / `setData`** are used constantly (hover, selection, staged-edit
  highlighting, live refresh). Native has equivalents but the API shape differs.
- **Turn arrows are drawn on an HTML `<canvas>`** and registered via `map.addImage()` —
  deliberately, because the sandbox blocks web fonts. On native there is no `<canvas>`;
  you'd render those glyphs to a platform bitmap (`UIImage` / `Bitmap`) and add them as
  style images, or ship them as pre-rendered PNG/SDF sprites. **Pre-baking a sprite sheet
  is probably the better answer on mobile anyway.**

### 2.2 The geometry engine — this is the real decision

`osm2streets-js` is a **Rust library compiled to WebAssembly**, and it does the expensive
part: turning centreline ways into lane polygons, intersections, and markings. Three
options, roughly in order of effort:

1. **Server-side (recommended for a first pass).** Leave the pipeline on a backend, have
   the app fetch pre-built GeoJSON or vector tiles. The mobile app becomes a *viewer +
   editor UI*, which is by far the smallest change and sidesteps every WASM question.
   This also aligns with the PostGIS/PMTiles direction already noted in the README
   roadmap.
2. **On-device native Rust.** osm2streets is Rust — it can be compiled to a real
   `.framework` / `.so` instead of WASM and called over FFI (UniFFI, cbindgen, JNI).
   More work, but it's the *right* answer if offline field editing matters.
3. **On-device WASM.** Possible (wasmtime/wasmer bindings, or a WebView) but you get the
   worst of both: FFI complexity *and* WASM overhead. Only makes sense if you're going
   WebView-hybrid anyway.

**Sizing input for the decision:** a rebuild reprocesses the *entire* loaded area, and on
a district-sized extract that takes on the order of a minute on a laptop — which is
exactly why `server.mjs` forks it into `rebuild.mjs` instead of running it inline. Assume
it is **not** something you run interactively on a phone over a large area. Tile it,
scope it small, or keep it server-side.

### 2.3 The upload path — this does NOT port

Editing works like this today: you stage tag changes in the browser, submit, and the tool
hands the result to **JOSM** (desktop Java app) over `127.0.0.1:8111` Remote Control.
**You** then press Upload in JOSM. The tool never touches the OSM API and never handles
credentials.

None of that exists on a phone. A mobile app must **talk to the OSM API directly**, which
means work that has no equivalent in this codebase:

- **OAuth 2.0** against openstreetmap.org, with secure token storage (Keychain /
  Keystore).
- **Changeset lifecycle** — open, upload a diff, close; handle version conflicts and
  `409`s (someone else edited the element since you fetched it).
- **Editor responsibility.** JOSM's validator is currently the safety net between this
  tool and OSM. Remove JOSM and you inherit that responsibility: validation, conflict
  resolution, sane changeset comments and `source`, and honouring the
  [automated-edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_edits_code_of_conduct).
  Look hard at how **StreetComplete** and **Vespucci** (both Android, both open source)
  handle this before designing your own.

Treat this as the largest single item of new work in the port. It is a bigger job than
the rendering.

---

## 3. Porting strategies, ranked

| # | Approach | Effort | What you get |
|---|---|---|---|
| **A** | **Server + thin native client.** Keep `server.mjs`/`build.mjs` on a host; app = MapLibre Native + a native editor UI over the same `/api/*` contract. | Medium | Real native feel, small client. Needs connectivity. **Best first target.** |
| **B** | **WebView wrapper.** Ship `index.html` in a WKWebView/WebView pointed at a hosted backend. | Low | Working demo in days. Poor touch ergonomics — the UI is mouse-first (hover states, a dense side panel, double-click-to-copy). A demo, not a product. |
| **C** | **Fully offline native.** osm2streets via Rust FFI, local extract or PMTiles, direct OSM API sync. | High | Field-survey capable. The real product, eventually. |

A pragmatic path is **A now, C later** — the `/api/*` boundary is already a clean seam,
so a client written against it survives the backend being swapped from Node+Overpass to
PostGIS or to on-device Rust.

---

## 4. UI that has to be redesigned, not ported

The current interface assumes a mouse, a keyboard and a big screen. Specifically:

- **Hover highlighting** (blue on hover, yellow on select) — no hover on touch. Needs
  tap-to-select plus something else for preview.
- **The side panel** carries three tabs, a tag table, a visual lane editor, a boundary
  list and a CSV loader. On a phone that becomes bottom sheets / a modal stack.
- **Double-click to copy a coordinate** — remap to long-press.
- **Precise small-target clicking** on individual lane polygons — needs bigger hit
  targets, or a tap-then-disambiguate list when several features are under the finger.
- **The visual lane editor** (click a lane cell to cycle its turn arrows) is actually the
  most touch-friendly thing in the tool and is a good starting point for a mobile-first
  editing surface.
- **CSV bulk editing** is a desktop workflow. Don't port it; it belongs on the backend.

---

## 5. Data & network realities to plan for

- **Overpass is a public, rate-limited, frequently overloaded API.** The tool already
  falls back across four mirrors and *still* sees 504s. **Do not point a mobile app at
  Overpass** for anything but development — you need your own tile/data backend.
- **Payload sizes are big.** A district-sized fetch produces GeoJSON in the tens of
  megabytes (`markings.geojson` alone can exceed 20 MB). Raw GeoJSON over mobile data is
  not viable — this is why the README recommends `tippecanoe` → **PMTiles** and pointing
  MapLibre at vector tiles. For mobile, treat that as **mandatory, not optional**.
- **MapLibre JS is loaded from unpkg at runtime.** Native builds bundle the library
  instead, so this dependency simply disappears — but note it if you go the WebView route
  (offline = broken map).
- **Basemap licensing.** The picker offers several free backdrops, but only **Esri World
  Imagery** is licensed as a *tracing source* for OSM. Whatever you ship must preserve
  that distinction and its attribution requirements.
- **Heights are mostly estimates.** Buildings without a `height`/`building:levels` tag get
  a flat 6 m default; each feature carries a `height_source` field
  (`tag` / `levels` / `default`) recording which. On a typical fetch the overwhelming
  majority are `default`. Don't present guesses as survey data, and don't bulk-upload them.

---

## 6. Try it before you port it

```bash
cd hdmap
npm install        # osm2streets-js (WASM) + @xmldom/xmldom
./restart.sh       # starts detached, waits for readiness
# open http://localhost:8097/
```

`./restart.sh {start|stop|status|logs}` for the rest. Node ≥ 18 required. It boots to a
fixed default area from the committed `data/default.osm` seed, so it works **with no
network call** — you don't need Overpass or JOSM to see the map and click around.

For the editing flows you'd additionally need JOSM running with Remote Control enabled,
but for evaluating the *rendering*, the default seed is enough.

### What is NOT in this zip

`node_modules/` (run `npm install`), the git history, session logs, the `.env` file
(secrets — deliberately excluded), and the generated `data/*.geojson` + `live/*.osm`
working files, which the server rebuilds from the seed on first start. The one data file
included is `data/default.osm`, the committed default-area seed.

---

## 7. Short answer to "how hard is this?"

- **The map rendering ports well** — the style JSON is portable and MapLibre Native is a
  genuine equivalent. Budget the time for expression/feature parity checks and for
  replacing the canvas-drawn turn arrows with sprites.
- **The geometry engine is a fork in the road** — keep it server-side and it's nearly
  free; move it on-device and it's a Rust FFI project of its own.
- **The upload path is net-new work** — OAuth, changesets, conflict handling, validation,
  all of which JOSM does for the tool today. This is the biggest and riskiest chunk, and
  it's where the existing code helps you least.
- **The UI needs redesign, not translation.** It is mouse-first by construction.

Start with the seeded local run to see what the tool actually renders, then decide
between strategy **A** and **C** — because that choice determines everything else.
