"""Expand Twin AOI to downtown Denver neighborhoods and reclip buildings."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.ops import unary_union

OUT = Path(r"d:\twin\aoi")
WEB = Path(r"d:\twin\web\public\data")
BLDG = Path(r"d:\twin\_zip_bldg\bldg_footprints.shp")
OUT.mkdir(parents=True, exist_ok=True)
WEB.mkdir(parents=True, exist_ok=True)

# Central tall-building core only (not Speer / Capitol Hill sprawl)
NEIGHBORHOODS = [
    "Union Station",
    "CBD",
    "Civic Center",
    "Auraria",
]
MIN_HEIGHT_M = 20.0


def fetch_neighborhoods(names: list[str]) -> gpd.GeoDataFrame:
    quoted = ",".join("'" + n.replace("'", "''") + "'" for n in names)
    where = f"NBHD_NAME IN ({quoted})"
    params = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    url = (
        "https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/"
        "ODC_ADMN_NEIGHBORHOOD_A/FeatureServer/13/query?"
        + urllib.parse.urlencode(params)
    )
    print("GET neighborhoods…")
    with urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "twin/1.0"}), timeout=90
    ) as r:
        fc = json.loads(r.read().decode())
    gdf = gpd.GeoDataFrame.from_features(fc["features"], crs="EPSG:4326")
    print("Fetched:", sorted(gdf["NBHD_NAME"].tolist()))
    return gdf


def main() -> None:
    nbhds = fetch_neighborhoods(NEIGHBORHOODS)
    if nbhds.empty:
        raise SystemExit("No neighborhoods returned")

    # Save multi-neighborhood + dissolved AOI polygon
    nbhds_path = OUT / "downtown_neighborhoods.geojson"
    nbhds.to_file(nbhds_path, driver="GeoJSON")

    dissolved = gpd.GeoDataFrame(
        {
            "name": ["Downtown Denver Twin"],
            "neighborhoods": [", ".join(sorted(nbhds["NBHD_NAME"].tolist()))],
            "geometry": [unary_union(nbhds.geometry)],
        },
        crs="EPSG:4326",
    )
    aoi_path = OUT / "union_station_neighborhood.geojson"  # keep filename used by app
    # Also write explicit downtown file
    dissolved.to_file(OUT / "downtown_aoi.geojson", driver="GeoJSON")
    dissolved.to_file(aoi_path, driver="GeoJSON")
    print("AOI bounds:", tuple(round(x, 6) for x in dissolved.total_bounds))

    print("Reading buildings…")
    bldg = gpd.read_file(BLDG)
    if bldg.crs is None:
        bldg = bldg.set_crs(4326)
    else:
        bldg = bldg.to_crs(4326)

    print("Clipping buildings to downtown AOI…")
    clipped = gpd.clip(bldg, dissolved)
    clipped = clipped[~clipped.geometry.is_empty & clipped.geometry.notna()].copy()
    if "Height" in clipped.columns:
        clipped["Height"] = pd.to_numeric(clipped["Height"], errors="coerce")
        clipped = clipped[clipped["Height"].fillna(0) >= MIN_HEIGHT_M].copy()

    print(f"Buildings: {len(bldg)} -> {len(clipped)}")
    clipped.to_file(OUT / "buildings_union_station.geojson", driver="GeoJSON")
    clipped.to_file(WEB / "buildings.geojson", driver="GeoJSON")

    bbox = [float(x) for x in clipped.total_bounds.tolist()]
    center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
    meta = {
        "district": "Downtown Denver Core",
        "aoi": "Union Station + CBD + Civic Center + Auraria (Height >= 20 m)",
        "neighborhoods": sorted(nbhds["NBHD_NAME"].tolist()),
        "crs": "EPSG:4326",
        "building_count": int(len(clipped)),
        "bbox": bbox,
        "center": center,
        "height_field": "Height",
        "height_units_note": "meters (source footprints Height attribute)",
        "height_min": float(clipped["Height"].min()) if len(clipped) else None,
        "height_max": float(clipped["Height"].max()) if len(clipped) else None,
        "height_mean": float(clipped["Height"].mean()) if len(clipped) else None,
        "filter_note": f"Core neighborhoods; Height >= {MIN_HEIGHT_M} m",
        "layers": {
            "boundary": "union_station_neighborhood.geojson",
            "neighborhoods": "downtown_neighborhoods.geojson",
            "buildings": "buildings.geojson",
            "roads": "roads.geojson",
            "water": "water.geojson",
            "parks": "parks.geojson",
            "transit": "transit.geojson",
        },
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (WEB / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (WEB / "union_station_neighborhood.geojson").write_text(
        aoi_path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (WEB / "downtown_neighborhoods.geojson").write_text(
        nbhds_path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    print(json.dumps({k: meta[k] for k in ("district", "building_count", "bbox", "center", "height_mean")}, indent=2))


if __name__ == "__main__":
    main()
