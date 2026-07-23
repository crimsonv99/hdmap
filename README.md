# hdmap — HD road-network webmap & lane-tag editor from OSM

Turn plain OpenStreetMap centerlines into a **lane-level HD map** you can look at,
edit, and push back to OSM — safely, through JOSM.

```
OSM (Overpass)  →  osm2streets (WASM)  →  GeoJSON  →  MapLibre GL JS
```

It fetches raw OSM for a small area, runs the **osm2streets** geometry engine
(the same library behind https://a-b-street.github.io/osm2streets) to expand each
centerline `way` into lane polygons, intersections, and road markings, and renders
them as an HD basemap. You can then click a road, edit its lane tags, stage the
change, and hand a reviewed changeset to JOSM for upload.

Default area: a patch of Hanoi around `21.036860, 105.780890`.

Beyond the road pipeline it also fetches **buildings** as 3-D context (an independent
layer you can height-edit), and has a **Batch** tab for working at scale — fetch inside
an imported boundary, bulk-apply tags from a CSV to JOSM, and export the raw fetched
data as GeoJSON. See **§6**.

> **Scope: local single-user tool.** hdmap is a personal companion to JOSM. It keeps
> all state in one `live/current.osm` file and talks to JOSM over `127.0.0.1`, so it
> is meant to be run **locally by one editor at a time**. It is *not* designed to be
> deployed on a shared server for concurrent multi-user editing — several people
> hitting one instance would fetch/rebuild over each other's `current.osm`.

---

## 1. How it works (the logic)

The whole tool is built on **one function**, `osmToLayers(osmXml)` in
[`build.mjs`](build.mjs). Every entry point (generate / watch / server) feeds it OSM
XML and gets back the same set of HD layers:

```
             ┌──────────────────────────── build.mjs ────────────────────────────┐
 OSM XML ──► │  new JsStreetNetwork(xml, IMPORT_OPTIONS)   (osm2streets WASM)      │
             │      │                                                              │
             │      ├─ toLanePolygonsGeojson()      → lanes.geojson                │
             │      ├─ toLaneMarkingsGeojson()      → markings (centre lines, …)   │
             │      ├─ toIntersectionMarkingsGeojson()                             │
             │      └─ toGeojsonPlain()             → intersection polygons        │
             │                                                                      │
             │  post-processing we add on top of osm2streets:                       │
             │   • drop centre lines on one-way roads (they'd sit at the kerb)      │
             │   • generate ONE directional turn arrow per lane (↑ ↰ ↱)            │
             │     from each lane's `allowed_turns`, placed at the downstream end   │
             └──────────────────────────────────────────────────────────────────┘
                          │ lanes / markings / intersections / turn_arrows (GeoJSON)
                          ▼
                    data/*.geojson  +  version.json (change stamp)
                          │
                          ▼
                index.html  — MapLibre GL renders the layers, handles clicks/edits
```

Key pieces of logic:

- **Lane expansion** is osm2streets' job: it reads `lanes`, `oneway`, `turn:lanes`,
  `width`, sidewalk/kerb tags, etc., infers what it isn't told, and outputs real
  polygons + `allowed_turns` per lane. `override_driving_side: "right"` is set for
  Vietnam. Widths are **inferred** where OSM doesn't tag them (see Notes).
- **Road width & paint by highway class.** Out of the box osm2streets barely
  differentiates classes — it **ignores the `width` tag** entirely, its only width
  lever is the `lanes` *count* (3 m per driving lane, 2 m on a `service` road), and
  its only built-in class rule is *service = 2 m vs everything-else = 3 m* — so an
  untagged residential, tertiary, secondary and primary all render at an identical
  6 m. To give roads a width that reads by class, `prepareRoads()` in
  [`build.mjs`](build.mjs) injects a default `lanes` count per class into an
  **in-memory** copy of the OSM *before* osm2streets runs (`LANES_BY_CLASS`:
  secondary/primary → 4 = 12 m, trunk/motorway → 6 = 18 m; service/residential/
  tertiary keep the 2-lane default). Two hard rules: **even counts only** (an odd
  count makes osm2streets split the carriageway asymmetrically, so the centre line
  lands off-centre), and **only widen the genuinely-wide classes** — injecting a
  two-way multi-lane default onto an untagged segment of a road that's really a
  *one-way dual carriageway* (common for city arterials) would invent a back lane,
  a yellow centre line and a width bulge. A way that **already tags** `lanes` /
  `oneway` / `lanes:forward|backward` is never touched, so surveyed data always
  wins. The injection is memory-only — it **never** reaches `live/current.osm`, so
  it can't pollute real OSM data or a JOSM upload; it's a rendering-inference layer,
  same honesty as inferred widths and building heights.
- **Bare-asphalt classes.** Small access roads (`NO_LANE_LINE_CLASSES` = `service`,
  `track`) render with **no painted markings at all** — centre line, lane separators
  *and* turn arrows inside them are dropped (they have no road paint in reality).
  Since osm2streets' markings carry no back-reference to their road, each marking's
  class is resolved by point-in-polygon against the road polygons (reusing the same
  bbox-precomputed machinery as the one-way centre-line filter). Add a class to that
  one set to strip all three kinds of paint from it at once.
- **Turn arrows are ours, not osm2streets'.** osm2streets v0.1.4 only paints
  *straight* arrows. So we drop those and, per driving lane, emit a single arrow
  near the intersection end (the marking farthest downstream along the lane's
  travel bearing), pick its glyph from `allowed_turns` (`through`/`left`/`right`
  and combos), and rotate it to the lane bearing. Rendered on a `<canvas>` via
  `map.addImage` — **no web fonts** (the sandbox blocks external glyph URLs).
- **Elevation bands.** Features are drawn in two passes by the OSM `layer` tag
  (absent ⇒ `0`): everything at `layer < 1` first, then `layer ≥ 1` on top. So a
  bridge/overpass (`layer=1`) fully covers the road *and its markings* beneath it,
  and tunnels (`layer=-1`) sit under grade — matching reality at interchanges.
- **Lane edges & overlaps.** Each road gets a dark **casing** drawn *under* its
  (opaque) lane fills, so only the road's two **outer** edges show — a neighbouring
  lane's fill hides the shared internal edge, so there's no busy dark line between
  every lane (lane divisions come from the dashed separator markings). The casing is
  **thicker for elevated roads** (`layer ≥ 1`), so a bridge lifts off what's beneath.
  Opaque fills also mean that where osm2streets emits overlapping lane polygons
  (forks / dual carriageways), the top road **cleanly covers** the one beneath instead
  of blending into a murky band. Drag **HD opacity** down to make fills translucent
  for tracing.
- **One continuous surface (edges first, fills last).** The style draws **all
  casings** (`inter-edge`, `lanes-edge`) before **all asphalt fills** (`intersections`,
  `lanes`, markings…). MapLibre centres a line on its polygon boundary, so half of a
  road's casing spills *outside* the road; drawing fills afterwards lets them swallow
  every internal seam — road↔road *and* road↔junction — leaving only the true **outer
  perimeter** dark. Junction asphalt also matches the driving-lane colour (`#5b6270`)
  and the kerb matches the road casing (`#1a1e25`, same ground width), so roads and
  intersections **fuse into one surface** instead of leaving a darker blob at every
  fork. Signalled junctions keep a warm accent (also flagged by the traffic-light
  icon); dead-end `Terminus` caps barely recede. Elevated roads render as a second
  edges-then-fills pass on top so bridges still cover what's beneath.
- **Live change stamp.** Every rebuild writes `data/version.json` with a new `v`.
  The viewer polls it and re-renders via `setData()` when `v` changes — so the map
  updates without a page reload and without losing your pan/zoom.

---

## 2. Setup

**Requirements**
- **Node ≥ 18** — the backend uses global `fetch`, `AbortController`, and top-level
  `await` (ESM; `package.json` has `"type": "module"`). Older Node will fail at startup.
- **A modern browser** (the viewer uses MapLibre GL 5 / WebGL).
- **JOSM** — only for the editing flows (§4/§5), see the note below.

```bash
cd hdmap
npm install          # installs osm2streets-js (the WASM engine) + @xmldom/xmldom
```

> Everything must be served over `http://` — opening `index.html` as a `file://`
> URL fails because the browser can't `fetch()` the local GeoJSON.

There are **three entry points**; pick the one that matches what you want to do.

| Entry point       | Use it to…                                                        |
|-------------------|-------------------------------------------------------------------|
| `generate.mjs`    | one-shot: fetch a bbox from Overpass and write the GeoJSON, done   |
| `watch.mjs`       | **preview mode**: JOSM is the editor, the tool just re-renders     |
| `server.mjs`      | **editor mode**: the tool is the editor, it hands edits to JOSM    |

> Run **either** `watch.mjs` **or** `server.mjs` against `current.osm`, not both —
> they'd fight over the same file.

### Starting / restarting the tool: `./restart.sh`

For the normal editor mode you don't need to remember any of the above — there's a
one-command helper:

```bash
cd hdmap
./restart.sh            # stop if running, then start  ← the usual one
./restart.sh start      # start only
./restart.sh stop       # stop it
./restart.sh status     # is it up? shows pid + URL
./restart.sh logs       # tail the live log
PORT=9000 ./restart.sh  # use a different port (default 8097)
```

It frees the port properly (`SIGTERM` first so the server writes a clean `session-end`,
force-kill only if it hangs — this is what prevents the `EADDRINUSE` failures), starts the
server **detached** so it survives closing the terminal, waits for the first real `200`
(startup runs an osm2streets rebuild, so it takes a few seconds) instead of a blind sleep,
and prints the last log lines if boot fails. It also checks for Node ≥ 18 and runs
`npm install` if `node_modules` is missing. Stdout goes to `logs/server-stdout.log`.

> It survives closing the terminal, but **not a machine reboot** — just run
> `./restart.sh` again after one.

**JOSM** (external, for the editing flows) must be installed and running with
**Remote Control enabled** (Edit → Preferences → Remote Control → *Enable remote
control*) — that's how the tool hands edits to JOSM over `127.0.0.1:8111` for review and
upload. It's not needed for the read-only *Quick look* (§3).

---

## 3. Quick look (no editing)

```bash
node generate.mjs                                  # default Hanoi bbox
#   or a custom bbox:  node generate.mjs <south> <west> <north> <east>
python3 -m http.server 8097                        # any static server works
# open http://localhost:8097/index.html
```

Viewer aids:
- **Go to a coordinate** (Google-Maps style): paste `lat, lng` into the box at the
  top of the panel (comma- or space-separated, OSM/Google order — e.g.
  `21.036860, 105.780890`) and press **Go** / Enter. The map flies there at z18 and
  drops a pin. (The tool only holds roads for the area you've fetched, so jumping
  outside it shows empty land — then click **Fetch OSM data (this view)** to load
  roads there.)
- **Click** a lane → its OSM tags (type, direction, inferred width, way id).
  **Click an intersection** → edits its OSM node's tags (e.g. `highway=traffic_signals`).
- **Intersections.** Real junctions get a **kerb edge** and are **tinted by traffic
  control** (signalised ones stand out warm and show a **🚦 traffic-light marker**);
  dead-end `Terminus` caps barely recede. `Connection` nodes (a road split for a tag
  change) are **filled with road asphalt but get no kerb** — their little polygon sits
  between the two road halves, so it closes the carriageway seamlessly (hiding it left a
  background-coloured gap). Only `MapEdge` data-boundary caps stay hidden.
  (Data comes from each junction's osm2streets `control` / `intersection_kind`.)
- Toggle Lanes / Intersections / Markings / Turn lanes in the panel.
- **Basemap picker** (the **▤** button, bottom-right). A list of free backdrops you can
  switch between without a style reload — *None*, **Esri World Imagery** (satellite),
  OSM Carto, OpenTopoMap, Carto Positron, Carto Dark Matter, Esri Topographic. The choice
  is remembered (`localStorage`). Only entries marked **traceable** in the list may be
  used as a **source for tracing new geometry** into OSM — of the ones offered that's
  **Esri World Imagery** only; the OSM-rendered and topo layers are *renderings*, not
  imagery, and copying from them is not permitted.
- **HD opacity** slider, always visible at the **bottom centre**. Fades the lane
  polygons *and* the 3-D buildings (with a live `%` readout) so you can trace real
  painted lines off the imagery underneath.
- **Empty ground** renders as a soft grass/land tone (not black) so roads, markings, and
  turn tints read like a real terrain map.
- **Minimize the panel.** The **⌃** button in the panel header collapses the whole tool
  to a single title row, handing the map the full screen; **⌄** restores it. Nothing is
  unmounted — staged edits, the active tab, and scroll position all survive — and the
  state is remembered across reloads.
- **Hover = blue, select = yellow** — light tint + outline so lane/marking/arrow
  detail underneath stays visible. Highlight covers every lane of the clicked way
  (including ways osm2streets has fused into a single road — see Notes).
- **Per-lane turn arrows** (↑ through / ↰ left / ↱ right, incl. combos) sit near
  each lane's intersection end; lanes are also tinted (teal = left, orange = right)
  for a quick read. Arrows **scale with zoom** and hide below z15 so they don't
  dwarf the map when zoomed out.
- A **lane-tag validator** runs live in the editor panel (non-blocking): flags
  `turn:lanes` count ≠ `lanes`, `oneway=yes` with `lanes:backward`,
  `lanes:forward + lanes:backward ≠ lanes`, unknown turn tokens, non-numeric width.
- **Double-click to copy a coordinate.** Double-click anywhere on the map to copy the
  point under the cursor to the clipboard as `lat, lng` (same order/precision the **Go**
  box accepts), with a small toast to confirm. Default double-click-zoom is disabled so
  the double-click is a pure copy.

---

## 4. Live preview from JOSM (`watch.mjs`)

Edit lane tags **in JOSM** and watch the HD map re-render in ~1 second. JOSM is the
editor; the tool is a read-only previewer.

```
JOSM (edit → Cmd+S)  →  live/current.osm  ──watch──►  watch.mjs (osm2streets)
                                                           │ writes data/*.geojson + version.json
                                     browser polls version ◄┘  → setData() re-render (view preserved)
```

```bash
node watch.mjs                     # watches live/current.osm
python3 -m http.server 8097        # serve the viewer
# open http://localhost:8097/index.html
```

In JOSM: **File → Save As** → `hdmap/live/current.osm` (once). After that, every
**Cmd+S** re-runs osm2streets and the viewer refreshes automatically — the green
"live sync" dot in the panel shows the last update time.

Notes:
- JOSM Remote Control can only *receive* load/zoom commands; it can't export the
  edit layer. So the refresh trigger is JOSM's **Save**, not a live socket.
- Change detection is a content hash, so same-length edits (`lanes=2`→`6`) are caught.
- The watcher tolerates half-written saves and parse errors (logs and waits).

---

## 5. Editing workflow (`server.mjs`) — the main flow

`server.mjs` turns the viewer into a **changeset-based lane-tag editor**. You edit in
the browser; the tool never talks to the OSM API — the actual upload is done by *you*
in JOSM. The core loop is four steps (plus an optional **Step 5 — Mark uploaded**
cleanup, below). **JOSM must be running with Remote Control enabled** for the Submit and
Split handoffs — the tool probes for it and warns if it's off (see Step 3).

```
 ┌── 1. FETCH ──────────┐   ┌── 2. STAGE ─────────┐   ┌── 3. SUBMIT ──────────┐   ┌── 4. UPLOAD ─────────┐
 │ "Fetch OSM data       │   │ click a way →        │   │ "Submit changeset(N)"│   │ JOSM opens a fresh   │
 │  (this view)"         │   │ edit tags →          │   │ → POST /api/changeset│   │ layer via Remote     │
 │ → POST /api/fetch     │   │ "Stage edit"         │   │ writes current.osm   │   │ Control /import      │
 │ Overpass → current.osm│   │ (held in browser,    │   │ (action="modify"),   │   │ → you Validate &     │
 │ → rebuild HD layers   │   │  way tinted MAGENTA) │   │ → instant; bg rebuild│   │ Upload to OSM        │
 └───────────────────────┘   └──────────────────────┘   └──────────────────────┘   └──────────────────────┘
```

```bash
./restart.sh            # recommended — see §2 (stop/start/status/logs, waits for readiness)
#   or directly:
node server.mjs         # viewer + /api/{way,node,fetch,buildings,building,bulk,download,
                        #                reset,rebuild-local,clear-modified,changeset}
# open http://localhost:8097/   (PORT env overrides the default 8097)
```

**Deterministic startup.** The tool always **boots to a fixed area/view** — the Pham
Hung interchange (`21.036860, 105.780890`, z16.5) — served from a committed default seed
(`data/default.osm`), so a fresh checkout opens the same known-good map **without any
live Overpass call**. Overpass is only hit when *you* click Fetch. On startup `server.mjs`
seeds `live/current.osm` from the default if it's missing; **⌂ Reset to default area**
reloads that seed at any time (a reliable escape hatch, e.g. after a bad fetch). *(If
you've fetched a different region, the boot view auto-frames that data instead of the
fixed center.)*

**Step 1 — Fetch.** Pan/zoom to your area, click **"Fetch OSM data (this view)"**.
The button grabs the map's current bbox and `POST /api/fetch`; the backend pulls it
from Overpass, writes `live/current.osm`, and rebuilds the HD layers.
**Endpoint fallback:** the public `overpass-api.de` is frequently overloaded and
returns `504` even for a tiny area, so the fetch tries a **list of mirrors in order**
(`overpass-api.de` → `lz4.overpass-api.de` → `maps.mail.ru` → `kumi.systems`) until one
answers — a single busy instance no longer fails the fetch. Re-order or replace the
list with the `OVERPASS_ENDPOINTS` env var (comma/space separated). If *all* mirrors are
down, use **⌂ Reset to default area** to get back to the bundled map with no network call.
The panel shows **how old the fetched data is** ("data fetched 14m ago") and nudges a
re-fetch once it's stale — a heads-up before you edit against outdated data.
**Overwrite guard:** a fetch replaces `current.osm`. If you have staged edits (browser)
or tool-applied edits still marked `action="modify"` in the file, the tool **asks before
discarding them** — the server refuses an unforced fetch with `409 {needsConfirm}` when
`current.osm` still carries those markers, and the viewer confirms before retrying.
Note the tool **can't tell whether you've already uploaded** those edits in JOSM: a JOSM
upload happens from its own imported layer and never clears the `action="modify"` marker
here, so the confirmation spells out both cases (already uploaded → safe to overwrite;
not uploaded → they're lost) rather than claiming they're un-uploaded.

**Step 2 — Stage.** Click a **way** (→ *Edit lane tags*) or an **intersection** (→
*Edit node tags*, for `highway=traffic_signals` etc.). Edit values, then press
**"Stage edit"**. Two ways to add a tag:
- **Quick-add chips** for the common keys — lanes / `lanes:forward|:backward` / `oneway`
  / `turn:lanes(:forward|:backward)`, plus `name`, `maxspeed`, `surface`, and
  vehicle-kind access (`access`, `motor_vehicle`, `motorcycle`, `moped`, `bicycle`,
  `foot`, `hgv`, `bus`). A chip drops in that key and focuses its value.
- **+ add tag (any key)** — appends a blank row so you can type **any** OSM key/value by
  hand (anything the chips don't cover).

The change is held **in the browser**
(`pendingEdits`, keyed `way:<id>` / `node:<id>`) and the element is tinted **magenta**
— nothing hits the backend yet, so geometry doesn't reshape until you submit. Stage as
many as you want. Each staged edit appears as a **removable row** under the submit
button (element id + what changed) with an `✕` to discard it individually — no page
refresh needed.

*Visual lane editor.* For ways, the editor has a collapsible **Visual lane editor** that
turns the raw lane tags into a **diagram** — one cell per lane, grouped by direction,
each drawn with its turn arrows (↑ through / ↰ left / ↱ right). **Click a lane to cycle
its turns** (shift-click to cycle back), use **−/+** to add or remove lanes per
direction, and the **one-way** checkbox to switch between one-way and two-way. Every
change writes standard OSM tags straight back into the rows above —
`lanes`, `lanes:forward|:backward`, `oneway`, `turn:lanes(:forward|:backward)` — kept
consistent (e.g. `lanes` = forward + backward) and re-validated live. It's a *front-end
to the tags*, not a geometry editor: osm2streets is one-directional (tags → geometry),
so the diagram builds tags; the geometry reshapes when you submit. The binding is
two-way: **hand-edit a raw tag row and the diagram auto-syncs** to match (debounced,
while the panel is open — it only redraws the diagram, never rewrites the row you're
typing in). The **⟲ rebuild from tags** button does the same *and* normalizes the rows
(e.g. recomputes `lanes` = forward + backward).

**Step 3 — Submit.** Press **"Submit changeset (N)"**. All staged edits go in one
`POST /api/changeset`; the backend replaces each way's tags, marks them
`action="modify"`, and writes `live/current.osm`. It then **responds immediately**
(Submit and the JOSM handoff are instant) and refreshes the HD geometry in the
**background**: the osm2streets rebuild reprocesses the *whole* network (~a minute on
a big area) and would freeze this single-threaded server if run inline, so it runs in a
**separate process** ([`rebuild.mjs`](rebuild.mjs)). When it finishes it bumps
`version.json`, and the viewer's live-sync poll reloads the layers — so the map catches
up on its own a moment later while you're already reviewing in JOSM. *(Fetch and Reset
still rebuild inline, because there's nothing to show until their new data is built.)*

*No file corruption from overlapping writes:* the server is single-threaded, so the
actual writes to `current.osm` (a changeset apply, a fetch, a reset) never interleave —
each runs to completion on the event loop before the next request is handled. The only
concurrent worker is the background rebuild *reader* (`rebuild.mjs`), and if a newer
write arrives while it's running, the server **kills that stale rebuild**
(`killBgRebuild`) *before* touching `current.osm`, then rebuilds from the new data — the
newest write always wins and a stale rebuild can never clobber it. (This is a
kill-on-supersede design, not a request lock: fetch/submit are never blocked or
rejected for being "busy".)

> **JOSM must be open with Remote Control enabled.** The handoff below talks to JOSM
> over `127.0.0.1:8111`, so before applying the changeset Submit **probes JOSM's
> `/version` endpoint**. If JOSM isn't running (or Remote Control is off) it warns —
> *"JOSM isn't reachable…"* — and lets you either cancel (edits stay staged, so you can
> open JOSM and Submit again) or submit anyway (edits are written to `live/current.osm`;
> open that file in JOSM via **File → Open** afterwards). Enable it once in JOSM under
> **Edit → Preferences → Remote Control → "Enable remote control"**. The **✂ Split**
> handoff runs the same check.

**Step 4 — Upload via JOSM.** On success the browser fires JOSM Remote Control:

```
http://127.0.0.1:8111/import?new_layer=true&layer_name=hdmap edit <time>&url=<origin>/live/current.osm
```

`new_layer=true` is important: JOSM's `/import` **always merges** into the active
layer, so without it, repeated submits pile up phantom `modified` ways in one shared
layer and you could upload edits you never made. With it, **each submit opens a fresh,
isolated layer** (named `hdmap edit <time>`) containing only that submission's edits.
In JOSM: pick the newest `hdmap edit …` layer → **Validate** → **File → Upload Data**
with a clear changeset comment + source. **That upload is the only step that touches
OpenStreetMap, and you do it.**

**Step 5 — Mark uploaded (optional).** After a successful JOSM upload, press
**✓ Mark uploaded**. A JOSM upload happens from its own imported layer and never clears
the `action="modify"` markers back in `current.osm`, so the fetch/reset overwrite guard
would keep warning about edits that are already live in OSM. This button
(`POST /api/clear-modified`) strips those markers so the state is accurate again — it
uploads nothing and doesn't change your tags. (Skipping it is harmless: the next fetch
overwrites `current.osm` anyway; the guard just double-checks with you first.)

> If you ran several submits before this fix, one shared JOSM layer may still hold
> stale modifications. Delete that layer and `File → Open` `live/current.osm` fresh
> once, so only the intended ways show as `modified` before you upload.

### Seeding `current.osm`
`server.mjs` fetches for you (Step 1), but you can also seed it manually: copy
`data/raw.osm`, or **Save As** from JOSM. It must contain OSM `version=` attributes
(Overpass `out meta` and JOSM saves both include them) so JOSM can upload the edits.

### Round-tripping JOSM edits: ↻ Reload local file
If you edit `live/current.osm` **outside the tool** — most commonly a **way split** in
JOSM (the ✂ button), then **Save** over `current.osm` — click **↻ Reload local file**
to re-render it (`POST /api/rebuild-local`). This rebuilds the HD layers from the file
as-is, **without** calling Overpass, so it can't overwrite your local edit the way a
Fetch would. It's non-destructive (never rewrites `current.osm`) and rebuilds in the
background like a submit. (In `server.mjs` mode this is the manual equivalent of what
`watch.mjs` does automatically — but you can't run both against the same file.)

---

## 6. Buildings & batch tools

Beyond the road pipeline, the panel has two more tabs — **Building** and **Batch** —
for 3-D context and for working over many features at once.

### Building tab — 3-D context extrusions

Fetch nearby **buildings** as an independent 3-D layer for spatial context while you
edit roads. Buildings are **decoupled** from the osm2streets / JOSM road pipeline: they
live only in `data/buildings.geojson`, never in `current.osm` or a changeset — so a
building edit never reshapes roads and never lands in a road changeset.

- **⤓ Fetch buildings (this view)** pulls **both** `way["building"]` and
  `relation["building"]` for the map bbox (`POST /api/buildings`) and polygonizes them.
  Heights are **inferred** in `buildingsFromOsm` — `height` tag →
  `building:levels × 3 m` (`LEVEL_M`) → `6 m` default (`DEFAULT_HEIGHT_M`) — so the
  extrusions read as HD but are estimates, not survey. A **base** is also read
  (`min_height` → `building:min_level × 3 m` → `0`) and drives `fill-extrusion-base`, so
  a raised/stacked part sits at the right elevation. Turn on **3-D view** (the tilt
  toggle) to see them rise.
- **Multipolygon relations are supported.** A building mapped as a
  `type=multipolygon` / `type=building` **relation** — the usual case for a courtyard
  block, or any building whose tags live on the relation and not on its member ways —
  is assembled properly: member ways are **chained end-to-end by shared node** into
  closed rings (handles reversed and out-of-order segments), `inner` rings are assigned
  to the `outer` that contains them (ray-casting) and become real **holes**, and a
  relation with several outers becomes a `MultiPolygon`. Member ways consumed by a
  relation are **not drawn again** on their own, so nothing double-renders.
- **Every feature carries its `osm_type`.** OSM ids are only unique *per element type* —
  way `123` and relation `123` are different objects — so each building records whether
  it is a `way` or a `relation`, and selection, editing, staging, and bulk all match on
  the **(type, id)** pair. This is what stops an edit meant for a building relation from
  landing on an unrelated way (see the safety guard under Batch).
- **`height_source` provenance.** Each building records where its height came from —
  `tag` (an actual `height`), `levels` (derived from `building:levels`), or `default`
  (the flat 6 m fallback). Worth checking before you upload: on a typical fetch the vast
  majority are `default`, i.e. tool guesses, and mass-uploading those is exactly the kind
  of edit the [automated-edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_edits_code_of_conduct)
  is about. It is an **internal** field — never written to OSM.
- **Click a building → edit → stage → submit**, the same two-step flow as roads. Editing
  a building stages it into `pendingBuildings` (keyed `type/id`), tints it **magenta**,
  and lists it as a removable row; **Submit** then pushes every staged building through
  the bulk path into a fresh **JOSM** layer for review and upload. The local preview
  patches `data/buildings.geojson` in place (`POST /api/building`) so the extrusion
  updates immediately, but that is **preview only** — as with roads, the actual OSM
  upload is yours to make in JOSM.
- **Partial Simple 3D Buildings support.** The parser accepts **`building:part`** ways
  and honours `min_height` / `building:min_level` — the tiered-massing half of
  [S3DB](detailed-building-tagging.md). One gap remains: the Overpass query doesn't ask
  for `building:part`, so **parts are never fetched** (adding them would double-draw the
  part on top of its outline; that needs an outline-suppression pass first). Sloped roofs
  (`roof:shape`) are out of reach entirely — MapLibre `fill-extrusion` only does flat
  tops; real roof shapes need a mesh renderer (three.js) or pre-baked glTF / 3D Tiles.
  See [`detailed-building-tagging.md`](detailed-building-tagging.md) for the tag reference.
- **Legibility.** Each footprint is tinted from a small palette keyed by its id and
  shrunk slightly toward its own centroid, so touching blocks read as separate buildings
  instead of one mass. The shrink is **render-only** — the stored geometry, the edits,
  and the GeoJSON export all keep the true footprints.

### Batch tab — boundary fetch, bulk CSV, GeoJSON export

- **Boundary fetch.** Import a boundary **`.geojson`** (Polygon / MultiPolygon /
  FeatureCollection) and fetch pulls only what's *inside* it instead of the map view —
  handy for tiling by admin area or H3 cell. Each feature is listed with a checkbox
  (untick to exclude); a **find id…** box filters the list and **Select all /
  Deselect all** bulk-toggle the currently-matching rows (click a label to zoom to it).
  **⤓ Fetch roads in boundary** / **⤓ Fetch buildings in boundary** send the included
  rings as an Overpass `poly:` query (big rings are decimated to keep the query bounded).
- **Bulk tag update → JOSM (CSV).** Supply a CSV of ids + tag columns; the tool fetches
  exactly those elements **by id** (not a bbox), merges the CSV tags (blank cell = leave
  unchanged), marks them `action="modify"`, and opens them in a fresh JOSM layer to
  review + upload (`POST /api/bulk`). Roads and buildings write to **separate** files
  (`live/bulk-road.osm` / `live/bulk-building.osm`), so the two never conflict and
  neither disturbs `current.osm` or the seed. A building bulk run also refreshes the
  3-D heights on the map.
  - Road CSV header: `type,id,<tag>,…` (`type` = `way|node`, default `way`)
  - Building CSV header: `id,osm_type,<tag>,…` (`osm_type` = `way|relation`) — exactly
    what **Download → buildings.geojson** produces, so an export round-trips
  - **Identity columns are never uploaded as tags.** `id` / `osm_type` / `osm_way_id` /
    `type` / `height_source` are the tool's own columns, and are dropped (client- *and*
    server-side) rather than written to OSM. A few render names are remapped to their
    real OSM keys on the way in — `base → min_height`, `levels → building:levels`,
    `min_level → building:min_level` — and the UI reports what it dropped and remapped
    so nothing is silently changed.
  - **Duplicate rows are de-duplicated** per `(type, id)` before the fetch (later rows
    win on a repeated key), so the same element is fetched and modified once.
  - **Type-mismatch guard.** Before touching anything, the server checks each element's
    real tags against the run's `kind` and **refuses** the mismatches: building tags onto
    something tagged `highway`/`railway`/`waterway`/`aeroway`/`natural`, or road tags onto
    a building. Refused rows come back in `skipped[]` with the reason (shown in orange in
    the UI) and the rest still go through. This exists because ids collide across types —
    a stale `type=way` on what is really a relation once wrote a `building=school` onto an
    unrelated residential road.
  - **Bulk cannot delete tags** (a blank cell means *unchanged*, not *remove*), and there
    is no row cap or chunking yet — a several-thousand-row CSV goes to Overpass in one
    request. And read the automated-edits note in §8 before uploading a large mechanical
    run.
- **Download raw OSM → GeoJSON.** Save the last-fetched data as GeoJSON, **split by
  type** (`GET /api/download?kind=road|building`): **roads.geojson** — one LineString
  per highway way carrying `osm_way_id` + all OSM tags (the *raw* fetched geometry, not
  the osm2streets-exploded lanes/markings) — and **buildings.geojson** — the true
  building polygons (unshrunk), exported with **real OSM tag keys** (`height`,
  `min_height`, `building:levels`, `building:min_level`, `building`, `name`) plus the
  `id` / `osm_type` identity columns and `height_source`. That's deliberate: the export
  is meant to be edited in a spreadsheet and fed **straight back into the bulk CSV**, so
  it must not carry the tool's internal render names.
  > The two downloads can describe **different areas** — roads come from the last
  > `data/raw.osm` fetch, buildings from the last `data/buildings.geojson` fetch (plus any
  > bulk upserts). Fetch both for the same view if you want them to line up.

---

## 7. Files

| File           | Purpose |
|----------------|---------|
| `build.mjs`    | **Shared pipeline**: OSM XML → HD GeoJSON layers (`osmToLayers`). Used by all entry points. |
| `rebuild.mjs`  | `current.osm` → GeoJSON layers + `version.json`. Importable (`rebuildFiles`) and runnable as a subprocess — `server.mjs` forks it so a changeset rebuild runs off the main thread |
| `generate.mjs` | One-shot: Overpass fetch → `data/*.geojson` + `meta.json` + `version.json` |
| `watch.mjs`    | Preview mode: watch `live/current.osm` (JOSM save) → rebuild on change |
| `server.mjs`   | Editor mode: serve viewer + the `/api/*` endpoints (see table below); writes edits to `current.osm` as `action="modify"` (changeset rebuild forked to `rebuild.mjs`) |
| `index.html`   | MapLibre GL viewer — styling, layer toggles, live-sync poll, staging tag editor, JOSM import |
| `restart.sh`   | Start / stop / restart / status helper for `server.mjs` (§2) — frees the port cleanly, starts detached, waits for readiness |
| `detailed-building-tagging.md` | OSM tag guideline for mapping **detailed 3D buildings** (Simple 3D Buildings: `building:part`, `height`/`min_height`, `roof:*`) |
| `live/`        | `current.osm` — the working OSM file (watched / edited); auto-seeded from the default on first run. **gitignored** |
| `data/*.geojson`, `data/{raw,meta,version}` | Generated HD layers + stamps — **gitignored**. `server.mjs` rebuilds them on startup from the seed, and `generate.mjs` regenerates them, so they're never committed (they'd only drift) |
| `data/buildings.geojson` | The decoupled 3-D building layer (§6) — fetched/edited independently of the road pipeline; **gitignored** |
| `live/bulk-{road,building}.osm` | Per-kind output of a bulk CSV run (§6), opened in a fresh JOSM layer; separate files so road/building runs never conflict. **gitignored** |
| `data/default.osm` | **The one committed data file** — the default-area seed (Pham Hung). Powers deterministic startup + **Reset to default area**; a fresh checkout rebuilds everything else from it. Fetch never overwrites it |
| `logs/`        | Per-session action logs (`session-<start>.log`) — not committed |
| `plan.md`      | The staging-editor design this workflow implements |

### Session action log (traceability)

Every live `server.mjs` session appends to its own `logs/session-<start>.log`, so each
service start/restart begins a fresh file and older sessions' traces are preserved. It
records `session-start`, `seed-default` (first-run seeding), every request (`req` — the
`version.json` poll is filtered out), each `rebuild` (source + counts), `fetch` /
`fetch-blocked`, `reset` / `reset-blocked`, `rebuild-local`, `clear-modified` (markers
cleared after a JOSM upload), `changeset` (keys + count), the background changeset
rebuild (`rebuild-bg-start` / `rebuild-bg` / `rebuild-bg-exit`, and `rebuild-bg-kill`
when a newer write supersedes an in-flight rebuild), crashes (`uncaught`), and
`session-end` (reason + uptime). Writes are synchronous write-through,
so a crash still leaves a complete trace up to the failure — if something goes wrong
(e.g. edits disappear), the log shows exactly what ran and when.

Backend endpoints (`server.mjs`):

| Endpoint | Does |
|---|---|
| `GET  /api/way?id=<id>` | current OSM tags for a way |
| `GET  /api/node?id=<id>` | current OSM tags for a node (intersection editing) |
| `POST /api/fetch {bbox:[w,s,e,n]}` | pull area from Overpass (mirror fallback; `OVERPASS_ENDPOINTS` env) → `current.osm` → rebuild (stamps `fetchedAt`) |
| `POST /api/reset {force?}` | reload the committed default area (`data/default.osm`) → `current.osm` → rebuild — no Overpass; same overwrite guard as fetch |
| `POST /api/rebuild-local` | rebuild HD layers from the **existing** `current.osm` (no Overpass, no overwrite) — re-render an external JOSM save; background rebuild |
| `POST /api/clear-modified` | strip `action="modify"` markers from `current.osm` after you've uploaded in JOSM (tags untouched → no rebuild); returns `{cleared}` |
| `POST /api/changeset {edits:{key:{k:v}}}` | batch-apply staged edits (key = `way:<id>` / `node:<id>`), mark `action="modify"`, rebuild |
| `POST /api/edit {wayId, tags}` | single-way edit (legacy; superseded by the staging flow) |
| `POST /api/buildings {bbox \| polys}` | fetch `way["building"]` **+ `relation["building"]`** for a bbox or boundary rings → polygonize (multipolygon rings stitched, holes assigned) → `data/buildings.geojson` (decoupled layer, §6) |
| `POST /api/building {id, osm_type?, height?, base?, props?}` | patch one building's inferred height/props in `buildings.geojson` in place, matched on **(type, id)** (no rebuild, no version bump) — local preview for the staging flow |
| `POST /api/bulk {kind, rows:[{id,type?,tags}]}` | fetch elements **by id** (ways, nodes *and* relations), de-dupe, **refuse type mismatches**, merge tags, mark `action="modify"`, write `live/bulk-<kind>.osm` for JOSM (§6). Returns `{matched, missing, skipped, total}`. The CSV is parsed **client-side** into `rows` |
| `GET  /api/download?kind=road\|building` | download last-fetched data as GeoJSON — raw highway LineStrings, or building polygons re-keyed to **real OSM tags** for a clean bulk-CSV round-trip (§6) |

`/api/fetch` and `/api/buildings` also accept `{ polys: [[[lng,lat],…]] }` (boundary
rings) in place of `bbox`, which is how the Batch tab's boundary fetch works.

---

## 8. Notes / next steps

- **Widths are inferred — twice over.** OSM rarely tags lane width, so osm2streets
  estimates from lane type; on top of that we inject a per-class default `lanes`
  count so higher road classes read wider (§1, *Road width & paint by highway
  class*). Both are educated guesses, not survey — a two-way multi-lane default on
  an untagged segment of a one-way arterial can still look wrong, and the honest fix
  is to tag that way's real `oneway`/`lanes`. To dial the hierarchy up or down (or
  off), edit `LANES_BY_CLASS` / `NO_LANE_LINE_CLASSES` at the top of
  [`build.mjs`](build.mjs).
- **osm2streets merges ways/nodes.** Adjacent OSM ways (or nodes) that form one
  continuous road are fused into a single Road/Intersection, so a lane can carry
  several `osm_way_ids` (e.g. `[a, b]`) and an intersection several `osm_node_ids`.
  Selecting one highlights **all** lanes of the fused road, but the tag editor reads
  and writes the **first** id only — if the segments need different tags, split the
  way in JOSM first (the **✂ Split this way in JOSM** button), then either upload and
  re-fetch, or Save over `current.osm` and click **↻ Reload local file**. (The
  viewer normalizes these array-vs-string ids internally so hover/select highlight
  works for merged ways too.)
- **Tags only — not routing relations.** This tool edits **way tags** and **node
  tags**. It does *not* edit OSM **relations**. That's an important distinction for
  turns: the lane **turn *tags*** it handles (`turn:lanes`, the arrows, the visual
  lane editor) describe *which lanes may turn where* — they are **not** legal turn
  restrictions. A real restriction ("no left turn from road A into road B") is a
  `type=restriction` **relation**, and relations aren't even fetched (the Overpass
  query is `(way["highway"];>;)` — ways + their nodes, no relations). For turn
  restrictions, routes, or any relation editing, use **JOSM directly**. (Because
  parent relations aren't loaded, JOSM may also flag a modified way's relations as
  incomplete on upload — that's expected; it doesn't affect the tag change itself.)
  *Exception:* the **building** pipeline does read `relation["building"]` and can put a
  building relation's own **tags** in a bulk changeset (§6) — but even there it only
  edits tags, never relation membership or geometry.
