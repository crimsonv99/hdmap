# Navigation Feature — Task List

Client-side turn-by-turn navigation for the MVP 3D map. Routing runs entirely
in the browser (no backend, stays standalone from GitHub Pages) on a prebaked
routing graph. Two presentation modes: **2D** (familiar Google-style) and **3D**
(follow-cam drive mode — our differentiator).

**Rules for this list**
- Do **one task at a time**. Stop after each for review before starting the next.
- Each task below states: *Why* (reason), *How* (logic), *Expected result*.
- A task is "done" only when its Expected result is demonstrably true.

**Key constraint driving the design:** vector tiles are clipped at tile borders
by tippecanoe, so road lines are cut into disconnected pieces at every tile edge.
We therefore cannot route on tile geometry. Instead we prebake a proper routing
graph (`graph.json`) with full, unclipped connectivity, ship it as a static file,
and run A* on it in the browser.

---

## Phase A — Routing data

### Task 1 — Prototype the graph emitter and measure size  ✅ DONE
- **Result (Hanoi urban core extent):** 71,613 junction nodes, 88,197 edges.
  Draft raw 20.93 MB / **4.09 MB gzipped**. Go — a single lazily-loaded file is
  viable; compaction in Task 2 targets ~1.5–2.5 MB gz.
- **Decision:** `service` roads are 53% of edges. **Keep them but penalize** in the
  routing cost (reachable for first/last-meters access, not used as through-routes,
  like Google). Prototype: `scratchpad/graph-proto.mjs`.
- **Why:** Before committing to shipping a graph, we must know how big it is for
  the covered extent. A huge JSON would blow up page load. This de-risks the whole
  approach with a throwaway measurement.
- **How:** In the build pipeline, walk the road ways (highway=*) from the OSM
  extract already fetched in `build.mjs`. Split each way at shared nodes to form
  graph edges. Emit a *draft* `graph.json` (`nodes[]`, `edges[]`) with raw
  (uncompacted) fields. Print node count, edge count, and file size (raw + gzipped).
- **Expected result:** A printed report of counts and size for the current extent,
  and a rough go/no-go on whether one file is viable or we need compaction/tiling.
- **Files:** `build.mjs` (or a scratch script), console output only.

### Task 2 — Finalize compact graph format and bake it  ✅ DONE
- **Result:** Baker is `bake-graph.mjs` → `data/graph.json` (committed + served,
  since `build/` is gitignored). 71,613 nodes, 88,197 edges, **5.89 MB raw /
  1.81 MB gzipped** (from 20.93/4.09 draft). Integrity verified: 0 out-of-range
  or zero-length edges (sub-meter edges clamped to 1 m). Schema documented at the
  bottom of this file. Re-run any time with `node bake-graph.mjs`.
- **Why:** The draft is too fat to ship. We want the smallest file that still
  routes correctly.
- **How:** Index-based edge refs (edges reference node indices, not coordinates),
  coordinates rounded to ~6 decimals, per-edge fields limited to what routing needs:
  `length_m`, `highway_class` (for speed), `oneway`, and `name` (for maneuvers).
  Produce the final `build/graph.json`.
- **Expected result:** `graph.json` exists at a sane size (target: single-digit MB
  or less for the current extent), with a documented schema at the top of this file.
- **Files:** `build.mjs`, `build/graph.json`.

---

## Phase B — Routing core (no fancy UI yet)

### Task 3 — Load the graph in the browser and build adjacency  ✅ DONE
- **Result:** `NAV` module in `index.html`. `NAV.ensureGraph()` lazy-fetches
  `data/graph.json` exactly once (also exposed as `window.NAV` for dev). `build()`
  makes an oneway-aware adjacency `Map<nodeIdx, [{to,e,len,cls}]>` + per-class
  speed table (m/s). Verified: 71,557/71,613 nodes have out-edges; **164,422
  directed entries = 2×76,225 both-way + 11,961 + 11 oneway (exact)**; 56 oneway
  sinks; busiest node = real 6-way junction. Graph served 200 as application/json.
  Load fires on first `map.idle` (self-check logs to console); no visible UI yet.
- **Why:** A* needs an in-memory adjacency structure; loading must not stall the map.
- **How:** Fetch `graph.json` after the map loads (lazy / on first nav use).
  Build `adjacency: Map<nodeId, Array<{to, edgeId, length_m, class}>>`, respecting
  `oneway`. Verify by logging node/edge counts and a sample neighbor lookup.
