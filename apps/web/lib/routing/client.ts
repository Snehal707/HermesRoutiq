import type {
  LngLat,
  RoutingProviderName,
  SimulationWorld,
  VehicleRoutingPlan,
  VehicleRoutingPlanStop,
} from "@/lib/sim/types";

interface RoutingLocation {
  lat: number;
  lng: number;
}

export interface RoutingAvoidArea {
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
}

interface RoutingDriverInput {
  id: string;
  name: string;
  vehicle_id: string;
  start_location: RoutingLocation;
  end_location: RoutingLocation;
  capacity: number;
  current_load: number;
  time_window: {
    start: number;
    end: number;
  };
}

interface RoutingOrderInput {
  id: string;
  location: RoutingLocation;
  demand: number;
  service_time_seconds: number;
  assigned_driver_id: string | null;
  sequence: number;
}

interface RoutingDriverRoute {
  driver_id: string;
  vehicle_id?: string | null;
  ordered_stops: Array<{
    id: string;
    kind: "start" | "order" | "end";
    location: RoutingLocation;
    eta_seconds: number;
    order_id?: string | null;
  }>;
  geometry: number[][];
  distance_meters: number;
  duration_seconds: number;
}

interface RoutingResponse {
  provider: RoutingProviderName;
  assignments: Array<{
    order_id: string;
    driver_id: string;
  }>;
  unassigned_order_ids: string[];
  routes: RoutingDriverRoute[];
}

export interface RoutedSimulationWorld {
  world: SimulationWorld;
  provider: RoutingProviderName;
  routeCount: number;
}

export interface SolvedOrderRoute {
  vehicleId: string;
  driverId: string;
  routeStatus: SimulationWorld["vehicles"][number]["routeStatus"];
  route: LngLat[];
  routingPlan: VehicleRoutingPlan;
}

export interface SolvedOrdersWorld {
  provider: RoutingProviderName;
  routeCount: number;
  unassignedOrderIds: string[];
  assignments: Array<{
    orderId: string;
    driverId: string;
    vehicleId: string;
  }>;
  routes: SolvedOrderRoute[];
}

interface SolveDbOrdersWorldOptions {
  vehicleIds?: string[];
  orderIds?: string[];
  avoidAreas?: RoutingAvoidArea[];
}

function getRoutingServiceUrl(): string {
  return process.env.ROUTING_SERVICE_URL?.trim() || "http://127.0.0.1:8001";
}

function lngLatToLocation([lng, lat]: LngLat): RoutingLocation {
  return { lat, lng };
}

function locationToLngLat(location: RoutingLocation): LngLat {
  return [location.lng, location.lat];
}

function haversineMeters(a: LngLat, b: LngLat): number {
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

function dedupeConsecutivePoints(points: LngLat[]): LngLat[] {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }

    const previous = points[index - 1];
    return previous[0] !== point[0] || previous[1] !== point[1];
  });
}

function buildFallbackGeometryFromStops(
  orderedStops: RoutingDriverRoute["ordered_stops"],
): LngLat[] {
  return dedupeConsecutivePoints(
    orderedStops.map((stop) => locationToLngLat(stop.location)),
  );
}

// Mirrors OsrmRoutingProvider.IMPOSSIBLE_JUMP_METERS: gaps larger than this are a
// routing artefact (freeway/bridge detour), not real road geometry. Legitimate SF
// block-length straight segments reach ~250m, so 300m accepts those while still
// rejecting the multi-kilometre detour gaps.
const IMPOSSIBLE_JUMP_METERS = 300;

function hasImpossibleGeometryJump(geometry: LngLat[]): boolean {
  for (let index = 1; index < geometry.length; index += 1) {
    if (haversineMeters(geometry[index - 1] as LngLat, geometry[index] as LngLat) > IMPOSSIBLE_JUMP_METERS) {
      return true;
    }
  }

  return false;
}

function sanitizeRouteGeometry(
  geometry: number[][],
  orderedStops: RoutingDriverRoute["ordered_stops"],
): { route: LngLat[]; geometryMode: "road" | "fallback" } {
  const normalized = dedupeConsecutivePoints(
    geometry
      .filter(
        (point): point is LngLat =>
          Array.isArray(point) &&
          point.length >= 2 &&
          typeof point[0] === "number" &&
          typeof point[1] === "number",
      )
      .map((point) => [point[0], point[1]] as LngLat),
  );

  if (normalized.length < 2 || hasImpossibleGeometryJump(normalized)) {
    return {
      route: buildFallbackGeometryFromStops(orderedStops),
      geometryMode: "fallback",
    };
  }

  return {
    route: normalized,
    geometryMode: "road",
  };
}

function extractRouteStops(route: LngLat[]): LngLat[] {
  if (route.length <= 2) {
    return route;
  }

  const stops: LngLat[] = [];
  for (let index = 0; index < route.length; index += 3) {
    stops.push(route[index] as LngLat);
  }

  const last = route[route.length - 1] as LngLat;
  const currentLast = stops[stops.length - 1];
  if (!currentLast || currentLast[0] !== last[0] || currentLast[1] !== last[1]) {
    stops.push(last);
  }

  return stops;
}

