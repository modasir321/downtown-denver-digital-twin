"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  TwinBadge,
  TwinButton,
  TwinDivider,
  TwinGlassPanel,
  TwinHeightLegend,
  TwinInspectTooltip,
  TwinMetric,
  TwinToggleChip,
  formatCount,
  twinType,
  type InspectTipData,
} from "./TwinUi";
import {
  readTwinCameraPose,
  writeTwinCameraPose,
  zoomToHeight,
} from "@/lib/twinCameraSync";

type Meta = {
  district: string;
  aoi?: string;
  neighborhoods?: string[];
  building_count: number;
  center: [number, number];
  bbox: [number, number, number, number];
  height_mean?: number;
};

type RouteMode = "walking" | "cycling" | "driving";

type LngLat = [number, number];

type InspectTip = InspectTipData;

const MODE_LABEL: Record<RouteMode, string> = {
  walking: "Person",
  cycling: "Bike",
  driving: "Car",
};

const MODE_ICON: Record<RouteMode, string> = {
  walking: "/icons/person.png",
  cycling: "/icons/bike.png",
  driving: "/icons/car.png",
};

/** Icon art facing offset (degrees) so 0° = travel north. Car faces up; bike is angled ~45°. */
const MODE_BEARING_OFFSET: Record<RouteMode, number> = {
  walking: 0,
  cycling: -35,
  driving: 0,
};

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function addOrSetSource(map: mapboxgl.Map, id: string, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Shortest-path blend between compass bearings (degrees). */
function lerpAngleDeg(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function densifyCoords(coords: LngLat[], spacingM = 12): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const dist = haversineMeters(a, b);
    const steps = Math.max(1, Math.ceil(dist / spacingM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function buildRouteTrack(coords: LngLat[]) {
  const dense = densifyCoords(coords, 10);
  const cum: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(dense[i - 1], dense[i]));
  }
  return { coords: dense, cum, total: cum[cum.length - 1] || 0 };
}

function sampleTrackIndex(
  track: ReturnType<typeof buildRouteTrack>,
  distance: number,
): { i0: number; i1: number; t: number; d: number } {
  const { cum, total } = track;
  const d = Math.max(0, Math.min(distance, total));
  let i = 1;
  while (i < cum.length && cum[i] < d) i++;
  const i0 = Math.max(0, i - 1);
  const i1 = Math.min(track.coords.length - 1, i);
  const segLen = cum[i1] - cum[i0] || 1;
  return { i0, i1, t: (d - cum[i0]) / segLen, d };
}

/** Catmull-Rom position + look-ahead heading for smooth corner arcs. */
function pointAlongTrackSmooth(
  track: ReturnType<typeof buildRouteTrack>,
  distance: number,
  lookAheadM = 28,
): { point: LngLat; bearing: number } {
  const { coords } = track;
  if (coords.length === 1) return { point: coords[0], bearing: 0 };
  if (coords.length === 2) {
    const { i0, i1, t } = sampleTrackIndex(track, distance);
    const a = coords[i0];
    const b = coords[i1];
    return {
      point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      bearing: bearingDegrees(a, b),
    };
  }

  const { i0, i1, t } = sampleTrackIndex(track, distance);
  const p0 = coords[Math.max(0, i0 - 1)];
  const p1 = coords[i0];
  const p2 = coords[i1];
  const p3 = coords[Math.min(coords.length - 1, i1 + 1)];

  const crm = (a: number, b: number, c: number, d: number, u: number) => {
    const u2 = u * u;
    const u3 = u2 * u;
    return 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  };

  const point: LngLat = [
    crm(p0[0], p1[0], p2[0], p3[0], t),
    crm(p0[1], p1[1], p2[1], p3[1], t),
  ];

  const ahead = sampleTrackIndex(track, distance + lookAheadM);
  const a0 = coords[ahead.i0];
  const a1 = coords[ahead.i1];
  const aheadPt: LngLat = [
    a0[0] + (a1[0] - a0[0]) * ahead.t,
    a0[1] + (a1[1] - a0[1]) * ahead.t,
  ];
  return { point, bearing: bearingDegrees(point, aheadPt) };
}

function createTravelerEl(mode: RouteMode): HTMLDivElement {
  // Vehicle sits on the map plane; soft halo keeps it readable over extrusions
  const el = document.createElement("div");
  el.className = "twin-traveler";
  const size = mode === "walking" ? 52 : 48;
  el.style.cssText =
    `width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;` +
    "pointer-events:none;user-select:none;will-change:transform;" +
    "border-radius:9999px;background:radial-gradient(circle,rgba(0,240,255,0.28) 0%,rgba(0,240,255,0.06) 55%,transparent 72%);" +
    "box-shadow:0 0 0 2px #0F172A,0 0 12px rgba(0,240,255,0.75);";
  const img = document.createElement("img");
  img.src = MODE_ICON[mode];
  img.alt = MODE_LABEL[mode];
  img.draggable = false;
  img.style.cssText =
    "width:78%;height:78%;object-fit:contain;display:block;" +
    "filter:drop-shadow(0 2px 3px rgba(0,0,0,.75));";
  el.appendChild(img);
  return el;
}

function animDurationMs(distanceM: number, durationSec: number, mode: RouteMode): number {
  // Speedy preview: ~1/25 of real travel time, clamped
  const fromReal = (durationSec * 1000) / 25;
  const speed =
    mode === "walking" ? 18 : mode === "cycling" ? 40 : 70; // m/s visual
  const fromDist = (distanceM / speed) * 1000;
  return Math.max(4500, Math.min(28000, (fromReal + fromDist) / 2));
}

export default function DigitalTwinMap({ active = true }: { active?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const endMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const travelerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const routeGeomRef = useRef<GeoJSON.LineString | null>(null);
  const routeMetaRef = useRef<{ distance: number; duration: number } | null>(null);
  const routeModeRef = useRef<RouteMode>("walking");
  const skipPoseWriteRef = useRef(false);
  const travelingRef = useRef(false);
  const pointsRef = useRef<{ start: LngLat | null; end: LngLat | null }>({
    start: null,
    end: null,
  });
  const startTravelRef = useRef<
    ((geom: GeoJSON.LineString, mode: RouteMode, distance: number, duration: number) => void) | null
  >(null);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Starting map…");
  const [terrainOn, setTerrainOn] = useState(true);
  const [buildingsOn, setBuildingsOn] = useState(true);
  const [routeMode, setRouteMode] = useState<RouteMode>("walking");
  const [routeInfo, setRouteInfo] = useState<string | null>(null);
  const [routeHint, setRouteHint] = useState("Click map: set start, then destination");
  const [traveling, setTraveling] = useState(false);
  const [tip, setTip] = useState<InspectTip | null>(null);

  routeModeRef.current = routeMode;

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();
    if (!token) {
      setError("Missing NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN in web/.env.local");
      return;
    }

    const el = containerRef.current;
    if (!el || mapRef.current) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    mapboxgl.accessToken = token;

    const stopTravel = () => {
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      travelerMarkerRef.current?.remove();
      travelerMarkerRef.current = null;
      travelingRef.current = false;
      setTraveling(false);
    };

    const startTravel = (
      geom: GeoJSON.LineString,
      mode: RouteMode,
      distance: number,
      duration: number,
    ) => {
      const map = mapRef.current;
      if (!map || !geom.coordinates?.length) return;
      stopTravel();
      routeGeomRef.current = geom;
      routeMetaRef.current = { distance, duration };
      setTip(null);

      const coords = geom.coordinates.map((c) => [c[0], c[1]] as LngLat);
      const track = buildRouteTrack(coords);
      const ms = animDurationMs(distance, duration, mode);
      const alignToMap = mode !== "walking";

      const first = pointAlongTrackSmooth(track, 0);
      travelerMarkerRef.current = new mapboxgl.Marker({
        element: createTravelerEl(mode),
        // Cars/bikes yaw with the road; pedestrians stay billboard-upright
        rotationAlignment: alignToMap ? "map" : "viewport",
        pitchAlignment: alignToMap ? "map" : "viewport",
        anchor: "center",
        offset: alignToMap ? [0, 0] : [0, -14],
      })
        .setLngLat(first.point)
        .setRotation(
          mode === "walking" ? 0 : first.bearing + MODE_BEARING_OFFSET[mode],
        )
        .addTo(map);

      travelingRef.current = true;
      setTraveling(true);
      setRouteHint(`${MODE_LABEL[mode]} traveling to destination…`);
      const t0 = performance.now();
      let lastNow = t0;
      let smoothBearing = first.bearing;
      let camBearing = map.getBearing();

      const tick = (now: number) => {
        const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
        lastNow = now;
        const t = Math.min(1, (now - t0) / ms);
        // Soft ease only at ends — mid-route speed stays more constant
        const eased = smootherstep(t);
        const { point, bearing } = pointAlongTrackSmooth(
          track,
          eased * track.total,
          mode === "driving" ? 36 : 24,
        );

        // Exponential heading blend → no instantaneous corner snaps
        const turnRate = mode === "driving" ? 7.5 : mode === "cycling" ? 9 : 11;
        const alpha = 1 - Math.exp(-turnRate * dt);
        smoothBearing = lerpAngleDeg(smoothBearing, bearing, alpha);
        camBearing = lerpAngleDeg(camBearing, smoothBearing, 1 - Math.exp(-5.5 * dt));

        const marker = travelerMarkerRef.current;
        if (marker) {
          marker.setLngLat(point);
          if (mode === "walking") {
            marker.setRotation(0);
          } else {
            marker.setRotation(smoothBearing + MODE_BEARING_OFFSET[mode]);
          }
        }

        if (t < 1) {
          skipPoseWriteRef.current = true;
          map.jumpTo({
            center: point,
            bearing: camBearing,
            pitch: Math.min(68, 58 + (mode === "driving" ? 4 : 0)),
            zoom: mode === "walking" ? 16.8 : mode === "cycling" ? 16.2 : 15.6,
          });
          skipPoseWriteRef.current = false;
          animFrameRef.current = requestAnimationFrame(tick);
        } else {
          animFrameRef.current = null;
          travelingRef.current = false;
          setTraveling(false);
          setRouteHint("Arrived · Replay or click map for a new start");
        }
      };
      animFrameRef.current = requestAnimationFrame(tick);
    };
    startTravelRef.current = startTravel;

    const clearRoute = () => {
      const map = mapRef.current;
      stopTravel();
      startMarkerRef.current?.remove();
      endMarkerRef.current?.remove();
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      pointsRef.current = { start: null, end: null };
      routeGeomRef.current = null;
      routeMetaRef.current = null;
      setRouteInfo(null);
      setRouteHint("Click map: set start, then destination");
      if (map?.getSource("route")) {
        (map.getSource("route") as mapboxgl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        });
      }
    };

    const fetchRoute = async (start: LngLat, end: LngLat, mode: RouteMode) => {
      const map = mapRef.current;
      if (!map) return;
      stopTravel();
      setRouteHint("Fetching route…");
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/${mode}/` +
        `${start[0]},${start[1]};${end[0]},${end[1]}` +
        `?geometries=geojson&overview=full&access_token=${token}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data.routes?.[0]) {
          setRouteHint(data.message || "No route found");
          return;
        }
        const route = data.routes[0];
        const geom = route.geometry as GeoJSON.LineString;
        addOrSetSource(map, "route", {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: geom }],
        });
        // Ensure street route layers exist (created on load; recreate if style was reset)
        if (!map.getLayer("route-casing")) {
          map.addLayer({
            id: "route-casing",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#0F172A",
              "line-width": 12,
              "line-opacity": 0.95,
            },
          });
        }
        if (!map.getLayer("route-line")) {
          map.addLayer({
            id: "route-line",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#00F0FF",
              "line-width": 5,
              "line-opacity": 1,
            },
          });
        }
        // Keep route visually above building fill-extrusions when possible
        try {
          if (map.getLayer("buildings-3d") && map.getLayer("route-casing")) {
            map.moveLayer("route-casing");
            map.moveLayer("route-line");
          }
        } catch {
          /* ignore */
        }
        const km = route.distance / 1000;
        const mins = Math.round(route.duration / 60);
        setRouteInfo(
          `${km.toFixed(2)} km · ${mins} min · ${MODE_LABEL[mode]}`,
        );
        startTravel(geom, mode, route.distance, route.duration);
      } catch (e) {
        console.error(e);
        setRouteHint("Routing request failed");
      }
    };

    (async () => {
      setStatus("Loading metadata…");
      const loadedMeta = await loadJson<Meta>("/data/meta.json");
      if (cancelled || !loadedMeta?.center) {
        if (!cancelled) setError("Could not load /data/meta.json");
        return;
      }
      setMeta(loadedMeta);

      setStatus("Creating map…");
      const savedPose = readTwinCameraPose();
      const map = new mapboxgl.Map({
        container: el,
        style: "mapbox://styles/mapbox/dark-v11",
        center: savedPose
          ? [savedPose.lng, savedPose.lat]
          : loadedMeta.center,
        zoom: savedPose?.zoom ?? 13.6,
        pitch: savedPose?.mapPitch ?? 55,
        bearing: savedPose?.heading ?? -20,
        antialias: true,
      });
      mapRef.current = map;
      (window as unknown as { __twinMap?: mapboxgl.Map }).__twinMap = map;

      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

      const persistPose = () => {
        if (skipPoseWriteRef.current) return;
        const c = map.getCenter();
        writeTwinCameraPose({
          lng: c.lng,
          lat: c.lat,
          zoom: map.getZoom(),
          height: zoomToHeight(map.getZoom()),
          heading: map.getBearing(),
          mapPitch: map.getPitch(),
        });
      };
      map.on("moveend", persistPose);
      cleanups.push(() => {
        map.off("moveend", persistPose);
      });

      // Soften remaining basemap road paint so it never fights orange extrusions / cyan routes
      map.on("style.load", () => {
        const layers = map.getStyle().layers ?? [];
        for (const layer of layers) {
          if (layer.type !== "line") continue;
          const id = layer.id.toLowerCase();
          if (!id.includes("road") && !id.includes("street") && !id.includes("bridge")) continue;
          try {
            map.setPaintProperty(layer.id, "line-color", "#334155");
            map.setPaintProperty(layer.id, "line-opacity", 0.45);
          } catch {
            /* some style layers reject overrides */
          }
        }
      });

      const resize = () => {
        try {
          map.resize();
        } catch {
          /* ignore */
        }
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      cleanups.push(() => ro.disconnect());
      window.addEventListener("resize", resize);
      cleanups.push(() => window.removeEventListener("resize", resize));

      map.on("error", (e) => {
        console.error("Mapbox error", e);
        const msg = e?.error?.message || "Mapbox style/tiles failed to load.";
        // Ignore benign 404s for optional sprites
        if (/404/.test(msg) && /sprite|icon/i.test(msg)) return;
        setError(msg);
      });

      map.on("load", async () => {
        if (cancelled) return;
        resize();
        setStatus("Adding terrain & Twin layers…");

        // Terrain (Mapbox DEM) — uses your token; exaggeration helps LoDo read in 3D
        if (!map.getSource("mapbox-dem")) {
          map.addSource("mapbox-dem", {
            type: "raster-dem",
            url: "mapbox://mapbox.mapbox-terrain-dem-v1",
            tileSize: 512,
            maxzoom: 14,
          });
        }
        map.setTerrain({ source: "mapbox-dem", exaggeration: 1.35 });
        if (!map.getLayer("sky")) {
          map.addLayer({
            id: "sky",
            type: "sky",
            paint: {
              "sky-type": "atmosphere",
              "sky-atmosphere-sun": [0.0, 90.0],
              "sky-atmosphere-sun-intensity": 12,
            },
          });
        }

        // Critical path: buildings + boundary only. Skip roads (basemap has them).
        // Parks/water load after first paint so the map becomes interactive sooner.
        setStatus("Loading buildings…");
        const [boundary, buildings] = await Promise.all([
          loadJson<GeoJSON.FeatureCollection>("/data/union_station_neighborhood.geojson"),
          loadJson<GeoJSON.FeatureCollection>("/data/buildings.geojson"),
        ]);

        if (boundary) {
          addOrSetSource(map, "boundary", boundary);
          if (!map.getLayer("boundary-line")) {
            map.addLayer({
              id: "boundary-line",
              type: "line",
              source: "boundary",
              paint: {
                "line-color": "#0284c7",
                "line-width": 2.5,
                "line-dasharray": [2, 1.2],
                "line-opacity": 0.85,
              },
            });
          }
        }

        if (buildings?.features?.length) {
          addOrSetSource(map, "buildings", buildings);
          if (!map.getLayer("buildings-3d")) {
            map.addLayer({
              id: "buildings-3d",
              type: "fill-extrusion",
              source: "buildings",
              paint: {
                "fill-extrusion-color": [
                  "step",
                  ["to-number", ["get", "Height"]],
                  "#86efac",
                  12,
                  "#38bdf8",
                  25,
                  "#a78bfa",
                  50,
                  "#fb923c",
                  100,
                  "#ef4444",
                ],
                "fill-extrusion-height": ["to-number", ["get", "Height"]],
                "fill-extrusion-base": 0,
                "fill-extrusion-opacity": 0.95,
                "fill-extrusion-height-alignment": "terrain",
                "fill-extrusion-base-alignment": "terrain",
              },
            });
          }
        }

        addOrSetSource(map, "route", { type: "FeatureCollection", features: [] });
        if (!map.getLayer("route-casing")) {
          map.addLayer({
            id: "route-casing",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#0F172A",
              "line-width": 12,
              "line-opacity": 0.95,
            },
          });
        }
        if (!map.getLayer("route-line")) {
          map.addLayer({
            id: "route-line",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#00F0FF",
              "line-width": 5,
              "line-opacity": 1,
            },
          });
        }

        if (!savedPose) {
          map.fitBounds(
            [
              [loadedMeta.bbox[0], loadedMeta.bbox[1]],
              [loadedMeta.bbox[2], loadedMeta.bbox[3]],
            ],
            { padding: 56, pitch: 55, bearing: -20, duration: 0, maxZoom: 14.2 },
          );
        }

        // Become interactive before secondary overlays finish
        requestAnimationFrame(resize);
        setReady(true);
        setStatus("");

        const loadOverlays = async () => {
          if (cancelled) return;
          const [water, parks] = await Promise.all([
            loadJson<GeoJSON.FeatureCollection>("/data/water.geojson"),
            loadJson<GeoJSON.FeatureCollection>("/data/parks.geojson"),
          ]);
          if (cancelled) return;

          if (parks?.features?.length) {
            addOrSetSource(map, "parks", parks);
            const before = map.getLayer("buildings-3d") ? "buildings-3d" : undefined;
            if (!map.getLayer("parks-fill")) {
              map.addLayer(
                {
                  id: "parks-fill",
                  type: "fill",
                  source: "parks",
                  filter: ["==", ["geometry-type"], "Polygon"],
                  paint: { "fill-color": "#3f8f55", "fill-opacity": 0.55 },
                },
                before,
              );
            }
            if (!map.getLayer("parks-outline")) {
              map.addLayer(
                {
                  id: "parks-outline",
                  type: "line",
                  source: "parks",
                  filter: ["==", ["geometry-type"], "Polygon"],
                  paint: { "line-color": "#166534", "line-width": 1.2, "line-opacity": 0.85 },
                },
                before,
              );
            }
          }

          if (water?.features?.length) {
            addOrSetSource(map, "water", water);
            const before = map.getLayer("buildings-3d") ? "buildings-3d" : undefined;
            if (!map.getLayer("water-fill")) {
              map.addLayer(
                {
                  id: "water-fill",
                  type: "fill",
                  source: "water",
                  filter: ["==", ["geometry-type"], "Polygon"],
                  paint: { "fill-color": "#2563eb", "fill-opacity": 0.7 },
                },
                before,
              );
            }
            if (!map.getLayer("water-line")) {
              map.addLayer(
                {
                  id: "water-line",
                  type: "line",
                  source: "water",
                  filter: ["==", ["geometry-type"], "LineString"],
                  paint: { "line-color": "#1d4ed8", "line-width": 4, "line-opacity": 0.9 },
                },
                before,
              );
            }
          }
        };

        const ric = (
          window as unknown as {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          }
        ).requestIdleCallback;
        if (ric) ric(() => void loadOverlays(), { timeout: 1500 });
        else window.setTimeout(() => void loadOverlays(), 500);

        map.on("click", (e) => {
          const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
          const pts = pointsRef.current;
          if (!pts.start || (pts.start && pts.end)) {
            // new start
            stopTravel();
            startMarkerRef.current?.remove();
            endMarkerRef.current?.remove();
            endMarkerRef.current = null;
            pts.start = lngLat;
            pts.end = null;
            routeGeomRef.current = null;
            routeMetaRef.current = null;
            startMarkerRef.current = new mapboxgl.Marker({ color: "#16a34a", offset: [0, -10] })
              .setLngLat(lngLat)
              .addTo(map);
            if (map.getSource("route")) {
              (map.getSource("route") as mapboxgl.GeoJSONSource).setData({
                type: "FeatureCollection",
                features: [],
              });
            }
            setRouteInfo(null);
            setRouteHint("Click map to set destination");
            return;
          }
          pts.end = lngLat;
          endMarkerRef.current?.remove();
          endMarkerRef.current = new mapboxgl.Marker({ color: "#dc2626", offset: [0, -10] })
            .setLngLat(lngLat)
            .addTo(map);
          void fetchRoute(pts.start, lngLat, routeModeRef.current);
        });

        const tipKeyRef = { current: "" };
        map.on("mousemove", "buildings-3d", (e) => {
          // Suppress inspect tips while the traveler is active (avoids overlap)
          if (travelingRef.current) {
            tipKeyRef.current = "";
            setTip((prev) => (prev ? { ...prev, visible: false } : null));
            return;
          }
          const f = e.features?.[0];
          if (!f?.properties) {
            tipKeyRef.current = "";
            setTip((prev) => (prev ? { ...prev, visible: false } : null));
            return;
          }
          const h = Number(f.properties.Height) || 0;
          const floors =
            Number(f.properties.Floors) || Math.max(1, Math.round(h / 3.5));
          const neighborhood = String(f.properties.Neighborhood || "Downtown Core");
          // Stable key reduces tooltip flicker when Mapbox returns new feature objects
          const key = `${f.id ?? f.properties.Height}-${neighborhood}-${floors}`;
          map.getCanvas().style.cursor = "pointer";
          if (key === tipKeyRef.current) {
            setTip((prev) =>
              prev ? { ...prev, x: e.point.x, y: e.point.y, visible: true } : prev,
            );
            return;
          }
          tipKeyRef.current = key;
          setTip({
            x: e.point.x,
            y: e.point.y,
            heightM: h,
            floors,
            neighborhood,
            visible: true,
          });
        });
        map.on("mouseleave", "buildings-3d", () => {
          tipKeyRef.current = "";
          map.getCanvas().style.cursor = "";
          setTip((prev) => (prev ? { ...prev, visible: false } : null));
        });

        const onClear = () => clearRoute();
        const onReplay = () => {
          const geom = routeGeomRef.current;
          const metaR = routeMetaRef.current;
          if (!geom || !metaR) return;
          startTravel(geom, routeModeRef.current, metaR.distance, metaR.duration);
        };
        window.addEventListener("twin-clear-route", onClear);
        window.addEventListener("twin-replay-travel", onReplay);
        cleanups.push(() => {
          window.removeEventListener("twin-clear-route", onClear);
          window.removeEventListener("twin-replay-travel", onReplay);
        });

        setTimeout(resize, 100);
        setTimeout(resize, 500);
      });
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
      if (animFrameRef.current != null) cancelAnimationFrame(animFrameRef.current);
      travelerMarkerRef.current?.remove();
      startMarkerRef.current?.remove();
      endMarkerRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      startTravelRef.current = null;
      delete (window as unknown as { __twinMap?: mapboxgl.Map }).__twinMap;
    };
  }, []);

  // Preserve pitch/bearing across Map ↔ Globe: resize + ease to shared pose when shown
  useEffect(() => {
    const map = mapRef.current;
    if (!active || !map || !ready) return;
    requestAnimationFrame(() => {
      try {
        map.resize();
      } catch {
        /* ignore */
      }
      const pose = readTwinCameraPose();
      if (!pose) return;
      skipPoseWriteRef.current = true;
      map.easeTo({
        center: [pose.lng, pose.lat],
        zoom: pose.zoom,
        pitch: pose.mapPitch,
        bearing: pose.heading,
        duration: 850,
        easing: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
      });
      map.once("moveend", () => {
        skipPoseWriteRef.current = false;
      });
    });
  }, [active, ready]);

  // Terrain toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (terrainOn) {
      if (!map.getSource("mapbox-dem")) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }
      map.setTerrain({ source: "mapbox-dem", exaggeration: 1.35 });
    } else {
      map.setTerrain(null);
    }
  }, [terrainOn, ready]);

  // Buildings toggle — fade extrusion opacity instead of hard visibility snap
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer("buildings-3d")) return;

    let raf = 0;
    const from = buildingsOn ? 0 : 0.95;
    const to = buildingsOn ? 0.95 : 0;
    if (buildingsOn) {
      map.setLayoutProperty("buildings-3d", "visibility", "visible");
    }
    const t0 = performance.now();
    const dur = 280;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / dur);
      const e = u * u * (3 - 2 * u);
      const opacity = from + (to - from) * e;
      try {
        map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", opacity);
      } catch {
        /* ignore */
      }
      if (u < 1) {
        raf = requestAnimationFrame(step);
      } else if (!buildingsOn) {
        map.setLayoutProperty("buildings-3d", "visibility", "none");
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [buildingsOn, ready]);

  // Re-route when mode changes and both points exist
  useEffect(() => {
    const map = mapRef.current;
    const { start, end } = pointsRef.current;
    if (!map || !ready || !start || !end) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();
    if (!token) return;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${routeMode}/` +
      `${start[0]},${start[1]};${end[0]},${end[1]}` +
      `?geometries=geojson&overview=full&access_token=${token}`;
    setRouteHint("Updating route…");
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (!data.routes?.[0]) {
          setRouteHint("No route for this mode");
          return;
        }
        const route = data.routes[0];
        const geom = route.geometry as GeoJSON.LineString;
        (map.getSource("route") as mapboxgl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: geom }],
        });
        setRouteInfo(
          `${(route.distance / 1000).toFixed(2)} km · ${Math.round(route.duration / 60)} min · ${MODE_LABEL[routeMode]}`,
        );
        startTravelRef.current?.(geom, routeMode, route.distance, route.duration);
      })
      .catch(() => setRouteHint("Routing request failed"));
  }, [routeMode, ready]);

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-[#0b1220] text-slate-100">
      <div
        ref={containerRef}
        id="twin-map"
        className="absolute inset-0"
        style={{ width: "100%", height: "100%" }}
      />

      {tip && <TwinInspectTooltip tip={tip} />}

      {/* Cohesive scrollable sidebar — tight gap, no clipped controls */}
      <div className="pointer-events-none absolute bottom-16 left-4 top-16 z-20 flex w-[min(100%-2rem,22rem)] flex-col">
        <div className="pointer-events-auto flex max-h-full flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
          <TwinGlassPanel>
            <TwinBadge>Downtown Denver · Mapbox</TwinBadge>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-white">
              {meta?.district ?? "Downtown Denver"}
            </h1>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <TwinMetric
                label="Buildings"
                value={formatCount(meta?.building_count)}
              />
              <TwinMetric
                label="Mean height"
                value={meta?.height_mean ? `${meta.height_mean.toFixed(0)} m` : "—"}
              />
            </div>
            <div className="mt-3">
              <TwinHeightLegend />
            </div>
            <p className={`mt-3 ${twinType.hint}`}>
              Hover buildings to inspect · click map to route
            </p>
            {!ready && !error && (
              <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs font-medium text-amber-100">
                {status || "Loading map layers…"}
              </p>
            )}
          </TwinGlassPanel>

          <TwinGlassPanel>
            <p className={twinType.label}>Controls</p>

            {/* Layers — full-width row, left-aligned with header */}
            <div className="mt-2.5 flex w-full flex-wrap gap-1.5">
              <TwinToggleChip
                accent="orange"
                active={buildingsOn}
                onClick={() => setBuildingsOn((v) => !v)}
              >
                Buildings {buildingsOn ? "On" : "Off"}
              </TwinToggleChip>
              <TwinToggleChip
                accent="emerald"
                active={terrainOn}
                onClick={() => setTerrainOn((v) => !v)}
              >
                Terrain {terrainOn ? "On" : "Off"}
              </TwinToggleChip>
            </div>

            <TwinDivider />

            <p className={twinType.label}>Travel mode</p>
            <div className="mt-2.5 flex w-full flex-wrap gap-1.5">
              {([
                ["walking", "Person"],
                ["cycling", "Bike"],
                ["driving", "Car"],
              ] as const).map(([id, label]) => (
                <TwinToggleChip
                  key={id}
                  accent="cyan"
                  active={routeMode === id}
                  onClick={() => setRouteMode(id)}
                >
                  {label}
                </TwinToggleChip>
              ))}
            </div>

            <TwinDivider />

            <p className={`${twinType.hint}`}>{routeHint}</p>
            {routeInfo && (
              <p className="mt-1 text-sm font-medium text-cyan-300">{routeInfo}</p>
            )}
            <div className="mt-2.5 flex gap-1.5">
              <TwinButton
                variant="primary"
                className="flex-1"
                disabled={!routeInfo || traveling}
                onClick={() => window.dispatchEvent(new Event("twin-replay-travel"))}
              >
                {traveling ? "Traveling…" : "Replay travel"}
              </TwinButton>
              <TwinButton
                variant="secondary"
                className="flex-1"
                onClick={() => window.dispatchEvent(new Event("twin-clear-route"))}
              >
                Clear route
              </TwinButton>
            </div>
            <TwinButton
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => {
                const map = mapRef.current;
                if (!map || !meta?.bbox) return;
                map.easeTo({
                  pitch: 55,
                  bearing: -20,
                  duration: 900,
                });
                map.fitBounds(
                  [
                    [meta.bbox[0], meta.bbox[1]],
                    [meta.bbox[2], meta.bbox[3]],
                  ],
                  { padding: 56, pitch: 55, bearing: -20, duration: 900, maxZoom: 14.2 },
                );
              }}
            >
              Reset 3D view
            </TwinButton>
          </TwinGlassPanel>
        </div>
      </div>

      {error && (
        <div className="absolute bottom-4 left-4 right-4 z-20 rounded-2xl border border-rose-400/30 bg-rose-950/80 p-4 text-sm text-rose-100 backdrop-blur-md md:left-auto md:max-w-lg">
          {error}
        </div>
      )}
    </div>
  );
}
