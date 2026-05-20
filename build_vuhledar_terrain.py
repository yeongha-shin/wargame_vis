from __future__ import annotations

import argparse
import inspect
import json
import math
import shutil
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import folium
import geopandas as gpd
import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
import osmnx as ox
import pandas as pd
import rasterio
import rasterio.mask
from pyproj import CRS
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import calculate_default_transform, reproject
from shapely.geometry import Point, Polygon, box, mapping
from shapely.prepared import prep
from tqdm import tqdm


CRS_WGS84 = CRS.from_epsg(4326)
CRS_PROJECTED = CRS.from_epsg(32637)

# ORG
# DEFAULT_BBOX = {
#     "south": 47.64,
#     "west": 37.05,
#     "north": 47.92,
#     "east": 37.45,
# }

# Second revision

DEFAULT_BBOX = {
    "south": 48.8711945,
    "west": 38.2002615,
    "north": 48.8868365,
    "east": 38.2384235
}

LAYER_DEFINITIONS: dict[str, dict[str, Any]] = {
    "roads": {"tags": {"highway": True}, "tag_column": "highway"},
    "buildings": {"tags": {"building": True}, "tag_column": "building"},
    "landuse": {"tags": {"landuse": True}, "tag_column": "landuse"},
    "natural": {"tags": {"natural": True}, "tag_column": "natural"},
    "waterways": {"tags": {"waterway": True}, "tag_column": "waterway"},
    "railways": {"tags": {"railway": True}, "tag_column": "railway"},
}

COLORS = {
    "urban": "gray",
    "forest": "green",
    "open_field": "tan",
    "water": "blue",
    "railway_corridor": "purple",
    "roads": "black",
    "buildings": "darkgray",
    "landuse": "#c9b27c",
    "natural": "#2e7d32",
    "waterways": "#1976d2",
    "railways": "purple",
    "aoi": "#ffcc00",
}

TERRAIN_FACTORS = {
    "open_field": {
        "mobility_factor_vehicle": 0.70,
        "mobility_factor_infantry": 0.90,
        "cover_factor": 0.20,
        "concealment_factor": 0.20,
        "los_block": 0,
    },
    "urban": {
        "mobility_factor_vehicle": 0.40,
        "mobility_factor_infantry": 0.70,
        "cover_factor": 0.70,
        "concealment_factor": 0.60,
        "los_block": 1,
    },
    "forest": {
        "mobility_factor_vehicle": 0.30,
        "mobility_factor_infantry": 0.60,
        "cover_factor": 0.60,
        "concealment_factor": 0.80,
        "los_block": 1,
    },
    "water": {
        "mobility_factor_vehicle": 0.00,
        "mobility_factor_infantry": 0.20,
        "cover_factor": 0.10,
        "concealment_factor": 0.10,
        "los_block": 0,
    },
    "railway_corridor": {
        "mobility_factor_vehicle": 0.60,
        "mobility_factor_infantry": 0.80,
        "cover_factor": 0.30,
        "concealment_factor": 0.30,
        "los_block": 0,
    },
}

ROAD_PRIORITY = [
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "service",
    "track",
]

URBAN_LANDUSE = {"residential", "commercial", "industrial"}
FOREST_NATURAL = {"wood"}
FOREST_LANDUSE = {"forest"}
OPEN_LANDUSE = {"farmland", "meadow", "grass"}
WATER_NATURAL = {"water", "wetland", "bay", "strait"}


@dataclass
class DemProducts:
    dem_path: Path
    slope_path: Path
    hillshade_png: Path
    slope_png: Path
    elevation_stats: dict[str, float]
    slope_stats: dict[str, float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build Vuhledar AOI terrain data for a wargame grid."
    )
    parser.add_argument("--south", type=float, default=DEFAULT_BBOX["south"])
    parser.add_argument("--west", type=float, default=DEFAULT_BBOX["west"])
    parser.add_argument("--north", type=float, default=DEFAULT_BBOX["north"])
    parser.add_argument("--east", type=float, default=DEFAULT_BBOX["east"])
    parser.add_argument("--cell-size", type=float, default=50.0)
    parser.add_argument("--output-dir", type=Path, default=Path("outputs"))
    parser.add_argument(
        "--data-raw-dir",
        type=Path,
        default=Path("data_raw"),
        help="Directory for downloaded/raw source data.",
    )
    parser.add_argument(
        "--data-processed-dir",
        type=Path,
        default=Path("data_processed"),
        help="Directory for generated GeoPackage/CSV/raster data.",
    )
    parser.add_argument(
        "--dem-path",
        type=Path,
        default=None,
        help="Optional local DEM GeoTIFF. If omitted, data_raw/dem.tif is used as fallback.",
    )
    parser.add_argument(
        "--skip-dem-download",
        action="store_true",
        help="Do not attempt automatic Copernicus DEM download.",
    )
    return parser.parse_args()


def ensure_directories(*paths: Path) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


def cell_size_label(cell_size: float) -> str:
    if float(cell_size).is_integer():
        return f"{int(cell_size)}m"
    return f"{str(cell_size).replace('.', 'p')}m"


def output_path_for_cell_size(output_dir: Path, base_name: str, extension: str, cell_size: float) -> Path:
    if int(cell_size) == 50 and float(cell_size).is_integer():
        return output_dir / f"{base_name}.{extension}"
    return output_dir / f"{base_name}_{cell_size_label(cell_size)}.{extension}"


def bbox_polygon(south: float, west: float, north: float, east: float) -> Polygon:
    return box(west, south, east, north)


def make_aoi_gdf(south: float, west: float, north: float, east: float) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"name": ["vuhledar_aoi"]},
        geometry=[bbox_polygon(south, west, north, east)],
        crs=CRS_WGS84,
    )


def normalize_tag_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, float) and math.isnan(value):
        return []
    if isinstance(value, (list, tuple, set)):
        values: list[str] = []
        for item in value:
            values.extend(normalize_tag_values(item))
        return values
    text = str(value).strip().lower()
    if not text or text in {"nan", "none", "<na>"}:
        return []
    values = [part.strip().lower() for part in text.replace("|", ";").split(";")]
    return [part for part in values if part]


def tag_series_matches(series: pd.Series, accepted: set[str]) -> pd.Series:
    return series.apply(lambda value: bool(set(normalize_tag_values(value)) & accepted))


def configure_osmnx() -> None:
    ox.settings.use_cache = True
    ox.settings.log_console = False
    ox.settings.requests_timeout = 180
    if hasattr(ox.settings, "overpass_settings"):
        ox.settings.overpass_settings = "[out:json][timeout:180]"


