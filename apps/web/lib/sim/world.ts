import { createRng } from "@/lib/prng";
import { getVehiclePositionAtTime, latLngToLngLat } from "./movement";
import type {
  CustomerLocation,
  Driver,
  Incident,
  LngLat,
  Order,
  PickupHub,
  SimulationWorld,
  Vehicle,
} from "./types";

export const DEFAULT_SIMULATION_SEED = 42;
export const BREAKDOWN_VEHICLE_ID = "vehicle-3";
const DEFAULT_SPEED_MPS = 10;
// A small congestion patch on the South-hub → Folsom Street Drop corridor, on a
// segment that OSRM can cleanly detour around one block (verified: avoiding it
// costs ~0 extra distance). Aligned with the visible "soma-core-gridlock" zone
// (center 37.78502, -122.40048).
export const CONGESTION_AREA = {
  minLat: 37.78457,
  maxLat: 37.78547,
  minLng: -122.40098,
  maxLng: -122.39998,
};
const MIN_CONGESTION_EXPOSURE_METERS = 60;

/** Financial District / SoMa demo — compact on-street delivery zone (~3 km). */

/** Fixed hub anchors on land (west of Embarcadero, north/south of center). */
const HUB_LOCATIONS: Record<string, { lat: number; lng: number }> = {
  "hub-north": { lat: 37.789, lng: -122.4015 },
  "hub-south": { lat: 37.7815, lng: -122.3995 },
};

/**
 * On-street waypoints in FiDi / SoMa / Transbay / Rincon Hill (all on land).
 * Seeded shuffle picks 10 for customers — same seed => same picks.
 */
const CUSTOMER_WAYPOINTS: ReadonlyArray<{ lat: number; lng: number }> = [
  { lat: 37.7905, lng: -122.3968 },
  { lat: 37.7888, lng: -122.402 },
  { lat: 37.7875, lng: -122.4045 },
  { lat: 37.786, lng: -122.403 },
  { lat: 37.7845, lng: -122.401 },
  { lat: 37.783, lng: -122.3985 },
  { lat: 37.7815, lng: -122.4025 },
  { lat: 37.7805, lng: -122.3995 },
  { lat: 37.7895, lng: -122.399 },
  { lat: 37.787, lng: -122.3975 },
  { lat: 37.7855, lng: -122.405 },
  { lat: 37.7825, lng: -122.396 },
  { lat: 37.791, lng: -122.4035 },
  { lat: 37.784, lng: -122.404 },
];

const ROUTE_JITTER_LNG = 0.0015;
const ROUTE_JITTER_LAT = 0.0012;

function buildParkedRoutingPlan(
  point: LngLat,
  provider: "seed" | "osrm" | "cuopt-osrm" = "seed",
) {
  return {
    provider,
    assignedOrderIds: [],
    totalDistanceMeters: 0,
    totalDurationSeconds: 0,
    orderedStops: [
      {
        id: "parked-start",
        kind: "start" as const,
        orderId: null,
        etaSeconds: 0,
        location: { lng: point[0], lat: point[1] },
      },
    ],
  };
}

export function getSimulationSeed(): number {
  const raw = process.env.NEXT_PUBLIC_SIMULATION_SEED;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_SIMULATION_SEED;
}