- **Bulk never touches geometry.** If JOSM's validator flags overlapping buildings,
  self-crossing ways, or missing companion tags after a bulk run, those are **pre-existing
  problems in the OSM data** you fetched, not something the tool introduced — it only ever
  merges tag values onto elements it fetched verbatim.
- **Bulk edits.** Lane-tag edits at scale fall under OSM's
  [automated-edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_edits_code_of_conduct):
  keep each changeset small, scoped, and documented, and discuss large mechanical
  edits with the local community first. JOSM re-validates on upload — heed it.
- **Nothing here touches the OSM API.** Uploads happen only when *you* click Upload
  in JOSM. The tool never handles OSM credentials or tokens.
- **Runtime CDN dependency.** `index.html` loads MapLibre JS/CSS from `unpkg.com`
  (pinned to `5.24.0`). Fine for a local demo, but for an offline or internal/VTII
  deployment you'd want to **vendor** them (download into the repo and point the
  `<link>`/`<script>` at local copies) to drop the network + supply-chain coupling.
  Turn-arrow glyphs are already local (canvas-drawn, no web-font URLs).
- **Generation cost.** The one-way centre-line pass bbox-rejects non-overlapping roads
  before the point-in-polygon test, but `osmToLayers` still reprocesses the *whole*
  file each rebuild. Fine per-district; for a city, pre-tile (see render note above)
  and/or rebuild only changed tiles.
