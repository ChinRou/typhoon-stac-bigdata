from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image
import xarray as xr


def open_zarr_dataset(path: Path) -> xr.Dataset:
    """Open a Zarr dataset from the given path."""
    return xr.open_zarr(str(path))


def read_raster_frame(dataset: xr.Dataset, data_var: str, time_index: int = 0) -> np.ndarray:
    """Read a raster frame from the dataset at the specified time index."""
    if "time" in dataset.coords:
        return dataset[data_var].isel(time=time_index).values
    return dataset[data_var].values


def describe_raster_dataset(
    dataset: xr.Dataset,
    data_var: str,
    asset_name: str,
    item: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    data_array = dataset[data_var]
    shape = list(data_array.shape)
    if "time" in data_array.dims and len(shape) >= 3:
        height, width = int(shape[-2]), int(shape[-1])
        time_count = int(shape[0])
    else:
        height, width = int(shape[-2]), int(shape[-1])
        time_count = 1

    bounds = _extract_bounds(dataset, item)
    metadata: Dict[str, Any] = {
        "bounds": bounds,
        "width": width,
        "height": height,
        "time_count": time_count,
        "default_style": default_style_for_asset(asset_name),
    }

    value_range = default_value_range_for_asset(asset_name)
    if value_range is not None:
        metadata["vmin"] = value_range["vmin"]
        metadata["vmax"] = value_range["vmax"]

    return metadata


def render_array_to_png(array: Any) -> bytes:
    image = _normalize_array_to_image(array)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _normalize_array_to_image(array: Any) -> Image.Image:
    data = np.asarray(array, dtype=float)
    if data.ndim > 2:
        data = np.squeeze(data)
    if data.ndim != 2:
        raise ValueError("Raster frame must be two-dimensional")

    data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    min_val = float(np.nanmin(data))
    max_val = float(np.nanmax(data))
    if min_val == max_val:
        max_val = min_val + 1.0

    scaled = ((data - min_val) / (max_val - min_val) * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(scaled, mode="L")


def render_array_to_png_radar(array: Any) -> bytes:
    image = _normalize_array_to_radar_image(array)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def default_style_for_asset(asset_name: str) -> str:
    normalized = asset_name.lower()
    if normalized == "maxdbz":
        return "radar_reflectivity"
    if normalized in {"rain_rate", "accum_rainfall"}:
        return "rainfall_intensity"
    if normalized in {"echotop_18", "echotop_45"}:
        return "echo_top"
    if normalized == "vil":
        return "vil"
    return "grayscale"


def default_value_range_for_asset(asset_name: str) -> Optional[Dict[str, float]]:
    normalized = asset_name.lower()
    ranges: Dict[str, Dict[str, float]] = {
        "maxdbz": {"vmin": -10.0, "vmax": 60.0},
        "rain_rate": {"vmin": 0.0, "vmax": 120.0},
        "accum_rainfall": {"vmin": 0.0, "vmax": 500.0},
        "vil": {"vmin": 0.0, "vmax": 60.0},
        "echotop_18": {"vmin": 0.0, "vmax": 20.0},
        "echotop_45": {"vmin": 0.0, "vmax": 20.0},
    }
    return ranges.get(normalized)


def _normalize_array_to_radar_image(array: Any) -> Image.Image:
    """Convert radar reflectivity data to NWS-style colormap image."""
    data = np.asarray(array, dtype=float)
    if data.ndim > 2:
        data = np.squeeze(data)
    if data.ndim != 2:
        raise ValueError("Raster frame must be two-dimensional")

    # Handle NaN values - set to transparent or background
    data = np.nan_to_num(data, nan=-999.0)

    # Create RGB image
    height, width = data.shape
    rgb_image = np.zeros((height, width, 3), dtype=np.uint8)

    # Apply NWS reflectivity colormap (-10 to 60 dBZ)
    for i in range(height):
        for j in range(width):
            dbz = data[i, j]
            if dbz == -999.0:  # NaN values
                rgb_image[i, j] = [0, 0, 0]  # Black for no data
            else:
                rgb_image[i, j] = _dbz_to_rgb(dbz)

    return Image.fromarray(rgb_image, mode="RGB")


def _extract_bounds(dataset: xr.Dataset, item: Optional[Dict[str, Any]]) -> List[float]:
    if "lon" in dataset.coords and "lat" in dataset.coords:
        lon = dataset.coords["lon"].values
        lat = dataset.coords["lat"].values
        return [
            float(np.nanmin(lon)),
            float(np.nanmin(lat)),
            float(np.nanmax(lon)),
            float(np.nanmax(lat)),
        ]

    properties = (item or {}).get("properties", {})
    bounds = properties.get("proj:bbox") or item.get("bbox")
    if bounds:
        return [float(value) for value in bounds]

    raise ValueError("Unable to determine raster bounds")


def _dbz_to_rgb(dbz: float) -> List[int]:
    """Convert dBZ value to RGB color using NWS reflectivity colormap."""
    # Clamp to -10 to 60 dBZ range
    dbz = max(-10.0, min(60.0, dbz))

    if dbz < 5:
        # Deep blue to light blue (-10 to 5 dBZ)
        ratio = (dbz + 10) / 15.0  # 0 to 1
        r = int(0 + ratio * 0)
        g = int(0 + ratio * 100)
        b = int(100 + ratio * 155)
    elif dbz < 15:
        # Green (5 to 15 dBZ)
        ratio = (dbz - 5) / 10.0  # 0 to 1
        r = int(0 + ratio * 50)
        g = int(100 + ratio * 155)
        b = int(255 - ratio * 255)
    elif dbz < 30:
        # Yellow to orange (15 to 30 dBZ)
        ratio = (dbz - 15) / 15.0  # 0 to 1
        r = int(50 + ratio * 205)
        g = int(255 - ratio * 155)
        b = int(0 + ratio * 0)
    elif dbz < 50:
        # Red (30 to 50 dBZ)
        ratio = (dbz - 30) / 20.0  # 0 to 1
        r = int(255 - ratio * 0)
        g = int(100 - ratio * 100)
        b = int(0 + ratio * 0)
    else:
        # Purple/pink (50+ dBZ)
        ratio = min(1.0, (dbz - 50) / 10.0)  # 0 to 1
        r = int(255 - ratio * 55)
        g = int(0 + ratio * 0)
        b = int(0 + ratio * 255)

    return [r, g, b]
