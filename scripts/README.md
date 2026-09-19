# Helper scripts (repo root tooling)

## USGS downloads

From this folder:

```powershell
.\Download-UsgsData.ps1 -UrlFile "..\data\raw\data (1).txt" -OutDir "..\data\downloads\dem"
.\Download-UsgsData.ps1 -UrlFile "..\data\raw\data (2).txt" -OutDir "..\data\downloads\laz" -Throttle 4
```

URL lists live in `data/raw/`. Outputs go to `data/downloads/`.
