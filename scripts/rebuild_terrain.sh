#!/usr/bin/env bash
# Rebuild background terrain PNGs for a new lat/lon AOI.
#
# Runs build_vuhledar_terrain.py (OSM + Copernicus DEM → terrain grid CSV +
# color overlay PNG) and then dump_height_overlay.py (grid CSV → grayscale
# elevation PNG). Both outputs overwrite the paths that src/main.js already
# loads (TERRAIN_TEXTURE_URL / HEIGHT_GRID_URL), so no code change is needed —
# just hard-refresh the browser.
#
# Cell size is fixed at 50 m because dump_height_overlay.py reads
# data_processed/terrain_grid_50m.csv by name. Change both if you need a
# different resolution.
#
# Usage:
#   scripts/rebuild_terrain.sh <south> <west> <north> <east>
# Example (current Donetsk-area AOI):
#   scripts/rebuild_terrain.sh 48.8711945 38.2002615 48.8868365 38.2384235
#
# Override the Python interpreter with PYTHON=/path/to/python if needed.

set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <south> <west> <north> <east>" >&2
  echo "Example: $0 48.8711945 38.2002615 48.8868365 38.2384235" >&2
  exit 1
fi

SOUTH="$1"
WEST="$2"
NORTH="$3"
EAST="$4"

PYTHON="${PYTHON:-/home/yeongha/anaconda3/envs/geo_env/bin/python}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -x "$PYTHON" ]; then
  echo "[rebuild] ERROR: Python not found at $PYTHON" >&2
  echo "[rebuild] Set PYTHON=... to override (needs osmnx/geopandas/rasterio/rioxarray/folium)." >&2
  exit 1
fi

echo "[rebuild] AOI  south=$SOUTH west=$WEST north=$NORTH east=$EAST  (cell-size 50 m)"
echo "[rebuild] Python: $PYTHON"
echo

"$PYTHON" build_vuhledar_terrain.py \
  --south "$SOUTH" --west "$WEST" --north "$NORTH" --east "$EAST"

"$PYTHON" scripts/dump_height_overlay.py

echo
echo "[rebuild] DONE"
echo "  outputs/vuhledar_terrain_overlay.png"
echo "  data/vuhledar_height_grid.png"
echo "[rebuild] Browser cache: hard-refresh (Ctrl+Shift+R) to pick up new textures."