const DEPOT_LOCATION_EPSILON = 1e-5;

function isSameLocationWithinEpsilon(
  left: LngLat,
  right: LngLat,
  epsilon: number = DEPOT_LOCATION_EPSILON,
): boolean {
  return (
    Math.abs(left[0] - right[0]) <= epsilon &&
    Math.abs(left[1] - right[1]) <= epsilon
  );
}

function buildWorldRoutingRequest(
  world: SimulationWorld,
  provider: RoutingProviderName,
): {
  provider: RoutingProviderName;
  drivers: RoutingDriverInput[];
  orders: RoutingOrderInput[];
} {
  const depotLocations = world.pickupHubs.map(
    (hub) => [hub.location.lng, hub.location.lat] as LngLat,
  );

  const drivers = world.vehicles.map((vehicle) => {
    const plannedEndpoints =
      vehicle.routingPlan && vehicle.routingPlan.orderedStops.length >= 2
        ? [
          [
            vehicle.routingPlan.orderedStops[0].location.lng,
            vehicle.routingPlan.orderedStops[0].location.lat,
          ] as LngLat,
          [
            vehicle.routingPlan.orderedStops[vehicle.routingPlan.orderedStops.length - 1]
              .location.lng,
            vehicle.routingPlan.orderedStops[vehicle.routingPlan.orderedStops.length - 1]
              .location.lat,
          ] as LngLat,
        ]
        : null;
    const stops = plannedEndpoints ?? extractRouteStops(vehicle.route);
    const start = stops[0] ?? vehicle.route[0];

    return {
      id: vehicle.driverId,
      name: vehicle.driverId,
      vehicle_id: vehicle.id,
      start_location: lngLatToLocation(start),
      end_location: lngLatToLocation(start),
      capacity: 4,
      current_load: 0,
      time_window: {
        start: 0,
        end: 86_400,
      },
    };
  });

  const orders = world.vehicles.flatMap((vehicle) => {
    const stops = extractRouteStops(vehicle.route);
    const nonDepotStops = stops.filter(
      (stop) =>
        !depotLocations.some((depotLocation) =>
          isSameLocationWithinEpsilon(stop, depotLocation),
        ),
    );

    return nonDepotStops.map((stop, index) => ({
      id: `${vehicle.id}-stop-${index + 1}`,
      location: lngLatToLocation(stop),
      demand: 1,
      service_time_seconds: 0,
      assigned_driver_id: vehicle.driverId,
      sequence: index,
    }));
  });

  return { provider, drivers, orders };
}

const ACTIVE_ORDER_STATUSES = new Set<SimulationWorld["orders"][number]["status"]>([
  "paid",
  "assigned",
  "in_transit",
]);

function buildDbOrderRoutingRequest(
  world: SimulationWorld,
  provider: RoutingProviderName,
  options: SolveDbOrdersWorldOptions = {},
): {
  provider: RoutingProviderName;
  drivers: RoutingDriverInput[];
  orders: RoutingOrderInput[];
  avoid_areas?: RoutingAvoidArea[];
} {
  const includedVehicleIds = options.vehicleIds
    ? new Set(options.vehicleIds)
    : null;
  const includedOrderIds = options.orderIds ? new Set(options.orderIds) : null;
  const customersById = new Map(
    world.customers.map((customer) => [customer.id, customer]),
  );

  const drivers = world.vehicles.flatMap((vehicle) => {
    if (includedVehicleIds && !includedVehicleIds.has(vehicle.id)) {
      return [];
    }

    const stops = vehicle.routingPlan?.orderedStops.length
      ? vehicle.routingPlan.orderedStops
      : extractRouteStops(vehicle.route).map((stop, index, array) => ({
          id: `${vehicle.id}:${index}`,
          kind:
            index === 0 ? "start" : index === array.length - 1 ? "end" : "order",
          orderId:
            index === 0 || index === array.length - 1
              ? null
              : `${vehicle.id}-stop-${index}`,
          etaSeconds: 0,
          location: lngLatToLocation(stop),
        }));

    const start = stops[0]?.location ?? lngLatToLocation(vehicle.route[0] as LngLat);

    return [{
      id: vehicle.driverId,
      name: vehicle.driverId,
      vehicle_id: vehicle.id,
      start_location: start,
      end_location: start,
      capacity: 4,
      current_load: 0,
      time_window: {
        start: 0,
        end: 86_400,
      },
    }];
  });

  const orders = world.orders.flatMap((order, index) => {
    if (!ACTIVE_ORDER_STATUSES.has(order.status)) {
      return [];
    }
    if (includedOrderIds && !includedOrderIds.has(order.id)) {
      return [];
    }

    const customer = customersById.get(order.customerId);
    if (!customer) {
      return [];
    }

    return [{
      id: order.id,
      location: customer.location,
      demand: 1,
      service_time_seconds: 0,
      assigned_driver_id: null,
      sequence: index,
    }];
  });

  return {
    provider,
    drivers,
    orders,
    ...(options.avoidAreas?.length
      ? { avoid_areas: options.avoidAreas }
      : {}),
  };
}

