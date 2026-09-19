"use client";

/**
 * CesiumTwinGlobe — showcase globe for Downtown Denver Core.
 *
 * Performance notes:
 * - Skip sampleTerrainMostDetailed (N network RTTs). Use RELATIVE_TO_GROUND instead.
 * - suspendEvents + chunked entity styling via requestAnimationFrame so the UI stays responsive.
 * - requestRenderMode reduces idle GPU work; we requestRender on camera/layer changes.
 * - Soft shadows + globe lighting for LinkedIn-ready depth (341 core buildings is fine).
 */

import { useEffect, useRef, useState } from "react";
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
  densifyLine,
  fetchStreetRoute,
  simplifyForFlyTo,
  bearingDegrees,
  type LngLat,
} from "@/lib/streetRoute";
import {
  cesiumPitchToMap,
  heightToZoom,
  mapPitchToCesium,
  readTwinCameraPose,
  writeTwinCameraPose,
  zoomToHeight,
} from "@/lib/twinCameraSync";

type Meta = {
  district: string;
  building_count: number;
  bbox: [number, number, number, number];
  center: [number, number];
  height_mean?: number;
  neighborhoods?: string[];
  aoi?: string;
};

type CesiumNS = typeof import("cesium");

type InspectTip = InspectTipData;

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
    Cesium?: CesiumNS;
  }
}

function colorForHeight(Cesium: CesiumNS, h: number) {
  if (h < 12) return Cesium.Color.fromCssColorString("#86efac").withAlpha(0.92);
  if (h < 25) return Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.92);
  if (h < 50) return Cesium.Color.fromCssColorString("#a78bfa").withAlpha(0.92);
  if (h < 100) return Cesium.Color.fromCssColorString("#fb923c").withAlpha(0.92);
  return Cesium.Color.fromCssColorString("#ef4444").withAlpha(0.95);
}

/** Format slider hour (e.g. 13.5 → "13:30") */
function formatHourLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Convert a Denver-local wall-clock hour on today's Denver calendar date
 * into a Cesium JulianDate (handles MST/MDT offset).
 */
function julianFromDenverHour(Cesium: CesiumNS, hourFloat: number) {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const h = Math.min(23, Math.max(0, Math.floor(hourFloat)));
  const min = Math.min(59, Math.round((hourFloat - Math.floor(hourFloat)) * 60));
  const hm = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;

  // Probe Denver offset on this calendar day (noon UTC → shortOffset like "GMT-6")
  const probe = new Date(`${ymd}T18:00:00Z`);
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    timeZoneName: "shortOffset",
    hour: "numeric",
  }).formatToParts(probe);
  const tzName = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  const sign = m?.[1] ?? "-";
  const offH = String(m?.[2] ?? "6").padStart(2, "0");
  const offM = m?.[3] ?? "00";
  const iso = `${ymd}T${hm}${sign}${offH}:${offM}`;
  return Cesium.JulianDate.fromIso8601(iso);
}

/** Landmark corridor — camera follows Mapbox street routing between these */
const TOUR_LANDMARKS = [
  { name: "Union Station", lon: -105.0002, lat: 39.753, heading: 35, pitch: -32 },
  { name: "Civic Center", lon: -104.9885, lat: 39.7392, heading: -28, pitch: -36 },
  { name: "Capitol Hill", lon: -104.9808, lat: 39.7342, heading: 48, pitch: -34 },
] as const;

/** Denver downtown ≈ meters above WGS84 ellipsoid — used when sampling is skipped */
const DENVER_GROUND_ELLIPSOID_M = 1608;
/** Camera height above ground during tour (keeps chase cam clear of towers) */
const TOUR_AGL_M = 280;

/** Framing for Downtown Denver Core AOI when entering 3D Globe */
const STUDY_AREA_VIEW = {
  height: 1750,
  heading: 22,
  pitch: -42,
  duration: 1.35,
} as const;

function flyToStudyArea(
  Cesium: CesiumNS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any,
  center: [number, number],
  opts?: { duration?: number; setView?: boolean },
) {
  const [lon, lat] = center;
  const duration = opts?.duration ?? STUDY_AREA_VIEW.duration;
  const destination = Cesium.Cartesian3.fromDegrees(
    lon,
    lat,
    STUDY_AREA_VIEW.height,
  );
  const orientation = {
    heading: Cesium.Math.toRadians(STUDY_AREA_VIEW.heading),
    pitch: Cesium.Math.toRadians(STUDY_AREA_VIEW.pitch),
    roll: 0,
  };
  if (opts?.setView || duration <= 0) {
    viewer.camera.setView({ destination, orientation });
    return;
  }
  viewer.camera.flyTo({
    destination,
    orientation,
    duration,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });
}

