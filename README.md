# Downtown Denver Digital Twin

Clean layout for the Downtown Denver 3D twin (Next.js + Mapbox + Cesium).

## Directory layout

```
twin/
├── web/                 # Next.js app (run the product from here)
├── aoi/                 # GIS scripts + processed GeoJSON for the study area
├── data/
│   ├── raw/             # Source downloads (zips, DEM .tif, USGS manifests)
│   ├── extracts/        # Unzipped shapefile / parcel workspaces
│   └── downloads/       # Misc fetched datasets
├── docs/                # Specs, guides, roadmap PDFs
├── scripts/             # Helper PowerShell / tooling (outside the web app)
└── assets/
    └── icons-source/    # Original traveler PNGs (app uses web/public/icons/)
```

## Run the app

```bash
cd web
copy .env.example .env.local
# add NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN (+ optional CESIUM_ION token)
npm install
npm run dev
```

Open http://localhost:3000

## Deploy on Vercel

The Next.js app lives in **`web/`**. In the Vercel project:

1. **Root Directory** = `web`
2. Add env vars:
   - `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`
   - `NEXT_PUBLIC_CESIUM_ION_TOKEN` (optional)
3. Redeploy after changing Root Directory or env vars

Production: https://downtown-denver-digital-twin.vercel.app

## Data flow

1. Raw sources live in `data/raw/`
2. Python tools in `aoi/` clip / filter / enrich buildings
3. Copy outputs into `web/public/data/` for the browser app

## Docs

- `docs/Digital Twin.docx` — technical & deployment guide
- `docs/Denver_Union_Station_Digital_Twin.docx` — project notes
- `docs/US_Digital_Twin_Roadmap.md.pdf` — roadmap
