#!/usr/bin/env bash
# Bake the per-layer NDGeoJSON (from bake-city.mjs) into ONE vector-tile archive.
#
# Size strategy (keeps data/hanoi.pmtiles small enough for GitHub Pages' 100 MB
# file limit) — two passes joined with tile-join so layers get DIFFERENT zoom
# ranges:
#   BASE   (lanes, intersections, buildings)  z12..MAXZOOM  — visible city-wide
#   DETAIL (markings, turn_arrows)             z15..MAXZOOM  — only when zoomed in
# Lane markings are ~75% of the raw geometry and are meaningless zoomed out, so
# not storing them below z15 is most of the saving. MAXZOOM 17 (not 19) is the
# rest: the viewer overzooms z17 tiles to z18/19, which for vector data stays
# crisp. Tune via env:  MAXZOOM=18 MARK_MINZOOM=15 ./bake-tiles.sh
set -euo pipefail
cd "$(dirname "$0")"
L=build/layers
MAXZOOM=${MAXZOOM:-17}
MARK_MINZOOM=${MARK_MINZOOM:-15}

for f in lanes markings intersections turn_arrows buildings; do
  [ -s "$L/$f.ndjson" ] || { echo "missing/empty: $L/$f.ndjson (run bake-city.mjs first)"; exit 1; }
done

COMMON=(--force --drop-densest-as-needed --extend-zooms-if-still-dropping
  --no-simplification-of-shared-nodes --preserve-input-order
  --name="Hanoi HD" --attribution="© OpenStreetMap contributors · osm2streets")

echo "Baking BASE layers (lanes/intersections/buildings) z12-$MAXZOOM …"
tippecanoe -o build/base.pmtiles "${COMMON[@]}" -Z12 -z"$MAXZOOM" \
  -L lanes:"$L/lanes.ndjson" \
  -L intersections:"$L/intersections.ndjson" \
  -L buildings:"$L/buildings.ndjson"

echo "Baking DETAIL layers (markings/turn_arrows) z$MARK_MINZOOM-$MAXZOOM …"
tippecanoe -o build/detail.pmtiles "${COMMON[@]}" -Z"$MARK_MINZOOM" -z"$MAXZOOM" \
  -L markings:"$L/markings.ndjson" \
  -L turn_arrows:"$L/turn_arrows.ndjson"

echo "Joining → data/hanoi.pmtiles …"
tile-join --force -o data/hanoi.pmtiles \
  --name="Hanoi HD" --attribution="© OpenStreetMap contributors · osm2streets" \
  build/base.pmtiles build/detail.pmtiles
rm -f build/base.pmtiles build/detail.pmtiles

# the viewer reads this for its "Frame city" bounds + boot center
cp build/bake-meta.json data/hanoi-meta.json

echo "---"
pmtiles show data/hanoi.pmtiles 2>/dev/null | grep -iE "bounds|zoom|tile type" || true
ls -lh data/hanoi.pmtiles data/hanoi-meta.json
SIZE=$(stat -f%z data/hanoi.pmtiles)
echo "archive: $((SIZE/1024/1024)) MB  (GitHub file limit is 100 MB)"
