/**
 * Street-network routing helpers (Mapbox Directions → densified waypoints).
 */

export type LngLat = [number, number];

export type StreetRouteResult = {
  coords: LngLat[];
  distance: number;
  duration: number;
};

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

export function bearingDegrees(a: LngLat, b: LngLat): number {
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

/** Insert intermediate points so consecutive samples are ~`spacingM` apart. */
export function densifyLine(coords: LngLat[], spacingM = 90): LngLat[] {
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

/**
 * Keep landmark corners + every ~`minSegM` along the path so flyTo hops
 * still follow the street grid without hundreds of micro-flights.
 */
export function simplifyForFlyTo(coords: LngLat[], minSegM = 420): LngLat[] {
  if (coords.length <= 2) return coords.slice();
  const out: LngLat[] = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    acc += haversineMeters(coords[i - 1], coords[i]);
    if (acc >= minSegM) {
      out.push(coords[i]);
      acc = 0;
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export function buildCumDist(coords: LngLat[]): { cum: number[]; total: number } {
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  }
  return { cum, total: cum[cum.length - 1] || 0 };
}

/**
 * Fetch a street-network path through ordered waypoints via Mapbox Directions.
 * Falls back to straight segments only if the token/request fails or times out.
 */
export async function fetchStreetRoute(
  waypoints: LngLat[],
  profile: "driving" | "walking" | "cycling" = "driving",
  timeoutMs = 8000,
): Promise<StreetRouteResult | null> {
  if (waypoints.length < 2) return null;
  const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
  if (!token) return null;

  const path = waypoints.map(([lon, lat]) => `${lon},${lat}`).join(";");
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${path}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    const route = data?.routes?.[0];
    const coords = route?.geometry?.coordinates as LngLat[] | undefined;
    if (!res.ok || !coords?.length) return null;
    return {
      coords,
      distance: Number(route.distance) || 0,
      duration: Number(route.duration) || 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