- **Expected result:** Console confirms graph loaded, adjacency built, counts match
  `graph.json`. Map still loads at normal speed. No visible UI change yet.
- **Files:** `index.html`.

### Task 4 — Snap a clicked point to the nearest road  ✅ DONE
- **Result:** 🧭 Route button toggles pick-mode (crosshair cursor + top hint pill).
  `NAV.snap(lng,lat)` brute-forces the nearest point over all edge segments in a
  local planar frame → `{e, lng, lat, node, distM}`; ~**3.15 ms/snap**, so no
  spatial index needed. First click drops a green **A** pin, second a red **B**
  pin (both snapped onto the road, not the cursor), third click resets. Verified:
  arbitrary points snap 1–20 m onto real roads. `NAV.fullGeom(e)` added for edge
  geometry. Double-click-copy is suppressed while picking.
- **Follow-up fix (during review):** the existing "click road → info popup"
  handler was firing on the same click that places a pin. Guarded with
  `if (NAV.pickMode) return;` so pick-mode clicks only drop pins.
- **Known nit (refine in Task 9):** hovering a building overrides the crosshair
  cursor briefly (building hover handler). Cosmetic only.
- **Why:** Users click anywhere; we must anchor start/end onto the actual network.
- **How:** On click, find the nearest graph edge (point-to-segment distance) and
  the nearest node on it. Drop a marker at the snapped point. Two clicks set
  start (A) then end (B); a third click resets.
- **Expected result:** Clicking near a road drops a marker exactly on the road, not
  where the cursor was. A/B markers visible and distinguishable.
- **Files:** `index.html`.

### Task 5 — A* routing core + draw the raw route  ✅ DONE
- **Result:** `NAV.route(sA, sB)` = A* over the adjacency with a `MinHeap`. Cost =
  travel time (`len / class-speed`), service roads ×`service_penalty` (4) so they're
  access-only. Admissible heuristic (straight-line time at fastest class speed) →
  shortest-*time* path. Returns `{nodes, coords, distM, timeS}`. Placing the 2nd
  pin auto-computes; the route draws as a blue line (`nav-route` source +
  `nav-route-line` layer) and the hint shows `km · ~min`. 3rd click / toggling off
  clears it. "No route" handled. Verified in Node: 7–11 km routes, all reachable,
  ~5 ms typical (worst 43k pops <50 ms); stitched geometry continuous and correctly
  oriented (start coord = A node, end coord = B node, 0 bad jumps).
- **Why:** This is the heart of the feature — the actual path computation.
- **How:** A* from snapped A to snapped B. Cost = `length_m / class_speed`
  (a static speed table by `highway_class`). Heuristic = great-circle distance /
  max speed (admissible). Return the ordered node list + stitched geometry. Draw it
  as a plain line layer (styling comes later).
- **Expected result:** Two clicks produce a connected route line following real
  roads from A to B, with no gaps at former tile boundaries. Handles "no route
  found" gracefully.
- **Files:** `index.html`.

---

## Phase C — Route presentation & info

