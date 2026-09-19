# AOI pipeline (Downtown Denver)

Python scripts that build the study-area GeoJSON served by `web/public/data/`.

## Scripts

| Script | Purpose |
| --- | --- |
| `expand_downtown_aoi.py` | Expand / define downtown AOI |
| `filter_core_tall.py` | Keep core neighborhoods, height ≥ 20 m |
| `enrich_building_attrs.py` | Neighborhood / floors attributes |
| `clip_buildings.py` | Clip footprints to AOI |
| `fetch_osm_layers.py` / `fetch_osm_minimal.py` | Optional OSM overlays |

## Outputs

Key GeoJSON + `meta.json` in this folder should be copied to `web/public/data/` after regenerating.
