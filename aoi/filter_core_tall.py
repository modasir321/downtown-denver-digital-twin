import json
from pathlib import Path
import geopandas as gpd
from shapely.ops import unary_union

OUT = Path(r"d:\twin\aoi")
WEB = Path(r"d:\twin\web\public\data")
CORE = ["Union Station", "CBD", "Civic Center", "Auraria"]

# Prefer already-fetched neighborhoods file
nbhd_path = OUT / "downtown_neighborhoods.geojson"
if nbhd_path.exists():
    nbhds = gpd.read_file(nbhd_path)
    nbhds = nbhds[nbhds["NBHD_NAME"].isin(CORE)].copy()
else:
    raise SystemExit("missing downtown_neighborhoods.geojson")

print("Using:", sorted(nbhds["NBHD_NAME"].tolist()))
aoi = gpd.GeoDataFrame(
    {"name": ["Downtown Core"], "neighborhoods": [", ".join(sorted(CORE))], "geometry": [unary_union(nbhds.geometry)]},
    crs="EPSG:4326",
)

# Start from full clipped downtown buildings if present, else statewide is too heavy — use web buildings
bldg = gpd.read_file(WEB / "buildings.geojson")
if bldg.crs is None:
    bldg = bldg.set_crs(4326)
else:
    bldg = bldg.to_crs(4326)

before = len(bldg)
clipped = gpd.clip(bldg, aoi)
clipped = clipped[~clipped.geometry.is_empty & clipped.geometry.notna()].copy()
if "Height" in clipped.columns:
    clipped["Height"] = clipped["Height"].astype(float)
    # Keep mid/tall+ in the core (drop the low sea of houses)
    clipped = clipped[clipped["Height"] >= 20].copy()

print(f"Buildings: {before} -> {len(clipped)}")
print(clipped["Height"].describe())

aoi.to_file(OUT / "union_station_neighborhood.geojson", driver="GeoJSON")
aoi.to_file(OUT / "downtown_aoi.geojson", driver="GeoJSON")
nbhds.to_file(OUT / "downtown_neighborhoods.geojson", driver="GeoJSON")
clipped.to_file(OUT / "buildings_union_station.geojson", driver="GeoJSON")
clipped.to_file(WEB / "buildings.geojson", driver="GeoJSON")

bbox = [float(x) for x in clipped.total_bounds.tolist()]
center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
meta = {
    "district": "Downtown Denver Core",
    "aoi": "Union Station + CBD + Civic Center + Auraria (tall buildings)",
    "neighborhoods": sorted(CORE),
    "crs": "EPSG:4326",
    "building_count": int(len(clipped)),
    "bbox": bbox,
    "center": center,
    "height_field": "Height",
    "height_units_note": "meters",
    "height_min": float(clipped["Height"].min()) if len(clipped) else None,
    "height_max": float(clipped["Height"].max()) if len(clipped) else None,
    "height_mean": float(clipped["Height"].mean()) if len(clipped) else None,
    "filter_note": "Core neighborhoods only; Height >= 20 m",
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
    (OUT / "union_station_neighborhood.geojson").read_text(encoding="utf-8"), encoding="utf-8"
)
(WEB / "downtown_neighborhoods.geojson").write_text(
    (OUT / "downtown_neighborhoods.geojson").read_text(encoding="utf-8"), encoding="utf-8"
)
print(json.dumps({k: meta[k] for k in ("district", "building_count", "bbox", "center", "height_mean", "filter_note")}, indent=2))
