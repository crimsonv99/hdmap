# hdmap — 3D/2.5D Task Breakdown

Detailed, checkable tasks for the 3D phase described in [`plan.md`](plan.md) §5.
Ordered **by risk** (safe wins first). Progress is logged in
[`runtasklog.md`](runtasklog.md).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked/needs decision.

---

## Phase 0 — Prep & guardrails (no visual change yet)

- [ ] **0.1 Confirm elevation inputs survive the pipeline.**
  - Check whether `bridge`, `tunnel`, `layer` reach the GeoJSON out of `build.mjs`
    (`layer` is confirmed present; `bridge`/`tunnel` unverified).
  - Files: `build.mjs` (feature property assembly), inspect `data/lanes.geojson`.
  - Accept: know exactly which tags are available per feature before writing height rules.

- [ ] **0.2 Add an inferred-height ruleset in `build.mjs` (data only, renderer ignores it for now).**
  - Emit `base` (metres) and `height` (metres) per feature:
    - `base` from `layer` (`+1 ≈ 5.5 m` clearance, `-1` → below grade), gated by
      `bridge`/`tunnel` where available so non-bridge `layer` tags don't float.
    - lane/road deck `height` = small deck thickness constant.
    - curb/median/barrier heights = constants.
  - Document constants at the top of `build.mjs` as "estimated, not survey."
  - Files: `build.mjs`. Accept: `data/*.geojson` features carry `base`/`height`; existing
    2D renderer still works unchanged.
  - Risk: `layer` is stacking order, not elevation (see plan §5 caveat) — keep the rule
    small and documented.

- [ ] **0.3 Snapshot current 2D render** (screenshot / notes) as a visual regression baseline.

---

## Phase 1 — MapLibre 2.5D: pitch + sky + light  *(index.html only, zero data work)*

- [ ] **1.1 Enable camera tilt/rotate.**
  - `dragRotate`/`touchPitch` on; sensible `maxPitch`; keep the existing `f`-to-frame key.
  - Files: `index.html` (map init ~L797). Accept: can tilt/rotate; 2D still default-on load.
- [ ] **1.2 Add a `sky` layer + directional light** for depth shading.
  - Files: `index.html` (style `layers`/`light`). Accept: horizon + subtle shading, no
    perf regression at the default Pham Hung view.
- [ ] **1.3 Add a "3D" / pitch toggle button** in `#panel` (default off = today's top-down).
  - Files: `index.html` (`#panel`, `bind` helpers ~L928). Accept: toggle flips pitch and
    persists during pan/zoom.
- [ ] **1.4 Verify editor still works when pitched** (hover/select/click, popups).
  - Accept: picking + tag editor unaffected at pitch>0.

---

## Phase 2 — Building extrusions  *(context win, low risk)*

- [ ] **2.1 Extend Overpass query to buildings.**
  - Add `building` to the query (currently `way["highway"]` only, `generate.mjs` ~L25);
    thread through `server.mjs` fetch path too.
  - Files: `generate.mjs`, `server.mjs`. Accept: raw OSM now contains building ways.
- [ ] **2.2 Emit a `buildings.geojson` layer from `build.mjs`.**
  - Polygonize building ways; compute `height` = `height` tag → `building:levels × 3 m`
    → default (e.g. 6 m). Emit `min_height`/`base` if present.
  - Files: `build.mjs`. Accept: new `data/buildings.geojson` with per-feature height.
- [ ] **2.3 Render buildings as `fill-extrusion`.**
  - New source + `fill-extrusion` layer under the HD road band; muted palette; respects
    the `sky`/light from Phase 1.
  - Files: `index.html`. Accept: buildings rise in 3D; roads still read on top/clearly.
- [ ] **2.4 Wire building visibility into the layer toggles + HD-opacity slider.**
  - Files: `index.html` (`bind`, `HD_OPACITY` ~L969). Accept: buildings toggle/fade like
    other layers.

---

## Phase 3 — Elevated roads (bridges/tunnels)  *(EXPERIMENTAL — the hard tier)*

- [ ] **3.1 Convert road/intersection/marking fills to `fill-extrusion`** driven by
  `base`/`height` from Phase 0.2.
  - Files: `index.html` (`bandFills`, `bandEdges`, intersection layers L651-756).
  - Accept: `layer>=1` roads visibly lift over `layer=0` beneath them.
- [ ] **3.2 Mitigate coplanar z-fighting** among overlapping `layer=0` polygons (forks /
  dual carriageways — see comment L664-669) and marking-on-deck.
  - Options: dedupe/merge overlaps in `build.mjs`; tiny epsilon base offsets per feature
    class (deck < paint < curb).
  - Accept: no flicker at forks or on lifted decks when orbiting the camera.
- [ ] **3.3 Keep markings/arrows on the deck surface.**
  - Markings inherit the deck's `base` + tiny height so they don't float/sink.
  - Files: `build.mjs` (propagate base to markings/turn arrows), `index.html`.
  - Accept: a stop line on a lifted bridge sits on the deck.
- [ ] **3.4 Preserve picking across both elevation bands.**
  - The existing topmost-layer tiebreak (`LANE_LAYERS`, `topWayId` L1002-1009) must still
    select the bridge over the road beneath in a pitched view.
  - Accept: clicking a flyover selects the flyover way, not the road under it.
- [ ] **3.5 Decide satellite behaviour under lifted geometry.**
  - Satellite is a flat z=0 raster (L806-810); extruded bridges will hover over it.
  - Decision `[!]`: keep it a ground plane (accept hover) vs. drape/skip in 3D mode.
  - Accept: documented choice; tracing workflow still usable.
- [ ] **3.6 Handle/annotate the ramp cliff** (plan §5 caveat).
  - Minimum: document it; optional: taper deck ends or mask with a ramp guess.
  - Accept: known, documented, not a silent surprise.

---

## Phase 4 — deck.gl additive overlay  *(Tier 2, future)*

- [ ] **4.1 Load deck.gl UMD from CDN; mount `MapboxOverlay` (interleaved).** No bundler.
- [ ] **4.2 `ScenegraphLayer` glTF models** for traffic signals/signs at junctions.
- [ ] **4.3 `TripsLayer` animated traffic** — requires stitched lane centerlines/paths
  (graph work; scope separately).
- [ ] **4.4 Keep all editable HD layers on MapLibre** — deck.gl is additive only, so the
  editor picking is never moved.

## Phase 5 — Three.js custom layer  *(Tier 3, reserve)*

- [ ] **5.1** Only if a photoreal/cinematic result is needed; re-owns picking/interaction.

---

## Cross-cutting acceptance

- [ ] No new build step / bundler (keep the dependency-light, static-served setup).
- [ ] 2D top-down remains the default load; 3D is opt-in.
- [ ] Editor (stage/submit/JOSM handoff) unaffected by any 3D change.
- [ ] README + plan updated; runtasklog kept current.

## Open decisions `[!]`
- 3.5 satellite ground-plane vs drape in 3D.
- Default building height when untagged (6 m assumed — confirm).
- Whether to invest in ramp-cliff mitigation (3.6) now or defer.
