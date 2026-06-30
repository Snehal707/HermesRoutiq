import type { LatLng, LngLat, RouteWaypoint } from "./types";

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Haversine distance in meters between two WGS84 points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lngLatToLatLng([lng, lat]: LngLat): LatLng {
  return { lat, lng };
}

export function latLngToLngLat({ lat, lng }: LatLng): LngLat {
  return [lng, lat];
}

/** Total polyline length in meters. */
export function routeLength(waypoints: LngLat[]): number {
  if (waypoints.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    total += haversineMeters(
      lngLatToLatLng(waypoints[i - 1]),
      lngLatToLatLng(waypoints[i]),
    );
  }
  return total;
}

export interface PositionAlongRoute {
  position: LatLng;
  bearing: number;
  progress: number;
  segmentIndex: number;
}

function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLng = toRadians(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Deterministic position along a route polyline at elapsed sim seconds.
 */
export function positionAlongRoute(
  waypoints: LngLat[],
  elapsedSeconds: number,
  speedMps: number,
): PositionAlongRoute {
  if (waypoints.length === 0) {
    return {
      position: { lat: 0, lng: 0 },
      bearing: 0,
      progress: 0,
      segmentIndex: 0,
    };
  }

  if (waypoints.length === 1) {
    return {
      position: lngLatToLatLng(waypoints[0]),
      bearing: 0,
      progress: 1,
      segmentIndex: 0,
    };
  }

  const totalLength = routeLength(waypoints);
  if (totalLength === 0) {
    return {
      position: lngLatToLatLng(waypoints[0]),
      bearing: 0,
      progress: 0,
      segmentIndex: 0,
    };
  }

  const distanceTravelled = Math.max(0, elapsedSeconds * speedMps);
  const clampedDistance = Math.min(distanceTravelled, totalLength);
  let traversed = 0;

  for (let i = 1; i < waypoints.length; i += 1) {
    const from = lngLatToLatLng(waypoints[i - 1]);
    const to = lngLatToLatLng(waypoints[i]);
    const segmentLength = haversineMeters(from, to);

    if (traversed + segmentLength >= clampedDistance) {
      const segmentProgress =
        segmentLength === 0
          ? 1
          : (clampedDistance - traversed) / segmentLength;
      const lat = from.lat + (to.lat - from.lat) * segmentProgress;
      const lng = from.lng + (to.lng - from.lng) * segmentProgress;

      return {
        position: { lat, lng },
        bearing: bearingDegrees(from, to),
        progress: clampedDistance / totalLength,
        segmentIndex: i - 1,
      };
    }

    traversed += segmentLength;
  }

  const last = lngLatToLatLng(waypoints[waypoints.length - 1]);
  const prev = lngLatToLatLng(waypoints[waypoints.length - 2]);

  return {
    position: last,
    bearing: bearingDegrees(prev, last),
    progress: 1,
    segmentIndex: waypoints.length - 2,
  };
}

/** Build TripsLayer path with synthetic timestamps from route geometry. */
export function buildTripPath(
  waypoints: LngLat[],
  speedMps: number,
  startAtSeconds = 0,
): RouteWaypoint[] {
  if (waypoints.length === 0) {
    return [];
  }

  const path: RouteWaypoint[] = [[waypoints[0][0], waypoints[0][1], startAtSeconds]];
  let elapsed = startAtSeconds;

  for (let i = 1; i < waypoints.length; i += 1) {
    const segmentLength = haversineMeters(
      lngLatToLatLng(waypoints[i - 1]),
      lngLatToLatLng(waypoints[i]),
    );
    elapsed += segmentLength / speedMps;
    path.push([waypoints[i][0], waypoints[i][1], elapsed]);
  }

  return path;
}

export function getVehiclePositionAtTime(
  waypoints: LngLat[],
  elapsedSeconds: number,
  speedMps: number,
  frozenAtSeconds: number | null,
  routeStartAtSeconds = 0,
): PositionAlongRoute {
  const relativeElapsed = Math.max(0, elapsedSeconds - routeStartAtSeconds);
  const effectiveElapsed =
    frozenAtSeconds !== null
      ? Math.min(relativeElapsed, Math.max(0, frozenAtSeconds - routeStartAtSeconds))
      : relativeElapsed;

  return positionAlongRoute(waypoints, effectiveElapsed, speedMps);
}
