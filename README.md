# 3D City Map — MVP

A **read-only, Google-Maps-style slippy map** that renders the same HD scene the
`hdmap` editor produces — osm2streets lane geometry, lane markings, turn arrows,
and inferred **3D buildings** — but with **no editor, no server logic, no WASM**.
Just pre-baked map data painted with MapLibre.

There are **two viewers**, same style, different scale:

| Viewer | Covers | Data source | For |
|---|---|---|---|
| **`index.html`** (the front page) | **all of urban Hanoi** | **`data/hanoi.pmtiles`** (vector tiles) | **the real webmap** |
| `index-district.html` | one district (Pham Hung) | raw GeoJSON in `data/` | the original quick demo |

The city viewer is the point: it covers the whole city and stays fast because
MapLibre only fetches the vector tiles under the current view. See
[Baking the city](#baking-the-city) to (re)generate the Hanoi archive.

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

> **The view is locked to central Hanoi (Hoan Kiem / Old Quarter) by default.**
> The whole city is baked into the archive, but panning the full extent can lag
> on modest hardware, so the camera is bounded to a compact, dense slice for
> smooth loading. To roam the whole city, delete `maxBounds` and lower `minZoom`
> in `index.html` (see the `LOCK_BOUNDS` comment). The heavy lane-markings layer
> only draws at zoom ≥ 16, so mid-zoom panning stays light.

> A tiny HTTP server is required — you can't just double-click the HTML, because
> the page fetches data from `./data` (and PMTiles needs HTTP **range**
> requests, which `file://` can't do). `serve.mjs` has **zero dependencies** and
> supports range requests.

### Controls
- **Search box** — paste `lat, lng` (Google/OSM order) to fly there.
- **3D view** — toggle tilt on/off (this is also your **2D** map: turn it off).
- **Frame city** — reset to the full locked area.
- **⌖ North** — reset rotation.
- **Layers card** (bottom-left) — toggle roads / markings / turn arrows /
  buildings, and flip on an Esri satellite base to trace against.
- **Click** a building or road for a quick info popup (height / width / etc.).
- **Geolocate** button (top-right) — jump to your real location (only useful if
  you've baked data for wherever you are).

---

## What's inside

```
MVP-3D-MAP/
├─ index.html          CITY viewer (PMTiles vector source) ← the front page
├─ index-district.html district viewer (raw GeoJSON)
├─ serve.mjs           zero-dep static server (with HTTP range support)
├─ bake-city.mjs       OSM extract → tile → osm2streets → NDGeoJSON layers
├─ bake-tiles.sh       NDGeoJSON → data/hanoi.pmtiles (tippecanoe)
├─ data/
│   ├─ hanoi.pmtiles       ← the baked city (all 5 layers, one archive)
│   ├─ hanoi-meta.json     bbox/center/counts for the city bake
│   ├─ *.geojson           the original district layers (for index-district.html)
│   └─ meta.json           district bbox
├─ build/             baker intermediates (gitignored: pbf, tiles, layers)
└─ README.md
```

The paint (colours, casing-then-fill road ordering, building height ramp, sky,
directional light) is copied **verbatim** from the editor's `index.html`, so the
map looks identical — same style, just pointed at vector tiles instead of a live
osm2streets source.

---

## Baking the city

The district demo loads raw GeoJSON (fine for ~50 MB / one neighbourhood). The
city map can't — a whole city is far too much geometry to hold in the browser.
So it's pre-baked into **vector tiles** (PMTiles): MapLibre fetches only the
tiles under the current view, and the whole city lives in one range-requestable
archive you can host as a static file.

### The pipeline (all built here)

```
Geofabrik .pbf ──► osmium (clip + tile) ──► osm2streets per tile ──► NDGeoJSON
                                                                        │
                                                              tippecanoe (bake)
                                                                        │
                                                              data/hanoi.pmtiles ──► MapLibre
```

osm2streets can't swallow a city at once, so `bake-city.mjs` **tiles** it: cuts
the extract into ~1.6 km cells (`--strategy complete_ways`, so boundary roads
arrive whole), runs osm2streets on each, and keeps every output feature in
exactly one tile (**centroid ownership**) so overlapping cells never
double-render. Output streams to NDGeoJSON (one feature per line) to keep memory
flat regardless of city size.

### Re-bake / bake a different city

```bash
# 0. one-time tooling
brew install tippecanoe pmtiles osmium-tool

# 1. get an OSM extract (Vietnam shown; swap for your country)
curl -L -o build/vietnam-latest.osm.pbf \
  https://download.geofabrik.de/asia/vietnam-latest.osm.pbf

# 2. tile + osm2streets  (default bbox = Hanoi urban core; or pass S W N E [tileDeg])
node bake-city.mjs build/vietnam-latest.osm.pbf
#   e.g. a different city:  node bake-city.mjs build/x.osm.pbf 20.95 105.75 21.10 105.89 0.015

# 3. bake to one PMTiles archive (+ copies meta for the viewer)
./bake-tiles.sh

# 4. view it
node serve.mjs   # -> http://localhost:8100/index.html
```

`data/hanoi.pmtiles` (~73 MB — under GitHub's 100 MB file limit) can sit on
**any static host** — GitHub Pages, S3, Cloudflare R2 — no tile server needed.
To host the archive remotely, just change the `PMTILES` url near the top of
`index.html`'s script.

**Size control.** The bake keeps the archive small two ways, both tunable via env
vars on `bake-tiles.sh`: lane markings + turn arrows (≈75% of the geometry) are
stored only from `MARK_MINZOOM=15` up (they're invisible zoomed out anyway), and
everything caps at `MAXZOOM=17` — the viewer overzooms those tiles to z18/19,
which stays crisp because the data is vector. Widen the bbox or raise `MAXZOOM`
and the file grows; if it passes 100 MB, host it externally (above).

### Beyond one city
- **Two-tier style.** Your lane geometry only reads at z14+. Below that, fall
  back to a normal OSM road-line tileset so the map stays useful zoomed out.
  The HD 3D layer switches in via `minzoom` — which is also the only zoom where
  3D looks good anyway.
- **Terrain.** Add a MapLibre `terrain` DEM source + `hillshade` for real hills
  under a tilted camera. Independent of your data pipeline; big visual payoff.
- **Updates.** A baked tileset is a snapshot. Decide the refresh cadence — never
  / nightly OSM-diff rebuild / live-edit overlay — that single choice drives how
  much backend you sign up for. (See `../hdmap/MOBILE-PORT-NOTES.md` for the
  related mobile/offline analysis.)
- **Editing.** If you later want people to *edit*, keep this baked map as the
  fast base and drop the existing `hdmap` WASM editor in as an overlay for the
  one small area being edited — best of both.

---

## Limitations (be honest)
- **Hanoi urban core only.** The city viewer covers the built-up districts (the
  default bake bbox). Pan past its edge and you'll see empty ground until you
  bake a wider bbox — change the bounds passed to `bake-city.mjs` and re-bake.
- **Frozen snapshot.** The archive is whatever OSM looked like at bake time.
  Re-run the pipeline to refresh; there's no live update yet.
- **Tile-edge seams.** Centroid ownership + complete-ways keeps this rare, but a
  junction sitting exactly on a tile boundary can occasionally look slightly off.
  Smaller tiles reduce edges; it's cosmetic, not missing data.
- **Inferred, not surveyed.** Road widths and building heights are estimated by
  the pipeline (same honesty caveat as the editor), not ground truth.
