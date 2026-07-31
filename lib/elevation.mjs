// elevation.mjs — shared road-elevation logic for the osm2street tools.
// VENDORED into MVP-3D-MAP/lib so this repo builds standalone. Source of truth:
// the osm2street-root elevation.mjs; keep in sync if you edit it there.
//
// Pure data, no renderer, no I/O. Turns the OSM `layer` tag into a per-vertex
// altitude with automatic tilt ramps at junctions. Imported by both
//   MVP-3D-MAP/bake-graph.mjs   and   hdmap/build.mjs
// so the two tools agree on exactly where every road sits in z.
//
// Model (see design notes in the PR): altitude is keyed off NODES, not ways, so
// roads that share a junction can never crack apart vertically.
//   1. layer(way)      = clamp(parseInt(layer)||0, -5..+5)          — the OSM `layer`
//   2. altitude(node)  = layer CLOSEST TO GROUND among roads meeting here, * H — the
//                        junction sits at ground when a surface road is present, and
//                        the road FARTHEST from ground (overpass OR tunnel) ramps to
//                        reach it. (Using plain min would drag surface roads DOWN into
//                        a tunnel mouth; closest-to-zero keeps them flat.)
//   3. a way cruises at its own layer height and RAMPS between that and each
//      endpoint's node altitude over RAMP_M. That yields, for free:
//        both ends equal  -> flat        (ordinary road)
//        one end at ground -> a tilt/ramp  (on-ramp; the classic A0-B1-C1 case)
//        both ends at ground, layer>0 -> a hump (overpass, crest mid-span)
//        both ends at ground, layer<0 -> a dip  (tunnel/underpass, trough mid-span)
//   Grade separations (a bridge crossing a road with NO shared node) never ramp —
//   they simply pass at different z, which is already how OSM models them.

export const LAYER_HEIGHT = 5;   // metres of altitude per OSM `layer` step
export const RAMP_M = 70;        // horizontal metres a road ramps to a junction (~7% grade to +5 m — realistic, and gentle enough that the stepped deck reads smooth)
export const LAYER_MIN = -5, LAYER_MAX = 5;

// OSM `layer` tag -> integer, clamped. Missing / junk (e.g. "-") -> 0.
export function layerOf(tags) {
  const raw = tags && tags.layer;
  if (raw == null) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(LAYER_MIN, Math.min(LAYER_MAX, n));
}

const truthy = (v) => !!(v && v !== "no" && v !== "false" && v !== "0");

// Physical elevation LEVEL of a road — NOT the raw OSM `layer`, which is only a
// draw-order hint (which feature paints on top when two overlap at grade). Physical
// height comes from bridge/tunnel:
//   layer > 0                    -> elevated (bridge / flyover). Near-universal OSM
//                                   convention for a road overpass, so we don't demand
//                                   an explicit bridge tag.
//   layer < 0 AND tunnel=yes     -> genuinely underground.
//   otherwise (incl. layer < 0 with NO tunnel) -> GROUND. A riverside road tagged
//                                   layer=-1 just to sit *under* the bridges crossing
//                                   over it is at ground level, not in a hole.
export function roadLevel(tags) {
  const layer = layerOf(tags);
  if (layer > 0) return layer;
  if (layer < 0 && truthy(tags && tags.tunnel)) return layer;
  return 0;
}

// ways: [{ nodeIds:[id,...], layer, link? }]  ->  Map(nodeId -> altitude metres)
// A junction sits at the layer CLOSEST TO GROUND (0) of the roads meeting there:
//   - roads straddle ground (some below, some above)  -> ground (0)
//   - all at/above ground                              -> the lowest (nearest 0)
//   - all at/below ground                              -> the highest (nearest 0)
// So a surface road keeps a junction at ground while the overpass/tunnel ramps to it.
//
// EXCEPTION — ramp links (`link:true`, e.g. motorway_link) do NOT vote. A link is the
// road that CHANGES level (an on/off ramp descending from a flyover to the ground), so
// letting it vote drags the elevated THROUGH road (the mainline it joins) down to
// ground at every interchange — the mainline then dives and rises under each ramp while
// osm2streets keeps it flat, so the HD lane detail floats above the diving deck. With
// links excluded, the mainline keeps its layer through the interchange and the link
// alone ramps to meet it. A node touched only by links falls back to the link layers.
export function nodeAltitudes(ways) {
  const lo = new Map(), hi = new Map();          // through-roads only (they set the altitude)
  const loAny = new Map(), hiAny = new Map();    // all roads (fallback for link-only nodes)
  for (const w of ways) {
    for (const nid of w.nodeIds) {
      const c = loAny.get(nid); if (c === undefined || w.layer < c) loAny.set(nid, w.layer);
      const d = hiAny.get(nid); if (d === undefined || w.layer > d) hiAny.set(nid, w.layer);
      if (w.link) continue;
      const a = lo.get(nid); if (a === undefined || w.layer < a) lo.set(nid, w.layer);
      const b = hi.get(nid); if (b === undefined || w.layer > b) hi.set(nid, w.layer);
    }
  }
  const z = new Map();
  for (const nid of loAny.keys()) {
    const mn = lo.has(nid) ? lo.get(nid) : loAny.get(nid); // through-roads if any, else links
    const mx = lo.has(nid) ? hi.get(nid) : hiAny.get(nid);
    const jl = (mn < 0 && mx > 0) ? 0 : (mx <= 0 ? mx : mn); // closest-to-ground layer
    z.set(nid, jl * LAYER_HEIGHT);
  }
  return z;
}

