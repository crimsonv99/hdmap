# 3D City Map — MVP

A **Google/Amap-style 3D city map with client-side turn-by-turn navigation**,
rendering the same HD scene the `hdmap` editor produces — osm2streets lane
geometry, lane markings, turn arrows, and inferred **3D buildings** — but with
**no editor, no server, no WASM at runtime**. Just pre-baked map data painted
with MapLibre, plus a routing graph and A\* running entirely in the browser.

It runs **standalone from a static host** (GitHub Pages): the whole thing is
plain files — HTML, vector tiles, and one JSON graph.

There are **two viewers**, same style, different scale:

| Viewer | Covers | Data source | For |
|---|---|---|---|
| **`index.html`** (the front page) | **all of urban Hanoi** | **`./tiles`** (uncompressed MVT) + **`data/graph.json`** (routing) | **the real webmap + navigation** |
| `index-district.html` | one district (Pham Hung) | raw GeoJSON in `data/` | the original quick demo |

The city viewer is the point: it covers the whole city and stays fast because
MapLibre only fetches the tiles under the current view. See
[Baking the city](#baking-the-city) to (re)generate the data.

---

## Quick start

```bash
cd MVP-3D-MAP
node serve.mjs                     # -> http://localhost:8100
```

Then open:
- **`http://localhost:8100/`** — the whole-Hanoi 3D map (boots tilted over
  Hoan Kiem lake). Pan anywhere in the city; tiles stream in as you go.
- `http://localhost:8100/index-district.html` — the single-district GeoJSON demo.

Drag to pan, scroll to zoom, **right-drag** (or two-finger) to rotate/tilt.

> A tiny HTTP server is required — you can't just double-click the HTML, because
> the page fetches tiles + `graph.json` from `./` over HTTP. `serve.mjs` has
> **zero dependencies**.

### Controls
- **Search box** — paste `lat, lng` (Google/OSM order) to fly there. In 🧭 route
  mode, a typed coordinate instead **drops the next route point** (snapped).
- **3D view** — toggle tilt on/off (turn it off for a flat 2D map).
- **🌙 Dark** — neon night theme (gray-black ground, nightfall sky + stars,
  cyan buildings).
- **🧭 Route** — enter navigation mode (see [Navigation](#navigation)).
- **Frame city** / **⌖ North** — reset view / rotation.
- **Layers card** (bottom-left) — toggle roads / markings / turn arrows /
  buildings / satellite base.
- **Click** a building or road for a quick info popup; **double-click** anywhere
  to copy that `lat, lng` to your clipboard.
- **Geolocate** button (top-right) — jump to your real location.

---

## Navigation

Fully client-side — no routing server. A compact **routing graph**
(`data/graph.json`, ~6.5 MB / ~1.9 MB gzipped, loaded lazily on first use) carries
the road network with full, unclipped connectivity (vector tiles are clipped at
tile borders, so we can't route on them directly).

- **Pick a route** — click **🧭 Route**, then click a **start (A)** and
  **destination (B)** on the map (they snap to the nearest road), or type
  coordinates in the search box. A\* finds the shortest-**time** path — cost is
  `length ÷ class speed`, with `service` roads penalised so they're used only for
  access, not shortcuts.
- **2D directions panel** — Amap/Google-style: turn-by-turn steps (derived from
  bearing changes), distance to each, total **distance · ETA · arrival clock**,
  a swap button, and a show/hide toggle. ETAs use realistic urban speeds
  (`ETA_SPEED_KMH` in `index.html`), not free-flow limits.
- **3D drive mode** — hit **▶ GO**: a follow-cam flies the route with a **car
  marker**, a top **maneuver banner** (next turn + distance + road), a
  **speed readout**, and a bottom progress bar (remaining · arrival). Play/pause.
- **Lane-level guidance** — while driving, the car's **actual HD lanes** light up
  (green), matched to the route's OSM ways by `osm_way_ids` + `direction` and
  windowed to the current way + one ahead. This needs those two attributes in the
  tiles — see the `KEEP` list in `bake-tiles.sh`.

Scope note: routing is bounded to the baked extent (the graph ships for that
area). Cross-region routing would need a bigger graph or an external API.

---

## What's inside

```
MVP-3D-MAP/
├─ index.html          CITY viewer + navigation ← the front page
├─ index-district.html district viewer (raw GeoJSON demo)
├─ serve.mjs           zero-dep static server
├─ bake-city.mjs       OSM extract → tile → osm2streets → NDGeoJSON layers
├─ bake-tiles.sh       NDGeoJSON → ./tiles (uncompressed MVT, tippecanoe+tile-join)
├─ bake-graph.mjs      OSM highways → data/graph.json (routing graph)
├─ tiles/              baked {z}/{x}/{y}.pbf vector tiles (committed, served)
├─ data/
│   ├─ graph.json          routing graph (nodes/edges + per-edge osm_way_id)
│   ├─ hanoi-meta.json      bbox/center/counts for the city bake
│   └─ *.geojson, meta.json the original district layers (index-district.html)
├─ image/car.png       trimmed top-view car marker for 3D drive mode
├─ build/              baker intermediates (gitignored: pbf, layers, pmtiles)
└─ README.md
```

The paint (road ordering, building height ramp, sky, light) is copied from the
editor's `index.html`, so the base map looks identical — same style, pointed at
vector tiles instead of a live osm2streets source.

---

## Baking the city

A whole city is far too much geometry to hold in the browser, so it's pre-baked
into **vector tiles**. The viewer fetches only the tiles under the current view.

Tiles are served as an **uncompressed `{z}/{x}/{y}.pbf` directory** (not a single
PMTiles archive): MapLibre v5 errors on gzipped tiles unless the server sends
`Content-Encoding: gzip`, which GitHub Pages can't do for `.pbf`. Raw MVT renders
everywhere with no headers.

That reasoning is about **plain static file hosting**, and it is why the *city*
bake ships a directory. The `national-map` tool (a separate repo) ships a
**PMTiles archive** instead and is not a contradiction: a PMTiles reader fetches
tile ranges with HTTP `Range` requests and gunzips them itself, so the server
never has to set `Content-Encoding`. The trade is that it needs a PMTiles-aware
client (`pmtiles serve`, or the `pmtiles://` protocol in MapLibre) rather than
plain `<img>`-style tile URLs — and at 2.27 M files a whole-country directory
would be unusable in git anyway.

### The pipeline (all built here)

```
Geofabrik .pbf ──► osmium (clip + tile) ──► osm2streets per tile ──► NDGeoJSON
                                                                        │
                                                              tippecanoe + tile-join
                                                                        │
                                                                    ./tiles ──► MapLibre
     └──► osmium (highways) ──► bake-graph.mjs ──► data/graph.json ──► A* (browser)
```

osm2streets can't swallow a city at once, so `bake-city.mjs` **tiles** it: cuts
the extract into ~1.6 km cells (`--strategy complete_ways`, so boundary roads
arrive whole), runs osm2streets on each, and keeps every output feature in
exactly one tile (**centroid ownership**) so overlapping cells never
double-render. Output streams to NDGeoJSON to keep memory flat.

### Re-bake / bake a different city

```bash
# 0. one-time tooling
brew install tippecanoe pmtiles osmium-tool

# 1. get an OSM extract (Vietnam shown; swap for your country)
curl -L -o build/vietnam-latest.osm.pbf \
  https://download.geofabrik.de/asia/vietnam-latest.osm.pbf

# 2. tile + osm2streets  (default bbox = Hanoi urban core; or pass S W N E [tileDeg])
node bake-city.mjs build/vietnam-latest.osm.pbf

# 3. bake to the ./tiles directory (+ copies meta for the viewer)
MAXZOOM=18 ./bake-tiles.sh      # z18 so the 3D-drive close-up renders native

# 4. bake the routing graph (reads build/city.osm.pbf from step 2)
node bake-graph.mjs             # -> data/graph.json

# 5. view it
node serve.mjs                  # -> http://localhost:8100
```

`./tiles` (~211 MB at z18) + `data/graph.json` are committed and served straight
from **any static host** — GitHub Pages, S3, Cloudflare R2 — no tile server.

**Size / fidelity knobs** (env vars on `bake-tiles.sh`): lane markings + turn
arrows (~75% of the geometry) bake only from `MARK_MINZOOM=16` up; everything
caps at `MAXZOOM` (18 here). Baking to z18 keeps the close-up drive view crisp
(z17 got overzoomed/clipped at drive zoom); dropping back to `MAXZOOM=17` roughly
halves the tile size at the cost of soft close-ups. The `KEEP` list in
`bake-tiles.sh` is the attribute allowlist — `osm_way_ids` + `direction` must stay
in it for lane-level guidance to work.

### Whole-country coverage — see the `national-map` tool

Country-scale coverage is a **separate tool**, `../national-map/`, not part of this
repo. It ships osm2streets' *input* (road centrelines + the lane spec, plus building
footprints) and generates lane bodies, markings and lane arrows at render time,
instead of baking every lane polygon. Measured on `vietnam-latest.osm.pbf`: **~412 MB
in one PMTiles file, ~6 min to bake**, against 13.8 GB across 2.27 M files for the HD
pipeline projected nationally.

It is **not** a replacement for this bake: it has no osm2streets intersection
polygons and no real turn arrows. The intended shape is this HD bake over the city
cores you care about, layered on that national backdrop.

### Beyond one city
- **Two-tier style.** HD lane geometry only reads at z15+. Below that, fall back
  to a normal OSM road-line tileset so the map stays useful zoomed out.
- **Terrain.** Add a MapLibre `terrain` DEM + `hillshade` for hills under a
  tilted camera. Independent of the data pipeline; big visual payoff.
- **Updates.** A baked tileset is a snapshot. Decide the refresh cadence — that
  choice drives how much backend you sign up for.
- **Editing.** To let people *edit*, keep this baked map as the fast base and drop
  the `hdmap` WASM editor in as an overlay for the small area being edited.

---

## Limitations (be honest)
- **Hanoi urban core only.** The viewer covers the default bake bbox; pan past its
  edge and you'll see empty ground until you bake a wider bbox. Routing is bounded
  to the same extent.
- **Frozen snapshot.** Tiles + graph are whatever OSM looked like at bake time.
  Re-run the pipeline to refresh; there's no live update.
- **No live traffic.** Routes are single-colour and ETAs are model-based (realistic
  urban speeds), not real-time — there's no traffic feed. No signal-timing either.
- **Inferred, not surveyed.** Road widths and building heights are estimated by the
  pipeline (same caveat as the editor), not ground truth.
- **Junction interiors.** osm2streets renders big junction interiors as
  "intersection" polygons (not lanes), so the lane highlight can show a small gap
  inside large junctions (the lanes leading in/out are highlighted).
