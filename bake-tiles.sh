#!/usr/bin/env bash
# Bake the per-layer NDGeoJSON (from bake-city.mjs) into a directory of standard
# {z}/{x}/{y}.pbf vector tiles in ./tiles — what the viewer (index.html) reads.
#
# Design choices, both so the map renders correctly on a plain static host
# (GitHub Pages) AND stays complete at close zoom:
#   * UNCOMPRESSED tiles (--no-tile-compression). MapLibre errors on gzipped
#     tiles unless the server sends Content-Encoding: gzip, which Pages can't do
#     for .pbf. Raw MVT renders everywhere with no headers.
#   * Bake DEEP (z12-17) so close-up has native, complete tiles. "Data disappears
#     when you zoom in" comes from too-shallow a maxzoom (overzoom past it) or from
#     dropping at the deepest level; a z17 max fixes both — the viewer only
#     overzooms past 17.
#   * tippecanoe uses --drop-densest-as-needed so the ZOOMED-OUT tiles stay light
#     (drops only kick in on huge low-zoom tiles, where detail isn't visible
#     anyway); the deepest zoom keeps everything. tile-join then repackages to an
#     uncompressed dir with --no-tile-size-limit so no finished tile is skipped.
#   * Per-layer zoom via two passes: base layers city-wide (z12-MAXZOOM), markings
#     /arrows only z15+ (they're most of the geometry and pointless zoomed out).
# Tune with:  MAXZOOM=17 MARK_MINZOOM=15 ./bake-tiles.sh
set -euo pipefail
cd "$(dirname "$0")"
L=build/layers
MAXZOOM=${MAXZOOM:-17}
BASE_MINZOOM=${BASE_MINZOOM:-15}   # HD layers are hidden below the 2D->3D switch,
MARK_MINZOOM=${MARK_MINZOOM:-16}   # so there's no point baking tiles below it.

for f in lanes markings intersections turn_arrows buildings; do
  [ -s "$L/$f.ndjson" ] || { echo "missing/empty: $L/$f.ndjson (run bake-city.mjs first)"; exit 1; }
done

# Clip everything to the bake bbox so complete_ways overhangs at the edge don't
# leak stray out-of-view tiles. Reads the bbox [W,S,E,N] that bake-city.mjs wrote →
# clip order is minlon,minlat,maxlon,maxlat, which matches.
BBOX=$(python3 -c "import json;b=json.load(open('build/bake-meta.json'))['bbox'];print('%s,%s,%s,%s'%(b[0],b[1],b[2],b[3]))" 2>/dev/null || true)
[ -n "$BBOX" ] && echo "clipping to bbox: $BBOX" || echo "no bake-meta.json bbox — skipping clip"

# Keep ONLY the attributes the viewer actually reads (style + click popup + the
# nav lane-highlight, which needs osm_way_ids + direction to match lanes to the
# route's ways). Everything else is dropped for size.
KEEP=(-y type -y layer -y allowed_turns -y width -y speed_limit -y control
  -y intersection_kind -y bearing -y turns -y osm_way_id -y osm_way_ids -y direction
  -y svc -y height -y base -y height_source -y name -y levels
  -y building -y min_level -y osm_type
  -y roof_shape -y roof_height -y roof_angle -y roof_orientation -y roof_direction
  -y colour -y material -y roof_colour -y roof_material -y roof_only)
COMMON=(--force --drop-densest-as-needed --no-simplification-of-shared-nodes --preserve-input-order "${KEEP[@]}")
[ -n "$BBOX" ] && COMMON+=(--clip-bounding-box="$BBOX")

# NOTE: water/green land cover is NO LONGER baked. The viewer draws a permanent
# street/satellite basemap underlay (index.html) that supplies all context —
# rivers, banks, parks, everything — so we don't bake (or maintain) those layers.
# That also retired bake-landcover.mjs and the osmium smart-relation assembly.
echo "Baking BASE layers (lanes/intersections/buildings) z$BASE_MINZOOM-$MAXZOOM …"
tippecanoe -o build/base.pmtiles "${COMMON[@]}" -Z"$BASE_MINZOOM" -z"$MAXZOOM" \
  -L lanes:"$L/lanes.ndjson" \
  -L intersections:"$L/intersections.ndjson" \
  -L buildings:"$L/buildings.ndjson"

echo "Baking DETAIL layers (markings/turn_arrows) z$MARK_MINZOOM-$MAXZOOM …"
tippecanoe -o build/detail.pmtiles "${COMMON[@]}" -Z"$MARK_MINZOOM" -z"$MAXZOOM" \
  -L markings:"$L/markings.ndjson" \
  -L turn_arrows:"$L/turn_arrows.ndjson"

echo "Joining → ./tiles (uncompressed MVT directory) …"
rm -rf tiles
tile-join --force --no-tile-compression --no-tile-size-limit --output-to-directory=tiles \
  build/base.pmtiles build/detail.pmtiles
rm -f build/base.pmtiles build/detail.pmtiles

# the viewer reads this for its "Frame city" bounds
cp build/bake-meta.json data/hanoi-meta.json 2>/dev/null || true

echo "---"
du -sh tiles | cut -f1
find tiles -name '*.pbf' | wc -l | awk '{print $1" tiles (z12-'"$MAXZOOM"')"}'
echo "Set the viewer source maxzoom to $MAXZOOM in index.html if you change it here."
