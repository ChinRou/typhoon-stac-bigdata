import json
from pathlib import Path
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, Response

from fastapi.responses import FileResponse
from backend.render import (
    default_style_for_asset,
    default_value_range_for_asset,
    describe_raster_dataset,
    open_zarr_dataset,
    read_raster_frame,
    render_array_to_png,
    render_array_to_png_radar,
)
from backend.stac import (
    collect_items,
    collect_events,
    get_event,
    get_event_raster_asset,
    get_stac_root,
    get_event_vector_asset,
    get_time_coordinates,
    get_time_coordinates_from_item,
    resolve_asset_path,
    choose_data_variable,
    summarize_event,
)

try:
    import geopandas as gpd
except ModuleNotFoundError:
    gpd = None

try:
    from pyproj import Transformer
except ModuleNotFoundError:
    Transformer = None

app = FastAPI(title="STAC WebGIS Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_ROOT = Path("frontend")
TEMPLATE_ROOT = FRONTEND_ROOT / "templates"
STATIC_ROOT = FRONTEND_ROOT / "static"
app.mount("/static", StaticFiles(directory=STATIC_ROOT), name="static")


@app.get("/", include_in_schema=False)
def serve_index() -> FileResponse:
    return FileResponse(TEMPLATE_ROOT / "index.html", media_type="text/html")

STAC_ROOT_PATH = get_stac_root()
ITEM_INDEX = collect_items(STAC_ROOT_PATH)
EVENT_INDEX = collect_events(ITEM_INDEX)


@app.get("/api/items")
def list_items() -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    for event_id in sorted(EVENT_INDEX):
        items.append(summarize_event(EVENT_INDEX[event_id]))
    return {"items": items}


@app.get("/api/items/{item_id}/timestamps")
def get_item_raster_times(item_id: str, asset: str = Query(...)) -> Dict[str, Any]:
    event = get_event(EVENT_INDEX, item_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Item not found")

    try:
        asset_info = get_event_raster_asset(event, asset)
    except KeyError:
        raise HTTPException(status_code=404, detail="Raster asset not found")

    item = asset_info["item"]
    asset_definition = asset_info["asset"]
    asset_path = resolve_asset_path(item, asset_definition)
    if not asset_path.exists():
        try:
            timestamps = get_time_coordinates_from_item(item)
            return {"item_id": item_id, "asset": asset_info["name"], "timestamps": timestamps}
        except ValueError:
            raise HTTPException(status_code=404, detail="Raster asset file not found")

    try:
        dataset = open_zarr_dataset(asset_path)
        data_var = choose_data_variable(dataset, asset)
        try:
            timestamps = get_time_coordinates(dataset, data_var)
        except ValueError:
            timestamps = get_time_coordinates_from_item(item)
        return {"item_id": item_id, "asset": asset_info["name"], "timestamps": timestamps}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to load time coordinates: {exc}")


@app.get("/api/items/{item_id}/vector")
def get_item_vector(
    item_id: str,
    asset: str = Query(...),
) -> Any:
    event = get_event(EVENT_INDEX, item_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Item not found")

    try:
        asset_info = get_event_vector_asset(event, asset)
    except KeyError:
        raise HTTPException(status_code=404, detail="Vector asset not found")

    item = asset_info["item"]
    asset_definition = asset_info["asset"]
    asset_path = resolve_asset_path(item, asset_definition)
    if asset_path.suffix.lower() == ".geojson":
        try:
            with asset_path.open("r", encoding="utf-8") as handle:
                geojson = json.load(handle)
                return JSONResponse(content=normalize_geojson_to_epsg4326(geojson))
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="GeoJSON preview file not found")

    if asset_path.suffix.lower() == ".gpkg":
        if gpd is None:
            raise HTTPException(status_code=500, detail="GeoPackage support requires geopandas")
        try:
            gdf = gpd.read_file(str(asset_path))
            if gdf.crs is not None and str(gdf.crs).upper() != "EPSG:4326":
                gdf = gdf.to_crs(4326)
            return JSONResponse(content=json.loads(gdf.to_json()))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Unable to read landslide GeoPackage: {exc}")

    raise HTTPException(status_code=415, detail="Unsupported landslide asset type")


@app.get("/api/items/{item_id}/raster/meta")
def get_item_raster_meta(item_id: str, asset: str = Query(...)) -> Dict[str, Any]:
    event = get_event(EVENT_INDEX, item_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Item not found")

    try:
        asset_info = get_event_raster_asset(event, asset)
    except KeyError:
        raise HTTPException(status_code=404, detail="Raster asset not found")

    item = asset_info["item"]
    asset_definition = asset_info["asset"]
    asset_path = resolve_asset_path(item, asset_definition)
    if not asset_path.exists():
        properties = item.get("properties", {})
        bounds = properties.get("proj:bbox") or item.get("bbox")
        shape = properties.get("proj:shape") or []
        if not bounds or len(shape) < 2:
            raise HTTPException(status_code=404, detail="Raster asset file not found")
        metadata: Dict[str, Any] = {
            "bounds": bounds,
            "width": int(shape[-1]),
            "height": int(shape[-2]),
            "default_style": default_style_for_asset(asset_info["name"]),
        }
        try:
            timestamps = get_time_coordinates_from_item(item)
            metadata["timestamps"] = timestamps
            metadata["time_count"] = len(timestamps)
        except ValueError:
            metadata["time_count"] = 1
        value_range = default_value_range_for_asset(asset_info["name"])
        if value_range is not None:
            metadata.update(value_range)
        return metadata

    try:
        dataset = open_zarr_dataset(asset_path)
        data_var = choose_data_variable(dataset, asset)
        metadata = describe_raster_dataset(dataset, data_var, asset_info["name"], item=item)
        try:
            metadata["timestamps"] = get_time_coordinates(dataset, data_var)
        except ValueError:
            try:
                metadata["timestamps"] = get_time_coordinates_from_item(item)
            except ValueError:
                pass
        return metadata
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to load raster metadata: {exc}")


@app.get("/api/items/{item_id}/raster/frame")
def render_raster(
    item_id: str,
    asset: str = Query(...),
    time_index: int = Query(0, ge=0),
) -> Response:
    event = get_event(EVENT_INDEX, item_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Item not found")

    try:
        asset_info = get_event_raster_asset(event, asset)
    except KeyError:
        raise HTTPException(status_code=404, detail="Raster asset not found")

    item = asset_info["item"]
    asset_definition = asset_info["asset"]
    asset_path = resolve_asset_path(item, asset_definition)
    if not asset_path.exists():
        raise HTTPException(status_code=404, detail="Raster asset file not found")

    try:
        dataset = open_zarr_dataset(asset_path)
        data_var = choose_data_variable(dataset, asset)
        frame = read_raster_frame(dataset, data_var, time_index=time_index)
        if asset_info["name"] == "maxdbz":
            image_bytes = render_array_to_png_radar(frame)
        else:
            image_bytes = render_array_to_png(frame)
        return Response(content=image_bytes, media_type="image/png")
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to render raster: {exc}")


def normalize_geojson_to_epsg4326(geojson: Dict[str, Any]) -> Dict[str, Any]:
    crs_name = (
        geojson.get("crs", {})
        .get("properties", {})
        .get("name", "")
        .upper()
    )
    if "4326" in crs_name or not crs_name:
        return geojson
    if "3826" not in crs_name:
        return geojson
    if Transformer is None:
        return geojson

    transformer = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)
    normalized = dict(geojson)
    normalized["features"] = [
        normalize_feature_to_epsg4326(feature, transformer) for feature in geojson.get("features", [])
    ]
    normalized["crs"] = {
        "type": "name",
        "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
    }
    if "bbox" in normalized:
        normalized["bbox"] = transform_bbox_to_epsg4326(normalized["bbox"], transformer)
    return normalized


def normalize_feature_to_epsg4326(feature: Dict[str, Any], transformer: Any) -> Dict[str, Any]:
    normalized = dict(feature)
    geometry = feature.get("geometry")
    if geometry:
        normalized["geometry"] = transform_geometry_to_epsg4326(geometry, transformer)
    if "bbox" in feature:
        normalized["bbox"] = transform_bbox_to_epsg4326(feature["bbox"], transformer)
    return normalized


def transform_geometry_to_epsg4326(geometry: Dict[str, Any], transformer: Any) -> Dict[str, Any]:
    normalized = dict(geometry)
    normalized["coordinates"] = transform_coordinates_to_epsg4326(
        geometry.get("coordinates"),
        transformer,
    )
    return normalized


def transform_coordinates_to_epsg4326(coordinates: Any, transformer: Any) -> Any:
    if isinstance(coordinates, (list, tuple)):
        if coordinates and isinstance(coordinates[0], (int, float)):
            x = coordinates[0]
            y = coordinates[1]
            lon, lat = transformer.transform(x, y)
            if len(coordinates) > 2:
                return [lon, lat, *coordinates[2:]]
            return [lon, lat]
        return [transform_coordinates_to_epsg4326(value, transformer) for value in coordinates]
    return coordinates


def transform_bbox_to_epsg4326(bbox: List[float], transformer: Any) -> List[float]:
    minx, miny = transformer.transform(bbox[0], bbox[1])
    maxx, maxy = transformer.transform(bbox[2], bbox[3])
    return [minx, miny, maxx, maxy]
