import json
from pathlib import Path
import geopandas as gpd

WEB = Path(r"d:\twin\web\public\data")
OUT = Path(r"d:\twin\aoi")
bldg = gpd.read_file(WEB / "buildings.geojson")
nbhd = gpd.read_file(WEB / "downtown_neighborhoods.geojson")
if bldg.crs is None: bldg = bldg.set_crs(4326)
else: bldg = bldg.to_crs(4326)
nbhd = nbhd.to_crs(4326)
# point-on-surface join
pts = bldg.copy()
pts["geometry"] = pts.representative_point()
joined = gpd.sjoin(pts[["geometry"]], nbhd[["NBHD_NAME", "geometry"]], how="left", predicate="within")
bldg["Neighborhood"] = joined["NBHD_NAME"].values
bldg["Neighborhood"] = bldg["Neighborhood"].fillna("Downtown Core")
bldg["Floors"] = (bldg["Height"].astype(float) / 3.5).round().astype(int)
bldg.to_file(WEB / "buildings.geojson", driver="GeoJSON")
bldg.to_file(OUT / "buildings_union_station.geojson", driver="GeoJSON")
print(bldg["Neighborhood"].value_counts().to_string())
print("ok", len(bldg))
