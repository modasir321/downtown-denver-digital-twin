"""Fetch OSM roads/parks/water for the current AOI bbox from meta.json."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(r"d:\twin\aoi")
WEB = Path(r"d:\twin\web\public\data")
WEB.mkdir(parents=True, exist_ok=True)

meta = json.loads((OUT / "meta.json").read_text(encoding="utf-8"))
west, south, east, north = meta["bbox"]
# Overpass bbox: south,west,north,east
bbox = f"{south},{west},{north},{east}"
print("AOI bbox (S,W,N,E):", bbox)

empty = {"type": "FeatureCollection", "features": []}
for name in ["roads", "water", "parks", "transit"]:
    p = OUT / f"{name}.geojson"
    if not p.exists() or p.stat().st_size < 50:
        p.write_text(json.dumps(empty), encoding="utf-8")
    (WEB / p.name).write_text(p.read_text(encoding="utf-8"), encoding="utf-8")

QUERY = f"""
[out:json][timeout:90];
(
  way["waterway"]({bbox});
  way["natural"="water"]({bbox});
  relation["natural"="water"]({bbox});
  way["leisure"="park"]({bbox});
  relation["leisure"="park"]({bbox});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]({bbox});
);
out body;
>;
out skel qt;
"""

endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

osm = None
for url in endpoints:
    try:
        print("try", url)
        data = urllib.parse.urlencode({"data": QUERY}).encode()
        req = urllib.request.Request(
            url,
            data=data,
            headers={"User-Agent": "twin/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            osm = json.loads(r.read().decode())
            print("ok elements", len(osm.get("elements", [])))
            break
    except Exception as e:  # noqa: BLE001
        print("fail", e)

if osm:
    nodes = {
        el["id"]: (el["lon"], el["lat"])
        for el in osm["elements"]
        if el.get("type") == "node" and "lon" in el
    }
    roads, water, parks = [], [], []
    for el in osm["elements"]:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        coords = [nodes[n] for n in el.get("nodes", []) if n in nodes]
        if len(coords) < 2:
            continue
        props = {
            k: tags[k]
            for k in ("name", "highway", "leisure", "waterway", "natural")
            if k in tags
        }
        closed = len(coords) >= 4 and coords[0] == coords[-1]
        if tags.get("waterway") or tags.get("natural") == "water":
            water.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
        elif tags.get("leisure") == "park":
            geom = (
                {"type": "Polygon", "coordinates": [coords]}
                if closed
                else {"type": "LineString", "coordinates": coords}
            )
            parks.append({"type": "Feature", "properties": props, "geometry": geom})
        elif tags.get("highway"):
            roads.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
    for name, feats in [("water", water), ("parks", parks), ("roads", roads)]:
        raw = json.dumps({"type": "FeatureCollection", "features": feats})
        (OUT / f"{name}.geojson").write_text(raw, encoding="utf-8")
        (WEB / f"{name}.geojson").write_text(raw, encoding="utf-8")
        print(name, len(feats))
else:
    print("No OSM; leaving placeholders")

for src, dst in [
    (OUT / "buildings_union_station.geojson", WEB / "buildings.geojson"),
    (OUT / "union_station_neighborhood.geojson", WEB / "union_station_neighborhood.geojson"),
    (OUT / "meta.json", WEB / "meta.json"),
]:
    if src.exists():
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        print("copied", dst.name)