def call_osmnx_features(
    south: float,
    west: float,
    north: float,
    east: float,
    tags: dict[str, Any],
) -> gpd.GeoDataFrame:
    if hasattr(ox, "features_from_bbox"):
        function = ox.features_from_bbox
    elif hasattr(ox, "geometries_from_bbox"):
        function = ox.geometries_from_bbox
    else:
        raise RuntimeError("Installed OSMnx has no features_from_bbox/geometries_from_bbox API.")

    signature = inspect.signature(function)
    errors: list[Exception] = []

    if "bbox" in signature.parameters:
        try:
            return function((west, south, east, north), tags)
        except Exception as exc:
            errors.append(exc)

    call_patterns = [
        lambda: function(north, south, east, west, tags=tags),
        lambda: function(north=north, south=south, east=east, west=west, tags=tags),
        lambda: function(bbox=(west, south, east, north), tags=tags),
    ]
    for pattern in call_patterns:
        try:
            return pattern()
        except Exception as exc:
            errors.append(exc)

    joined = " | ".join(f"{type(exc).__name__}: {exc}" for exc in errors[-3:])
    raise RuntimeError(f"OSMnx bbox request failed: {joined}")


def empty_gdf(crs: CRS | str = CRS_WGS84) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=crs)


def clean_osm_gdf(gdf: gpd.GeoDataFrame, aoi_wgs: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf is None or gdf.empty:
        return empty_gdf(CRS_WGS84)

    cleaned = gdf.copy()
    if cleaned.crs is None:
        cleaned = cleaned.set_crs(CRS_WGS84)
    else:
        cleaned = cleaned.to_crs(CRS_WGS84)

    cleaned = cleaned[cleaned.geometry.notna()].copy()
    cleaned = cleaned[~cleaned.geometry.is_empty].copy()
    if cleaned.empty:
        return empty_gdf(CRS_WGS84)

    cleaned["geometry"] = cleaned.geometry.make_valid()
    cleaned = cleaned[cleaned.geometry.notna() & ~cleaned.geometry.is_empty].copy()
    if cleaned.empty:
        return empty_gdf(CRS_WGS84)

    try:
        cleaned = gpd.clip(cleaned, aoi_wgs)
    except Exception:
        cleaned = cleaned[cleaned.intersects(aoi_wgs.geometry.iloc[0])].copy()

    if cleaned.empty:
        return empty_gdf(CRS_WGS84)

    cleaned = cleaned.explode(index_parts=False).reset_index(drop=False)
    return cleaned.set_crs(CRS_WGS84, allow_override=True)


def serialize_value_for_gpkg(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (str, int, float, bool, np.integer, np.floating)):
        return value
    try:
        return json.dumps(value, ensure_ascii=True)
    except TypeError:
        return str(value)


def prepare_for_gpkg(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.empty:
        return gdf.copy()
    prepared = gdf.copy()
    prepared.columns = [str(col) for col in prepared.columns]
    for column in prepared.columns:
        if column == prepared.geometry.name:
            continue
        if prepared[column].dtype == "object":
            prepared[column] = prepared[column].map(serialize_value_for_gpkg)
    return prepared


def write_gpkg(gdf: gpd.GeoDataFrame, path: Path, layer: str, warnings: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        prepared = prepare_for_gpkg(gdf)
        if prepared.empty:
            prepared = gpd.GeoDataFrame(
                {"note": pd.Series(dtype="str")},
                geometry=gpd.GeoSeries([], crs=gdf.crs or CRS_WGS84),
                crs=gdf.crs or CRS_WGS84,
            )
        prepared.to_file(path, layer=layer, driver="GPKG")
    except Exception as exc:
        warning = f"Could not write {path}: {exc}"
        print(f"WARNING: {warning}")
        warnings.append(warning)


def download_osm_layers(
    south: float,
    west: float,
    north: float,
    east: float,
    data_raw_dir: Path,
    aoi_wgs: gpd.GeoDataFrame,
    warnings: list[str],
) -> dict[str, gpd.GeoDataFrame]:
    configure_osmnx()
    layers: dict[str, gpd.GeoDataFrame] = {}

    for layer_name, definition in LAYER_DEFINITIONS.items():
        print(f"[OSM] Downloading {layer_name} with tags {definition['tags']}...")
        raw_path = data_raw_dir / f"osm_{layer_name}.gpkg"
        try:
            gdf = call_osmnx_features(south, west, north, east, definition["tags"])
            gdf = clean_osm_gdf(gdf, aoi_wgs)
            print(f"[OSM] {layer_name}: {len(gdf)} features after clipping.")
            if gdf.empty:
                warnings.append(f"OSM layer {layer_name} downloaded but contains 0 features.")
        except Exception as exc:
            message = (
                f"OSM layer {layer_name} failed. Check internet/Overpass availability. "
                f"Error: {type(exc).__name__}: {exc}"
            )
            print(f"WARNING: {message}")
            warnings.append(message)
            gdf = empty_gdf(CRS_WGS84)

        gdf_for_file = gdf.to_crs(CRS_PROJECTED) if not gdf.empty else empty_gdf(CRS_PROJECTED)
        write_gpkg(gdf_for_file, raw_path, layer_name, warnings)
        layers[layer_name] = gdf

    return layers


def tile_name(lat: int, lon: int, arc_seconds: int) -> str:
    lat_prefix = "N" if lat >= 0 else "S"
    lon_prefix = "E" if lon >= 0 else "W"
    return (
        f"Copernicus_DSM_COG_{arc_seconds}_"
        f"{lat_prefix}{abs(lat):02d}_00_{lon_prefix}{abs(lon):03d}_00_DEM"
    )


def iter_dem_tiles(south: float, west: float, north: float, east: float) -> Iterable[tuple[int, int]]:
    lat_start = math.floor(south)
    lat_end = math.floor(north - 1e-12)
    lon_start = math.floor(west)
    lon_end = math.floor(east - 1e-12)
    for lat in range(lat_start, lat_end + 1):
        for lon in range(lon_start, lon_end + 1):
            yield lat, lon


def download_url(url: str, destination: Path, timeout: int = 60) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "vuhledar-terrain-builder/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        total = int(response.headers.get("Content-Length", "0") or "0")
        with destination.open("wb") as file_obj:
            with tqdm(
                total=total,
                unit="B",
                unit_scale=True,
                desc=f"Downloading {destination.name}",
                disable=total == 0,
            ) as progress:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    file_obj.write(chunk)
                    progress.update(len(chunk))


def try_download_copernicus_dem(
    south: float,
    west: float,
    north: float,
    east: float,
    data_raw_dir: Path,
    warnings: list[str],
) -> list[Path]:
    downloaded: list[Path] = []
    buckets = [
        ("copernicus-dem-30m", 10),
        ("copernicus-dem-90m", 30),
    ]

    for bucket, arc_seconds in buckets:
        candidate_paths: list[Path] = []
        failed = False
        print(f"[DEM] Trying Copernicus DEM from s3://{bucket}...")

        for lat, lon in iter_dem_tiles(south, west, north, east):
            name = tile_name(lat, lon, arc_seconds)
            destination = data_raw_dir / f"{name}.tif"
            if destination.exists() and destination.stat().st_size > 0:
                print(f"[DEM] Reusing existing {destination.name}.")
                candidate_paths.append(destination)
                continue

            url = f"https://{bucket}.s3.amazonaws.com/{name}/{name}.tif"
            try:
                download_url(url, destination)
                candidate_paths.append(destination)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
                failed = True
                if destination.exists():
                    destination.unlink(missing_ok=True)
                message = f"DEM download failed for {url}: {type(exc).__name__}: {exc}"
                print(f"WARNING: {message}")
                warnings.append(message)
                break

        if not failed and candidate_paths:
            downloaded = candidate_paths
            print(f"[DEM] Using {len(downloaded)} Copernicus tile(s) from {bucket}.")
            break

    return downloaded


def select_dem_sources(
    south: float,
    west: float,
    north: float,
    east: float,
    data_raw_dir: Path,
    explicit_dem_path: Path | None,
    skip_download: bool,
    warnings: list[str],
) -> list[Path]:
    if explicit_dem_path is not None:
        if explicit_dem_path.exists():
            print(f"[DEM] Using explicit local DEM: {explicit_dem_path}")
            return [explicit_dem_path]
        warning = f"Explicit DEM path does not exist: {explicit_dem_path}"
        print(f"WARNING: {warning}")
        warnings.append(warning)

    if not skip_download:
        downloaded = try_download_copernicus_dem(south, west, north, east, data_raw_dir, warnings)
        if downloaded:
            return downloaded
    else:
        print("[DEM] Automatic DEM download skipped by request.")

    fallback = data_raw_dir / "dem.tif"
    if fallback.exists():
        print(f"[DEM] Using fallback local DEM: {fallback}")
        return [fallback]

    warning = "No DEM available. DEM-derived elevation, slope, and hillshade will be skipped."
    print(f"WARNING: {warning}")
    warnings.append(warning)
    return []


def open_and_merge_dem(dem_paths: list[Path], data_processed_dir: Path) -> Path:
    if len(dem_paths) == 1:
        return dem_paths[0]

    print(f"[DEM] Merging {len(dem_paths)} DEM tiles...")
    datasets = [rasterio.open(path) for path in dem_paths]
    try:
        crs_values = {dataset.crs.to_string() if dataset.crs else None for dataset in datasets}
        if len(crs_values) != 1 or None in crs_values:
            raise RuntimeError("DEM tiles have missing or inconsistent CRS values.")
        merged_array, merged_transform = merge(datasets)
        profile = datasets[0].profile.copy()
        profile.update(
            driver="GTiff",
            height=merged_array.shape[1],
            width=merged_array.shape[2],
            transform=merged_transform,
            compress="deflate",
        )
        merged_path = data_processed_dir / "dem_merged.tif"
        with rasterio.open(merged_path, "w", **profile) as dst:
            dst.write(merged_array)
        return merged_path
    finally:
        for dataset in datasets:
            dataset.close()


def clip_dem_to_aoi(dem_path: Path, aoi_wgs: gpd.GeoDataFrame, data_processed_dir: Path) -> Path:
    clipped_path = data_processed_dir / "dem_clipped.tif"
    with rasterio.open(dem_path) as src:
        if src.crs is None:
            raise RuntimeError(f"DEM has no CRS: {dem_path}")
        dst_nodata = src.nodata if src.nodata is not None else -9999.0
        aoi_source_crs = aoi_wgs.to_crs(src.crs)
        clipped, clipped_transform = rasterio.mask.mask(
            src,
            [mapping(aoi_source_crs.geometry.iloc[0])],
            crop=True,
            filled=True,
            nodata=dst_nodata,
        )
        profile = src.profile.copy()
        profile.update(
            driver="GTiff",
            height=clipped.shape[1],
            width=clipped.shape[2],
            transform=clipped_transform,
            nodata=dst_nodata,
            compress="deflate",
        )
        with rasterio.open(clipped_path, "w", **profile) as dst:
            dst.write(clipped)
    return clipped_path


def reproject_dem_to_utm(clipped_path: Path, data_processed_dir: Path) -> Path:
    projected_path = data_processed_dir / "dem_utm32637.tif"
    with rasterio.open(clipped_path) as src:
        dst_nodata = src.nodata if src.nodata is not None else -9999.0
        transform, width, height = calculate_default_transform(
            src.crs,
            CRS_PROJECTED,
            src.width,
            src.height,
            *src.bounds,
        )
        profile = src.profile.copy()
        profile.update(
            crs=CRS_PROJECTED,
            transform=transform,
            width=width,
            height=height,
            nodata=dst_nodata,
            compress="deflate",
        )
        with rasterio.open(projected_path, "w", **profile) as dst:
            for band_index in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band_index),
                    destination=rasterio.band(dst, band_index),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=CRS_PROJECTED,
                    src_nodata=src.nodata,
                    dst_nodata=dst_nodata,
                    init_dest_nodata=True,
                    resampling=Resampling.bilinear,
                )
    return projected_path


def raster_to_float_array(path: Path) -> tuple[np.ndarray, rasterio.Affine, Any, dict[str, Any]]:
    with rasterio.open(path) as src:
        array = src.read(1).astype("float64")
        nodata = src.nodata
        if nodata is not None:
            array[array == nodata] = np.nan
        profile = src.profile.copy()
        return array, src.transform, nodata, profile


def finite_stats(array: np.ndarray) -> dict[str, float]:
    finite = array[np.isfinite(array)]
    if finite.size == 0:
        return {"min": float("nan"), "max": float("nan"), "mean": float("nan")}
    return {
        "min": float(np.nanmin(finite)),
        "max": float(np.nanmax(finite)),
        "mean": float(np.nanmean(finite)),
    }


def compute_slope_and_hillshade(
    dem_utm_path: Path,
    output_dir: Path,
    data_processed_dir: Path,
) -> tuple[Path, Path, Path, dict[str, float], dict[str, float]]:
    dem_array, transform, nodata, profile = raster_to_float_array(dem_utm_path)
    x_res = abs(transform.a)
    y_res = abs(transform.e)
    grad_y, grad_x = np.gradient(dem_array, y_res, x_res)
    slope_percent = np.sqrt(grad_x**2 + grad_y**2) * 100.0
    slope_percent[~np.isfinite(dem_array)] = np.nan

    slope_profile = profile.copy()
    slope_nodata = -9999.0
    slope_profile.update(dtype="float32", nodata=slope_nodata, compress="deflate")
    slope_path = data_processed_dir / "slope_percent.tif"
    slope_output = np.where(np.isfinite(slope_percent), slope_percent, slope_nodata)
    with rasterio.open(slope_path, "w", **slope_profile) as dst:
        dst.write(slope_output.astype("float32"), 1)

    azimuth = np.deg2rad(315.0)
    altitude = np.deg2rad(45.0)
    slope_rad = np.arctan(np.sqrt(grad_x**2 + grad_y**2))
    aspect = np.arctan2(-grad_x, grad_y)
    hillshade = (
        np.sin(altitude) * np.cos(slope_rad)
        + np.cos(altitude) * np.sin(slope_rad) * np.cos(azimuth - aspect)
    )
    hillshade = np.clip(hillshade, 0, 1)
    hillshade[~np.isfinite(dem_array)] = np.nan

    hillshade_png = output_dir / "vuhledar_hillshade.png"
    plt.figure(figsize=(10, 8))
    plt.imshow(hillshade, cmap="gray")
    plt.axis("off")
    plt.tight_layout(pad=0)
    plt.savefig(hillshade_png, dpi=180, bbox_inches="tight", pad_inches=0)
    plt.close()

    slope_png = output_dir / "vuhledar_slope_map.png"
    finite_slope = slope_percent[np.isfinite(slope_percent)]
    vmax = float(np.nanpercentile(finite_slope, 98)) if finite_slope.size else 1.0
    plt.figure(figsize=(10, 8))
    image = plt.imshow(slope_percent, cmap="inferno", vmin=0, vmax=vmax)
    plt.colorbar(image, label="Slope (%)", shrink=0.75)
    plt.axis("off")
    plt.tight_layout()
    plt.savefig(slope_png, dpi=180)
    plt.close()

    return slope_path, hillshade_png, slope_png, finite_stats(dem_array), finite_stats(slope_percent)


def process_dem(
    dem_paths: list[Path],
    aoi_wgs: gpd.GeoDataFrame,
    output_dir: Path,
    data_processed_dir: Path,
    warnings: list[str],
) -> DemProducts | None:
    if not dem_paths:
        return None

    try:
        source = open_and_merge_dem(dem_paths, data_processed_dir)
        print("[DEM] Clipping DEM to AOI...")
        clipped = clip_dem_to_aoi(source, aoi_wgs, data_processed_dir)
        print("[DEM] Reprojecting DEM to EPSG:32637...")
        dem_utm = reproject_dem_to_utm(clipped, data_processed_dir)
        print("[DEM] Computing slope and hillshade...")
        slope_path, hillshade_png, slope_png, elevation_stats, slope_stats = compute_slope_and_hillshade(
            dem_utm,
            output_dir,
            data_processed_dir,
        )
        return DemProducts(
            dem_path=dem_utm,
            slope_path=slope_path,
            hillshade_png=hillshade_png,
            slope_png=slope_png,
            elevation_stats=elevation_stats,
            slope_stats=slope_stats,
        )
    except Exception as exc:
        warning = f"DEM processing failed and will be skipped: {type(exc).__name__}: {exc}"
        print(f"WARNING: {warning}")
        warnings.append(warning)
        return None


def create_grid(aoi_wgs: gpd.GeoDataFrame, cell_size: float) -> gpd.GeoDataFrame:
    print(f"[GRID] Creating {cell_size:.0f} m grid in EPSG:32637...")
    aoi_utm = aoi_wgs.to_crs(CRS_PROJECTED)
    aoi_geom = aoi_utm.geometry.iloc[0]
    minx, miny, maxx, maxy = aoi_geom.bounds
    start_x = math.floor(minx / cell_size) * cell_size
    start_y = math.floor(miny / cell_size) * cell_size
    end_x = math.ceil(maxx / cell_size) * cell_size
    end_y = math.ceil(maxy / cell_size) * cell_size

    x_values = np.arange(start_x, end_x, cell_size)
    y_values = np.arange(start_y, end_y, cell_size)
    prepared_aoi = prep(aoi_geom)

    records: list[dict[str, Any]] = []
    geometries: list[Polygon] = []
    cell_id = 0
    for row_idx, y in enumerate(tqdm(y_values, desc="Grid rows")):
        for col_idx, x in enumerate(x_values):
            centroid_x = x + cell_size / 2.0
            centroid_y = y + cell_size / 2.0
            if not prepared_aoi.contains(Point(centroid_x, centroid_y)):
                continue
            cell_id += 1
            records.append(
                {
                    "cell_id": cell_id,
                    "centroid_x": centroid_x,
                    "centroid_y": centroid_y,
                    "_grid_row": row_idx,
                    "_grid_col": col_idx,
                }
            )
            geometries.append(box(x, y, x + cell_size, y + cell_size))

    grid = gpd.GeoDataFrame(records, geometry=geometries, crs=CRS_PROJECTED)
    print(f"[GRID] Created {len(grid)} cells.")
    return grid


def to_projected_layers(layers: dict[str, gpd.GeoDataFrame]) -> dict[str, gpd.GeoDataFrame]:
    projected: dict[str, gpd.GeoDataFrame] = {}
    for name, gdf in layers.items():
        if gdf.empty:
            projected[name] = empty_gdf(CRS_PROJECTED)
            continue
        source = gdf
        if source.crs is None:
            source = source.set_crs(CRS_WGS84)
        projected[name] = source.to_crs(CRS_PROJECTED)
    return projected


def sjoin_intersections(
    grid: gpd.GeoDataFrame,
    layer: gpd.GeoDataFrame,
    columns: list[str] | None = None,
) -> gpd.GeoDataFrame:
    if layer.empty:
        return gpd.GeoDataFrame()
    selected_columns = ["geometry"] + (columns or [])
    selected_columns = [column for column in selected_columns if column in layer.columns]
    try:
        return gpd.sjoin(
            grid[["cell_id", "geometry"]],
            layer[selected_columns],
            how="inner",
            predicate="intersects",
        )
    except TypeError:
        return gpd.sjoin(
            grid[["cell_id", "geometry"]],
            layer[selected_columns],
            how="inner",
            op="intersects",
        )


def intersecting_cell_ids(
    grid: gpd.GeoDataFrame,
    layer: gpd.GeoDataFrame,
    filter_mask: pd.Series | None = None,
) -> set[int]:
    if layer.empty:
        return set()
    subset = layer.loc[filter_mask].copy() if filter_mask is not None else layer
    if subset.empty:
        return set()
    joined = sjoin_intersections(grid, subset)
    if joined.empty:
        return set()
    return set(joined["cell_id"].astype(int).tolist())


def choose_road_type(values: Iterable[Any]) -> str:
    normalized: set[str] = set()
    for value in values:
        normalized.update(normalize_tag_values(value))
    if not normalized:
        return "none"
    for road_type in ROAD_PRIORITY:
        if road_type in normalized:
            return road_type
    return sorted(normalized)[0]


def classify_slope_value(value: float) -> str:
    if not np.isfinite(value):
        return "unknown"
    if value <= 3:
        return "0-3"
    if value <= 8:
        return "3-8"
    if value <= 15:
        return "8-15"
    if value <= 25:
        return "15-25"
    return "over_25"


def slope_vehicle_multiplier(value: float) -> float:
    if not np.isfinite(value):
        return 1.0
    if value <= 3:
        return 1.0
    if value <= 8:
        return 0.85
    if value <= 15:
        return 0.60
    if value <= 25:
        return 0.30
    return 0.0


def slope_infantry_multiplier(value: float) -> float:
    if not np.isfinite(value):
        return 1.0
    if value <= 3:
        return 1.0
    if value <= 8:
        return 0.95
    if value <= 15:
        return 0.80
    if value <= 25:
        return 0.60
    return 0.30


def sample_raster_at_grid_points(path: Path, grid: gpd.GeoDataFrame) -> np.ndarray:
    values = np.full(len(grid), np.nan, dtype="float64")
    coords = list(zip(grid["centroid_x"].to_numpy(), grid["centroid_y"].to_numpy()))
    with rasterio.open(path) as src:
        nodata = src.nodata
        chunk_size = 50000
        for start in tqdm(range(0, len(coords), chunk_size), desc=f"Sampling {path.name}"):
            chunk = coords[start : start + chunk_size]
            sampled = []
            for sample in src.sample(chunk):
                value = float(sample[0])
                if nodata is not None and value == nodata:
                    sampled.append(np.nan)
                else:
                    sampled.append(value if np.isfinite(value) else np.nan)
            values[start : start + len(sampled)] = sampled
    return values


def assign_grid_attributes(
    grid: gpd.GeoDataFrame,
    layers_utm: dict[str, gpd.GeoDataFrame],
    dem_products: DemProducts | None,
) -> gpd.GeoDataFrame:
    print("[ATTR] Assigning OSM-derived terrain attributes...")
    attributed = grid.copy()
    attributed["elevation_m"] = np.nan
    attributed["slope_percent"] = np.nan
    attributed["slope_class"] = "unknown"
    attributed["terrain_type"] = "open_field"
    attributed["road_type"] = "none"
    attributed["building_count"] = 0
    attributed["urban_flag"] = 0
    attributed["water_obstacle"] = 0
    attributed["railway_flag"] = 0

    buildings = layers_utm.get("buildings", empty_gdf(CRS_PROJECTED))
    landuse = layers_utm.get("landuse", empty_gdf(CRS_PROJECTED))
    natural = layers_utm.get("natural", empty_gdf(CRS_PROJECTED))
    waterways = layers_utm.get("waterways", empty_gdf(CRS_PROJECTED))
    railways = layers_utm.get("railways", empty_gdf(CRS_PROJECTED))
    roads = layers_utm.get("roads", empty_gdf(CRS_PROJECTED))

    building_join = sjoin_intersections(attributed, buildings)
    if not building_join.empty:
        counts = building_join.groupby("cell_id")["index_right"].nunique()
        attributed["building_count"] = (
            attributed["cell_id"].map(counts).fillna(0).astype(int)
        )

    urban_cells = set(attributed.loc[attributed["building_count"] > 0, "cell_id"].astype(int))
    if not landuse.empty and "landuse" in landuse.columns:
        urban_landuse_cells = intersecting_cell_ids(
            attributed,
            landuse,
            tag_series_matches(landuse["landuse"], URBAN_LANDUSE),
        )
        urban_cells.update(urban_landuse_cells)

    forest_cells: set[int] = set()
    if natural.empty is False and "natural" in natural.columns:
        forest_cells.update(
            intersecting_cell_ids(
                attributed,
                natural,
                tag_series_matches(natural["natural"], FOREST_NATURAL),
            )
        )
    if landuse.empty is False and "landuse" in landuse.columns:
        forest_cells.update(
            intersecting_cell_ids(
                attributed,
                landuse,
                tag_series_matches(landuse["landuse"], FOREST_LANDUSE),
            )
        )

    water_cells: set[int] = set()
    if natural.empty is False and "natural" in natural.columns:
        water_cells.update(
            intersecting_cell_ids(
                attributed,
                natural,
                tag_series_matches(natural["natural"], WATER_NATURAL),
            )
        )
    water_cells.update(intersecting_cell_ids(attributed, waterways))

    railway_cells = intersecting_cell_ids(attributed, railways)

    attributed.loc[attributed["cell_id"].isin(railway_cells), "terrain_type"] = "railway_corridor"
    attributed.loc[attributed["cell_id"].isin(water_cells), "terrain_type"] = "water"
    attributed.loc[attributed["cell_id"].isin(forest_cells), "terrain_type"] = "forest"
    attributed.loc[attributed["cell_id"].isin(urban_cells), "terrain_type"] = "urban"
    attributed.loc[attributed["cell_id"].isin(urban_cells), "urban_flag"] = 1
    attributed.loc[attributed["cell_id"].isin(water_cells), "water_obstacle"] = 1
    attributed.loc[attributed["cell_id"].isin(railway_cells), "railway_flag"] = 1

    if not roads.empty and "highway" in roads.columns:
        road_join = sjoin_intersections(attributed, roads, columns=["highway"])
        if not road_join.empty:
            road_types = road_join.groupby("cell_id")["highway"].apply(choose_road_type)
            attributed["road_type"] = attributed["cell_id"].map(road_types).fillna("none")

    for terrain_type, factors in TERRAIN_FACTORS.items():
        mask = attributed["terrain_type"] == terrain_type
        for factor_name, value in factors.items():
            attributed.loc[mask, factor_name] = value

    road_mask = (attributed["road_type"] != "none") & (attributed["terrain_type"] != "water")
    attributed.loc[road_mask, "mobility_factor_vehicle"] = attributed.loc[
        road_mask, "mobility_factor_vehicle"
    ].clip(lower=0.80)

    if dem_products is not None:
        print("[ATTR] Sampling DEM elevation and slope at grid centroids...")
        attributed["elevation_m"] = sample_raster_at_grid_points(dem_products.dem_path, attributed)
        attributed["slope_percent"] = sample_raster_at_grid_points(dem_products.slope_path, attributed)
        attributed["slope_class"] = attributed["slope_percent"].apply(classify_slope_value)

        vehicle_multiplier = attributed["slope_percent"].apply(slope_vehicle_multiplier)
        infantry_multiplier = attributed["slope_percent"].apply(slope_infantry_multiplier)
        attributed["mobility_factor_vehicle"] = (
            attributed["mobility_factor_vehicle"].astype(float) * vehicle_multiplier
        ).clip(lower=0.0, upper=1.0)
        attributed["mobility_factor_infantry"] = (
            attributed["mobility_factor_infantry"].astype(float) * infantry_multiplier
        ).clip(lower=0.0, upper=1.0)

    return attributed


def terrain_color_array(grid: gpd.GeoDataFrame) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    min_col = int(grid["_grid_col"].min())
    max_col = int(grid["_grid_col"].max())
    min_row = int(grid["_grid_row"].min())
    max_row = int(grid["_grid_row"].max())
    rows = max_row - min_row + 1
    cols = max_col - min_col + 1
    rgba = np.zeros((rows, cols, 4), dtype=float)

    for terrain_type, color in COLORS.items():
        if terrain_type not in TERRAIN_FACTORS:
            continue
        mask = grid["terrain_type"] == terrain_type
        if not mask.any():
            continue
        row_indices = grid.loc[mask, "_grid_row"].astype(int).to_numpy() - min_row
        col_indices = grid.loc[mask, "_grid_col"].astype(int).to_numpy() - min_col
        rgba[row_indices, col_indices, :] = mcolors.to_rgba(color, alpha=0.80)

    bounds = grid.total_bounds
    return rgba, (bounds[0], bounds[2], bounds[1], bounds[3])


def save_terrain_overlay_png(grid: gpd.GeoDataFrame, output_path: Path) -> Path:
    rgba, _ = terrain_color_array(grid)
    plt.imsave(output_path, rgba, origin="lower")
    return output_path


def make_static_map(
    grid: gpd.GeoDataFrame,
    layers_utm: dict[str, gpd.GeoDataFrame],
    output_path: Path,
    cell_size: float,
) -> None:
    print("[MAP] Rendering static terrain map...")
    rgba, extent = terrain_color_array(grid)
    fig, ax = plt.subplots(figsize=(12, 10))
    ax.imshow(rgba, origin="lower", extent=extent)

    buildings = layers_utm.get("buildings", empty_gdf(CRS_PROJECTED))
    roads = layers_utm.get("roads", empty_gdf(CRS_PROJECTED))
    railways = layers_utm.get("railways", empty_gdf(CRS_PROJECTED))

    if not buildings.empty:
        buildings.plot(ax=ax, color=COLORS["buildings"], edgecolor="none", alpha=0.85)
    if not railways.empty:
        railways.plot(ax=ax, color=COLORS["railways"], linewidth=0.7, alpha=0.9)
    if not roads.empty:
        roads.plot(ax=ax, color=COLORS["roads"], linewidth=0.45, alpha=0.9)

    handles = [
        plt.Line2D([0], [0], marker="s", color="none", markerfacecolor=COLORS[name], label=name)
        for name in TERRAIN_FACTORS
    ]
    handles.append(
        plt.Line2D([0], [0], color=COLORS["roads"], linewidth=2.2, label="roads")
    )
    ax.legend(handles=handles, loc="lower right", framealpha=0.92)
    ax.set_title(f"Vuhledar Terrain Grid ({cell_size:g} m)")
    ax.set_xlabel("Easting (m), EPSG:32637")
    ax.set_ylabel("Northing (m), EPSG:32637")
    ax.set_aspect("equal")
    plt.tight_layout()
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def make_terrain_classification_map(
    grid: gpd.GeoDataFrame,
    layers_utm: dict[str, gpd.GeoDataFrame],
    output_path: Path,
    cell_size: float,
) -> None:
    print("[MAP] Rendering terrain classification map...")
    rgba, extent = terrain_color_array(grid)
    fig, ax = plt.subplots(figsize=(14, 11))
    ax.imshow(rgba, origin="lower", extent=extent)

    roads = layers_utm.get("roads", empty_gdf(CRS_PROJECTED))
    railways = layers_utm.get("railways", empty_gdf(CRS_PROJECTED))
    buildings = layers_utm.get("buildings", empty_gdf(CRS_PROJECTED))

    if not buildings.empty:
        buildings.plot(ax=ax, color="#2b2b2b", edgecolor="none", alpha=0.55)
    if not railways.empty:
        railways.plot(ax=ax, color=COLORS["railways"], linewidth=0.8, alpha=0.95)
    if not roads.empty:
        roads.plot(ax=ax, color=COLORS["roads"], linewidth=1.35, alpha=0.95)

    handles = [
        plt.Line2D(
            [0],
            [0],
            marker="s",
            color="none",
            markerfacecolor=COLORS[name],
            markersize=11,
            label=name,
        )
        for name in TERRAIN_FACTORS
    ]
    handles.append(
        plt.Line2D([0], [0], color=COLORS["roads"], linewidth=3.0, label="roads")
    )
    ax.legend(handles=handles, loc="lower right", framealpha=0.94, title="terrain_type")
    ax.set_title(f"Vuhledar Terrain Classification by {cell_size:g} m Cell")
    ax.set_xlabel("Easting (m), EPSG:32637")
    ax.set_ylabel("Northing (m), EPSG:32637")
    ax.set_aspect("equal")
    plt.tight_layout()
    fig.savefig(output_path, dpi=220)
    plt.close(fig)


def make_contour_map(
    dem_products: DemProducts | None,
    layers_utm: dict[str, gpd.GeoDataFrame],
    output_path: Path,
) -> bool:
    if dem_products is None:
        print("[MAP] Skipping contour map because DEM is unavailable.")
        return False

    print("[MAP] Rendering DEM contour map...")
    with rasterio.open(dem_products.dem_path) as src:
        elevation = src.read(1).astype("float64")
        nodata = src.nodata
        if nodata is not None:
            elevation[elevation == nodata] = np.nan
        bounds = src.bounds

    finite = elevation[np.isfinite(elevation)]
    if finite.size == 0:
        print("[MAP] Skipping contour map because DEM contains no finite elevation values.")
        return False

    vmin = float(np.nanpercentile(finite, 2))
    vmax = float(np.nanpercentile(finite, 98))
    min_level = math.floor(float(np.nanmin(finite)) / 10.0) * 10.0
    max_level = math.ceil(float(np.nanmax(finite)) / 10.0) * 10.0
    contour_levels = np.arange(min_level, max_level + 10.0, 10.0)
    label_levels = np.arange(min_level, max_level + 20.0, 20.0)

    x = np.linspace(bounds.left, bounds.right, elevation.shape[1])
    y = np.linspace(bounds.top, bounds.bottom, elevation.shape[0])

    fig, ax = plt.subplots(figsize=(14, 11))
    image = ax.imshow(
        elevation,
        extent=(bounds.left, bounds.right, bounds.bottom, bounds.top),
        cmap="terrain",
        vmin=vmin,
        vmax=vmax,
        alpha=0.96,
    )
    contours = ax.contour(
        x,
        y,
        elevation,
        levels=contour_levels,
        colors="#2b2b2b",
        linewidths=0.45,
        alpha=0.80,
    )
    label_contours = ax.contour(
        x,
        y,
        elevation,
        levels=label_levels,
        colors="#111111",
        linewidths=0.70,
        alpha=0.95,
    )
    ax.clabel(label_contours, inline=True, fmt="%d m", fontsize=7)

    roads = layers_utm.get("roads", empty_gdf(CRS_PROJECTED))
    railways = layers_utm.get("railways", empty_gdf(CRS_PROJECTED))
    waterways = layers_utm.get("waterways", empty_gdf(CRS_PROJECTED))
    if not waterways.empty:
        waterways.plot(ax=ax, color=COLORS["waterways"], linewidth=0.9, alpha=0.85)
    if not railways.empty:
        railways.plot(ax=ax, color=COLORS["railways"], linewidth=0.8, alpha=0.85)
    if not roads.empty:
        roads.plot(ax=ax, color="black", linewidth=1.10, alpha=0.85)

    fig.colorbar(image, ax=ax, shrink=0.72, label="Elevation (m)")
    ax.set_title("Vuhledar DEM Contours")
    ax.set_xlabel("Easting (m), EPSG:32637")
    ax.set_ylabel("Northing (m), EPSG:32637")
    ax.set_aspect("equal")
    plt.tight_layout()
    fig.savefig(output_path, dpi=220)
    plt.close(fig)
    return True


def style_for_layer(layer_name: str) -> dict[str, Any]:
    if layer_name == "roads":
        return {"color": COLORS["roads"], "weight": 2, "opacity": 0.8}
    if layer_name == "buildings":
        return {
            "color": COLORS["buildings"],
            "weight": 0.5,
            "fillColor": COLORS["buildings"],
            "fillOpacity": 0.65,
        }
    if layer_name == "waterways":
        return {"color": COLORS["waterways"], "weight": 2, "opacity": 0.85}
    if layer_name == "railways":
        return {"color": COLORS["railways"], "weight": 2, "opacity": 0.85}
    if layer_name == "natural":
        return {
            "color": COLORS["natural"],
            "weight": 0.8,
            "fillColor": COLORS["natural"],
            "fillOpacity": 0.35,
        }
    return {
        "color": COLORS["landuse"],
        "weight": 0.8,
        "fillColor": COLORS["landuse"],
        "fillOpacity": 0.30,
    }


def folium_add_gdf(
    fmap: folium.Map,
    gdf: gpd.GeoDataFrame,
    layer_name: str,
    tooltip_columns: list[str],
) -> None:
    if gdf.empty:
        return
    display_gdf = gdf.to_crs(CRS_WGS84).copy()
    keep_columns = ["geometry"] + [column for column in tooltip_columns if column in display_gdf.columns]
    display_gdf = display_gdf[keep_columns]
    for column in display_gdf.columns:
        if column != "geometry" and display_gdf[column].dtype == "object":
            display_gdf[column] = display_gdf[column].map(serialize_value_for_gpkg)

    folium.GeoJson(
        data=json.loads(display_gdf.to_json()),
        name=layer_name,
        style_function=lambda _feature, style=style_for_layer(layer_name): style,
        tooltip=folium.GeoJsonTooltip(
            fields=[column for column in keep_columns if column != "geometry"][:4],
            aliases=[column for column in keep_columns if column != "geometry"][:4],
            sticky=False,
        )
        if len(keep_columns) > 1
        else None,
    ).add_to(fmap)


def make_osm_html_map(
    layers_wgs: dict[str, gpd.GeoDataFrame],
    south: float,
    west: float,
    north: float,
    east: float,
    output_path: Path,
) -> None:
    print("[MAP] Writing OSM layer HTML map...")
    fmap = folium.Map(
        location=[(south + north) / 2.0, (west + east) / 2.0],
        zoom_start=11,
        tiles="OpenStreetMap",
    )
    folium.Rectangle(
        bounds=[[south, west], [north, east]],
        color=COLORS["aoi"],
        fill=False,
        weight=2,
        tooltip="AOI",
    ).add_to(fmap)

    tooltip_by_layer = {
        "roads": ["highway", "name"],
        "buildings": ["building", "name"],
        "landuse": ["landuse", "name"],
        "natural": ["natural", "name"],
        "waterways": ["waterway", "name"],
        "railways": ["railway", "name"],
    }
    for layer_name, gdf in layers_wgs.items():
        folium_add_gdf(fmap, gdf, layer_name, tooltip_by_layer.get(layer_name, []))
    folium.LayerControl(collapsed=False).add_to(fmap)
    fmap.save(output_path)


def make_grid_html_map(
    grid: gpd.GeoDataFrame,
    overlay_png: Path,
    south: float,
    west: float,
    north: float,
    east: float,
    output_path: Path,
) -> None:
    print("[MAP] Writing terrain grid HTML map...")
    fmap = folium.Map(
        location=[(south + north) / 2.0, (west + east) / 2.0],
        zoom_start=11,
        tiles="OpenStreetMap",
    )
    folium.raster_layers.ImageOverlay(
        image=str(overlay_png),
        bounds=[[south, west], [north, east]],
        name="terrain_grid",
        opacity=0.72,
        interactive=True,
        cross_origin=False,
    ).add_to(fmap)

    terrain_counts = grid["terrain_type"].value_counts().to_dict()
    summary_html = "<br>".join(f"{key}: {value}" for key, value in sorted(terrain_counts.items()))
    folium.Marker(
        [(south + north) / 2.0, (west + east) / 2.0],
        popup=folium.Popup(summary_html, max_width=260),
        tooltip="terrain_type counts",
    ).add_to(fmap)
    folium.LayerControl(collapsed=False).add_to(fmap)
    fmap.save(output_path)


def export_grid(
    grid: gpd.GeoDataFrame,
    data_processed_dir: Path,
    cell_size: float,
    warnings: list[str],
) -> tuple[Path, Path]:
    label = cell_size_label(cell_size)
    gpkg_path = data_processed_dir / f"terrain_grid_{label}.gpkg"
    csv_path = data_processed_dir / f"terrain_grid_{label}.csv"
    export_columns = [
        "cell_id",
        "centroid_x",
        "centroid_y",
        "elevation_m",
        "slope_percent",
        "slope_class",
        "terrain_type",
        "road_type",
        "building_count",
        "urban_flag",
        "water_obstacle",
        "railway_flag",
        "cover_factor",
        "concealment_factor",
        "mobility_factor_vehicle",
        "mobility_factor_infantry",
        "los_block",
        "geometry",
    ]
    export_gdf = grid[export_columns].copy()
    print(f"[OUT] Writing {gpkg_path}...")
    write_gpkg(export_gdf, gpkg_path, f"terrain_grid_{label}", warnings)

    print(f"[OUT] Writing {csv_path}...")
    csv_df = pd.DataFrame(export_gdf.drop(columns="geometry"))
    csv_df["geometry_wkt"] = export_gdf.geometry.to_wkt()
    csv_df.to_csv(csv_path, index=False)
    return gpkg_path, csv_path


def format_stats(stats: dict[str, float]) -> str:
    return (
        f"min={stats.get('min', float('nan')):.2f}, "
        f"max={stats.get('max', float('nan')):.2f}, "
        f"mean={stats.get('mean', float('nan')):.2f}"
    )


def write_validation_report(
    output_path: Path,
    south: float,
    west: float,
    north: float,
    east: float,
    layers: dict[str, gpd.GeoDataFrame],
    grid: gpd.GeoDataFrame,
    dem_products: DemProducts | None,
    warnings: list[str],
    generated_files: list[Path],
) -> None:
    print(f"[REPORT] Writing validation report to {output_path}...")
    lines: list[str] = []
    lines.append("Vuhledar Terrain Data Validation Report")
    lines.append("=" * 40)
    lines.append(f"Run time: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"Input bounding box: south={south}, west={west}, north={north}, east={east}")
    lines.append(f"CRS: source EPSG:4326, working/output {CRS_PROJECTED.to_string()}")
    lines.append("")
    lines.append("OSM feature counts:")
    for layer_name in LAYER_DEFINITIONS:
        lines.append(f"- {layer_name}: {len(layers.get(layer_name, empty_gdf()))}")
    lines.append("")
    lines.append(f"Grid cell count: {len(grid)}")
    lines.append("")
    lines.append("terrain_type cell counts:")
    for key, value in grid["terrain_type"].value_counts().sort_index().items():
        lines.append(f"- {key}: {value}")
    lines.append("")
    lines.append("road_type cell counts:")
    for key, value in grid["road_type"].value_counts().sort_index().items():
        lines.append(f"- {key}: {value}")
    lines.append("")
    lines.append(f"DEM used: {'yes' if dem_products is not None else 'no'}")
    if dem_products is not None:
        lines.append(f"Elevation stats: {format_stats(dem_products.elevation_stats)}")
        lines.append(f"Slope stats: {format_stats(dem_products.slope_stats)}")
    lines.append("")
    lines.append("Warnings:")
    if warnings:
        for warning in warnings:
            lines.append(f"- {warning}")
    else:
        lines.append("- none")
    lines.append("")
    lines.append("Generated files:")
    for file_path in generated_files:
        if file_path.exists():
            lines.append(f"- {file_path}")
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def copy_if_needed(source: Path, destination: Path) -> Path:
    if source.resolve() == destination.resolve():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


def main() -> None:
    args = parse_args()
    south = args.south
    west = args.west
    north = args.north
    east = args.east

    output_dir = args.output_dir
    data_raw_dir = args.data_raw_dir
    data_processed_dir = args.data_processed_dir
    ensure_directories(output_dir, data_raw_dir, data_processed_dir)

    warnings: list[str] = []
    generated_files: list[Path] = []

    print("[START] Building Vuhledar terrain project outputs.")
    print(f"[START] Bounding box: south={south}, west={west}, north={north}, east={east}")
    print(f"[START] Cell size: {args.cell_size} m")

    aoi_wgs = make_aoi_gdf(south, west, north, east)

    layers_wgs = download_osm_layers(south, west, north, east, data_raw_dir, aoi_wgs, warnings)
    generated_files.extend(data_raw_dir / f"osm_{name}.gpkg" for name in LAYER_DEFINITIONS)

    dem_sources = select_dem_sources(
        south,
        west,
        north,
        east,
        data_raw_dir,
        args.dem_path,
        args.skip_dem_download,
        warnings,
    )
    generated_files.extend(path for path in dem_sources if path.exists() and path.parent == data_raw_dir)
    dem_products = process_dem(dem_sources, aoi_wgs, output_dir, data_processed_dir, warnings)
    if dem_products is not None:
        generated_files.extend(
            [
                dem_products.dem_path,
                dem_products.slope_path,
                dem_products.hillshade_png,
                dem_products.slope_png,
            ]
        )

    grid = create_grid(aoi_wgs, args.cell_size)
    layers_utm = to_projected_layers(layers_wgs)
    attributed_grid = assign_grid_attributes(grid, layers_utm, dem_products)
    if dem_products is not None:
        missing_elevation = int(attributed_grid["elevation_m"].isna().sum())
        missing_slope = int(attributed_grid["slope_percent"].isna().sum())
        if missing_elevation:
            warnings.append(
                f"DEM elevation is missing for {missing_elevation} grid cells, usually AOI edge nodata."
            )
        if missing_slope:
            warnings.append(
                f"DEM slope is missing for {missing_slope} grid cells, usually AOI edge nodata."
            )

    gpkg_path, csv_path = export_grid(attributed_grid, data_processed_dir, args.cell_size, warnings)
    generated_files.extend([gpkg_path, csv_path])

    static_map_path = output_path_for_cell_size(output_dir, "vuhledar_static_map", "png", args.cell_size)
    contour_map_path = output_dir / "vuhledar_contour_map.png"
    classification_map_path = output_path_for_cell_size(
        output_dir,
        "vuhledar_terrain_classification_map",
        "png",
        args.cell_size,
    )
    overlay_path = output_path_for_cell_size(output_dir, "vuhledar_terrain_overlay", "png", args.cell_size)
    osm_html_path = output_dir / "vuhledar_osm_layers_map.html"
    grid_html_path = output_path_for_cell_size(output_dir, "vuhledar_terrain_grid_map", "html", args.cell_size)
    report_path = output_path_for_cell_size(output_dir, "data_validation_report", "txt", args.cell_size)

    make_static_map(attributed_grid, layers_utm, static_map_path, args.cell_size)
    make_terrain_classification_map(attributed_grid, layers_utm, classification_map_path, args.cell_size)
    if make_contour_map(dem_products, layers_utm, contour_map_path):
        generated_files.append(contour_map_path)
    save_terrain_overlay_png(attributed_grid, overlay_path)
    make_osm_html_map(layers_wgs, south, west, north, east, osm_html_path)
    make_grid_html_map(attributed_grid, overlay_path, south, west, north, east, grid_html_path)
    generated_files.extend(
        [static_map_path, classification_map_path, overlay_path, osm_html_path, grid_html_path]
    )
    generated_files.append(report_path)

    write_validation_report(
        report_path,
        south,
        west,
        north,
        east,
        layers_wgs,
        attributed_grid,
        dem_products,
        warnings,
        generated_files,
    )

    print("[DONE] Terrain build complete.")
    print(f"[DONE] Validation report: {report_path}")


if __name__ == "__main__":
    main()