- **Scaling up the render:** for a whole city, don't load raw GeoJSON. Pipe it through
  `tippecanoe` → **PMTiles** and point MapLibre at the tiles; add a centerline-only
  style below ~z14 so it stays fast when zoomed out.
- **Import options** (`build.mjs`): `override_driving_side: "right"` for Vietnam;
  toggle `inferred_sidewalks` / `dual_carriageway_experiment` etc.
- Pinned to `osm2streets-js@0.1.4` (its constructor needs the `osm2lanes` field).

---

## Roadmap: internal PostGIS source (replacing live Overpass)

Today every fetch hits the public **Overpass API**, which is rate-limited, often
overloaded (the tool already falls back across several mirrors — see Step 1), and caps
how much area you can pull at once. The long-term plan is to make the data source an
**internal database instead of a live API**:

- Load a regional **PBF** extract (e.g. Geofabrik Vietnam) into **PostGIS** with
  `osm2pgsql`, and refresh it from minutely/daily diffs.
- Replace `/api/fetch`'s Overpass call with a bbox query against PostGIS — same
  `current.osm`-shaped output feeding the existing osm2streets → GeoJSON pipeline, so
  nothing downstream changes.
- This removes the 504s and area caps, makes fetches fast and deterministic, and is the
  prerequisite for city-scale coverage (paired with the PMTiles render path above).

This is a significant architectural shift (a stateful DB + import/diff tooling), so it's
tracked here as a direction rather than something wired in yet.