### Task 6 — Route styling (day + dark-mode neon)  ✅ DONE
- **Result:** Route is now a two-layer ribbon — wide `nav-route-casing` under a
  bright `nav-route-core`, zoom-interpolated widths. `styleRoute(dark)` recolours
  both: day = blue core (#2f6bd6) on a navy outline; dark = cyan core (#00e5ff)
  with a blurred cyan casing that fakes a neon glow. Hooked into `applyTheme` so
  the ribbon flips with the 🌙 toggle, and `ensureRouteLayer` calls it so a route
  drawn while already dark comes up cyan.
- **Why:** The raw line looks rough; a proper casing/glow makes it read as a route.
- **How:** Two-layer line (wide casing + bright core). Day: blue core / white casing.
  Dark: cyan neon core matching the existing night theme. Hook into `applyTheme`.
- **Expected result:** Route looks polished in both themes; glows cyan in dark mode.
- **Files:** `index.html`.

### Task 7 — Distance and ETA  ✅ DONE
- **Result:** Dedicated `#nav-summary` card (bottom-center) shows `🚗 <dist> · ~<dur>`
  with a ✕ clear button; the hint pill now only carries pick instructions.
  `fmtDist`/`fmtDur` give human units (m / km, "< 1 min", "1 h 5 min"). **Correctness
  fix:** ETA now uses REAL travel time (Σ len/speed, no penalty), computed in
  `route()` alongside distance — the A* gScore was service-penalty-inflated and
  over-reported (e.g. a 272 m-service route read ~14 min but is really ~12 min).
  `resetNav()` unifies teardown (pins + line + card + hint) across 3rd-click,
  toggle-off, and the ✕ button.
- **ETA realism enhancement (user request):** posted maxspeed / free-flow badly
  overstates real urban travel. Added a client-side `ETA_SPEED_KMH` effective-speed
  model (achieved averages: primary 30, residential 18, service 10, motorway 65…),
  capped at the free-flow routing speed, built into `NAV.etaSpeed` and used for the
  ETA only — routing preference still uses graph free-flow speeds. Result: effective
  ~26–31 km/h city speeds (was 45–51); a 7.7 km trip now reads ~18 min, not 10.
  Table is easy to tune (client-side, no re-bake).
- **Why:** Every nav tool answers "how far / how long"; cheap to compute now.
- **How:** Sum edge `length_m` for distance. ETA = sum of `length_m / class_speed`.
  Format (e.g. "3.2 km · 8 min").
- **Expected result:** A readout shows total distance and estimated time, updating
  each time a route is computed. Values are plausible against the drawn path.
- **Files:** `index.html`.

### Task 8 — Turn-by-turn maneuver generation  ✅ DONE
- **Result:** `route()` now builds oriented "legs" and returns `maneuvers[]`.
  `buildManeuvers` computes bearing-in vs bearing-out at each junction → signed
  delta → `classifyTurn` (slight/turn/sharp left|right, U-turn) with the street it
  turns ONTO and the distance to the next maneuver. Start = "Head <compass> on X";
  ends with "Arrive at destination". Straight same-street segments collapse; a real
  rename emits "Continue onto Y". Verified: 175 legs → 19 maneuvers, distances sum
  exactly to route total, instructions read correctly with real street names.
  Logged to console for now; rendered as a panel in Task 9.
- **Why:** Directions are the point of navigation, not just a line.
- **How:** At each interior node, compute bearing-in vs bearing-out delta →
  classify (sharp/normal/slight left/right, continue, U-turn). Attach street `name`
  and distance-to-next-maneuver. Collapse consecutive "continue" on the same street.
- **Expected result:** An ordered list of maneuvers ("Turn left onto X — 400 m")
  that matches the drawn route when eyeballed.
- **Files:** `index.html`.

---

## Phase D — The two modes

**Design direction (from Amap/高德 references + user decisions):**
Adopt the *structural* UX (banner, ribbon, car, bottom bar, arrival clock); skip
the data-gated bits we can't do truthfully.
- **Route color:** single clean color (blue day / neon route). NO fake traffic
  congestion coloring — we have no live traffic feed.
- **Alternatives:** single best route only (fastest by realistic speeds).
- **3D extras chosen:** car marker + simulated speed readout. NOT included:
  traffic-signal countdowns (no timing data), route congestion/side progress bar,
  transit/cycling/walking mode tabs (driving only).
- **Our edge over Amap:** the route rides REAL HD lane geometry, not a stylized
  illustration (leveraged fully in Task 11).

### Task 9 — 2D navigation mode (Amap/Google-style planning)  ✅ DONE
- **Result:** A `#nav-panel` directions card (left) renders on route: header with
  **ETA (dist) · via <road> · Arrive ~clock**, A/B rows (snapped street names) with
  a ⇅ **swap** button, and a scrollable **turn-by-turn step list** (turn glyph +
  instruction + distance, from Task 8's maneuvers). Panel **hides via the ‹ button**
  and reopens via a floating **📋 Directions** button (`#nav-steps-btn`) — the
  show/hide toggle requested. On compute, the map flattens to pitch 0 and
  `fitRoute` frames the whole route with left padding for the panel. `resetNav`
  tears the panel down too. `NAV.edgeName(e)` added for the A/B labels.
- **Why:** Familiar, trusted top-down view; the everyday-use mode.
- **How:** Flatten to pitch 0. Planning header with A/B fields + swap + a big GO
  button (adapt the existing pick UI). A maneuver-list panel (from Task 8) with a
  top current-step banner, distance-to-next, and total distance · ETA · arrival
  clock. Single blue route. Start/Clear controls.
- **Expected result:** A recognizable 2D nav layout: A→B fields, route on a flat
  map, scrollable step list, current-step banner, arrival time, clear works.
- **Files:** `index.html`.

### Task 10 — 3D follow-cam drive mode  ✅ DONE
- **Result:** GO button in the panel launches `startDrive(r)`. A `requestAnimationFrame`
  loop walks distance `d` along the route (cum-distance table over `r.coords`) at the
  current road's effective speed ×`PLAYBACK`(6); `sampleAt` interpolates position +
  heading; camera `jumpTo` a point `LOOK_AHEAD_M` ahead, pitch 72, zoom 17.5 (below the
  overzoom-bug threshold), bearing = heading. **Car marker** (SVG, viewport-up) leads.
  HUD: **top banner** (turn glyph + distance-to-next-turn + upcoming road), **speed
  readout** (current road effective km/h), **bottom bar** (remaining dist · time ·
  arrival clock) with **pause/exit**. `hideForDrive` hides planning chrome; exit restores
  it + re-frames the route. Verified in a tick sim: geometry aligns (cum≈distM), all
  turns tracked, 0 negative distance-to-turn frames, ends on "arrive", realistic speeds.
- **Why:** The differentiator — a cockpit fly-through no browser map offers.
- **How:** Animate the camera along the route (interpolate position + bearing),
  tilt ~70–75°. **Car marker** at the camera focus with a compass sense; dark
  **top maneuver banner** (turn icon + distance-to-turn + next road name);
  **simulated speed readout** (km/h from the current edge's effective speed);
  bottom bar (remaining dist · ETA · arrival clock). Play/pause. Pairs with neon
  night theme; route ribbon rides the real HD lanes.
- **Expected result:** Pressing "Drive" flies the camera smoothly along the route
  through turns, car marker leading, banner showing the next turn + distance,
  speed readout live, bottom bar counting down.
- **Files:** `index.html`.

---

## Phase E — Differentiators & polish (stretch)

### Task 11 — Lane-level guidance  ✅ DONE (pivoted to lane-corridor highlight)
- **Data finding:** `allowed_turns` exists on lanes but is **empty on ~99.9%** of
  Driving lanes (7992/8000) — OSM `turn:lanes` tagging is sparse in Hanoi. So the
  classic "be in the left-turn lane" would light up almost nowhere. Lanes DO carry
  abundant geometry + `osm_way_ids`/`direction`/`index`.
- **Result:** Pivoted to the achievable, more impressive version — during the 3D
  drive, a `lane-guide` fill layer (green, below buildings) **highlights the real HD
  Driving-lane polygons around the car**, found by `queryRenderedFeatures` in an
  ahead-biased box (throttled 180ms), deduped by way/road/index. This is the true
  "better than Google" moment: the route rides actual lane geometry, not a stylized
  illustration. Cleared on exit.
- **Route-hug fix (user feedback "highlight looks unrelated to the trip"):** the
  tiles dropped the lane→way link (`-y` allowlist kept `osm_way_id` but lanes use
  `osm_way_ids`), so lanes can't be matched to the route by id. Instead the highlight
  now keeps only Driving lanes that (a) sit within 13 m of the route centerline AND
  (b) run within 35° of the local route heading — dropping cross-streets (rejected
  even at 1.4 m by the angle test) and neighbouring roads (rejected by distance).
  Verified with a synthetic test. Precise per-lane/direction would need a tile re-bake
  (user chose the geometric fix).
- **Refinement 2 (user spec: only current way + 1 ahead, only on-route, exclude
  oncoming):** (1) route ribbon made semi-transparent (core 0.55/0.7, casing 0.4)
  so the lane highlight leads; (2) highlight WINDOWED to the corridor from the car
  to ~1 leg ahead (built in tick from cum/turnAt), not the whole route; (3) added a
  signed side-of-travel test (right-hand traffic → keep lanes on the right of the
  route centerline, `signed <= 2 m`), excluding the oncoming carriageway. Verified
  with synthetic tests (our/centerline lanes kept, oncoming dropped).
- **Refinement 3 → PRECISE re-bake (user: geometric still wrong at junctions).**
  Restored the true lane→way link: `bake-graph.mjs` now emits a `wayids[]` array
  (way id per edge); `bake-tiles.sh` KEEP now includes `osm_way_ids` + `direction`
  (tiles re-baked, 118→127 MB, ~30 s). `route()` returns `legWays` (way id + Fwd/Back
  travel dir per leg); drive merges them into way-runs and highlights lanes whose
  `osm_way_ids` ∈ {current way, next way} AND `direction` matches travel — exact, so
  no cross-street/oncoming/parallel false positives, and it fills the approach fully.
  Verified in data: a 175-leg route's ways carry 420 Driving lanes (350 Fwd / 70 Back).
- **Caveats:** junction *interiors* are osm2streets "intersection" polygons (not
  Driving lanes), so a small gap remains inside big junctions; if Fwd/Back ends up
  reversed on undivided roads it's a one-line flip. Geometric helpers now unused
  (dead code to trim in Task 12).
- **Files:** `index.html`.

### Task 12 — Re-route, search-to-route, and polish  ✅ DONE
- **Result:** (1) **Search-to-route** — when 🧭 pick mode is on, typing a `lat,lng`
  in the Fly-to box drops the next A/B point (snapped) instead of just flying.
  (2) **Out-of-extent guard** — clicks/searches >150 m (`SNAP_MAX_M`) from any road
  show "No road near there — pick a point on the mapped area" instead of snapping to
  a far edge. (3) **Disconnected pairs** already handled ("⚠ No route found").
  (4) **Polish** — crosshair no longer flips to a pointer over buildings during pick
  mode; removed the dead geometric helpers (`ringCentroid`/`longAxisBearing`/
  `angDiff180`/`nearestOnRoute`/`routeCoords`) left over from the superseded lane
  approach. Parses clean, no dangling refs.
- **Files:** `index.html`.

---

## Known issues (not part of the nav feature)

- **Wide roads lose fill when overzoomed** — ✅ FIXED by re-baking to z18.
  Root cause (confirmed by decoding tiles): NOT dropped data (the z17 tile had the
  lanes) but **overzoom + tile-edge clipping** of large lane polygons past the z17
  cap. The editor looks perfect because it draws un-tiled GeoJSON (no clip, no cap).
  Fix: `MAXZOOM=18 ./bake-tiles.sh` + viewer source `maxzoom: 18`, so the drive
  range (~18.2) renders native tiles, not stretched z17. Tiles 127→211 MB, ~35 s bake.

---

## graph.json schema (Task 2)

Emitted by `bake-graph.mjs` from `build/city.osm.pbf` → `data/graph.json`.
Everything is index-based to stay small. Coordinates are `[lon, lat]`, 6-dp.

```jsonc
{
  "meta": {
    "bbox": [W, S, E, N],            // graph extent
    "center": [lon, lat],
    "nodes": 71613,                  // == nodes.length / 2
    "edges": 88197,                  // == edges.length
    "speeds_kmh": { "<class>": 30 }, // free-flow speed per highway class (A* cost)
    "service_penalty": 4,            // A* multiplier for service roads (Task 5)
    "edge_layout": [ ... ]           // human note of the edge tuple order
  },
  "classes": ["residential", "primary", ...],  // string table; edge.cls = index
  "names":   ["Phố Mã Mây", ...],               // string table; edge.name = index (-1 = unnamed)
  "nodes":   [lon, lat, lon, lat, ...],         // flat; node index i -> (nodes[2i], nodes[2i+1])
  "edges":   [ [a, b, len_m, cls, oneway, name, ...interior], ... ]
}
```

**Edge tuple** = `[a, b, len_m, cls, oneway, name, ilon, ilat, ilon, ilat, ...]`
- `a`, `b`   — node indices (into `nodes`) for the two junction endpoints
- `len_m`    — edge length in metres (integer, ≥1)
- `cls`      — index into `classes`
- `oneway`   — `0` both directions · `1` a→b only · `2` b→a only
- `name`     — index into `names`, or `-1` if unnamed
- `...`      — flat interior shape points (lon,lat pairs), **excluding** endpoints;
               full render geometry = `nodes[a]` + interior + `nodes[b]`.

