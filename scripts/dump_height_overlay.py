"""Generate a clean grayscale elevation grid PNG aligned 1:1 with the
terrain_overlay.png pixel grid (613 cols × 636 rows). Replaces
dump_slope_overlay.py for displacement input — slope is a derivative of the
DEM and therefore inherently noisy, while elevation gives smooth rolling
relief that actually corresponds to "지형의 높낮이".

Pipeline:
  - Read elevation_m from terrain_grid_50m.csv (already pre-sampled at grid
    cell centroids by build_vuhledar_terrain.py assign_grid_attributes, which
    samples the EPSG:32637 DEM at each centroid).
  - Reshape into 2-D using centroid coordinates.
  - 5-point mean smoothing × N passes. We need fairly aggressive smoothing
    because the AOI (31 km wide) is being compressed into a 120 m game plane
    (≈258× horizontal compression). Each game-mesh segment covers ~3 source
    cells, so without pre-smoothing the per-vertex bilinear under-filters
    and aliases the high-frequency content into visible jaggedness.
    Effective Gaussian radius after N passes ≈ √N cells.
  - Normalize to [0, 1] using the actual data range so the brightest pixel is
    the highest peak of the AOI and 0 is the lowest valley.
  - Save as L-mode PNG, top row = north, to match terrain_overlay.png.

Output: data/vuhledar_height_grid.png
"""

from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image

CELL_SIZE = 50.0
PROJECT = Path(__file__).resolve().parent.parent
CSV_PATH = PROJECT / "data_processed" / "terrain_grid_50m.csv"
OUT_PATH = PROJECT / "data" / "vuhledar_height_grid.png"


def smooth_mean5(arr: np.ndarray, passes: int = 2) -> np.ndarray:
    out = arr.astype(np.float32, copy=True)
    for _ in range(passes):
        # 5-point stencil (cell + 4 neighbors), zero-pad edges by reusing self
        north = np.vstack([out[:1], out[:-1]])
        south = np.vstack([out[1:], out[-1:]])
        west = np.hstack([out[:, :1], out[:, :-1]])
        east = np.hstack([out[:, 1:], out[:, -1:]])
        out = (out + north + south + west + east) / 5.0
    return out


def main() -> None:
    df = pd.read_csv(CSV_PATH, usecols=["centroid_x", "centroid_y", "elevation_m"])

    x0 = df["centroid_x"].min()
    y0 = df["centroid_y"].min()
    df["_col"] = ((df["centroid_x"] - x0) / CELL_SIZE).round().astype(int)
    df["_row"] = ((df["centroid_y"] - y0) / CELL_SIZE).round().astype(int)
    ncols = int(df["_col"].max()) + 1
    nrows = int(df["_row"].max()) + 1

    # Fill missing cells (AOI edge nodata) with the per-row neighbor mean later
    # via the smoothing pass; for now mark them with NaN.
    elev = np.full((nrows, ncols), np.nan, dtype=np.float32)
    elev[df["_row"].to_numpy(), df["_col"].to_numpy()] = df["elevation_m"].to_numpy()

    # Replace NaN with the global mean so smoothing doesn't propagate NaN.
    finite = elev[np.isfinite(elev)]
    fill_value = float(finite.mean()) if finite.size else 0.0
    elev = np.where(np.isfinite(elev), elev, fill_value)

    # 6 passes ≈ Gaussian σ ≈ 2.4 cells ≈ 120 m real ≈ ~1 game-mesh segment;
    # matches the effective per-vertex coverage so bilinear doesn't alias.
    elev = smooth_mean5(elev, passes=6)

    e_min = float(elev.min())
    e_max = float(elev.max())
    span = max(e_max - e_min, 1e-6)
    norm = (elev - e_min) / span
    norm = np.clip(norm, 0.0, 1.0)

    # CSV row 0 = south. PNG top row should be north → flip vertically.
    img_array = (np.flipud(norm) * 255.0).astype(np.uint8)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img_array, mode="L").save(OUT_PATH)
    print(
        f"height grid: {ncols} cols × {nrows} rows, "
        f"elevation {e_min:.1f}–{e_max:.1f} m (span {span:.1f} m) "
        f"→ {OUT_PATH.relative_to(PROJECT)}"
    )


if __name__ == "__main__":
    main()