function shuffleIndices(length: number, rng: () => number): number[] {
  const indices = Array.from({ length }, (_, index) => index);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function createPickupHubs(): PickupHub[] {
  return [
    {
      id: "hub-north",
      name: "North Pickup Hub",
      location: HUB_LOCATIONS["hub-north"],
    },
    {
      id: "hub-south",
      name: "South Pickup Hub",
      location: HUB_LOCATIONS["hub-south"],
    },
  ];
}

function createCustomers(rng: () => number): CustomerLocation[] {
  const shuffled = shuffleIndices(CUSTOMER_WAYPOINTS.length, rng);
  return shuffled.slice(0, 10).map((waypointIndex, index) => ({
    id: `customer-${index + 1}`,
    name: `Customer ${index + 1}`,
    location: CUSTOMER_WAYPOINTS[waypointIndex],
  }));
}

function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Build a smooth polyline through ordered stops with intermediate corners. */
function buildRouteThroughStops(stops: LngLat[]): LngLat[] {
  if (stops.length === 0) {
    return [];
  }

  const route: LngLat[] = [stops[0]];

  for (let i = 1; i < stops.length; i += 1) {
    const from = stops[i - 1];
    const to = stops[i];
    route.push(lerpLngLat(from, to, 0.33));
    route.push(lerpLngLat(from, to, 0.66));
    route.push(to);
  }

  return route;
}

function toLngLat(point: { lat: number; lng: number }): LngLat {
  return [point.lng, point.lat];
}

function assignRoutes(
  hubs: PickupHub[],
  customers: CustomerLocation[],
  rng: () => number,
): Vehicle[] {
  const hubLngLats = hubs.map((hub) => toLngLat(hub.location));
  const customerLngLats = customers.map((customer) =>
    toLngLat(customer.location),
  );

  const vehicles: Vehicle[] = [];

  for (let i = 0; i < 8; i += 1) {
    const hub = hubLngLats[i % hubLngLats.length];
    const customerA = customerLngLats[(i * 2) % customerLngLats.length];
    const customerB = customerLngLats[(i * 2 + 3) % customerLngLats.length];
    const customerC = customerLngLats[(i * 2 + 7) % customerLngLats.length];

    const jitter: LngLat = [
      hub[0] + (rng() - 0.5) * 2 * ROUTE_JITTER_LNG,
      hub[1] + (rng() - 0.5) * 2 * ROUTE_JITTER_LAT,
    ];

    const route = buildRouteThroughStops([
      hub,
      jitter,
      customerA,
      customerB,
      hub,
      customerC,
    ]);

    vehicles.push({
      id: `vehicle-${i + 1}`,
      driverId: `driver-${i + 1}`,
      route,
      routeStatus: "normal",
      status: "en_route",
      speedMps: DEFAULT_SPEED_MPS,
      routingProvider: "seed",
      routingPlan: null,
      frozenAtSeconds: null,
    });
  }

  return vehicles;
}

function createDrivers(vehicles: Vehicle[]): Driver[] {
  const names = [
    "Alex",
    "Jordan",
    "Sam",
    "Taylor",
    "Casey",
    "Morgan",
    "Riley",
    "Quinn",
  ];

  return vehicles.map((vehicle, index) => ({
    id: `driver-${index + 1}`,
    name: names[index],
    vehicleId: vehicle.id,
  }));
}

function createIdleVehicles(hubs: PickupHub[]): Vehicle[] {
  const hubLngLats = hubs.map((hub) => toLngLat(hub.location));

  return Array.from({ length: 8 }, (_, index) => {
    const start = hubLngLats[index % hubLngLats.length] as LngLat;

    return {
      id: `vehicle-${index + 1}`,
      driverId: `driver-${index + 1}`,
      route: [start],
      routeStatus: "normal",
      status: "idle",
      speedMps: DEFAULT_SPEED_MPS,
      routingProvider: "seed",
      routingPlan: buildParkedRoutingPlan(start),
      frozenAtSeconds: null,
    };
  });
}

export function createWorld(seed: number = getSimulationSeed()): SimulationWorld {
  const rng = createRng(seed);
  const pickupHubs = createPickupHubs();
  const customers = createCustomers(rng);
  const vehicles = createIdleVehicles(pickupHubs);
  const drivers = createDrivers(vehicles);

  return {
    seed,
    breakdownVehicleId: BREAKDOWN_VEHICLE_ID,
    drivers,
    vehicles,
    pickupHubs,
    customers,
    orders: [],
    incidents: [],
  };
}

export function createDemoWorld(
  seed: number = getSimulationSeed(),
): SimulationWorld {
  return createWorld(seed);
}

export function resetWorld(world: SimulationWorld): SimulationWorld {
  return createWorld(world.seed);
}

/** Unique per breakdown event — never derived from seed or incident count. */
export function createIncidentId(): string {
  return crypto.randomUUID();
}

export function isDispatchableOrderForVehicle(
  order: Order,
  vehicleId: string,
): boolean {
  return (
    order.vehicleId === vehicleId &&
    (order.status === "assigned" || order.status === "in_transit")
  );
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

export function getActiveDeliveryRoute(vehicle: Vehicle): LngLat[] {
  const orderedStops = vehicle.routingPlan?.orderedStops ?? [];
  const lastOrderStop = [...orderedStops]
    .reverse()
    .find((stop) => stop.kind === "order");

  if (!lastOrderStop) {
    return vehicle.route;
  }

  const lastOrderPoint: LngLat = [
    lastOrderStop.location.lng,
    lastOrderStop.location.lat,
  ];
  let bestIndex = vehicle.route.length - 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < vehicle.route.length; index += 1) {
    const point = vehicle.route[index]!;
    const distance = haversineMeters(point, lastOrderPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return vehicle.route.slice(0, bestIndex + 1);
}

export function routePassesThroughCongestionArea(route: LngLat[]): boolean {
  return route.some(
    ([lng, lat]) =>
      lat >= CONGESTION_AREA.minLat &&
      lat <= CONGESTION_AREA.maxLat &&
      lng >= CONGESTION_AREA.minLng &&
      lng <= CONGESTION_AREA.maxLng,
  );
}

function isLocationInCongestionArea(location: { lat: number; lng: number }): boolean {
  return (
    location.lat >= CONGESTION_AREA.minLat &&
    location.lat <= CONGESTION_AREA.maxLat &&
    location.lng >= CONGESTION_AREA.minLng &&
    location.lng <= CONGESTION_AREA.maxLng
  );
}

function isPointInCongestionArea([lng, lat]: LngLat): boolean {
  return (
    lat >= CONGESTION_AREA.minLat &&
    lat <= CONGESTION_AREA.maxLat &&
    lng >= CONGESTION_AREA.minLng &&
    lng <= CONGESTION_AREA.maxLng
  );
}

function getVehicleRemainingRoute(
  vehicle: Vehicle,
  elapsedSeconds: number,
): LngLat[] {
  if (vehicle.route.length <= 1) {
    return vehicle.route;
  }

  const routeStartAtSeconds = vehicle.routingPlan?.routeStartAtSeconds ?? 0;
  const sampled = getVehiclePositionAtTime(
    vehicle.route,
    elapsedSeconds,
    vehicle.speedMps,
    vehicle.frozenAtSeconds,
    routeStartAtSeconds,
  );
  const currentPosition = latLngToLngLat(sampled.position);
  const nextSegmentStart = Math.min(
    vehicle.route.length - 1,
    sampled.segmentIndex + 1,
  );

  return [currentPosition, ...vehicle.route.slice(nextSegmentStart)];
}

function routeDistanceInsideCongestionArea(route: LngLat[]): number {
  if (route.length < 2) {
    return 0;
  }

  let totalMeters = 0;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1]!;
    const end = route[index]!;
    const midpoint: LngLat = [
      (start[0] + end[0]) / 2,
      (start[1] + end[1]) / 2,
    ];
    if (!isPointInCongestionArea(midpoint)) {
      continue;
    }

    totalMeters += haversineMeters(start, end);
  }

  return totalMeters;
}

export function getRemainingCongestionExposureMeters(
  vehicle: Vehicle,
  elapsedSeconds: number,
): number {
  return routeDistanceInsideCongestionArea(
    getVehicleRemainingRoute(vehicle, elapsedSeconds),
  );
}

export function findCongestionVehicleId(
  world: SimulationWorld,
  elapsedSeconds = 0,
): string | null {
  const customerById = new Map(
    world.customers.map((customer) => [customer.id, customer]),
  );
  const candidates = world.vehicles.filter((vehicle) => {
    if (
      vehicle.status === "incident" ||
      getRemainingCongestionExposureMeters(vehicle, elapsedSeconds) <
        MIN_CONGESTION_EXPOSURE_METERS
    ) {
      return false;
    }

    const dispatchableOrders = world.orders.filter((order) =>
      isDispatchableOrderForVehicle(order, vehicle.id),
    );
    if (dispatchableOrders.length === 0) {
      return false;
    }

    return dispatchableOrders.every((order) => {
      const customer = customerById.get(order.customerId);
      return customer ? !isLocationInCongestionArea(customer.location) : false;
    });
  });

  const candidate = candidates[0];

  return candidate?.id ?? null;
}

export function triggerBreakdown(
  world: SimulationWorld,
  elapsedSeconds: number,
  vehicleId: string = world.breakdownVehicleId,
): SimulationWorld {
  const target = world.vehicles.find((v) => v.id === vehicleId);
  if (!target || target.status === "incident") {
    return world;
  }

  const orderIds = world.orders
    .filter(
      (order) =>
        isDispatchableOrderForVehicle(order, vehicleId),
    )
    .map((order) => order.id);
  if (orderIds.length === 0) {
    return world;
  }

  const incident: Incident = {
    id: createIncidentId(),
    type: "vehicle_breakdown",
    vehicleId,
    orderIds,
    createdAtSimSeconds: elapsedSeconds,
  };

  return {
    ...world,
    vehicles: world.vehicles.map((vehicle) =>
      vehicle.id === vehicleId
        ? {
            ...vehicle,
            status: "incident",
            routeStatus: "incident",
            frozenAtSeconds: elapsedSeconds,
          }
        : vehicle,
    ),
    incidents: [...world.incidents, incident],
  };
}

export function hasActiveBreakdown(world: SimulationWorld): boolean {
  return world.incidents.some(
    (incident) => incident.type === "vehicle_breakdown",
  );
}

export function triggerCongestion(
  world: SimulationWorld,
  elapsedSeconds: number,
  vehicleId?: string,
  options?: { bypassExposureGate?: boolean },
): SimulationWorld {
  const congestionVehicleId =
    vehicleId ??
    findCongestionVehicleId(world, elapsedSeconds);
  if (!congestionVehicleId) {
    return world;
  }

  const target = world.vehicles.find((vehicle) => vehicle.id === congestionVehicleId);
  if (!target || target.status === "incident") {
    return world;
  }

  const orderIds = world.orders
    .filter((order) => isDispatchableOrderForVehicle(order, congestionVehicleId))
    .map((order) => order.id);
  if (orderIds.length === 0) {
    return world;
  }
  if (hasActiveCongestionForOrders(world, orderIds)) {
    return world;
  }
  // The exposure gate keeps auto-picked congestion realistic, but a user who
  // explicitly selects a vehicle and clicks "Trigger Congestion" should always
  // get an incident even if their route doesn't happen to cross the fixed zone.
  if (
    !options?.bypassExposureGate &&
    getRemainingCongestionExposureMeters(target, elapsedSeconds) <
      MIN_CONGESTION_EXPOSURE_METERS
  ) {
    return world;
  }

  const incident: Incident = {
    id: createIncidentId(),
    type: "congestion",
    vehicleId: congestionVehicleId,
    orderIds,
    createdAtSimSeconds: elapsedSeconds,
  };

  return {
    ...world,
    vehicles: world.vehicles.map((vehicle) =>
      vehicle.id === congestionVehicleId
        ? {
            ...vehicle,
            routeStatus: "at_risk",
            status: "incident",
            frozenAtSeconds: elapsedSeconds,
          }
        : vehicle,
    ),
    incidents: [...world.incidents, incident],
  };
}

export function hasActiveCongestion(
  world: SimulationWorld,
  vehicleId?: string,
): boolean {
  return world.incidents.some(
    (incident) =>
      incident.type === "congestion" &&
      (vehicleId ? incident.vehicleId === vehicleId : true),
  );
}

export function hasActiveCongestionForOrders(
  world: SimulationWorld,
  orderIds: string[],
): boolean {
  if (orderIds.length === 0) {
    return false;
  }

  const targetOrderIds = new Set(orderIds);
  return world.incidents.some(
    (incident) =>
      incident.type === "congestion" &&
      incident.orderIds.some((orderId) => targetOrderIds.has(orderId)),
  );
}

export function triggerPaymentDeclined(
  world: SimulationWorld,
  elapsedSeconds: number,
  orderId: string,
): SimulationWorld {
  const order = world.orders.find((candidate) => candidate.id === orderId);
  if (!order || order.status !== "pending") {
    return world;
  }

  const alreadyActive = world.incidents.some(
    (incident) =>
      incident.type === "payment_declined" &&
      incident.orderIds.includes(orderId),
  );
  if (alreadyActive) {
    return world;
  }

  const incident: Incident = {
    id: createIncidentId(),
    type: "payment_declined",
    vehicleId: null,
    orderIds: [orderId],
    createdAtSimSeconds: elapsedSeconds,
  };

  return {
    ...world,
    incidents: [...world.incidents, incident],
  };
}

export function hasActivePaymentDeclined(
  world: SimulationWorld,
  orderId?: string,
): boolean {
  return world.incidents.some(
    (incident) =>
      incident.type === "payment_declined" &&
      (orderId ? incident.orderIds.includes(orderId) : true),
  );
}
