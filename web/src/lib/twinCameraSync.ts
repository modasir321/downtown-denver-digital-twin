/**
 * Shared camera pose between Mapbox (2D/3D map) and Cesium globe.
 * Stored in memory + sessionStorage so Map ↔ Globe switches don't snap to defaults.
 */

export type TwinCameraPose = {
  lng: number;
  lat: number;
  /** Mapbox zoom level */
  zoom: number;
  /** Cesium camera height above ellipsoid (meters) */
  height: number;
  /** Degrees: Mapbox bearing / Cesium heading (clockwise from north) */
  heading: number;
  /**
   * Degrees stored in Mapbox convention (0 = top-down, 60 = tilted).
   * Cesium pitch ≈ mapPitch - 90.
   */
  mapPitch: number;
};

const KEY = "twin-camera-pose";
const EVENT = "twin-camera-pose";

/** Rough Denver downtown defaults */
export const DEFAULT_POSE: TwinCameraPose = {
  lng: -104.9903,
  lat: 39.7392,
  zoom: 13.6,
  height: 2200,
  heading: -20,
  mapPitch: 55,
};

let memory: TwinCameraPose | null = null;

export function mapPitchToCesium(mapPitch: number): number {
  return mapPitch - 90;
}

export function cesiumPitchToMap(cesiumPitch: number): number {
  return Math.max(0, Math.min(80, cesiumPitch + 90));
}

/** Approximate ellipsoid height from Mapbox zoom at mid-latitudes. */
export function zoomToHeight(zoom: number): number {
  return Math.max(80, 40_000_000 / Math.pow(2, zoom));
}

export function heightToZoom(height: number): number {
  const z = Math.log2(40_000_000 / Math.max(80, height));
  return Math.max(10, Math.min(18, z));
}

export function readTwinCameraPose(): TwinCameraPose | null {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TwinCameraPose;
    if (
      typeof parsed?.lng === "number" &&
      typeof parsed?.lat === "number" &&
      typeof parsed?.zoom === "number"
    ) {
      memory = {
        ...DEFAULT_POSE,
        ...parsed,
        height: parsed.height ?? zoomToHeight(parsed.zoom),
        mapPitch: parsed.mapPitch ?? DEFAULT_POSE.mapPitch,
        heading: parsed.heading ?? DEFAULT_POSE.heading,
      };
      return memory;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writeTwinCameraPose(pose: Partial<TwinCameraPose> & { lng: number; lat: number }) {
  const prev = readTwinCameraPose() ?? DEFAULT_POSE;
  const next: TwinCameraPose = {
    ...prev,
    ...pose,
    height: pose.height ?? prev.height ?? zoomToHeight(pose.zoom ?? prev.zoom),
    zoom: pose.zoom ?? prev.zoom ?? heightToZoom(pose.height ?? prev.height),
  };
  memory = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
}

export const TWIN_CAMERA_EVENT = EVENT;
