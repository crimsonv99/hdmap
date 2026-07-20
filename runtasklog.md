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