function toVehicleRoutingPlanStop(
  stop: RoutingDriverRoute["ordered_stops"][number],
): VehicleRoutingPlanStop {
  return {
    id: stop.id,
    kind: stop.kind,
    location: {
      lat: stop.location.lat,
      lng: stop.location.lng,
    },
    etaSeconds: stop.eta_seconds,
    orderId: stop.order_id ?? null,
  };
}

export async function routeSimulationWorld(
  world: SimulationWorld,
  provider: RoutingProviderName = "cuopt-osrm",
): Promise<RoutedSimulationWorld> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(`${getRoutingServiceUrl()}/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildWorldRoutingRequest(world, provider)),
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = (await response.json()) as RoutingResponse & {
      detail?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(
        payload.detail ??
          payload.error ??
          `Routing service request failed with status ${response.status}`,
      );
    }

    const routesByVehicleId = new Map(
      payload.routes
        .filter((route): route is RoutingDriverRoute & { vehicle_id: string } =>
          typeof route.vehicle_id === "string" && route.vehicle_id.length > 0,
        )
        .map((route) => [route.vehicle_id, route]),
    );

    return {
      provider: payload.provider,
      routeCount: payload.routes.length,
      world: {
        ...world,
        vehicles: world.vehicles.map((vehicle) => {
          const route = routesByVehicleId.get(vehicle.id);
          if (!route) {
            return {
              ...vehicle,
              routingProvider: payload.provider,
            };
          }

          const orderedStops = route.ordered_stops.map(toVehicleRoutingPlanStop);
          const sanitized = sanitizeRouteGeometry(
            route.geometry,
            route.ordered_stops,
          );
          const routingPlan: VehicleRoutingPlan = {
            provider: payload.provider,
            orderedStops,
            assignedOrderIds: orderedStops
              .map((stop) => stop.orderId)
              .filter((orderId): orderId is string => orderId !== null),
            totalDistanceMeters: route.distance_meters,
            totalDurationSeconds: route.duration_seconds,
            geometryMode: sanitized.geometryMode,
          };

          return {
            ...vehicle,
            route: sanitized.route,
            routingProvider: payload.provider,
            routingPlan,
          };
        }),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function solveDbOrdersWorld(
  world: SimulationWorld,
  provider: RoutingProviderName = "cuopt-osrm",
  options: SolveDbOrdersWorldOptions = {},
): Promise<SolvedOrdersWorld> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(`${getRoutingServiceUrl()}/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildDbOrderRoutingRequest(world, provider, options)),
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = (await response.json()) as RoutingResponse & {
      detail?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(
        payload.detail ??
          payload.error ??
          `Routing service request failed with status ${response.status}`,
      );
    }

    const vehicleIdByDriverId = new Map(
      world.vehicles.map((vehicle) => [vehicle.driverId, vehicle.id]),
    );
    const routeStatusByVehicleId = new Map(
      world.vehicles.map((vehicle) => [vehicle.id, vehicle.routeStatus]),
    );

    return {
      provider: payload.provider,
      routeCount: payload.routes.length,
      unassignedOrderIds: payload.unassigned_order_ids,
      assignments: payload.assignments.flatMap((assignment) => {
        const vehicleId = vehicleIdByDriverId.get(assignment.driver_id);
        if (!vehicleId) {
          return [];
        }

        return [{
          orderId: assignment.order_id,
          driverId: assignment.driver_id,
          vehicleId,
        }];
      }),
      routes: payload.routes
        .filter((route): route is RoutingDriverRoute & { vehicle_id: string } =>
          typeof route.vehicle_id === "string" && route.vehicle_id.length > 0,
        )
        .map((route) => {
          const orderedStops = route.ordered_stops.map(toVehicleRoutingPlanStop);
          const sanitized = sanitizeRouteGeometry(
            route.geometry,
            route.ordered_stops,
          );
          const routingPlan: VehicleRoutingPlan = {
            provider: payload.provider,
            orderedStops,
            assignedOrderIds: orderedStops
              .map((stop) => stop.orderId)
              .filter((orderId): orderId is string => orderId !== null),
            totalDistanceMeters: route.distance_meters,
            totalDurationSeconds: route.duration_seconds,
            geometryMode: sanitized.geometryMode,
          };

          return {
            vehicleId: route.vehicle_id,
            driverId: route.driver_id,
            routeStatus:
              routeStatusByVehicleId.get(route.vehicle_id) ?? "normal",
            route: sanitized.route,
            routingPlan,
          };
        }),
    };
  } finally {
    clearTimeout(timeout);
  }
}