/** Instant local framing — never leave the camera on the default Earth view. */
function setCameraFromPoseOrStudy(
  Cesium: CesiumNS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any,
  center: [number, number],
) {
  const pose = readTwinCameraPose();
  if (pose) {
    // Clamp height so Map street-zoom doesn't dump the globe underground / into space
    const height = Math.min(4500, Math.max(900, pose.height || zoomToHeight(pose.zoom)));
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(pose.lng, pose.lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(pose.heading),
        pitch: Cesium.Math.toRadians(mapPitchToCesium(pose.mapPitch)),
        roll: 0,
      },
    });
    return;
  }
  flyToStudyArea(Cesium, viewer, center, { setView: true });
}

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function loadCesiumScript(): Promise<CesiumNS> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  return new Promise((resolve, reject) => {
    window.CESIUM_BASE_URL = "/cesium/";
    const existing = document.querySelector<HTMLScriptElement>('script[data-cesium="1"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.Cesium) resolve(window.Cesium);
        else reject(new Error("Cesium failed to load"));
      });
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/cesium/Widgets/widgets.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "/cesium/Cesium.js";
    script.async = true;
    script.dataset.cesium = "1";
    script.onload = () => {
      if (window.Cesium) resolve(window.Cesium);
      else reject(new Error("Cesium global missing after script load"));
    };
    script.onerror = () => reject(new Error("Failed to load /cesium/Cesium.js"));
    document.body.appendChild(script);
  });
}

/** Yield to the browser every `chunkSize` entities to avoid long main-thread freezes. */
function styleBuildingsInChunks(
  Cesium: CesiumNS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entities: any[],
  chunkSize: number,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const now = Cesium.JulianDate.now();
    let i = 0;
    let styled = 0;

    const step = () => {
      const end = Math.min(i + chunkSize, entities.length);
      for (; i < end; i++) {
        const entity = entities[i];
        if (!entity.polygon) continue;

        const rawH = entity.properties?.Height?.getValue?.(now);
        const h = typeof rawH === "number" ? rawH : Number(rawH) || 15;
        const buildingH = Math.max(h, 3);
        const rawNbhd = entity.properties?.Neighborhood?.getValue?.(now);
        const nbhd = typeof rawNbhd === "string" && rawNbhd ? rawNbhd : "Downtown Core";
        const floors =
          Number(entity.properties?.Floors?.getValue?.(now)) ||
          Math.max(1, Math.round(buildingH / 3.5));

        // Terrain-safe extrusion: base clamped, height relative to ground (no sampleTerrain*).
        entity.polygon.height = new Cesium.ConstantProperty(0);
        entity.polygon.heightReference = new Cesium.ConstantProperty(
          Cesium.HeightReference.CLAMP_TO_GROUND,
        );
        entity.polygon.extrudedHeight = new Cesium.ConstantProperty(buildingH);
        entity.polygon.extrudedHeightReference = new Cesium.ConstantProperty(
          Cesium.HeightReference.RELATIVE_TO_GROUND,
        );
        entity.polygon.material = new Cesium.ColorMaterialProperty(colorForHeight(Cesium, h));
        entity.polygon.outline = new Cesium.ConstantProperty(false);
        entity.polygon.shadows = new Cesium.ConstantProperty(Cesium.ShadowMode.ENABLED);

        // Keep inspect fields on the entity for click/hover tooltips
        entity.properties = new Cesium.PropertyBag({
          Height: h,
          Neighborhood: nbhd,
          Floors: floors,
        });
        entity.name = `${h.toFixed(1)} m`;
        entity.description = new Cesium.ConstantProperty("");
        styled += 1;
      }

      onProgress(i, entities.length);
      if (i < entities.length) {
        requestAnimationFrame(step);
      } else {
        resolve(styled);
      }
    };

    requestAnimationFrame(step);
  });
}

