"use client";

import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "@deck.gl/geo-layers";
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { MapboxOverlayProps } from "@deck.gl/mapbox";
import { useControl } from "react-map-gl/maplibre";
import { useMemo } from "react";
import {
  MAP_CENTER,
  DEFAULT_MAP_ZOOM,
} from "@/lib/sim/types";
import type { RouteStatus, SimulationWorld } from "@/lib/sim/types";
import { isStripeBackedOrder } from "@hermes-routiq/shared";
import type {
  AmbientRouteSegment,
  AmbientVehicle,
  SignalLight,
  SimulatorMapView,
  TrafficZone,
} from "@hermes-routiq/shared";
import {
  buildTripPath,
  getVehiclePositionAtTime,
  latLngToLngLat,
} from "@/lib/sim/movement";
import MapView from "react-map-gl/maplibre";
import type { MapLibreEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DEFAULT_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Persisted routes are guaranteed contiguous road geometry: both the routing
// service (osrm_provider.py) and the client (lib/routing/client.ts) reject any
// segment longer than this and replace it with a stop-to-stop fallback. We use
// the same threshold at render time so a fallback's long straight segments are
// never drawn as "airborne" spikes across the map. Keep in sync with
// IMPOSSIBLE_JUMP_METERS in those two files.
const ROUTE_MAX_SEGMENT_METERS = 300;

const ROUTE_BASE_COLORS: Record<RouteStatus, [number, number, number, number]> = {
  normal: [86, 251, 191, 230],
  at_risk: [251, 191, 36, 232],
  incident: [255, 50, 50, 240],
  recovery: [72, 175, 255, 238],
  completed: [94, 234, 212, 130],
};

const ROUTE_TRAIL_COLORS: Record<RouteStatus, [number, number, number, number]> = {
  normal: [20, 255, 160, 228],
  at_risk: [0, 220, 255, 224],
  incident: [255, 50, 50, 245],
  recovery: [72, 175, 255, 245],
  completed: [20, 255, 160, 215],
};

interface TripDatum {
  id: string;
  path: [number, number, number][];
  staticPath: [number, number][];
  timestamps: number[];
  routeStatus: RouteStatus;
}

interface DriverDatum {
  id: string;
  position: [number, number];
  routeStatus: RouteStatus;
  isParked: boolean;
}

interface PointDatum {
  id: string;
  position: [number, number];
  name: string;
}

interface OrderPointDatum {
  id: string;
  position: [number, number];
  amountLabel: string;
  status: "pending" | "active" | "delivered";
}

interface AmbientVehicleDatum {
  id: string;
  position: [number, number];
  state: AmbientVehicle["state"];
  heading: number;
}

interface AmbientRouteSegmentDatum {
  geometry: [number, number][];
  distanceMeters: number;
}

interface TrafficZoneDatum {
  id: string;
  position: [number, number];
  radiusMeters: number;
  severity: TrafficZone["severity"];
}

interface SignalLightDatum {
  id: string;
  position: [number, number];
  displayPosition: [number, number];
  controlPosition: [number, number];
  controlledRouteFromWaypointIndex: number;
  controlledRouteToWaypointIndex: number;
  approachPath: [number, number][];
  stopLinePath: [number, number][];
  phase: SignalLight["phase"];
}

const SIGNAL_PHASE_SECONDS: Record<SignalLight["phase"], number> = {
  green: 16,
  yellow: 4,
  red: 14,
};

interface MarkerIconDefinition {
  url: string;
  width: number;
  height: number;
  anchorY: number;
}

interface RouteRenderBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

function expandBoundsWithPoint(
  bounds: RouteRenderBounds | null,
  point: { lng: number; lat: number },
): RouteRenderBounds {
  if (!bounds) {
    return {
      minLng: point.lng,
      maxLng: point.lng,
      minLat: point.lat,
      maxLat: point.lat,
    };
  }

  return {
    minLng: Math.min(bounds.minLng, point.lng),
    maxLng: Math.max(bounds.maxLng, point.lng),
    minLat: Math.min(bounds.minLat, point.lat),
    maxLat: Math.max(bounds.maxLat, point.lat),
  };
}

function ambientSegmentKey(fromWaypointIndex: number, toWaypointIndex: number): string {
  return `${fromWaypointIndex}:${toWaypointIndex}`;
}

function getMapStyleUrl(): string {
  return process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_STYLE_URL;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b[1] - a[1]);
  const dLng = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildRouteRenderBounds(world: SimulationWorld): RouteRenderBounds {
  const customersById = new globalThis.Map(
    world.customers.map((customer) => [customer.id, customer]),
  );
  let bounds: RouteRenderBounds | null = null;

  for (const hub of world.pickupHubs) {
    bounds = expandBoundsWithPoint(bounds, hub.location);
  }

  for (const order of world.orders) {
    if (!isStripeBackedOrder(order)) {
      continue;
    }

    const customer = customersById.get(order.customerId);
    if (!customer) {
      continue;
    }

    bounds = expandBoundsWithPoint(bounds, customer.location);
  }

  for (const vehicle of world.vehicles) {
    for (const [lng, lat] of vehicle.route) {
      bounds = expandBoundsWithPoint(bounds, { lng, lat });
    }
  }

  const baseBounds = bounds ?? {
    minLng: MAP_CENTER[0],
    maxLng: MAP_CENTER[0],
    minLat: MAP_CENTER[1],
    maxLat: MAP_CENTER[1],
  };

  return {
    minLng: baseBounds.minLng - 0.012,
    maxLng: baseBounds.maxLng + 0.012,
    minLat: baseBounds.minLat - 0.01,
    maxLat: baseBounds.maxLat + 0.01,
  };
}

// Returns the leading run of contiguous road geometry: in-bounds points up to
// (but not including) the first segment longer than ROUTE_MAX_SEGMENT_METERS.
// Truncating â€” rather than skipping a far point and reconnecting across the gap
// â€” guarantees the result never contains a long airborne segment. May return a
// single point (or empty), which getRenderableRoute handles.
function sanitizeRouteForRendering(
  route: [number, number][],
  bounds: RouteRenderBounds,
): [number, number][] {
  const inBounds = route.filter(
    ([lng, lat]) =>
      lng >= bounds.minLng &&
      lng <= bounds.maxLng &&
      lat >= bounds.minLat &&
      lat <= bounds.maxLat,
  );

  if (inBounds.length === 0) {
    return [];
  }

  const sanitized: [number, number][] = [inBounds[0] as [number, number]];

  for (let index = 1; index < inBounds.length; index += 1) {
    const point = inBounds[index] as [number, number];
    const lastPoint = sanitized[sanitized.length - 1];

    if (lastPoint[0] === point[0] && lastPoint[1] === point[1]) {
      continue;
    }

    if (haversineMeters(lastPoint, point) > ROUTE_MAX_SEGMENT_METERS) {
      break;
    }

    sanitized.push(point);
  }

  return sanitized;
}

function buildFallbackRouteFromVehicle(
  vehicle: SimulationWorld["vehicles"][number],
): [number, number][] {
  if (vehicle.routingPlan?.geometryMode === "fallback") {
    return vehicle.route.slice(0, 1);
  }

  const stops = vehicle.routingPlan?.orderedStops ?? [];
  if (stops.length >= 2) {
    const stopPoints = stops.map(
      (stop) => [stop.location.lng, stop.location.lat] as [number, number],
    );
    const fallbackRoute: [number, number][] = [stopPoints[0] as [number, number]];

    for (let index = 1; index < stopPoints.length; index += 1) {
      const from = stopPoints[index - 1] as [number, number];
      const to = stopPoints[index] as [number, number];
      fallbackRoute.push(
        [
          from[0] + (to[0] - from[0]) * 0.33,
          from[1] + (to[1] - from[1]) * 0.33,
        ],
        [
          from[0] + (to[0] - from[0]) * 0.66,
          from[1] + (to[1] - from[1]) * 0.66,
        ],
        to,
      );
    }

    return fallbackRoute;
  }

  return vehicle.route;
}

function getRenderableRoute(
  vehicle: SimulationWorld["vehicles"][number],
  bounds: RouteRenderBounds,
): [number, number][] {
  if (vehicle.routingPlan?.geometryMode === "fallback") {
    const anchor =
      sanitizeRouteForRendering(vehicle.route, bounds)[0] ??
      vehicle.route[0];
    return anchor ? [anchor] : [];
  }

  // sanitizeRouteForRendering guarantees no segment exceeds the threshold, so a
  // result of length >= 2 is safe to draw as-is.
  const sanitizedPrimary = sanitizeRouteForRendering(vehicle.route, bounds);
  if (sanitizedPrimary.length >= 2) {
    return sanitizedPrimary;
  }

  const sanitizedFallback = sanitizeRouteForRendering(
    buildFallbackRouteFromVehicle(vehicle),
    bounds,
  );
  if (sanitizedFallback.length >= 2) {
    return sanitizedFallback;
  }

  // No contiguous road geometry available (e.g. a stop-to-stop fallback route).
  // Keep a single anchor point so the vehicle marker still renders at its start,
  // but never emit a long straight connector.
  if (sanitizedPrimary.length > 0) {
    return sanitizedPrimary;
  }
  if (sanitizedFallback.length > 0) {
    return sanitizedFallback;
  }
  return vehicle.route.slice(0, 1);
}

function isParkedVehicle(
  vehicle: SimulationWorld["vehicles"][number],
): boolean {
  return (
    vehicle.status === "idle" &&
    vehicle.route.length <= 1 &&
    (vehicle.routingPlan?.assignedOrderIds.length ?? 0) === 0
  );
}

function findOverlappingHubId(
  position: [number, number],
  pickupHubs: SimulationWorld["pickupHubs"],
): string | null {
  const overlappingHub = pickupHubs.find((hub) => {
    const hubPosition = latLngToLngLat(hub.location);
    return haversineMeters(position, hubPosition) < 3;
  });

  return overlappingHub?.id ?? null;
}

function buildParkedVehicleOffset(
  position: [number, number],
  parkedIndex: number,
  parkedCount: number,
): [number, number] {
  const ringIndex = parkedIndex % Math.max(parkedCount, 1);
  const angle = (ringIndex / Math.max(parkedCount, 1)) * Math.PI * 2 - Math.PI / 2;
  const radiusScale = parkedCount <= 2 ? 0.00014 : parkedCount <= 4 ? 0.00017 : 0.0002;
  const lngOffset = Math.cos(angle) * radiusScale;
  const latOffset = Math.sin(angle) * radiusScale * 0.82;

  return [position[0] + lngOffset, position[1] + latOffset];
}

function buildParkedVehicleLayout(
  vehicles: SimulationWorld["vehicles"],
  pickupHubs: SimulationWorld["pickupHubs"],
): Map<string, [number, number]> {
  const parkedVehicleIdsByHubId = new Map<string, string[]>();
  const parkedAnchorsByVehicleId = new Map<string, [number, number]>();

  for (const vehicle of vehicles) {
    if (!isParkedVehicle(vehicle)) {
      continue;
    }

    const anchor = vehicle.route[vehicle.route.length - 1] ?? vehicle.route[0];
    if (!anchor) {
      continue;
    }

    const overlappingHubId = findOverlappingHubId(anchor, pickupHubs);
    if (!overlappingHubId) {
      continue;
    }

    parkedAnchorsByVehicleId.set(vehicle.id, anchor);
    const current = parkedVehicleIdsByHubId.get(overlappingHubId) ?? [];
    current.push(vehicle.id);
    parkedVehicleIdsByHubId.set(overlappingHubId, current);
  }

  const layoutByVehicleId = new Map<string, [number, number]>();

  for (const vehicleIds of parkedVehicleIdsByHubId.values()) {
    vehicleIds.forEach((vehicleId, index) => {
      const anchor = parkedAnchorsByVehicleId.get(vehicleId);
      if (!anchor) {
        return;
      }

      layoutByVehicleId.set(
        vehicleId,
        buildParkedVehicleOffset(anchor, index, vehicleIds.length),
      );
    });
  }

  return layoutByVehicleId;
}

function DeckGLOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function add3DBuildingsIfNeeded(event: MapLibreEvent) {
  const map = event.target;
  const styleLayers = map.getStyle().layers ?? [];

  const existingExtrusionLayer = styleLayers.find(
    (layer) =>
      layer.type === "fill-extrusion" &&
      "source-layer" in layer &&
      layer["source-layer"] === "building",
  );

  if (existingExtrusionLayer) {
    map.setPaintProperty(
      existingExtrusionLayer.id,
      "fill-extrusion-opacity",
      0.86,
    );
    return;
  }

  if (map.getLayer("hermes-3d-buildings")) {
    return;
  }

  const buildingLayer = styleLayers.find((layer): layer is typeof layer & {
    source: string;
    "source-layer": string;
  } => {
    if (!("source-layer" in layer) || layer["source-layer"] !== "building") {
      return false;
    }

    return "source" in layer && typeof layer.source === "string";
  });

  if (!buildingLayer) {
    return;
  }

  const firstLabelLayer = styleLayers.find((layer) => layer.type === "symbol")?.id;

  map.addLayer(
    {
      id: "hermes-3d-buildings",
      source: buildingLayer.source,
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "render_height"], ["get", "height"], 0],
          0,
          "#16202c",
          36,
          "#233246",
          120,
          "#41566f",
        ],
        "fill-extrusion-height": [
          "coalesce",
          ["get", "render_height"],
          ["get", "height"],
          12,
        ],
        "fill-extrusion-base": [
          "coalesce",
          ["get", "render_min_height"],
          ["get", "min_height"],
          0,
        ],
        "fill-extrusion-opacity": 0.72,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    firstLabelLayer,
  );
}

