# hdmap — Run / Task Log

Chronological record of what was actually changed in the code for the 3D phase.
Newest entries on top. Each entry: date, task id(s) from [`tasks.md`](tasks.md), files
touched, what changed, how it was verified, and anything left open.

Plan: [`plan.md`](plan.md) §5 · Task breakdown: [`tasks.md`](tasks.md)

---

## Template (copy for each work session)

```
## YYYY-MM-DD — <short title>
- Tasks: <e.g. 1.1, 1.2>
- Files: <paths touched>
- Changes:
  - <what changed, in code terms — functions/layers/props>
- Verified:
  - <how it was checked: served locally, orbited camera, clicked a lane, etc.>
- Open / follow-ups:
  - <anything deferred, decisions needed, known artifacts>
```

---

## 2026-07-20 — Building legibility, boundary list controls, dbl-click copy coord, README
- Files: index.html, README.md
- Changes:
  - **Building legibility (index.html).** `buildings-3d` fill-extrusion now:
    - tints each footprint from a 6-tone earth palette keyed by `osm_way_id % 6`
      (`match` on `["%", ["to-number", ["get","osm_way_id"], 0], 6]`), so adjacent
      blocks that share a wall no longer read as one mass;
    - `fill-extrusion-vertical-gradient: true` + opacity `0.85 → 0.92` for solidity.
  - **Fake gap between buildings (index.html).** New render-only `shrinkBuildings(fc)`
    helper insets each footprint toward its own centroid by a clamped ~2.2 m
    (`GAP_METERS`, ratio clamped 0.75–0.97 from the ring's metric half-span), so
    touching buildings show ground between them. Applied at EVERY point the buildings
    source gets data (initial source, `reloadSources`, height-edit re-extrude, viewport
    fetch, boundary/bulk fetch). `currentBuildings` + `data/buildings.geojson` keep the
    TRUE geometry, so height editing/selection and the GeoJSON download are unaffected.
    Replaced the earlier `buildings-edge` outline layer (removed) which looked bad.
  - **Boundary list controls (index.html).** Batch → Boundary fetch: added a `find id…`
    search box + Select all / Deselect all buttons (`#bnd-ctl`, shown only when a
    boundary is loaded). `renderBndList` now hides rows not matching `bndFilter`
    (case-insensitive substring); `setBndAll(val)` toggles `include` on the
    currently-matching rows only. Clear boundary resets the search + hides the controls.
  - **Double-click to copy coordinate (index.html).** `doubleClickZoom:false` in map
    opts; `map.on("dblclick")` copies `lat, lng` (6 dp, Go-box order) via
    `navigator.clipboard.writeText`, with a `#copy-toast` at the cursor (fades ~1.3s;
    shows "⚠ copy blocked" on clipboard failure).
  - **README.md.** Intro note about buildings + Batch; new §3 dbl-click-copy aid; new
    §6 "Buildings & batch tools" (Building tab, boundary fetch, bulk CSV, GeoJSON
    export); renumbered Files→§7 / Notes→§8; Files + endpoint tables extended with
    `/api/{buildings,building,bulk,download}`, `buildings.geojson`, `bulk-*.osm`.
- Verified:
  - Served copy on :8097 contains `shrinkBuildings` (7 uses), `bnd-ctl`/`bnd-search`/
    `btn-bnd-all`/`btn-bnd-none`, `setBndAll`, `doubleClickZoom: false`,
    `map.on("dblclick"`, `copy-toast`, `clipboard.writeText`; zero `buildings-edge` refs.
  - README headers renumbered clean (## 1–8 + Roadmap), no dangling §6/§7 prose refs.
- Open / follow-ups:
  - `GAP_METERS` (2.2) is a single global; not tunable in the UI. Easy to expose later.
  - Boundary list with an all-filtered-out search shows an empty bordered box (cosmetic).

---

## 2026-07-20 — Batch tab: download raw fetched OSM as GeoJSON (split road/building)
- Files: build.mjs, server.mjs, index.html
- Changes:
  - build.mjs: new `roadsFromOsm(osmXml)` — one LineString per `highway` way with
    `osm_way_id` + all tags carried verbatim (raw geometry, NOT the osm2streets
    lanes/markings output).
  - server.mjs: new `GET /api/download?kind=road|building`. road → `roadsFromOsm(data/raw.osm)`;
    building → `data/buildings.geojson` as-is. Sent as an attachment
    (`Content-Type: application/geo+json`, `Content-Disposition: filename="…"`).
    Separate files per kind so the two never mix.
  - index.html: "Download raw OSM → GeoJSON" section in the Batch tab with two buttons
    (roads.geojson / buildings.geojson). `downloadGeojson()` fetches the endpoint,
    surfaces JSON errors in `#batch-status`, saves via a blob object URL.
- Verified:
  - `node --check` on server.mjs + build.mjs + extracted inline script: clean.
  - Restarted :8097. roads → 2543 LineString features (osm_way_id + highway/name/lanes/
    maxweight/surface tags present); buildings → 3639 Polygon features; kind=foo → 400
    `{"error":"need ?kind=road|building"}`. Content-Disposition attachment headers set.
- Open / follow-ups:
  - Downloads reflect the LAST fetch (data/raw.osm + data/buildings.geojson), not a
    live re-pull; matches "raw data fetched from OSM".

---

## 2026-07-20 — Batch tab: bulk CSV edit (by id → JOSM) + boundary fetch
- Tasks: 2.7 (bulk CSV), 2.8 (boundary fetch)
- Why: editing one element at a time in the viewport doesn't scale. Two new
  "modes": (1) bulk-update a list of OSM elements from a CSV of id + tag columns,
  (2) fetch OSM strictly within an imported boundary polygon instead of the map
  window. Roads and buildings are kept in SEPARATE bulk files so the two never
  conflict (a road bulk run never disturbs the building layer or current.osm).
- Files: `server.mjs`, `index.html`
- Changes:
  - **server.mjs** —
    - `mergeTags()` (update/add only, blank cell = leave unchanged) + `polyString()`
      (Number-validated `lat lon …` for Overpass `poly:`, so nothing from the
      uploaded GeoJSON is interpolated raw into the query).
    - `/api/fetch` and `/api/buildings` now accept `{ poly:[[lng,lat],…] }` as an
      alternative to `bbox` — fetch clips to the boundary via Overpass `(poly:"…")`.
    - New `POST /api/bulk {kind:'road'|'building', rows:[{id,type?,tags}]}`: fetches
      exactly those elements FROM OSM BY ID (`way(id:…);node(id:…);(._;>;);out meta;`),
      merges the CSV tags, marks `action="modify"`, and writes a per-kind file
      (`live/bulk-road.osm` / `live/bulk-building.osm`). For buildings it ALSO
      upserts `data/buildings.geojson` (via `buildingsFromOsm`) so the 3D heights
      update on the map. Returns `{matched, missing[], file}`.
  - **index.html** —
    - New **Batch** tab (3rd tab) with three grouped sections: Boundary fetch,
      Road bulk → JOSM, Building bulk → JOSM. Dashed-cyan `boundary` source/layer
      draws the imported polygon; the map fits to it.
    - Client CSV parser (`parseCSV`/`csvToRows`) + boundary parser
      (`ringFromGeojson`, Polygon/MultiPolygon/Feature/FC) with `decimate()` to
      cap the poly at ~500 pts. Bulk run fetches by id then opens a FRESH JOSM
      layer (`/import new_layer`) named `hdmap bulk <kind> <time>`; building bulk
      also refreshes the buildings source in place.
- Verified (live, against the running :8097 server + real Overpass):
  - `node --check` clean on `server.mjs` and the extracted inline script.
  - Validation: bad kind / empty rows / non-numeric ids / bad poly all 400.
  - Building bulk on way 463580599 (height=57, levels=19): `action="modify"` +
    `k="height" v="57"` in `live/bulk-building.osm`; display layer height→57.
  - Road bulk on way 116432666 (maxspeed=50): written to `live/bulk-road.osm`,
    current.osm untouched (`displayUpdated:0`).
  - Boundary `poly` fetch (triangle) returned 45 buildings inside it.
  - Restored the full demo buildings (bbox re-fetch, 1366) + removed test files.
- Update (same day): **multi-feature boundaries.** A boundary GeoJSON with many
  features (e.g. an H3 hex grid) now loads ALL of them, not just the first. Server
  `/api/fetch` + `/api/buildings` accept `polys:[ring,…]` and query the UNION via
  repeated Overpass `(poly:…)` statements + `(._;>;)`. UI lists every feature
  (label from id/name/h3/ref) with a checkbox (untick to exclude) and click-to-zoom;
  excluded features dim on the map. Verified: 2-poly union → 9 buildings vs 1-poly
  → 6. Sample: `samples/boundary-multi.geojson`.
- Open / follow-ups:
  - Bulk merge only adds/updates tags; no tag DELETE (blank = unchanged). A future
    sentinel (e.g. `*delete*`) could remove a tag if needed.
  - Boundary uses each polygon's OUTER ring only (holes ignored); a MultiPolygon
    expands to one list entry per part. Fine for typical admin/AOI/H3 grids.
  - Building bulk edits DO open a JOSM layer (contribute heights upstream). If the
    user only wants the display updated, that's a one-line toggle later.

## 2026-07-20 — Click-to-edit building height (m) + split panel into Road/Building/View
- Tasks: 2.6
- Why: heights looked "wrong" — but the code is right; ~98% of buildings in the
  fetched area (1404/1431) have NO height/levels tag in OSM, so they all take the 6 m
  default and look like one uniform slab. Real fix = let the user set a height per
  building, the same way they edit a road.
- Files: `build.mjs`, `server.mjs`, `index.html`
- Changes:
  - **build.mjs** — building features now also carry `building` (type) and
    `min_level` props so the editor can show/edit them.
  - **server.mjs** — new `POST /api/building {id, height, base, props}`: patches the
    matched feature in `data/buildings.geojson` in place and rewrites it. No rebuild,
    no version bump, no current.osm write — consistent with the independent-layer model.
  - **index.html** —
    - Panel split into **Road / Building / View** sections (`.grp` headers); the two
      `#tools` blocks became `.tools` (class) to avoid duplicate ids.
    - Buildings are now pickable: hover cursor + click on `buildings-3d`; a lane under
      the cursor still wins (roads are primary). Selected building lit by a new gold
      `buildings-hi` fill-extrusion via `setFilter` on `osm_way_id`.
    - `openEditor("building", id)` loads tags from the client geojson feature (not
      `/api`, since buildings aren't in current.osm), hides the lane editor / split /
      warnings, uses a building quick-add set, and the apply button reads "Apply height".
    - `applyBuilding()` derives height (height tag → levels×3 → keep current) + base,
      updates the extrusion immediately (`setData`), and persists via `/api/building`.
- Verified:
  - `node --check` clean on all `.mjs` + the extracted 71k-char inline script.
  - Live: `POST /api/building` round-trip on way 168945119 (6 m → 42 m persisted, type
    set) then reverted. Page serves with the new panel sections, `buildings-hi` layer,
    "Apply height" button, and building fetch button.
- Open / follow-ups:
  - Still one-building-at-a-time; no bulk "set all untagged to N m".
  - Building edits are display-only (not pushed to OSM) — by design; buildings are the
    decoupled visual layer, not part of the JOSM changeset.

## 2026-07-20 — Decouple buildings into an independent layer + NUL-byte fix
- Tasks: Phase 2 refinement (separate building lifecycle)
- Why: "Fetch OSM data" replaces the whole dataset; when the public Overpass returned
  sparse/partial road data, osm2streets built ~0 lanes and the seed's roads vanished
  (buildings still came through). Root-caused it — an injection test proved building ways
  do NOT affect road-building (default.osm: 36,117 lanes with or without 600 injected
  buildings). So the fix is architectural: make buildings their own layer.
- Files: `server.mjs`, `rebuild.mjs`, `watch.mjs`, `index.html`
- Changes:
  - **server.mjs** — reverted `/api/fetch` road query to highway-only; added
    `POST /api/buildings {bbox}` that pulls buildings only, writes `data/buildings.geojson`,
    and touches nothing else (no current.osm, no rebuild, no version bump). Imports
    `buildingsFromOsm`.
  - **rebuild.mjs / watch.mjs** — no longer write `buildings.geojson`; the road rebuild
    leaves the buildings layer alone, so fetching/resetting roads never wipes buildings.
  - **index.html** — new "⤓ Fetch buildings (this view)" button + handler: POSTs the view
    bbox to `/api/buildings`, then refreshes only the `buildings` source in place (roads
    untouched). Also fixed a pre-existing stray **NUL byte** in the `NONE` filter sentinel
    (line ~968) that made the whole file read as binary to grep/git — replaced with a
    space (same "matches nothing" semantics).
- Verified:
  - `node --check` clean on all 5 `.mjs` + the extracted inline script.
  - Restarted server on the rich seed: startup road rebuild **preserved** a sentinel
    `buildings.geojson` (3 features survived) → confirms road rebuild no longer wipes it;
    roads intact (36,117 lanes).
  - `POST /api/buildings` live: Overpass returned 230 buildings for a Pham Hung bbox,
    written independently. `{"ok":true,"count":230}`.
- Open / follow-ups:
  - Road fetch for a NEW area still depends on Overpass health (unchanged); the seed
    remains the reliable road demo.
  - Phase 3 (elevated bridges) still not started.

## 2026-07-17 — Phase 1 (2.5D camera) + Phase 2 (building extrusions)
- Tasks: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4
- Files: `build.mjs`, `generate.mjs`, `rebuild.mjs`, `watch.mjs`, `server.mjs`, `index.html`
- Changes:
  - **build.mjs** — added `buildingsFromOsm(osmXml)`: osm2streets ignores building
    ways, so we parse them from the OSM XML with `@xmldom/xmldom`, polygonize closed
    ways, and attach an inferred `height`/`base` (height tag → `building:levels`×3 m →
    6 m default; base from `min_height`/`building:min_level`). `osmToLayers` now returns
    `buildings` + `counts.buildings`.
  - **generate.mjs / server.mjs** — Overpass queries now fetch `way["building"]`
    alongside `way["highway"]` (`>` recursion pulls their nodes).
  - **generate.mjs / rebuild.mjs / watch.mjs** — each now writes `data/buildings.geojson`.
  - **index.html (Phase 1)** — `maxPitch:80`; added `light` (anchor:map, for extrusion
    shading) and a soft `sky` to the style; a "3D view (tilt)" toggle that eases pitch
    0↔55; editor picking untouched (still MapLibre `queryRenderedFeatures`).
  - **index.html (Phase 2)** — new `buildings` GeoJSON source + `buildings-3d`
    `fill-extrusion` layer (`fill-extrusion-height/base` from feature props), drawn after
    the road surface and before the overlays; "Buildings (3D)" toggle; buildings added to
    the live-reload path so a JOSM save / changeset refreshes them in place.
- Verified:
  - `node --check` clean on all 5 `.mjs` files; extracted index.html inline script (62.9k
    chars) parses via `node --check`.
  - Data pipeline: `generate.mjs` on Pham Hung areas produced buildings with correct
    inferred heights (e.g. "FPT Building" levels=17→51 m, "AC Building" 10→30 m,
    untagged→6 m). Focused bbox: 4301 buildings; full seed bbox: 13243.
  - Committed `default.osm` still rebuilds the rich seed (184,930 markings, 7,825
    intersections, 0 buildings — as expected, seed is highway-only).
  - Server boot (PORT 8099) on a building-rich seed: `index.html` HTTP 200,
    `/data/buildings.geojson` HTTP 200 with 13,243 features → confirms `rebuild.mjs`
    writes buildings and the server serves them.
- Open / follow-ups:
  - **Seed has no buildings** (committed `default.osm` was fetched highway-only): a fresh
    checkout shows roads immediately and buildings after clicking "Fetch OSM data (this
    view)". Baking buildings into the seed = re-fetch the area with buildings (bigger
    file); deferred, offered to user.
  - Public Overpass returned 504 / sparse highways on big-bbox re-fetches — a data-source
    reliability quirk, not our code; the committed seed remains the reliable road demo.
  - Phase 3 (elevated bridge extrusion via `layer`) NOT started — the experimental tier
    with the ramp-cliff / z-fight caveats (see `tasks.md` Phase 3, `plan.md` §5).

## 2026-07-17 — Planning docs created (no code yet)
- Tasks: —
- Files: `plan.md`, `tasks.md`, `runtasklog.md`
- Changes:
  - Added `plan.md` §5 "3D / 2.5D Visualization (Next Phase)" — strategy, the
    `layer`-is-not-height caveat, tiers, and a risk-ordered sequence.
  - Created `tasks.md` — detailed Phase 0–5 breakdown with acceptance criteria and open
    decisions.
  - Created this log.
- Verified:
  - Docs only; no runtime change. Existing 2D viewer untouched.
- Open / follow-ups:
  - Start Phase 0.1 (confirm `bridge`/`tunnel` reach the GeoJSON) before writing height
    rules.
  - Awaiting go-ahead to implement Phase 1 (pitch/sky) + Phase 2 (building extrusions),
    the low-risk chunk.
