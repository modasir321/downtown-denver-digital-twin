import json
from pathlib import Path

import geopandas as gpd
import pandas as pd

aoi_path = Path(r"d:\twin\aoi\union_station_neighborhood.geojson")
bldg_shp = Path(r"d:\twin\_zip_bldg\bldg_footprints.shp")
out_dir = Path(r"d:\twin\aoi")
out_dir.mkdir(parents=True, exist_ok=True)

print("Reading AOI...")
aoi = gpd.read_file(aoi_path)
if aoi.crs is None:
    aoi = aoi.set_crs(4326)
else:
    aoi = aoi.to_crs(4326)
print("AOI features:", len(aoi), "CRS:", aoi.crs)
print("AOI bounds:", tuple(round(x, 6) for x in aoi.total_bounds))

print("Reading buildings...")
bldg = gpd.read_file(bldg_shp)
print("Buildings:", len(bldg), "CRS:", bldg.crs, "cols:", list(bldg.columns))
if bldg.crs is None:
    bldg = bldg.set_crs(4326)
else:
    bldg = bldg.to_crs(4326)

print("Building bounds:", tuple(round(x, 6) for x in bldg.total_bounds))

print("Clipping...")
clipped = gpd.clip(bldg, aoi)
clipped = clipped[~clipped.geometry.is_empty].copy()
clipped = clipped[clipped.geometry.notna()].copy()
print("Clipped buildings:", len(clipped))

if len(clipped) == 0:
    print("Clip empty — trying intersects filter...")
    aoi_union = aoi.unary_union
    clipped = bldg[bldg.intersects(aoi_union)].copy()
    print("Intersects count:", len(clipped))

if "Height" in clipped.columns:
    clipped["Height"] = pd.to_numeric(clipped["Height"], errors="coerce")
    print(
        "Height stats: min=",
        clipped["Height"].min(),
        "max=",
        clipped["Height"].max(),
        "mean=",
        round(float(clipped["Height"].mean()), 2),
    )

out_geojson = out_dir / "buildings_union_station.geojson"
out_shp_dir = out_dir / "buildings_union_station_shp"
out_shp_dir.mkdir(exist_ok=True)
out_shp = out_shp_dir / "buildings_union_station.shp"

clipped.to_file(out_geojson, driver="GeoJSON")
clipped.to_file(out_shp)

meta = {
    "district": "Union Station",
    "nbhd_id": 63,
    "crs": "EPSG:4326",
    "building_count": int(len(clipped)),
    "bbox": [float(x) for x in clipped.total_bounds.tolist()] if len(clipped) else None,
    "center": [
        float((clipped.total_bounds[0] + clipped.total_bounds[2]) / 2),
        float((clipped.total_bounds[1] + clipped.total_bounds[3]) / 2),
    ]
    if len(clipped)
    else None,
    "height_field": "Height",
    "height_units_note": "meters (source footprints Height attribute)",
    "source_buildings": str(bldg_shp),
    "source_aoi": str(aoi_path),
}
if "Height" in clipped.columns and len(clipped):
    meta["height_min"] = float(clipped["Height"].min())
    meta["height_max"] = float(clipped["Height"].max())
    meta["height_mean"] = float(clipped["Height"].mean())

with open(out_dir / "meta.json", "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)

kb = out_geojson.stat().st_size / 1024
print(f"Wrote {out_geojson} ({kb:.1f} KB)")
print(f"Wrote {out_shp}")
print("Wrote meta.json")
print(json.dumps(meta, indent=2))
