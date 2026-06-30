import "server-only";

import type { LngLat } from "../sim/types";
import type { SolvedOrderRoute, SolvedOrdersWorld } from "./client";
import { solveDbOrdersWorld } from "./client";
import {
  loadTickFromRedis,
  loadWorldFromPostgres,
  persistSolvedFleetStateSubset,
} from "../sim/persistence";
import {
  CONGESTION_AREA,
  getRemainingCongestionExposureMeters,
  isDispatchableOrderForVehicle,
} from "../sim/world";

function routesDiffer(
  beforeRoute: Array<[number, number]>,
  afterRoute: Array<[number, number]>,
): boolean {
  if (beforeRoute.length !== afterRoute.length) {
    return true;
  }

  return beforeRoute.some(
    (point, index) =>
      point[0] !== afterRoute[index]?.[0] || point[1] !== afterRoute[index]?.[1],
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

function trimRouteToLastOrderStop(route: SolvedOrderRoute): SolvedOrderRoute {
  const lastOrderStopIndex = [...route.routingPlan.orderedStops]
    .reverse()
    .findIndex((stop) => stop.kind === "order");
  if (lastOrderStopIndex === -1) {
    return route;
  }

  const absoluteLastOrderIndex =
    route.routingPlan.orderedStops.length - 1 - lastOrderStopIndex;
  const lastOrderStop = route.routingPlan.orderedStops[absoluteLastOrderIndex]!;
  const lastOrderPoint: LngLat = [
    lastOrderStop.location.lng,
    lastOrderStop.location.lat,
  ];

  let bestIndex = route.route.length - 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.route.length; index += 1) {
    const point = route.route[index]!;
    const distance = haversineMeters(point, lastOrderPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  const trimmedGeometry = route.route.slice(0, bestIndex + 1);
  const trimmedStops = route.routingPlan.orderedStops.slice(
    0,
    absoluteLastOrderIndex + 1,
  );
  const trimmedDistance = trimmedGeometry.reduce((total, point, index) => {
    if (index === 0) {
      return total;
    }
    return total + haversineMeters(trimmedGeometry[index - 1]!, point);
  }, 0);

  return {
    ...route,
    route: trimmedGeometry,
    routingPlan: {
      ...route.routingPlan,
      orderedStops: trimmedStops,
      assignedOrderIds: trimmedStops
        .map((stop) => stop.orderId)
        .filter((orderId): orderId is string => orderId !== null),
      totalDistanceMeters: trimmedDistance,
      totalDurationSeconds: lastOrderStop.etaSeconds,
    },
  };
}

export async function executeCongestionReroute(params: {
  incidentId: string;
}): Promise<{
  incidentId: string;
  vehicleId: string;
  orderIds: string[];
  provider: string;
  beforeRoute: Array<[number, number]>;
  afterRoute: Array<[number, number]>;
  beforeIntersectsCongestion: boolean;
  afterIntersectsCongestion: boolean;
  routeChanged: boolean;
  routeCount: number;
  orderAssignmentCount: number;
  untouchedVehicleIds: string[];
  beforeCongestionMeters: number;
  afterCongestionMeters: number;
}> {
  const [world, tick] = await Promise.all([
    loadWorldFromPostgres(),
    loadTickFromRedis(),
  ]);
  const incident = world.incidents.find(
    (candidate) => candidate.id === params.incidentId,
  );

  if (!incident) {
    throw new Error(`Incident not found: ${params.incidentId}`);
  }
  if (incident.type !== "congestion") {
    throw new Error(
      `Incident ${params.incidentId} is ${incident.type}, not congestion.`,
    );
  }
  const affectedVehicleId = incident.vehicleId;
  if (!affectedVehicleId) {
    throw new Error(
      `Congestion incident ${params.incidentId} is missing its affected vehicle.`,
    );
  }

  const affectedVehicle = world.vehicles.find(
    (vehicle) => vehicle.id === affectedVehicleId,
  );
  if (!affectedVehicle) {
    throw new Error(`Affected vehicle not found: ${affectedVehicleId}`);
  }

  const orderIds = world.orders
    .filter(
      (order) =>
        incident.orderIds.includes(order.id) &&
        isDispatchableOrderForVehicle(order, affectedVehicleId),
    )
    .map((order) => order.id);

  if (orderIds.length === 0) {
    throw new Error(
      `Congestion incident ${params.incidentId} has no dispatchable orders to reroute.`,
    );
  }

  const beforeRoute = affectedVehicle.route;
  const beforeCongestionMeters = getRemainingCongestionExposureMeters(
    affectedVehicle,
    tick.elapsedSeconds,
  );
  const beforeIntersectsCongestion = beforeCongestionMeters > 0;
  const solved = await solveDbOrdersWorld(world, "cuopt-osrm", {
    vehicleIds: [affectedVehicleId],
    orderIds,
    avoidAreas: [
      {
        min_lat: CONGESTION_AREA.minLat,
        max_lat: CONGESTION_AREA.maxLat,
        min_lng: CONGESTION_AREA.minLng,
        max_lng: CONGESTION_AREA.maxLng,
      },
    ],
  });

  const solvedRoute = solved.routes.find(
    (route) => route.vehicleId === affectedVehicleId,
  );
  if (!solvedRoute) {
    throw new Error(
      `cuOpt did not return a rerouted path for vehicle ${affectedVehicleId}.`,
    );
  }

  const trimmedSolvedRoute = trimRouteToLastOrderStop(solvedRoute);
  const solvedForPersistence: SolvedOrdersWorld = {
    ...solved,
    routes: solved.routes.map((route) =>
      route.vehicleId === affectedVehicleId ? trimmedSolvedRoute : route,
    ),
  };

  const afterRoute = trimmedSolvedRoute.route;
  const afterCongestionMeters = afterRoute.reduce((total, point, index) => {
    if (index === 0) {
      return total;
    }
    const previous = afterRoute[index - 1]!;
    const midpoint: LngLat = [
      (previous[0] + point[0]) / 2,
      (previous[1] + point[1]) / 2,
    ];
    const inside =
      midpoint[1] >= CONGESTION_AREA.minLat &&
      midpoint[1] <= CONGESTION_AREA.maxLat &&
      midpoint[0] >= CONGESTION_AREA.minLng &&
      midpoint[0] <= CONGESTION_AREA.maxLng;
    return inside ? total + haversineMeters(previous, point) : total;
  }, 0);
  const afterIntersectsCongestion = afterCongestionMeters > 0;
  if (beforeCongestionMeters > 0 && afterCongestionMeters >= beforeCongestionMeters) {
    throw new Error(
      "Routing service re-solved the vehicle but did not reduce congestion exposure on the remaining route.",
    );
  }

  const routeChanged = routesDiffer(beforeRoute, afterRoute);
  if (beforeIntersectsCongestion && !routeChanged) {
    throw new Error(
      "Routing service returned the same geometry for a congested route, so congestion avoidance could not be confirmed.",
    );
  }

  const invalidAssignment = solvedForPersistence.assignments.find(
    (assignment) =>
      orderIds.includes(assignment.orderId) &&
      assignment.vehicleId !== affectedVehicleId,
  );
  if (invalidAssignment) {
    throw new Error(
      `reroute_affected_vehicle reassigned ${invalidAssignment.orderId} to ${invalidAssignment.vehicleId}.`,
    );
  }

  const persisted = await persistSolvedFleetStateSubset(world, solvedForPersistence, {
    orderIds,
    vehicleIds: [affectedVehicleId],
    routeStatusByVehicleId: {
      [affectedVehicleId]: "recovery",
    },
    vehicleOverridesById: {
      [affectedVehicleId]: {
        status: "en_route",
        frozenAtSeconds: null,
      },
    },
  });

  return {
    incidentId: incident.id,
    vehicleId: affectedVehicleId,
    orderIds,
    provider: persisted.provider,
    beforeRoute,
    afterRoute,
    beforeIntersectsCongestion,
    afterIntersectsCongestion,
    routeChanged,
    routeCount: persisted.routeCount,
    orderAssignmentCount: persisted.orderAssignmentCount,
    beforeCongestionMeters,
    afterCongestionMeters,
    untouchedVehicleIds: world.vehicles
      .filter((vehicle) => vehicle.id !== affectedVehicleId)
      .map((vehicle) => vehicle.id),
  };
}