function getVehicleHaloRadius(routeStatus: RouteStatus, pulse: number): number {
  if (routeStatus === "incident") {
    return 120 * pulse;
  }
  if (routeStatus === "recovery") {
    return 94;
  }
  return 82;
}

function getOrderStatus(status: SimulationWorld["orders"][number]["status"]): OrderPointDatum["status"] {
  if (status === "delivered") {
    return "delivered";
  }
  if (status === "pending") {
    return "pending";
  }
  return "active";
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildMarkerIcon(svg: string, width: number, height: number, anchorY = height / 2): MarkerIconDefinition {
  return {
    url: svgToDataUrl(svg),
    width,
    height,
    anchorY,
  };
}

// Glyph inner-SVG from the Lucide icon set (MIT licensed, 24x24, stroke-based).
// Composed into coloured circular badges below so every marker is a consistent,
// professionally-drawn icon rather than a hand-rolled path.
const LUCIDE_TRUCK =
  '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>';
const LUCIDE_ALERT =
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
const LUCIDE_WAREHOUSE =
  '<path d="M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11"/><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z"/><path d="M6 13h12"/><path d="M6 17h12"/>';
const LUCIDE_PACKAGE =
  '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>';
const LUCIDE_CHECK = '<path d="M20 6 9 17l-5-5"/>';

// Builds a 64x64 circular badge: a filled status-coloured disc with a white ring
// and a centred Lucide glyph. The 24x24 glyph is scaled 1.5x and translated so it
// sits centred in the disc.
function buildBadgeIcon(
  fill: string,
  glyph: string,
  glyphColor = "#ffffff",
): MarkerIconDefinition {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="27" fill="${fill}" stroke="#ffffff" stroke-width="3"/>
      <g transform="translate(14 14) scale(1.5)" fill="none" stroke="${glyphColor}"
         stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
        ${glyph}
      </g>
    </svg>
  `;
  return buildMarkerIcon(svg, 64, 64);
}

const HUB_ICON = buildBadgeIcon("#0f172a", LUCIDE_WAREHOUSE, "#f59e0b");
const ORDER_ICONS: Record<OrderPointDatum["status"], MarkerIconDefinition> = {
  pending: buildBadgeIcon("#ffffff", LUCIDE_PACKAGE, "#0f172a"),
  active: buildBadgeIcon("#0ea5e9", LUCIDE_PACKAGE),
  delivered: buildBadgeIcon("#64748b", LUCIDE_CHECK),
};
const VEHICLE_ICONS: Record<RouteStatus, MarkerIconDefinition> = {
  normal: buildBadgeIcon("#10b981", LUCIDE_TRUCK),
  at_risk: buildBadgeIcon("#f59e0b", LUCIDE_TRUCK),
  incident: buildBadgeIcon("#ef4444", LUCIDE_ALERT),
  recovery: buildBadgeIcon("#3b82f6", LUCIDE_TRUCK),
  completed: buildBadgeIcon("#10b981", LUCIDE_TRUCK),
};

function buildAmbientVehicleIcon(state: AmbientVehicle["state"]): MarkerIconDefinition {
  const fill =
    state === "waiting_signal"
      ? "#facc15"
      : state === "congested"
        ? "#f97316"
        : "#22c55e";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
      <g transform="translate(28 28)">
        <path d="M 0 -15 C 6 -15 10 -10 10 -4 L 10 8 C 10 12 7 15 3 15 L -3 15 C -7 15 -10 12 -10 8 L -10 -4 C -10 -10 -6 -15 0 -15 Z"
          fill="${fill}" stroke="#e2e8f0" stroke-width="2.2" />
        <rect x="-7" y="-8" width="14" height="10" rx="4" fill="#082f49" opacity="0.78" />
        <rect x="-7.5" y="4" width="15" height="6" rx="3" fill="#0f172a" opacity="0.55" />
        <circle cx="-5.5" cy="12" r="2.2" fill="#020617" stroke="#cbd5e1" stroke-width="1.2" />
        <circle cx="5.5" cy="12" r="2.2" fill="#020617" stroke="#cbd5e1" stroke-width="1.2" />
      </g>
    </svg>
  `;

  return buildMarkerIcon(svg, 56, 56);
}

function buildSignalIcon(phase: SignalLight["phase"]): MarkerIconDefinition {
  const activeColor =
    phase === "green"
      ? "#22c55e"
      : phase === "yellow"
        ? "#facc15"
        : "#ef4444";
  const inactiveColor = "#1f2937";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="84" viewBox="0 0 72 84">
      <path d="M36 79c9.5-12.8 18-25.1 18-37 0-11-8-19-18-19s-18 8-18 19c0 11.9 8.5 24.2 18 37Z"
        fill="#0f172a" stroke="${activeColor}" stroke-width="3"/>
      <rect x="24" y="13" width="24" height="38" rx="10" fill="#020617" stroke="#cbd5e1" stroke-width="2"/>
      <circle cx="36" cy="22" r="5.5" fill="${phase === "red" ? "#ef4444" : inactiveColor}"/>
      <circle cx="36" cy="32" r="5.5" fill="${phase === "yellow" ? "#facc15" : inactiveColor}"/>
      <circle cx="36" cy="42" r="5.5" fill="${phase === "green" ? "#22c55e" : inactiveColor}"/>
      <circle cx="36" cy="60" r="4.5" fill="${activeColor}" opacity="0.28"/>
    </svg>
  `;

  return buildMarkerIcon(svg, 72, 84, 79);
}

function nextSignalPhase(phase: SignalLight["phase"]): SignalLight["phase"] {
  switch (phase) {
    case "green":
      return "yellow";
    case "yellow":
      return "red";
    default:
      return "green";
  }
}

function projectSignalPhase(
  signal: SignalLight,
  simSecondsSinceSnapshot: number,
): SignalLight["phase"] {
  let phase = signal.phase;
  let remaining = signal.remaining_seconds - Math.max(0, simSecondsSinceSnapshot);

  while (remaining <= 0) {
    phase = nextSignalPhase(phase);
    remaining += SIGNAL_PHASE_SECONDS[phase];
  }

  return phase;
}

function getVehicleIcon(routeStatus: RouteStatus): MarkerIconDefinition {
  return VEHICLE_ICONS[routeStatus];
}

export interface CityMapProps {
  world: SimulationWorld;
  elapsedSeconds: number;
  ambientElapsedSeconds?: number;
  ambientSnapshotTimeSeconds?: number | null;
  ambientRouteSegments?: AmbientRouteSegment[];
  ambientVehicles?: AmbientVehicle[];
  trafficZones?: TrafficZone[];
  signalLights?: SignalLight[];
  mapView?: SimulatorMapView | null;
}

function interpolateLngLat(
  start: [number, number],
  end: [number, number],
  progress: number,
): [number, number] {
  return [
    start[0] + (end[0] - start[0]) * progress,
    start[1] + (end[1] - start[1]) * progress,
  ];
}

function positionAlongAmbientGeometry(
  geometry: [number, number][],
  distanceMeters: number,
): [number, number] | null {
  if (geometry.length === 0) {
    return null;
  }

  if (geometry.length === 1) {
    return geometry[0] ?? null;
  }

  let remainingDistance = Math.max(0, distanceMeters);

  for (let index = 1; index < geometry.length; index += 1) {
    const start = geometry[index - 1] as [number, number];
    const end = geometry[index] as [number, number];
    const segmentLength = haversineMeters(start, end);

    if (segmentLength <= 0) {
      continue;
    }

    if (remainingDistance <= segmentLength) {
      return interpolateLngLat(start, end, remainingDistance / segmentLength);
    }

    remainingDistance -= segmentLength;
  }

  return geometry[geometry.length - 1] ?? null;
}

function resolveAmbientVehiclePosition(
  vehicle: AmbientVehicle,
  elapsedSeconds: number,
  routeCache: Map<string, AmbientRouteSegmentDatum>,
  waypointCount: number,
  signalLights: SignalLightDatum[],
): [number, number] | null {
  if (vehicle.state === "waiting_signal" || vehicle.speed_mps <= 0) {
    return latLngToLngLat(vehicle.position);
  }

  if (waypointCount <= 0) {
    return null;
  }

  let fromWaypointIndex = vehicle.route_from_waypoint_index;
  let toWaypointIndex = vehicle.route_to_waypoint_index;
  const initialDistanceMeters = vehicle.distance_along_route_meters;
  let distanceMeters =
    initialDistanceMeters + Math.max(0, elapsedSeconds) * vehicle.speed_mps;
  let currentSegment = routeCache.get(
    ambientSegmentKey(fromWaypointIndex, toWaypointIndex),
  );

  if (!currentSegment) {
    return null;
  }

  while (distanceMeters > currentSegment.distanceMeters) {
    distanceMeters -= currentSegment.distanceMeters;
    fromWaypointIndex = toWaypointIndex;
    toWaypointIndex = (toWaypointIndex + 1) % waypointCount;
    currentSegment = routeCache.get(
      ambientSegmentKey(fromWaypointIndex, toWaypointIndex),
    );

    if (!currentSegment) {
      return null;
    }
  }

  const basePosition = positionAlongAmbientGeometry(
    currentSegment.geometry,
    initialDistanceMeters,
  );
  const projectedPosition = positionAlongAmbientGeometry(
    currentSegment.geometry,
    distanceMeters,
  );

  if (!basePosition || !projectedPosition) {
    return projectedPosition;
  }

  const crossingRedSignal = signalLights.some(
    (signal) =>
      signal.phase === "red" &&
      pointToSegmentDistance(
        signal.controlPosition,
        basePosition,
        projectedPosition,
      ) <= 18,
  );

  return crossingRedSignal ? basePosition : projectedPosition;
}

function pointToSegmentDistance(
  point: [number, number],
  start: [number, number],
  end: [number, number],
): number {
  const px = point[0];
  const py = point[1];
  const sx = start[0];
  const sy = start[1];
  const ex = end[0];
  const ey = end[1];
  const dx = ex - sx;
  const dy = ey - sy;

  if (dx === 0 && dy === 0) {
    return haversineMeters(point, start);
  }

  const projection = ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, projection));
  const closest: [number, number] = [sx + dx * clamped, sy + dy * clamped];

  return haversineMeters(point, closest);
}

function lngLatToLocalMeters(
  origin: [number, number],
  point: [number, number],
): [number, number] {
  const meanLatRadians = ((origin[1] + point[1]) / 2) * (Math.PI / 180);
  const y = (point[1] - origin[1]) * 111_320;
  const x = (point[0] - origin[0]) * 111_320 * Math.cos(meanLatRadians);
  return [x, y];
}

function localMetersToLngLat(
  origin: [number, number],
  xMeters: number,
  yMeters: number,
): [number, number] {
  const latitude = origin[1] + yMeters / 111_320;
  const meanLatRadians = ((origin[1] + latitude) / 2) * (Math.PI / 180);
  const longitude =
    origin[0] + xMeters / (111_320 * Math.max(Math.cos(meanLatRadians), 0.01));
  return [longitude, latitude];
}

function offsetLngLatByMeters(
  point: [number, number],
  alongXMeters: number,
  alongYMeters: number,
): [number, number] {
  return localMetersToLngLat(point, alongXMeters, alongYMeters);
}

function positionAndHeadingAlongAmbientGeometry(
  geometry: [number, number][],
  distanceMeters: number,
): { position: [number, number]; headingRadians: number } | null {
  if (geometry.length === 0) {
    return null;
  }

  if (geometry.length === 1) {
    return { position: geometry[0] as [number, number], headingRadians: 0 };
  }

  let remainingDistance = Math.max(0, distanceMeters);

  for (let index = 1; index < geometry.length; index += 1) {
    const start = geometry[index - 1] as [number, number];
    const end = geometry[index] as [number, number];
    const segmentLength = haversineMeters(start, end);

    if (segmentLength <= 0) {
      continue;
    }

    const [dxMeters, dyMeters] = lngLatToLocalMeters(start, end);
    const headingRadians = Math.atan2(dyMeters, dxMeters);

    if (remainingDistance <= segmentLength) {
      return {
        position: interpolateLngLat(start, end, remainingDistance / segmentLength),
        headingRadians,
      };
    }

    remainingDistance -= segmentLength;
  }

  const penultimate = geometry[geometry.length - 2] as [number, number];
  const last = geometry[geometry.length - 1] as [number, number];
  const [dxMeters, dyMeters] = lngLatToLocalMeters(penultimate, last);

  return {
    position: last,
    headingRadians: Math.atan2(dyMeters, dxMeters),
  };
}

function projectDistanceAlongAmbientGeometry(
  geometry: [number, number][],
  point: [number, number],
): number | null {
  if (geometry.length < 2) {
    return null;
  }

  let traversedMeters = 0;
  let bestDistanceMeters = Number.POSITIVE_INFINITY;
  let bestDistanceAlongMeters = 0;

  for (let index = 1; index < geometry.length; index += 1) {
    const start = geometry[index - 1] as [number, number];
    const end = geometry[index] as [number, number];
    const segmentLength = haversineMeters(start, end);

    if (segmentLength <= 0) {
      continue;
    }

    const [px, py] = lngLatToLocalMeters(start, point);
    const [ex, ey] = lngLatToLocalMeters(start, end);
    const projection =
      Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
    const closest: [number, number] = interpolateLngLat(start, end, projection);
    const distanceMeters = haversineMeters(point, closest);

    if (distanceMeters < bestDistanceMeters) {
      bestDistanceMeters = distanceMeters;
      bestDistanceAlongMeters = traversedMeters + segmentLength * projection;
    }

    traversedMeters += segmentLength;
  }

  return bestDistanceAlongMeters;
}

function buildSignalApproachShape(
  controlPosition: [number, number],
  segment: AmbientRouteSegmentDatum | undefined,
): { approachPath: [number, number][]; stopLinePath: [number, number][] } {
  if (!segment || segment.geometry.length < 2) {
    return {
      approachPath: [controlPosition],
      stopLinePath: [controlPosition],
    };
  }

  const controlDistance =
    projectDistanceAlongAmbientGeometry(segment.geometry, controlPosition) ?? 0;
  const approachStart = positionAndHeadingAlongAmbientGeometry(
    segment.geometry,
    Math.max(0, controlDistance - 24),
  );
  const approachEnd = positionAndHeadingAlongAmbientGeometry(
    segment.geometry,
    Math.max(0, controlDistance - 2),
  );
  const controlAnchor = positionAndHeadingAlongAmbientGeometry(
    segment.geometry,
    controlDistance,
  );

  if (!approachStart || !approachEnd || !controlAnchor) {
    return {
      approachPath: [controlPosition],
      stopLinePath: [controlPosition],
    };
  }

  const normalRadians = controlAnchor.headingRadians + Math.PI / 2;
  const halfStopBarMeters = 4.5;
  const stopLineStart = offsetLngLatByMeters(
    controlAnchor.position,
    Math.cos(normalRadians) * halfStopBarMeters,
    Math.sin(normalRadians) * halfStopBarMeters,
  );
  const stopLineEnd = offsetLngLatByMeters(
    controlAnchor.position,
    Math.cos(normalRadians + Math.PI) * halfStopBarMeters,
    Math.sin(normalRadians + Math.PI) * halfStopBarMeters,
  );

  return {
    approachPath: [approachStart.position, approachEnd.position],
    stopLinePath: [stopLineStart, stopLineEnd],
  };
}

export function CityMap({
  world,
  elapsedSeconds,
  ambientElapsedSeconds = 0,
  ambientSnapshotTimeSeconds = null,
  ambientRouteSegments = [],
  ambientVehicles = [],
  trafficZones = [],
  signalLights = [],
  mapView = null,
}: CityMapProps) {
  const routeRenderBounds = useMemo(
    () => buildRouteRenderBounds(world),
    [world],
  );
  const parkedVehicleLayout = useMemo(
    () => buildParkedVehicleLayout(world.vehicles, world.pickupHubs),
    [world.vehicles, world.pickupHubs],
  );
  const ambientWaypointCount = useMemo(() => {
    if (ambientRouteSegments.length === 0) {
      return 0;
    }

    return (
      Math.max(
        ...ambientRouteSegments.flatMap((segment) => [
          segment.from_waypoint_index,
          segment.to_waypoint_index,
        ]),
      ) + 1
    );
  }, [ambientRouteSegments]);

  const ambientRouteSegmentCache = useMemo(() => {
    const cache = new Map<string, AmbientRouteSegmentDatum>();

    for (const segment of ambientRouteSegments) {
      cache.set(ambientSegmentKey(segment.from_waypoint_index, segment.to_waypoint_index), {
        geometry: segment.geometry.map((point) => latLngToLngLat(point)),
        distanceMeters: segment.distance_meters,
      });
    }

    return cache;
  }, [ambientRouteSegments]);

  const tripData = useMemo((): TripDatum[] =>
      world.vehicles.map((vehicle) => {
        const renderRoute = getRenderableRoute(vehicle, routeRenderBounds);
        const path = buildTripPath(
          renderRoute,
          vehicle.speedMps,
          vehicle.routingPlan?.routeStartAtSeconds ?? 0,
        ) as [
          number,
          number,
          number,
        ][];
        return {
          id: vehicle.id,
          path,
          staticPath: path.map(
            ([longitude, latitude]) => [longitude, latitude] as [number, number],
          ),
          // buildTripPath stores the per-vertex timestamp as the 3rd coordinate.
          // TripsLayer (deck.gl v9) needs these via getTimestamps; leaving them in
          // the path would make PathLayer read them as Z elevation (floating routes).
          timestamps: path.map(([, , timestamp]) => timestamp),
          routeStatus: vehicle.routeStatus,
        };
      }),
    [routeRenderBounds, world.vehicles],
  );

  const driverData = useMemo((): DriverDatum[] =>
      world.vehicles.map((vehicle) => {
        const renderRoute = getRenderableRoute(vehicle, routeRenderBounds);
        const { position } = getVehiclePositionAtTime(
          renderRoute,
          elapsedSeconds,
          vehicle.speedMps,
          vehicle.frozenAtSeconds,
          vehicle.routingPlan?.routeStartAtSeconds ?? 0,
        );
        const isParked = isParkedVehicle(vehicle);
        const basePosition = latLngToLngLat(position);
        const parkedPosition = parkedVehicleLayout.get(vehicle.id) ?? basePosition;

        return {
          id: vehicle.id,
          position: isParked ? parkedPosition : basePosition,
          routeStatus: vehicle.routeStatus,
          isParked,
        };
      }),
    [elapsedSeconds, parkedVehicleLayout, routeRenderBounds, world.vehicles],
  );

  const hubData = useMemo((): PointDatum[] =>
      world.pickupHubs.map((hub) => ({
        id: hub.id,
        position: latLngToLngLat(hub.location),
        name: hub.name,
      })),
    [world.pickupHubs],
  );

  const orderPointData = useMemo((): OrderPointDatum[] => {
    const customersById = new globalThis.Map(
      world.customers.map((customer) => [customer.id, customer]),
    );

    return world.orders
      .map((order) => {
        if (!isStripeBackedOrder(order)) {
          return null;
        }

        if (order.status === "pending") {
          return null;
        }

        const customer = customersById.get(order.customerId);
        if (!customer) {
          return null;
        }

        return {
          id: order.id,
          position: latLngToLngLat(customer.location),
          amountLabel: `$${(order.revenueCents / 100).toFixed(0)}`,
          status: getOrderStatus(order.status),
        };
      })
      .filter((order): order is OrderPointDatum => order !== null);
  }, [world.customers, world.orders]);

  const signalLightData = useMemo(
    (): SignalLightDatum[] =>
      signalLights.map((signal) => {
        const projectedPhase = projectSignalPhase(
          signal,
          ambientSnapshotTimeSeconds !== null
            ? Math.max(0, ambientElapsedSeconds - ambientSnapshotTimeSeconds)
            : 0,
        );
        const controlPosition = latLngToLngLat(signal.control_location);
        const displayPosition = latLngToLngLat(signal.location);
        const segment = ambientRouteSegmentCache.get(
          ambientSegmentKey(
            signal.controlled_route_from_waypoint_index,
            signal.controlled_route_to_waypoint_index,
          ),
        );
        const { approachPath, stopLinePath } = buildSignalApproachShape(
          controlPosition,
          segment,
        );

        return {
          id: signal.id,
          position: displayPosition,
          displayPosition,
          controlPosition,
          controlledRouteFromWaypointIndex:
            signal.controlled_route_from_waypoint_index,
          controlledRouteToWaypointIndex:
            signal.controlled_route_to_waypoint_index,
          approachPath,
          stopLinePath,
          phase: projectedPhase,
        };
      }),
    [ambientElapsedSeconds, ambientRouteSegmentCache, ambientSnapshotTimeSeconds, signalLights],
  );

  const ambientVehicleData = useMemo(
    (): AmbientVehicleDatum[] =>
      ambientVehicles.map((vehicle) => {
        const livePosition = resolveAmbientVehiclePosition(
          vehicle,
          ambientSnapshotTimeSeconds !== null
            ? Math.max(0, ambientElapsedSeconds - ambientSnapshotTimeSeconds)
            : 0,
          ambientRouteSegmentCache,
          ambientWaypointCount,
          signalLightData,
        );

        return {
          id: vehicle.id,
          position: livePosition ?? latLngToLngLat(vehicle.position),
          state: vehicle.state,
          heading: vehicle.heading_degrees,
        };
      }),
    [
      ambientRouteSegmentCache,
      ambientElapsedSeconds,
      ambientVehicles,
      signalLightData,
      ambientSnapshotTimeSeconds,
      ambientWaypointCount,
    ],
  );

  const trafficZoneData = useMemo(
    (): TrafficZoneDatum[] =>
      trafficZones.map((zone) => ({
        id: zone.id,
        position: latLngToLngLat(zone.center),
        radiusMeters: zone.radius_meters,
        severity: zone.severity,
      })),
    [trafficZones],
  );

  const layers = useMemo(() => {
    const breakdownPulse = 1 + Math.sin(elapsedSeconds * 5) * 0.16;
    const activeRouteTrips = tripData.filter(
      (trip) => trip.routeStatus !== "completed" && trip.staticPath.length > 1,
    );
    const incidentTrips = activeRouteTrips.filter(
      (trip) => trip.routeStatus === "incident",
    );
    const activeOrders = orderPointData.filter((order) => order.status === "active");

    return [
      new ScatterplotLayer<TrafficZoneDatum>({
        id: "ambient-traffic-zones",
        data: trafficZoneData,
        getPosition: (d) => d.position,
        getFillColor: (d) =>
          d.severity === "high"
            ? [251, 146, 60, 42]
            : d.severity === "medium"
              ? [250, 204, 21, 28]
              : [125, 211, 252, 24],
        getLineColor: (d) =>
          d.severity === "high"
            ? [249, 115, 22, 110]
            : d.severity === "medium"
              ? [234, 179, 8, 90]
              : [14, 165, 233, 75],
        stroked: true,
        filled: true,
        radiusUnits: "meters",
        getRadius: (d) => d.radiusMeters,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        getLineWidth: 2,
      }),

      new PathLayer<TripDatum>({
        id: "route-glow",
        data: activeRouteTrips,
        getPath: (d) => d.staticPath,
        getColor: (d) =>
          d.routeStatus === "incident"
            ? [255, 90, 90, 95]
            : d.routeStatus === "recovery"
              ? [72, 175, 255, 88]
              : [45, 212, 191, 72],
        getWidth: (d) =>
          d.routeStatus === "incident" ? 14 : d.routeStatus === "recovery" ? 12 : 10,
        widthUnits: "pixels",
        widthMinPixels: 8,
        jointRounded: true,
        capRounded: true,
        parameters: { depthCompare: "always" },
      }),

      /* 1. INCIDENT ROUTE GLOW */
      new PathLayer<TripDatum>({
        id: "incident-route-glow",
        data: incidentTrips,
        getPath: (d) => d.staticPath,
        getColor: [239, 68, 68, 118],
        getWidth: 16,
        widthUnits: "pixels",
        widthMinPixels: 14,
        jointRounded: true,
        capRounded: true,
        parameters: { depthCompare: "always" },
      }),

      /* 2. ROUTE RAILS */
      new PathLayer<TripDatum>({
        id: "route-rails",
        data: tripData,
        getPath: (d) => d.staticPath,
        getColor: (d: TripDatum) => ROUTE_BASE_COLORS[d.routeStatus],
        getWidth: (d: TripDatum) =>
          d.routeStatus === "incident" ? 6.5 : d.routeStatus === "recovery" ? 6 : 5,
        widthUnits: "pixels",
        widthMinPixels: 4,
        widthMaxPixels: 7,
        jointRounded: true,
        capRounded: true,
        parameters: { depthCompare: "always" },
      }),

      /* 3. VEHICLE PATH TRAILS */
      new TripsLayer<TripDatum>({
        id: "vehicle-routes",
        data: tripData,
        getPath: (d: TripDatum) => d.staticPath,
        getTimestamps: (d: TripDatum) => d.timestamps,
        getColor: (d: TripDatum) => ROUTE_TRAIL_COLORS[d.routeStatus],
        currentTime: elapsedSeconds,
        trailLength: 180,
        capRounded: true,
        jointRounded: true,
        getWidth: (d: TripDatum) =>
          d.routeStatus === "incident" ? 6 : d.routeStatus === "recovery" ? 5.5 : 4.5,
        widthMinPixels: 2.5,
        widthMaxPixels: 5.5,
        fadeTrail: true,
        parameters: { depthCompare: "always" },
      }),

      /* 4. PICKUP HUBS GLOW & ICON */
      new ScatterplotLayer({
        id: "pickup-hubs-glow",
        data: hubData,
        getPosition: (d: PointDatum) => d.position,
        getFillColor: [245, 158, 11, 45], // Amber glow
        getRadius: 160,
        radiusMinPixels: 18,
        radiusMaxPixels: 26,
      }),
      new IconLayer<PointDatum>({
        id: "pickup-hubs-icons",
        data: hubData,
        getPosition: (d: PointDatum) => d.position,
        getIcon: () => HUB_ICON,
        getSize: 30,
        sizeUnits: "pixels",
        sizeMinPixels: 24,
        sizeMaxPixels: 34,
        billboard: true,
        // Pitched map: without disabling depth test the lower half of the
        // billboard is clipped by the ground plane, leaving a "dome".
        parameters: { depthCompare: "always" },
      }),

      /* 5. CUSTOMER ORDERS GLOW & ICON */
      new ScatterplotLayer({
        id: "order-halos",
        data: activeOrders,
        getPosition: (d: OrderPointDatum) => d.position,
        getFillColor: [14, 165, 233, 42], // Sky blue glow
        getRadius: 140,
        radiusMinPixels: 16,
        radiusMaxPixels: 22,
      }),
      new IconLayer<OrderPointDatum>({
        id: "orders-icons",
        data: orderPointData,
        getPosition: (d: OrderPointDatum) => d.position,
        getIcon: (d: OrderPointDatum) => ORDER_ICONS[d.status],
        getSize: (d: OrderPointDatum) =>
          d.status === "delivered" ? 22 : d.status === "pending" ? 24 : 28,
        sizeUnits: "pixels",
        sizeMinPixels: 18,
        sizeMaxPixels: 30,
        billboard: true,
        parameters: { depthCompare: "always" },
      }),
      new TextLayer({
        id: "order-labels",
        data: activeOrders,
        getPosition: (d: OrderPointDatum) => [d.position[0], d.position[1] + 0.00025], // Offset slightly above
        getText: (d: OrderPointDatum) => d.amountLabel,
        getColor: [255, 255, 255, 255],
        getSize: 10,
        sizeMinPixels: 9,
        sizeMaxPixels: 11,
        getTextAnchor: "middle",
        getAlignmentBaseline: "bottom",
        fontWeight: 800,
        backgroundColor: [15, 23, 42, 180],
        padding: [3, 1],
      }),

      /* 6. DRIVERS GLOW & ICON WITH DIRECTIONAL ROTATION */
      new ScatterplotLayer({
        id: "driver-halos",
        data: driverData,
        getPosition: (d: DriverDatum) => d.position,
        getFillColor: (d: DriverDatum) =>
          d.routeStatus === "incident"
            ? [239, 68, 68, 42]       // Red pulsing glow
            : d.routeStatus === "recovery"
              ? [59, 130, 246, 28]     // Blue glow
              : [16, 185, 129, 20],    // Green glow
        getRadius: (d: DriverDatum) =>
          getVehicleHaloRadius(d.routeStatus, breakdownPulse),
        radiusMinPixels: 12,
        radiusMaxPixels: 20,
      }),
      new IconLayer<DriverDatum>({
        id: "drivers-icons",
        data: driverData,
        getPosition: (d: DriverDatum) => d.position,
        getIcon: (d: DriverDatum) => getVehicleIcon(d.routeStatus),
        getSize: (d: DriverDatum) =>
          d.routeStatus === "incident"
            ? 34 * breakdownPulse
            : d.routeStatus === "recovery"
              ? 32
              : d.isParked
                ? 26
                : 30,
        sizeUnits: "pixels",
        sizeMinPixels: 24,
        sizeMaxPixels: 40,
        billboard: true,
        parameters: { depthCompare: "always" },
      }),
      new ScatterplotLayer<AmbientVehicleDatum>({
        id: "ambient-vehicle-halos",
        data: ambientVehicleData,
        getPosition: (d) => d.position,
        getFillColor: (d) =>
          d.state === "waiting_signal"
            ? [250, 204, 21, 78]
            : d.state === "congested"
              ? [249, 115, 22, 72]
              : [34, 197, 94, 46],
        getRadius: (d) =>
          d.state === "waiting_signal" ? 12 : d.state === "congested" ? 11 : 9,
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 5,
      }),
      new IconLayer<AmbientVehicleDatum>({
        id: "ambient-vehicle-icons",
        data: ambientVehicleData,
        getPosition: (d) => d.position,
        getIcon: (d) => buildAmbientVehicleIcon(d.state),
        getSize: (d) => (d.state === "waiting_signal" ? 12 : 11),
        sizeUnits: "pixels",
        sizeMinPixels: 9,
        sizeMaxPixels: 15,
        getAngle: (d) => d.heading,
        billboard: true,
        parameters: { depthCompare: "always" },
      }),
      new PathLayer<SignalLightDatum>({
        id: "signal-light-approaches",
        data: signalLightData,
        getPath: (d) => d.approachPath,
        getColor: (d) =>
          d.phase === "green"
            ? [34, 197, 94, 210]
            : d.phase === "yellow"
              ? [250, 204, 21, 220]
              : [239, 68, 68, 230],
        getWidth: 5,
        widthUnits: "pixels",
        widthMinPixels: 4,
        widthMaxPixels: 7,
        capRounded: true,
        jointRounded: true,
      }),
      new PathLayer<SignalLightDatum>({
        id: "signal-light-stop-bars",
        data: signalLightData,
        getPath: (d) => d.stopLinePath,
        getColor: (d) =>
          d.phase === "green"
            ? [187, 247, 208, 255]
            : d.phase === "yellow"
              ? [254, 240, 138, 255]
              : [254, 202, 202, 255],
        getWidth: 7,
        widthUnits: "pixels",
        widthMinPixels: 5,
        widthMaxPixels: 8,
        capRounded: true,
      }),
      new IconLayer<SignalLightDatum>({
        id: "signal-light-icons",
        data: signalLightData,
        getPosition: (d) => d.position,
        getIcon: (d) => buildSignalIcon(d.phase),
        getSize: 28,
        sizeUnits: "pixels",
        sizeMinPixels: 22,
        sizeMaxPixels: 34,
        billboard: true,
        parameters: { depthCompare: "always" },
      }),
    ];
  }, [
    tripData,
    hubData,
    orderPointData,
    driverData,
    ambientVehicleData,
    trafficZoneData,
    signalLightData,
    elapsedSeconds,
  ]);

  const handleMapLoad = (event: MapLibreEvent) => {
    add3DBuildingsIfNeeded(event);
  };

  return (
    <MapView
      mapStyle={getMapStyleUrl()}
      initialViewState={{
        longitude: mapView?.longitude ?? MAP_CENTER[0] - 0.0015,
        latitude: mapView?.latitude ?? MAP_CENTER[1] + 0.0005,
        zoom: mapView?.zoom ?? DEFAULT_MAP_ZOOM + 0.4,
        pitch: mapView?.pitch ?? 50,
        bearing: mapView?.bearing ?? -10,
      }}
      style={{ width: "100%", height: "100%" }}
      attributionControl
      antialias
      onLoad={handleMapLoad}
      onStyleData={handleMapLoad}
      maxPitch={70}
    >
      <DeckGLOverlay layers={layers} interleaved={false} />
    </MapView>
  );
}
