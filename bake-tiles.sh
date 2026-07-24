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

# Keep ONLY the attributes the viewer actually reads (style + click popup); drop
# everything else (osm_way_ids arrays, movements, and the dozens of name:*/addr:*
# tags osmium put on water/green). This is a big size win with zero visual change.
KEEP=(-y type -y layer -y allowed_turns -y width -y speed_limit -y control
  -y intersection_kind -y bearing -y turns -y osm_way_id -y height -y base
  -y height_source -y name -y levels)
COMMON=(--force --drop-densest-as-needed --no-simplification-of-shared-nodes --preserve-input-order "${KEEP[@]}")

echo "Baking BASE layers (water/green/lanes/intersections/buildings) z$BASE_MINZOOM-$MAXZOOM …"
tippecanoe -o build/base.pmtiles "${COMMON[@]}" -Z"$BASE_MINZOOM" -z"$MAXZOOM" \
  -L water:"$L/water.ndjson" \
  -L green:"$L/green.ndjson" \
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
