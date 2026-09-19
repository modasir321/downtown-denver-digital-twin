"""Fetch OSM layers with a smaller Overpass query; fallbacks to public mirrors."""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(r"d:\twin\aoi")
META = json.loads((OUT / "meta.json").read_text(encoding="utf-8"))
minx, miny, maxx, maxy = META["bbox"]
pad = 0.0012
south, west, north, east = miny - pad, minx - pad, maxy + pad, maxx + pad

# Split into smaller queries to avoid 504s
QUERIES = {
    "roads": f"""
[out:json][timeout:60];
way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service)$"]({south},{west},{north},{east});
out body; >; out skel qt;
""",
    "water": f"""
[out:json][timeout:60];
(
  way["waterway"~"^(river|canal)$"]({south},{west},{north},{east});
  way["natural"="water"]({south},{west},{north},{east});
  relation["natural"="water"]({south},{west},{north},{east});
);
out body; >; out skel qt;
""",
    "parks": f"""
[out:json][timeout:60];
(
  way["leisure"="park"]({south},{west},{north},{east});
  relation["leisure"="park"]({south},{west},{north},{east});
);
out body; >; out skel qt;
""",
    "transit": f"""
[out:json][timeout:60];
way["railway"~"^(rail|light_rail|tram)$"]({south},{west},{north},{east});
out body; >; out skel qt;
""",
}


def overpass(query: str) -> dict:
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.openstreetmap.ru/api/interpreter",
    ]
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err = None
    for url in endpoints:
        try:
            print(f"  POST {url}")
            req = urllib.request.Request(
                url,
                data=data,
                headers={"User-Agent": "union-station-digital-twin/1.0"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"  fail: {e}")
            time.sleep(1)
    raise RuntimeError(str(last_err))


def to_features(osm: dict, kind: str) -> list:
    nodes = {
        el["id"]: (el["lon"], el["lat"])
        for el in osm.get("elements", [])
        if el.get("type") == "node" and "lon" in el
    }
    feats = []
    for el in osm.get("elements", []):
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        coords = [nodes[n] for n in (el.get("nodes") or []) if n in nodes]
        if len(coords) < 2:
            continue
        props = {k: tags[k] for k in ("name", "highway", "waterway", "natural", "leisure", "railway") if k in tags}
        closed = len(coords) >= 4 and coords[0] == coords[-1]
        if kind in {"parks", "water"} and closed and (tags.get("leisure") == "park" or tags.get("natural") == "water"):
            geom = {"type": "Polygon", "coordinates": [coords]}
        else:
            geom = {"type": "LineString", "coordinates": coords}
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    return feats


def main() -> None:
    print(f"BBox {west:.5f},{south:.5f} -> {east:.5f},{north:.5f}")
    layers = {}
    for kind, query in QUERIES.items():
        print(f"Fetching {kind}...")
        try:
            osm = overpass(query)
            feats = to_features(osm, kind)
            path = OUT / f"{kind}.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
            layers[kind] = path.name
            print(f"  {kind}: {len(feats)} features")
        except Exception as e:  # noqa: BLE001
            print(f"  SKIP {kind}: {e}")
            # empty placeholder so the map still loads
            path = OUT / f"{kind}.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")
            layers[kind] = path.name

    META["layers"] = {
        "boundary": "union_station_neighborhood.geojson",
        "buildings": "buildings_union_station.geojson",
        **layers,
    }
    (OUT / "meta.json").write_text(json.dumps(META, indent=2), encoding="utf-8")
    print("Done.")


if __name__ == "__main__":
    main()