async function sampleSurfaceHeight(
  Cesium: CesiumNS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any,
  lon: number,
  lat: number,
): Promise<number> {
  const carto = Cesium.Cartographic.fromDegrees(lon, lat);
  // Prefer fast sync probes — sampleHeightMostDetailed can hang and freeze the tour
  try {
    const sync = viewer.scene.sampleHeight?.(carto);
    if (typeof sync === "number" && Number.isFinite(sync) && sync > 500) return sync;
  } catch {
    /* fall through */
  }
  const globeH = viewer.scene.globe.getHeight?.(carto);
  if (typeof globeH === "number" && Number.isFinite(globeH) && globeH > 500) return globeH;
  return DENVER_GROUND_ELLIPSOID_M;
}

function landmarkNear(lon: number, lat: number): string | null {
  for (const stop of TOUR_LANDMARKS) {
    const dlon = stop.lon - lon;
    const dlat = stop.lat - lat;
    if (dlon * dlon + dlat * dlat < 0.00008) return stop.name;
  }
  return null;
}

function flyToPromise(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      ...opts,
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

export default function CesiumTwinGlobe({ active = true }: { active?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const osmTilesetRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tourPathEntityRef = useRef<any>(null);
  const cesiumRef = useRef<CesiumNS | null>(null);
  const handlerRef = useRef<{ destroy: () => void } | null>(null);
  const tourGenRef = useRef(0);
  const skipPoseWriteRef = useRef(false);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState("Starting Cesium globe…");
  const [error, setError] = useState<string | null>(null);
  const [osmBuildingsOn, setOsmBuildingsOn] = useState(false);
  const [aoiBuildingsOn, setAoiBuildingsOn] = useState(true);
  const [hasIon, setHasIon] = useState(false);
  const [buildingEntities, setBuildingEntities] = useState(0);
  const [tip, setTip] = useState<InspectTip | null>(null);
  const [osmLoading, setOsmLoading] = useState(false);
  /** Denver local hour of day for sun / shadow simulation */
  const [sunHour, setSunHour] = useState(14);
  const [touring, setTouring] = useState(false);
  const [tourStop, setTourStop] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || viewerRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        setStatus("Loading Cesium…");
        const Cesium = await loadCesiumScript();
        if (cancelled) return;
        cesiumRef.current = Cesium;

        const ionToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim();
        if (ionToken) {
          Cesium.Ion.defaultAccessToken = ionToken;
          setHasIon(true);
        }

        setStatus("Loading metadata…");
        const loadedMeta = await loadJson<Meta>("/data/meta.json");
        if (cancelled) return;
        if (!loadedMeta?.bbox) {
          setError("Could not load /data/meta.json");
          return;
        }
        setMeta(loadedMeta);

        setStatus("Creating globe…");
        // Borderless canvas: hide default Cesium chrome widgets
        // Skip World Terrain on first paint — ellipsoid is instant; terrain streams in after.
        const viewer = new Cesium.Viewer(el, {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          // Custom React tooltip replaces the jittery default green reticle
          selectionIndicator: false,
          useDefaultRenderLoop: true,
          terrain: undefined,
        });
        viewerRef.current = viewer;

        // CRITICAL: lock camera to Denver immediately — default Cesium view is Earth-from-space
        setCameraFromPoseOrStudy(Cesium, viewer, loadedMeta.center);
        viewer.scene.requestRender();

        // Stream terrain in the background (does not block first frame)
        if (ionToken) {
          void (async () => {
            try {
              const terrain = await Cesium.Terrain.fromWorldTerrain();
              if (cancelled || viewer.isDestroyed()) return;
              viewer.scene.setTerrain(terrain);
              viewer.scene.requestRender();
            } catch {
              /* ellipsoid fallback is fine */
            }
          })();
        }

        const toolbar = el.querySelector(".cesium-viewer-toolbar") as HTMLElement | null;
        if (toolbar) toolbar.style.display = "none";
        const credits = el.querySelector(".cesium-viewer-bottom") as HTMLElement | null;
        if (credits) {
          credits.style.left = "12px";
          credits.style.right = "auto";
          credits.style.bottom = "8px";
        }

        // Depth + atmosphere for LinkedIn-ready solid extrusions (not flat silhouettes)
        viewer.shadows = true;
        viewer.terrainShadows = Cesium.ShadowMode.ENABLED;
        if (viewer.shadowMap) {
          viewer.shadowMap.enabled = true;
          viewer.shadowMap.softShadows = true;
          viewer.shadowMap.darkness = 0.35;
          viewer.shadowMap.maximumDistance = 8000;
          try {
            // Higher-res shadow map reduces jagged edges at street zoom
            viewer.shadowMap.size = 2048;
          } catch {
            /* ignore */
          }
        }
        viewer.scene.globe.enableLighting = true;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.skyAtmosphere.show = true;
        try {
          viewer.scene.highDynamicRange = true;
        } catch {
          /* older builds may not expose HDR */
        }
        // Manual sun time via slider — do not auto-advance the clock
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = julianFromDenverHour(Cesium, 14);
        viewer.scene.requestRenderMode = false;

        const camCtrl = viewer.scene.screenSpaceCameraController;
        camCtrl.enableInputs = true;
        camCtrl.enableZoom = true;
        camCtrl.enableRotate = true;
        camCtrl.enableTilt = true;
        camCtrl.enableTranslate = true;
        camCtrl.minimumZoomDistance = 20;
        camCtrl.maximumZoomDistance = 8_000_000;
        try {
          camCtrl.enableCollisionDetection = true;
        } catch {
          /* older Cesium builds */
        }

        if (!ionToken) {
          viewer.imageryLayers.removeAll();
          viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
              credit: "© OpenStreetMap contributors",
              maximumLevel: 19,
            }),
          );
        }

        const applyPoseOrHome = () => {
          // Soft settle into study framing from the already-local camera (no Earth hop)
          flyToStudyArea(Cesium, viewer, loadedMeta.center, { duration: 1.1 });
        };

        const persistPose = () => {
          if (skipPoseWriteRef.current) return;
          const carto = viewer.camera.positionCartographic;
          writeTwinCameraPose({
            lng: Cesium.Math.toDegrees(carto.longitude),
            lat: Cesium.Math.toDegrees(carto.latitude),
            height: carto.height,
            zoom: heightToZoom(carto.height),
            heading: Cesium.Math.toDegrees(viewer.camera.heading),
            mapPitch: cesiumPitchToMap(Cesium.Math.toDegrees(viewer.camera.pitch)),
          });
        };
        viewer.camera.moveEnd.addEventListener(persistPose);

        setStatus("Loading AOI boundary…");
        const boundary = await loadJson<GeoJSON.FeatureCollection>(
          "/data/union_station_neighborhood.geojson",
        );
        if (cancelled) return;
        if (boundary) {
          // Outline only — filled polygons z-fight with terrain/extrusions (blue slabs)
          const boundaryDs = await Cesium.GeoJsonDataSource.load(boundary, {
            stroke: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.85),
            fill: Cesium.Color.TRANSPARENT,
            strokeWidth: 2,
            clampToGround: true,
          });
          for (const entity of boundaryDs.entities.values) {
            entity.name = "AOI";
            entity.description = new Cesium.ConstantProperty("");
            entity.properties = new Cesium.PropertyBag();
            if (entity.polygon) {
              entity.polygon.material = new Cesium.ColorMaterialProperty(
                Cesium.Color.TRANSPARENT,
              );
              entity.polygon.outline = new Cesium.ConstantProperty(true);
              entity.polygon.outlineColor = new Cesium.ConstantProperty(
                Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.7),
              );
              entity.polygon.height = undefined;
              entity.polygon.extrudedHeight = undefined;
            }
          }
          await viewer.dataSources.add(boundaryDs);
        }

        setStatus("Loading AOI buildings…");
        const bldgDs = await Cesium.GeoJsonDataSource.load("/data/buildings.geojson", {
          clampToGround: true,
        });
        bldgDs.name = "aoi-buildings";
        // Freeze entity collection events while we style in RAF chunks
        bldgDs.entities.suspendEvents();
        const entities = bldgDs.entities.values;

        const styled = await styleBuildingsInChunks(
          Cesium,
          entities,
          60,
          (done, total) => {
            if (!cancelled) setStatus(`Styling buildings ${done}/${total}…`);
          },
        );
        if (cancelled) return;

        bldgDs.entities.resumeEvents();
        await viewer.dataSources.add(bldgDs);
        setBuildingEntities(styled);

        // Hover / click inspection → React tooltip (no Cesium InfoBox clutter)
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handlerRef.current = handler;

        const readEntityTip = (entity: {
          polygon?: unknown;
          properties?: {
            Height?: { getValue: (t: unknown) => unknown };
            Neighborhood?: { getValue: (t: unknown) => unknown };
            Floors?: { getValue: (t: unknown) => unknown };
          };
        }): Omit<InspectTip, "x" | "y"> | null => {
          if (!entity?.polygon || !entity.properties) return null;
          const t = Cesium.JulianDate.now();
          const h = Number(entity.properties.Height?.getValue(t)) || 0;
          if (!h) return null;
          const neighborhood = String(
            entity.properties.Neighborhood?.getValue(t) || "Downtown Core",
          );
          const floors =
            Number(entity.properties.Floors?.getValue(t)) ||
            Math.max(1, Math.round(h / 3.5));
          return { heightM: h, floors, neighborhood };
        };

        const tipKeyRef = { current: "" };
        handler.setInputAction((movement: { endPosition: { x: number; y: number } }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const picked = viewer.scene.pick(movement.endPosition as any);
          const entity = picked?.id;
          const tipData = entity ? readEntityTip(entity) : null;
          if (tipData) {
            el.style.cursor = "pointer";
            const key = `${tipData.neighborhood}-${tipData.heightM}-${tipData.floors}`;
            if (key === tipKeyRef.current) {
              setTip((prev) =>
                prev
                  ? {
                      ...prev,
                      x: movement.endPosition.x,
                      y: movement.endPosition.y,
                      visible: true,
                    }
                  : prev,
              );
            } else {
              tipKeyRef.current = key;
              setTip({
                ...tipData,
                x: movement.endPosition.x,
                y: movement.endPosition.y,
                visible: true,
              });
            }
          } else {
            tipKeyRef.current = "";
            el.style.cursor = "default";
            setTip((prev) => (prev ? { ...prev, visible: false } : null));
          }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        handler.setInputAction((click: { position: { x: number; y: number } }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const picked = viewer.scene.pick(click.position as any);
          const entity = picked?.id;
          const tipData = entity ? readEntityTip(entity) : null;
          if (tipData) {
            tipKeyRef.current = `${tipData.neighborhood}-${tipData.heightM}-${tipData.floors}`;
            setTip({
              ...tipData,
              x: click.position.x,
              y: click.position.y,
              visible: true,
            });
          } else {
            tipKeyRef.current = "";
            setTip((prev) => (prev ? { ...prev, visible: false } : null));
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        viewer.resize();
        // Already framed via setCameraFromPoseOrStudy — short settle only
        applyPoseOrHome();
        viewer.scene.requestRender();
        setStatus("");
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Cesium failed to start");
        }
      }
    })();

    return () => {
      cancelled = true;
      tourGenRef.current += 1;
      handlerRef.current?.destroy();
      handlerRef.current = null;
      osmTilesetRef.current = null;
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === "aoi-buildings") ds.show = aoiBuildingsOn;
    }
    viewer.scene?.requestRender?.();
  }, [aoiBuildingsOn, buildingEntities]);

  useEffect(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer || viewer.isDestroyed?.() || !hasIon) return;

    let cancelled = false;
    (async () => {
      if (!osmBuildingsOn) {
        if (osmTilesetRef.current) {
          viewer.scene.primitives.remove(osmTilesetRef.current);
          osmTilesetRef.current = null;
        }
        setOsmLoading(false);
        return;
      }
      // Stream OSM while AOI stays visible — then swap (no empty satellite flash)
      setOsmLoading(true);
      try {
        const tileset = await Cesium.createOsmBuildingsAsync();
        if (cancelled || viewer.isDestroyed()) return;
        if (osmTilesetRef.current) {
          viewer.scene.primitives.remove(osmTilesetRef.current);
        }
        osmTilesetRef.current = tileset;
        viewer.scene.primitives.add(tileset);
        setAoiBuildingsOn(false);
        setOsmLoading(false);
      } catch (e) {
        console.error(e);
        setOsmLoading(false);
        setOsmBuildingsOn(false);
        setAoiBuildingsOn(true); // never leave the globe with zero building layers
        setError("OSM Buildings need a valid Cesium Ion token");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [osmBuildingsOn, hasIon]);

  // Pause Cesium when Globe is hidden — dual WebGL loops were crushing the Map view
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    const becameActive = active && !prevActiveRef.current;
    prevActiveRef.current = active;

    if (!Cesium || !viewer || viewer.isDestroyed?.()) return;

    try {
      viewer.useDefaultRenderLoop = !!active;
      if (!active) {
        // Cancel any in-flight cinematic tour when leaving Globe
        tourGenRef.current += 1;
        setTouring(false);
        setTourStop(null);
        try {
          viewer.camera.cancelFlight?.();
          viewer.scene.screenSpaceCameraController.enableInputs = true;
        } catch {
          /* ignore */
        }
        return;
      }
      viewer.resize();
      viewer.scene.requestRender();
    } catch {
      /* ignore */
    }

    if (!becameActive || !meta?.center) return;

    requestAnimationFrame(() => {
      skipPoseWriteRef.current = true;
      // Instant handoff from Map focus — prevents the space→Denver zoom the review flagged
      setCameraFromPoseOrStudy(Cesium, viewer, meta.center);
      viewer.scene.requestRender();
      // Short local settle into the standard study-area framing
      window.setTimeout(() => {
        if (!viewerRef.current || viewerRef.current.isDestroyed?.()) return;
        flyToStudyArea(Cesium, viewer, meta.center, { duration: 0.85 });
        window.setTimeout(() => {
          skipPoseWriteRef.current = false;
          const carto = viewer.camera.positionCartographic;
          writeTwinCameraPose({
            lng: Cesium.Math.toDegrees(carto.longitude),
            lat: Cesium.Math.toDegrees(carto.latitude),
            height: carto.height,
            zoom: heightToZoom(carto.height),
            heading: Cesium.Math.toDegrees(viewer.camera.heading),
            mapPitch: cesiumPitchToMap(Cesium.Math.toDegrees(viewer.camera.pitch)),
          });
        }, 900);
      }, 40);
    });
  }, [active, meta?.center]);

  // Sun / shadow: push Denver-local slider time into Cesium clock
  useEffect(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer || viewer.isDestroyed?.()) return;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = julianFromDenverHour(Cesium, sunHour);
    viewer.shadows = true;
    viewer.scene.requestRender();
  }, [sunHour, buildingEntities]);

  const clearTourGraphics = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) return;
    if (tourPathEntityRef.current) {
      try {
        viewer.entities.remove(tourPathEntityRef.current);
      } catch {
        /* ignore */
      }
      tourPathEntityRef.current = null;
    }
  };

  const stopTour = () => {
    tourGenRef.current += 1;
    setTouring(false);
    setTourStop(null);
    clearTourGraphics();
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed?.()) {
      try {
        viewer.camera.cancelFlight?.();
      } catch {
        /* ignore */
      }
      try {
        viewer.scene.screenSpaceCameraController.enableInputs = true;
      } catch {
        /* ignore */
      }
    }
  };

  const startTour = async () => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer || viewer.isDestroyed?.()) return;
    // Don't start while AOI is still loading — destinations aren't ready
    if (status || buildingEntities <= 0) {
      setTourStop("Wait for buildings to finish loading…");
      window.setTimeout(() => setTourStop((s) => (s?.startsWith("Wait") ? null : s)), 2800);
      return;
    }

    const gen = ++tourGenRef.current;
    setTouring(true);
    setTourStop("Starting tour…");
    clearTourGraphics();

    // Force render + unlock any stuck controller from manual orbit
    try {
      viewer.useDefaultRenderLoop = true;
      viewer.camera.cancelFlight?.();
      viewer.scene.screenSpaceCameraController.enableInputs = false;
    } catch {
      /* ignore */
    }

    const easing = Cesium.EasingFunction.QUADRATIC_IN_OUT;
    const camH = DENVER_GROUND_ELLIPSOID_M + TOUR_AGL_M;

    // 1) Immediate first hop — never wait on routing/sampling before the user sees motion
    const first = TOUR_LANDMARKS[0];
    setTourStop(first.name);
    await flyToPromise(viewer, {
      destination: Cesium.Cartesian3.fromDegrees(first.lon, first.lat, camH),
      orientation: {
        heading: Cesium.Math.toRadians(first.heading),
        pitch: Cesium.Math.toRadians(first.pitch),
        roll: 0,
      },
      duration: 3.2,
      easingFunction: easing,
    });
    if (tourGenRef.current !== gen) return;

    // 2) Optional street corridor (timed out) — polyline only, no per-vertex height sampling
    setTourStop("Fetching street path…");
    const waypoints: LngLat[] = TOUR_LANDMARKS.map((s) => [s.lon, s.lat]);
    const routed = await fetchStreetRoute(waypoints, "driving", 6000);
    if (tourGenRef.current !== gen) return;

    if (routed?.coords?.length) {
      const dense = densifyLine(routed.coords, 120);
      // Clamp-to-ground corridor — instant, no sampleHeight loops
      tourPathEntityRef.current = viewer.entities.add({
        name: "Tour corridor",
        polyline: {
          positions: dense.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat, DENVER_GROUND_ELLIPSOID_M + 25),
          ),
          width: 5,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.22,
            color: Cesium.Color.fromCssColorString("#00F0FF").withAlpha(0.95),
          }),
          clampToGround: true,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });

      // A few street waypoints between landmarks (fast sync heights only)
      const flyPts = simplifyForFlyTo(dense, 520);
      for (let i = 1; i < flyPts.length; i++) {
        if (tourGenRef.current !== gen) return;
        const [lon, lat] = flyPts[i];
        const [lookLon, lookLat] = flyPts[Math.min(i + 1, flyPts.length - 1)];
        const near = landmarkNear(lon, lat);
        setTourStop(near ?? `Along streets · ${i}/${flyPts.length - 1}`);

        const ground = await sampleSurfaceHeight(Cesium, viewer, lon, lat);
        const headingDeg = bearingDegrees([lon, lat], [lookLon, lookLat]);
        await flyToPromise(viewer, {
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, ground + TOUR_AGL_M),
          orientation: {
            heading: Cesium.Math.toRadians(headingDeg),
            pitch: Cesium.Math.toRadians(-34),
            roll: 0,
          },
          duration: Math.max(2.0, Math.min(4.5, 3.0)),
          easingFunction: easing,
        });
        if (tourGenRef.current !== gen) return;
        if (near) await new Promise((r) => setTimeout(r, 650));
      }
    } else {
      // 3) Fallback: landmark-only hop (always works offline / without Directions)
      setTourStop("Landmark path (routing unavailable)");
      for (let i = 1; i < TOUR_LANDMARKS.length; i++) {
        if (tourGenRef.current !== gen) return;
        const stop = TOUR_LANDMARKS[i];
        setTourStop(stop.name);
        await flyToPromise(viewer, {
          destination: Cesium.Cartesian3.fromDegrees(stop.lon, stop.lat, camH),
          orientation: {
            heading: Cesium.Math.toRadians(stop.heading),
            pitch: Cesium.Math.toRadians(stop.pitch),
            roll: 0,
          },
          duration: 4.5,
          easingFunction: easing,
        });
        if (tourGenRef.current !== gen) return;
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    if (tourGenRef.current === gen) {
      setTouring(false);
      setTourStop(null);
      try {
        viewer.scene.screenSpaceCameraController.enableInputs = true;
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (tourGenRef.current === gen) clearTourGraphics();
      }, 2000);
    }
  };

  const zoomBy = (dir: "in" | "out") => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) return;
    const height = viewer.camera.positionCartographic.height;
    const amount = Math.max(height * 0.35, 40);
    if (dir === "in") viewer.camera.zoomIn(amount);
    else viewer.camera.zoomOut(amount);
    viewer.scene.requestRender();
  };

  const resetView = () => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (!Cesium || !viewer || !meta || viewer.isDestroyed?.()) return;
    const [lon, lat] = meta.center;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 2200),
      orientation: {
        heading: Cesium.Math.toRadians(20),
        pitch: Cesium.Math.toRadians(-38),
        roll: 0,
      },
      duration: 1.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
    viewer.scene.requestRender();
  };

  const count = buildingEntities || meta?.building_count || 0;

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-[#0b1220] text-slate-100">
      <div
        ref={containerRef}
        className="absolute inset-0 z-0"
        style={{ touchAction: "none" }}
      />

      {tip && <TwinInspectTooltip tip={tip} />}

      {/* Scrollable sidebar — prevents Start Tour clipping at viewport bottom */}
      <div className="pointer-events-none absolute bottom-20 left-4 top-16 z-20 flex w-[min(100%-2rem,22rem)] flex-col">
        <div className="pointer-events-auto flex max-h-full flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
          <TwinGlassPanel>
            <TwinBadge>Downtown Denver · Cesium</TwinBadge>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-white">
              {meta?.district ?? "Downtown Denver"}
            </h1>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <TwinMetric label="Buildings" value={formatCount(count)} />
              <TwinMetric
                label="Mean height"
                value={meta?.height_mean ? `${meta.height_mean.toFixed(0)} m` : "—"}
              />
            </div>
            <div className="mt-3">
              <TwinHeightLegend />
            </div>
            <p className={`mt-3 ${twinType.hint}`}>
              Hover a building to inspect · scroll zoom · right-drag tilt
            </p>
            {status && !error && (
              <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs font-medium text-amber-100">
                {status}
              </p>
            )}
          </TwinGlassPanel>

          <TwinGlassPanel>
            <p className={twinType.label}>Globe layers</p>
            <div className="mt-2.5 flex w-full flex-col gap-1.5">
              <TwinToggleChip
                accent="orange"
                active={aoiBuildingsOn && !osmBuildingsOn}
                onClick={() => {
                  setOsmBuildingsOn(false);
                  setAoiBuildingsOn(true);
                }}
              >
                AOI Buildings {aoiBuildingsOn && !osmBuildingsOn ? "On" : "Off"}
              </TwinToggleChip>
              {hasIon && (
                <TwinToggleChip
                  accent="emerald"
                  active={osmBuildingsOn && !aoiBuildingsOn}
                  onClick={() => {
                    if (osmBuildingsOn && !aoiBuildingsOn) {
                      setOsmBuildingsOn(false);
                      setAoiBuildingsOn(true);
                    } else {
                      setOsmBuildingsOn(true);
                    }
                  }}
                >
                  {osmLoading
                    ? "Streaming OSM…"
                    : `OSM Buildings ${osmBuildingsOn && !aoiBuildingsOn ? "On" : "Off"}`}
                </TwinToggleChip>
              )}
            </div>
            <p className={`mt-2 ${twinType.hint}`}>
              Keep one building layer on. AOI = core · OSM = worldwide.
            </p>

            <TwinDivider />

            <p className={twinType.label}>Sun &amp; shadows</p>
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-sm text-slate-300">Denver local</span>
              {/* Affordance: plain label — not a fake button */}
              <span className="font-mono text-sm font-semibold tabular-nums text-amber-200">
                {formatHourLabel(sunHour)}
              </span>
            </div>
            <input
              type="range"
              min={6}
              max={20}
              step={0.25}
              value={sunHour}
              onChange={(e) => setSunHour(Number(e.target.value))}
              className="mt-3 w-full accent-amber-400"
              aria-label="Time of day in Denver"
            />
            <div className="mt-1 flex justify-between text-xs tabular-nums text-slate-400">
              <span>06:00</span>
              <span>12:00</span>
              <span>20:00</span>
            </div>
            <p className={`mt-2 ${twinType.hint}`}>
              Drag to move the sun and inspect building shadows.
            </p>

            <TwinDivider />

            <p className={twinType.label}>Camera tour</p>
            <div className="mt-2.5 flex gap-1.5">
              <TwinToggleChip
                accent="cyan"
                active={touring}
                className="flex-1"
                disabled={!touring && (!!status || buildingEntities <= 0)}
                onClick={() => {
                  if (touring) stopTour();
                  else void startTour();
                }}
              >
                {touring
                  ? "Stop Tour"
                  : status || buildingEntities <= 0
                    ? "Tour (loading…)"
                    : "Start Tour"}
              </TwinToggleChip>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-cyan-200/90">
              {tourStop
                ? tourStop
                : "Union Station → Civic Center → Capitol Hill"}
            </p>
          </TwinGlassPanel>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-8 right-4 z-20 flex flex-col gap-1.5">
        {(["in", "out"] as const).map((dir) => (
          <TwinButton
            key={dir}
            variant="secondary"
            className="h-10 w-10 !px-0 text-xl"
            onClick={() => zoomBy(dir)}
          >
            {dir === "in" ? "+" : "−"}
          </TwinButton>
        ))}
        <TwinButton variant="secondary" className="!px-2 text-[11px] uppercase tracking-wide" onClick={resetView}>
          Reset
        </TwinButton>
      </div>

      {error && (
        <div className="absolute bottom-4 left-4 right-4 z-20 rounded-2xl border border-rose-400/30 bg-rose-950/80 p-4 text-sm text-rose-100 backdrop-blur-md md:left-auto md:max-w-lg">
          {error}
        </div>
      )}
    </div>
  );
}
