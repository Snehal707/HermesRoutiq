import "server-only";

import { getVehiclePositionAtTime, latLngToLngLat } from "../sim/movement";
import type { LngLat, VehicleRoutingPlan } from "../sim/types";
import type { SolvedOrdersWorld } from "./client";
import { solveDbOrdersWorld } from "./client";
import {
  loadPersistedSimulation,
  persistSolvedFleetStateSubset,
} from "../sim/persistence";

interface ReplacementRouteExecution {
  vehicleId: string;
  orderIds: string[];
  beforeRoute: Array<[number, number]>;
  afterRoute: Array<[number, number]>;
  routeChanged: boolean;
}

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

function buildParkedRoutingPlan(
  point: LngLat,
  provider: VehicleRoutingPlan["provider"],
): VehicleRoutingPlan {
  return {
    provider,
    assignedOrderIds: [],
    totalDistanceMeters: 0,
    totalDurationSeconds: 0,
    orderedStops: [
      {
        id: "breakdown-parked",
        kind: "start",
        orderId: null,
        etaSeconds: 0,
        location: { lng: point[0], lat: point[1] },
      },
    ],
  };
}

export async function executeBreakdownRecoveryReroute(params: {
  incidentId: string;
  plannedAssignments: Array<{
    vehicleId: string;
    orderIds: string[];
  }>;
  simulatePersistFailure?: boolean;
}): Promise<{
  incidentId: string;
  orderIds: string[];
  provider: string;
  routeCount: number;
  orderAssignmentCount: number;
  replacementRoutes: ReplacementRouteExecution[];
  brokenVehicle: {
    vehicleId: string;
    beforeRoute: Array<[number, number]>;
    afterRoute: Array<[number, number]>;
    parkedLocation: [number, number];
  };
  untouchedVehicleIds: string[];
}> {
  const { world, tick } = await loadPersistedSimulation();
  const incident = world.incidents.find(
    (candidate) => candidate.id === params.incidentId,
  );

  if (!incident) {
    throw new Error(`Incident not found: ${params.incidentId}`);
  }
  if (incident.type !== "vehicle_breakdown") {
    throw new Error(
      `Incident ${params.incidentId} is ${incident.type}, not vehicle_breakdown.`,
    );
  }
  if (params.plannedAssignments.length === 0) {
    throw new Error("At least one replacement vehicle is required.");
  }
  const brokenVehicleId = incident.vehicleId;
  if (!brokenVehicleId) {
    throw new Error(
      `Breakdown incident ${params.incidentId} is missing its affected vehicle.`,
    );
  }
  const replacementVehicleIds = [
    ...new Set(params.plannedAssignments.map((assignment) => assignment.vehicleId)),
  ];

  const brokenVehicle = world.vehicles.find(
    (vehicle) => vehicle.id === brokenVehicleId,
  );
  if (!brokenVehicle) {
    throw new Error(`Broken vehicle not found: ${brokenVehicleId}`);
  }

  const replacementVehicleIdSet = new Set(replacementVehicleIds);
  for (const vehicleId of replacementVehicleIds) {
    if (!world.vehicles.some((vehicle) => vehicle.id === vehicleId)) {
      throw new Error(`Replacement vehicle not found: ${vehicleId}`);
    }
  }
  // Reroute the incident's still-active orders regardless of which vehicle they
  // currently sit on: Hermes may run assign_replacement_driver before this step
  // (moving them onto a replacement vehicle already), so requiring them to still
  // be on the broken vehicle would spuriously fail after a valid reassignment.
  const orderIds = world.orders
    .filter(
      (order) =>
        incident.orderIds.includes(order.id) &&
        (order.status === "assigned" || order.status === "in_transit"),
    )
    .map((order) => order.id);

  if (orderIds.length === 0) {
    throw new Error(
      `Breakdown incident ${params.incidentId} has no dispatchable orders to reroute.`,
    );
  }

  const beforeRoutesByVehicleId = new Map(
    world.vehicles.map((vehicle) => [vehicle.id, vehicle.route]),
  );
  const plannedOrderIds = new Set(
    params.plannedAssignments.flatMap((assignment) => assignment.orderIds),
  );
  const unexpectedPlannedOrderId = [...plannedOrderIds].find(
    (orderId) => !orderIds.includes(orderId),
  );
  if (unexpectedPlannedOrderId) {
    throw new Error(
      `Planned reassignment references non-incident order ${unexpectedPlannedOrderId}.`,
    );
  }
  if (plannedOrderIds.size !== orderIds.length) {
    throw new Error(
      "Planned reassignment must cover each affected order exactly once.",
    );
  }

  const activeOrdersByVehicleId = new Map<string, string[]>();
  for (const order of world.orders) {
    if (
      !replacementVehicleIdSet.has(order.vehicleId) ||
      !["paid", "assigned", "in_transit"].includes(order.status) ||
      orderIds.includes(order.id)
    ) {
      continue;
    }

    activeOrdersByVehicleId.set(order.vehicleId, [
      ...(activeOrdersByVehicleId.get(order.vehicleId) ?? []),
      order.id,
    ]);
  }

  const solvedByVehicle = await Promise.all(
    params.plannedAssignments.map(async (assignment) => {
      const solveOrderIds = [
        ...(activeOrdersByVehicleId.get(assignment.vehicleId) ?? []),
        ...assignment.orderIds,
      ];
      const solved = await solveDbOrdersWorld(world, "cuopt-osrm", {
        vehicleIds: [assignment.vehicleId],
        orderIds: solveOrderIds,
      });
      const solvedRoute = solved.routes.find(
        (route) => route.vehicleId === assignment.vehicleId,
      );
      if (!solvedRoute) {
        throw new Error(
          `cuOpt did not return a route for replacement vehicle ${assignment.vehicleId}.`,
        );
      }

      return {
        solved,
        solvedRoute,
        assignment,
      };
    }),
  );

  const solved: SolvedOrdersWorld = {
    provider: solvedByVehicle[0]?.solved.provider ?? "cuopt-osrm",
    routeCount: solvedByVehicle.reduce(
      (total, entry) => total + entry.solved.routeCount,
      0,
    ),
    unassignedOrderIds: solvedByVehicle.flatMap(
      (entry) => entry.solved.unassignedOrderIds,
    ),
    assignments: solvedByVehicle.flatMap((entry) =>
      entry.solved.assignments.filter((candidate) =>
        entry.assignment.orderIds.includes(candidate.orderId),
      ),
    ),
    routes: solvedByVehicle.map((entry) => entry.solvedRoute),
  };

  const invalidAssignment = solved.assignments.find(
    (assignment) =>
      orderIds.includes(assignment.orderId) &&
      assignment.vehicleId !==
        params.plannedAssignments.find((candidate) =>
          candidate.orderIds.includes(assignment.orderId),
        )?.vehicleId,
  );
  if (invalidAssignment) {
    throw new Error(
      `cuOpt reassigned ${invalidAssignment.orderId} to unexpected vehicle ${invalidAssignment.vehicleId}.`,
    );
  }

  const parkedPosition = getVehiclePositionAtTime(
    brokenVehicle.route,
    tick.elapsedSeconds,
    brokenVehicle.speedMps,
    brokenVehicle.frozenAtSeconds,
  ).position;
  const parkedLngLat = latLngToLngLat(parkedPosition);
  const brokenVehicleOverride = {
    route: [parkedLngLat],
    routingPlan: buildParkedRoutingPlan(
      parkedLngLat,
      brokenVehicle.routingProvider,
    ),
    routeStatus: "incident" as const,
    status: "incident" as const,
    frozenAtSeconds: brokenVehicle.frozenAtSeconds ?? tick.elapsedSeconds,
  };

  const persisted = await persistSolvedFleetStateSubset(world, solved, {
    orderIds,
    vehicleIds: [...replacementVehicleIds, brokenVehicle.id],
    routeStatusByVehicleId: Object.fromEntries(
      replacementVehicleIds.map((vehicleId) => [vehicleId, "recovery"]),
    ),
    vehicleOverridesById: {
      [brokenVehicle.id]: brokenVehicleOverride,
    },
    simulatePersistFailure: params.simulatePersistFailure,
  });

  const assignmentsByVehicleId = new Map<string, string[]>();
  for (const assignment of solved.assignments) {
    if (!orderIds.includes(assignment.orderId)) {
      continue;
    }

    assignmentsByVehicleId.set(assignment.vehicleId, [
      ...(assignmentsByVehicleId.get(assignment.vehicleId) ?? []),
      assignment.orderId,
    ]);
  }

  const replacementRoutes = solved.routes
    .filter((route) => replacementVehicleIdSet.has(route.vehicleId))
    .map((route) => ({
      vehicleId: route.vehicleId,
      orderIds: assignmentsByVehicleId.get(route.vehicleId) ?? [],
      beforeRoute:
        beforeRoutesByVehicleId.get(route.vehicleId) ?? ([] as Array<[number, number]>),
      afterRoute: route.route,
      routeChanged: routesDiffer(
        beforeRoutesByVehicleId.get(route.vehicleId) ?? [],
        route.route,
      ),
    }));

  return {
    incidentId: incident.id,
    orderIds,
    provider: persisted.provider,
    routeCount: persisted.routeCount,
    orderAssignmentCount: persisted.orderAssignmentCount,
    replacementRoutes,
    brokenVehicle: {
      vehicleId: brokenVehicle.id,
      beforeRoute: brokenVehicle.route,
      afterRoute: brokenVehicleOverride.route,
      parkedLocation: parkedLngLat,
    },
    untouchedVehicleIds: world.vehicles
      .filter(
        (vehicle) =>
          vehicle.id !== brokenVehicle.id &&
          !replacementVehicleIdSet.has(vehicle.id),
      )
      .map((vehicle) => vehicle.id),
  };
}