// Great-circle distance in metres (default distFn for elevateSegment).
export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const la1 = a[1] * rad, la2 = b[1] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Half-width (m) of a road's drawn deck by highway class — wider for trunk roads.
export const ROAD_HALF_W = { motorway: 8, motorway_link: 5, trunk: 7, trunk_link: 5,
  primary: 6, primary_link: 4, secondary: 5, secondary_link: 4, tertiary: 4.5,
  unclassified: 4, residential: 3.5, living_street: 3, service: 2.5 };
export const deckWidth = (highway) => ROAD_HALF_W[highway] || 3.5;

// Turn an elevated polyline (coordsZ = [[lng,lat,z],...]) into GeoJSON POLYGON deck
// segments for MapLibre fill-extrusion. Each segment carries its own base/top height
// (`zb`/`zt`) sampled from the ramp profile, so a chain of short flat slabs
// APPROXIMATES the smooth ramp — the deck climbs out of the ground up to the span
// instead of the single flat slab that leaves a vertical cliff at the junction.
// Sloped segments are densified (≤ STEP m) so the steps are small; the slab is THICK
// enough that neighbouring steps overlap and don't leave seam gaps. Width by class.
export function deckQuads(coordsZ, halfWidthM, distFn = haversine) {
  const STEP = 1, THICK = 2, TOP = 0.4, M = 111320;
  // densify sloped segments so the ramp steps stay small (flat spans stay coarse)
  const pts = [coordsZ[0]];
  for (let i = 1; i < coordsZ.length; i++) {
    const a = coordsZ[i - 1], b = coordsZ[i];
    const n = Math.abs((b[2] || 0) - (a[2] || 0)) > 0.1 ? Math.max(1, Math.ceil(distFn(a, b) / STEP)) : 1;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t]);
    }
  }
  const feats = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const lat = (a[1] + b[1]) / 2, cosLat = Math.cos(lat * Math.PI / 180) || 1e-6;
    let dx = (b[0] - a[0]) * cosLat * M, dy = (b[1] - a[1]) * M;
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const dLng = (-dy * halfWidthM) / (cosLat * M), dLat = (dx * halfWidthM) / M;
    const l0 = [a[0] + dLng, a[1] + dLat], r0 = [a[0] - dLng, a[1] - dLat];
    const l1 = [b[0] + dLng, b[1] + dLat], r1 = [b[0] - dLng, b[1] - dLat];
    const zmid = ((a[2] || 0) + (b[2] || 0)) / 2;
    feats.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[l0, r0, r1, l1, l0]] },
      properties: { zb: Math.max(0, Math.round((zmid - THICK) * 100) / 100), zt: Math.round((zmid + TOP) * 100) / 100 },
    });
  }
  return feats;
}

// Per-vertex altitude for one polyline (an edge / a way segment).
//   pts    : [[lon,lat],...] vertices (>= 2)
//   za, zb : altitudes at the two endpoint nodes (from nodeAltitudes). The ramp runs
//            between the endpoint altitude and the cruise, in whichever direction —
//            up toward an overpass crest, down toward a tunnel trough.
//   layer  : the way's own OSM layer (cruise altitude = layer * LAYER_HEIGHT)
//   distFn : (a,b) -> metres; defaults to haversine
// Returns z[] parallel to pts.
export function elevateSegment(pts, za, zb, layer, distFn = haversine) {
  const n = pts.length;
  const cruise = layer * LAYER_HEIGHT;
  const cum = new Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + distFn(pts[i - 1], pts[i]);
  const total = cum[n - 1] || 1;
  const ramp = Math.min(RAMP_M, total / 2); // keep the two end-ramps from overlapping
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = cum[i], dEnd = total - d;
    let z;
    if (d < ramp && dEnd >= ramp)       z = za + (cruise - za) * (d / ramp);
    else if (dEnd < ramp && d >= ramp)  z = zb + (cruise - zb) * (dEnd / ramp);
    else                                z = cruise; // mid-span (or the meeting point on a short seg)
    out[i] = z;
  }
  return out;
}
