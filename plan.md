# hdmap: Staging Editor & JOSM Integration Plan

This plan details the transformation of the `hdmap` tool from an instant-apply live previewer into a professional changeset-based staging editor. It incorporates auto-fetching from Overpass based on map view, staging edits locally in the browser, and automating the push into JOSM for final upload to OpenStreetMap.

## 1. Seed Data via UI (Auto-BBox)
- Add a new "Fetch OSM Data" button in the map's UI panel.
- When clicked, it grabs the map's current bounding box (based on where you have zoomed/panned). - but this will change late when we have internal DB PBF file, saved in postgresql (postgis).
- It sends this to a new backend endpoint (`POST /api/fetch`).
- The backend fetches the raw XML from the Overpass API, saves it to `live/current.osm`, and triggers `osm2streets` to rebuild the HD map layers.

## 2. Staging Edits Locally (Browser State)
- Introduce a `pendingEdits` object in the frontend's JavaScript state to temporarily hold changes.
- Change the existing "Apply & preview" button in the lane tag editor to say **"Stage Edit"**.
- Clicking "Stage Edit" will save the changes into the `pendingEdits` memory and close the editor panel, but it will **not** send an API request to the backend yet.
- *Note: Because the HD geometry is generated on the Node.js backend, staged edits will not visually update on the map until the entire changeset is submitted. Show for the preview to let editor where or which feature they have edited, make those have colorful color*

## 3. Changeset Submission (Batch Write)
- Add a new global button: **"Submit Changeset"** (which shows the count of staged edits).
- Clicking this button bundles all `pendingEdits` into a single JSON payload and sends it to a new backend endpoint (`POST /api/changeset`).
- The backend loops through all edited ways, replaces their tags, adds `action="modify"`, and writes everything to `live/current.osm` in one go.
- The backend then rebuilds the HD map layers, and the browser visually updates.

## 4. JOSM Remote Control Automation
- Expose `live/current.osm` over the local web server so JOSM can fetch it via HTTP.
- As soon as the changeset submission is successful, the browser will automatically execute a background fetch request to JOSM's Remote Control API:
  `http://localhost:8111/import?url=http://localhost:8097/live/current.osm`
- This forces JOSM to instantly open your modified file.
- A success message will appear in the UI reminding you to review the data in JOSM and click "Upload".

*(Note: To use Step 4, you must have JOSM running on your machine with the Remote Control feature enabled in preferences).*

---

## 5. 3D / 2.5D Visualization (Next Phase)

Sections 1–4 above are built. This phase adds depth to the viewer: tilt/rotate the
camera, extrude buildings and elevated interchanges, and (later) animate traffic — so
the flat HD ribbons read as a real scene. Detailed task breakdown lives in
[`tasks.md`](tasks.md); implementation progress is logged in
[`runtasklog.md`](runtasklog.md).

### Why 3D here
The roads are flat ribbons, so "3D" is not about tall tarmac. The wins are:
- **Perspective (2.5D)** — pitch/rotate so lanes, arrows and junctions read like a scene.
- **Elevated interchanges** — lift bridges/flyovers over the roads they cross (Hanoi is
  full of these). This is the marquee visual, and also the hardest (see caveat).
- **Context** — extruded buildings; extruded curbs/medians for the "molded" HD look.
- **Life (later)** — animated vehicles flowing along lanes.

### The data we already have
`build.mjs` propagates a per-feature `layer` tag (see
[`build.mjs`](build.mjs) → lane/turn-arrow properties) that `index.html` already uses for
draw-order banding and casing thickness. That same value is the seed for elevation.

### Critical caveat — `layer` is *stacking order*, not *height*
OSM `layer` means "above/below what I cross **here**," not an absolute elevation.
Consequences we design around:
- A bridge tagged `layer=1` floats for its **whole length**, even where nothing is under it.
- **Ramp cliff:** flyovers ramp gradually from grade to deck, but `layer → constant
  height` is a step function, so an elevated deck sits flat then drops **vertically** to 0
  where it meets its `layer=0` approaches. osm2streets gives us no ramp geometry.
- Heights are therefore **inferred, not survey** — same honesty as our inferred widths.
  Key height off `bridge`/`tunnel` **and** `layer`, and expect/mitigate the cliff.

### Tiers (how far we go)
- **Tier 1 — MapLibre 2.5D (cheap, no new deps).** Pitch + sky + directional light;
  `fill-extrusion` driven by inferred height for buildings and elevated roads; extruded
  curbs. Our existing polygons feed in (with z-fighting mitigation — see tasks).
- **Tier 2 — deck.gl as an *additive* overlay (CDN UMD, no bundler).** ONLY for buildings,
  glTF models (signals/signs) and animated traffic. The editable HD layers **stay on
  MapLibre** so the existing editor picking (`queryRenderedFeatures`, way/node select)
  keeps working untouched.
- **Tier 3 — Three.js custom layer (reserve).** Photoreal/cinematic only; re-owns picking.

### Sequenced by risk (not by tier number)
Because elevation is the riskiest part, we do the safe wins first:
1. **Pitch + sky + light** — `index.html` only, instant 2.5D, zero data work.
2. **Building extrusions** — extend the Overpass query (currently `way["highway"]` only)
   to `building`; extrude by `building:levels × 3 m`. Biggest early payoff, low risk.
3. **Bridge/tunnel extrusion — experimental** — add `height`/`base` in `build.mjs`;
   accept/mitigate the ramp cliff and coplanar z-fighting; keep markings on the deck;
   keep picking working across both elevation bands; decide satellite ground-plane
   behaviour.
4. **deck.gl additive overlay** — models + animated traffic, MapLibre stays source of truth.
5. **Three.js** — held in reserve.

### Non-goals (for now)
- **DEM/terrain** — Hanoi is flat; bridges matter far more. Skipped.
- **Rewriting the editor onto another renderer** — the editor stays on MapLibre.
- **Routed traffic simulation** — animated flows need stitched lane centerlines (graph
  work); scoped into Tier 2, not Tier 1.
