# hdmap — HD road-network webmap from OSM

A thin vertical slice proving the pipeline:

```
OSM (Overpass)  →  osm2streets (WASM)  →  GeoJSON  →  MapLibre GL JS
```

It fetches raw OSM for a small area, runs the **osm2streets** geometry engine
(the same library behind https://a-b-street.github.io/osm2streets) to turn
centerline ways into lane-level polygons, and renders them as an HD basemap.

Default area: a small patch of Hanoi around `21.02788, 105.850312`.

## What you get

- **Lane polygons** coloured by type (driving / sidewalk / footway / …)
- **Intersection polygons** (osm2streets trims road ends and fills the junction)
- **Lane markings** — centre lines, separators, arrows, stop lines
- Click any lane → its type, direction, inferred width, and source OSM way id
- Press **`f`** to frame the whole road network

## Run it

```bash
cd hdmap
npm install                 # installs osm2streets-js (WASM)

# 1. generate data for the default Hanoi bbox
node generate.mjs
#    or a custom bbox:  node generate.mjs <south> <west> <north> <east>

# 2. serve statically (any static server works)
python3 -m http.server 8097
#    open http://localhost:8097/index.html
```

> Must be served over http:// — opening `index.html` as a `file://` URL fails
> because the browser can't `fetch()` the local GeoJSON.

## Files

| File | Purpose |
|---|---|
| `generate.mjs` | Overpass fetch → osm2streets WASM → `data/*.geojson` + `data/meta.json` |
| `index.html`   | MapLibre GL viewer (styling + layer toggles + click inspector) |
| `data/`        | Generated GeoJSON (lanes, markings, intersections) — not committed |

## Notes / next steps

- **Widths are inferred.** OSM rarely tags lane width, so osm2streets estimates
  from lane type. The map looks HD but widths are educated guesses, not survey.
- **Scaling up:** for a whole city, don't load raw GeoJSON. Pipe the GeoJSON
  through `tippecanoe` → **PMTiles** and point MapLibre at the tiles. Add a
  centerline-only style below ~z14 so it stays fast when zoomed out.
- **Import options** (`generate.mjs`): `override_driving_side: "right"` for
  Vietnam; toggle `inferred_sidewalks` / `dual_carriageway_experiment` etc.
- Pinned to `osm2streets-js@0.1.4` (its constructor needs the `osm2lanes` field).
