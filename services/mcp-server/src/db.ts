import type { Json } from "../../../apps/web/lib/supabase/database.types.js";
import type {
  LngLat,
  SimulationWorld,
} from "../../../packages/shared/types/index.js";
import { getFreshRedisClient, getSupabaseAdminClient } from "./clients.js";

const TICK_KEY = "sim:tick";
const VEHICLES_KEY = "sim:vehicles";

interface PersistedTickState {
  elapsedSeconds: number;
  speedMultiplier: number;
  status: string;
  seed: number;
}

interface DbRowError {
  message: string;
}

interface DbPickupHub {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface DbCustomer {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface DbDriver {
  id: string;
  name: string;
  vehicle_id: string;
  stripe_payout_account_id: string | null;
}

interface DbVehicle {
  id: string;
  driver_id: string;
  route: [number, number][];
  routing_provider: SimulationWorld["vehicles"][number]["routingProvider"];
  routing_plan: SimulationWorld["vehicles"][number]["routingPlan"];
  route_status: SimulationWorld["vehicles"][number]["routeStatus"];
  status: SimulationWorld["vehicles"][number]["status"];
  speed_mps: number;
  frozen_at_seconds: number | null;
}

interface DbOrder {
  id: string;
  customer_id: string;
  pickup_hub_id: string;
  vehicle_id: string;
  status: SimulationWorld["orders"][number]["status"];
  revenue_cents: number;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_event_id: string | null;
  created_at?: string;
}

interface DbIncident {
  id: string;
  type: SimulationWorld["incidents"][number]["type"];
  vehicle_id: string | null;
  order_ids: string[];
  created_at_sim_seconds: number;
}

interface DbSimulationEvent {
  event_type: string;
  payload: Json;
}

interface RedisVehicleState {
  routeStatus: SimulationWorld["vehicles"][number]["routeStatus"];
  status: SimulationWorld["vehicles"][number]["status"];
  frozenAtSeconds: number | null;
}

type UntypedTable = ReturnType<typeof getSupabaseAdminClient> extends infer T
  ? T extends { from: (table: string) => infer U }
    ? U
    : never
  : never;

function table(name: string): UntypedTable {
  return getSupabaseAdminClient().from(name) as UntypedTable;
}

function asRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : {};
}

function buildParkedRoutingPlan(
  point: LngLat,
  provider: SimulationWorld["vehicles"][number]["routingProvider"] = "seed",
): NonNullable<SimulationWorld["vehicles"][number]["routingPlan"]> {
  return {
    provider,
    assignedOrderIds: [],
    totalDistanceMeters: 0,
    totalDurationSeconds: 0,
    orderedStops: [
      {
        id: "parked-start",
        kind: "start",
        orderId: null,
        etaSeconds: 0,
        location: { lng: point[0], lat: point[1] },
      },
    ],
  };
}

function getResolvedIncidentIds(params: {
  incidents: DbIncident[];
  orders: DbOrder[];
  simulationEvents: DbSimulationEvent[];
}): Set<string> {
  const paidOrClosedOrderIds = new Set(
    params.orders
      .filter((order) =>
        order.status === "paid" ||
        order.status === "assigned" ||
        order.status === "in_transit" ||
        order.status === "delivered" ||
        order.status === "cancelled",
      )
      .map((order) => order.id),
  );
  const paymentResolvedIds = params.incidents
    .filter(
      (incident) =>
        incident.type === "payment_declined" &&
        incident.order_ids.every((orderId) => paidOrClosedOrderIds.has(orderId)),
    )
    .map((incident) => incident.id);

  const completedOperationalIncidentIds = params.incidents
    .filter((incident) => incident.type !== "payment_declined")
    .filter((incident) =>
      incident.order_ids.length > 0 &&
      incident.order_ids.every((orderId) => {
        const order = params.orders.find((candidate) => candidate.id === orderId);
        return order ? order.status === "delivered" || order.status === "cancelled" : false;
      }),
    )
    .map((incident) => incident.id);

  return new Set([
    ...paymentResolvedIds,
    ...completedOperationalIncidentIds,
  ]);
}

async function updateRedisVehicleStates(
  updates: Record<string, Partial<RedisVehicleState>>,
): Promise<void> {
  const redis = await getFreshRedisClient();
  try {
    const raw = await redis.get(VEHICLES_KEY);
    const states = raw
      ? JSON.parse(raw) as Record<string, RedisVehicleState>
      : {};

    for (const [vehicleId, update] of Object.entries(updates)) {
      states[vehicleId] = {
        routeStatus: update.routeStatus ?? states[vehicleId]?.routeStatus ?? "normal",
        status: update.status ?? states[vehicleId]?.status ?? "en_route",
        frozenAtSeconds:
          update.frozenAtSeconds ??
          states[vehicleId]?.frozenAtSeconds ??
          null,
      };
    }

    await redis.set(VEHICLES_KEY, JSON.stringify(states));
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export async function readTickState(): Promise<PersistedTickState> {
  const redis = await getFreshRedisClient();
  try {
    const raw = await redis.get(TICK_KEY);
    if (!raw) {
      return {
        elapsedSeconds: 0,
        speedMultiplier: 1,
        status: "idle",
        seed: 42,
      };
    }

    return JSON.parse(raw) as PersistedTickState;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export async function loadSimulationWorld(): Promise<SimulationWorld> {
  const supabase = getSupabaseAdminClient();
  const [
    hubsResult,
    customersResult,
    driversResult,
    vehiclesResult,
    ordersResult,
    incidentsResult,
    simulationEventsResult,
  ] = await Promise.all([
    supabase.from("pickup_hubs").select("*"),
    supabase.from("customer_locations").select("*"),
    supabase.from("drivers").select("*"),
    supabase.from("vehicles").select("*"),
    supabase.from("orders").select("*"),
    supabase.from("incidents").select("*"),
    supabase.from("simulation_events").select("event_type,payload"),
  ]);

  const firstError =
    hubsResult.error ??
    customersResult.error ??
    driversResult.error ??
    vehiclesResult.error ??
    ordersResult.error ??
    incidentsResult.error ??
    simulationEventsResult.error;

  if (firstError) {
    throw new Error(`Failed to load simulation world: ${firstError.message}`);
  }

  const orders = (ordersResult.data as DbOrder[]) ?? [];
  const incidents = (incidentsResult.data as DbIncident[]) ?? [];
  const simulationEvents = (simulationEventsResult.data as DbSimulationEvent[]) ?? [];
  const resolvedIncidentIds = getResolvedIncidentIds({
    incidents,
    orders,
    simulationEvents,
  });

  const tick = await readTickState();

  return {
    seed: tick.seed,
    breakdownVehicleId: "vehicle-3",
    pickupHubs: (hubsResult.data as DbPickupHub[]).map((hub) => ({
      id: hub.id,
      name: hub.name,
      location: { lat: hub.lat, lng: hub.lng },
    })),
    customers: (customersResult.data as DbCustomer[]).map((customer) => ({
      id: customer.id,
      name: customer.name,
      location: { lat: customer.lat, lng: customer.lng },
    })),
    drivers: (driversResult.data as DbDriver[]).map((driver) => ({
      id: driver.id,
      name: driver.name,
      vehicleId: driver.vehicle_id,
    })),
    vehicles: (vehiclesResult.data as DbVehicle[]).map((vehicle) => ({
      id: vehicle.id,
      driverId: vehicle.driver_id,
      route: vehicle.route,
      routingProvider: vehicle.routing_provider,
      routingPlan: vehicle.routing_plan,
      routeStatus: vehicle.route_status,
      status: vehicle.status,
      speedMps: vehicle.speed_mps,
      frozenAtSeconds: vehicle.frozen_at_seconds,
    })),
    orders: orders.map((order) => ({
      id: order.id,
      customerId: order.customer_id,
      pickupHubId: order.pickup_hub_id,
      vehicleId: order.vehicle_id,
      status: order.status,
      revenueCents: order.revenue_cents,
      stripeCheckoutSessionId: order.stripe_checkout_session_id,
      stripePaymentIntentId: order.stripe_payment_intent_id,
      stripeEventId: order.stripe_event_id,
    })),
    incidents: incidents
      .filter((incident) => !resolvedIncidentIds.has(incident.id))
      .map((incident) => ({
        id: incident.id,
        type: incident.type,
        vehicleId: incident.vehicle_id,
        orderIds: incident.order_ids,
        createdAtSimSeconds: incident.created_at_sim_seconds,
      })),
  };
}

export async function insertSimulationEvent(event: {
  eventType: string;
  payload: Json;
  simSeconds?: number | null;
}): Promise<void> {
  const { error } = await table("simulation_events").insert({
    event_type: event.eventType,
    payload: event.payload,
    sim_seconds: event.simSeconds ?? null,
  });

  if (error) {
    throw new Error(`Failed to write simulation event: ${error.message}`);
  }
}

export async function countSimulationEvents(params: {
  eventType: string;
  minimumSimSeconds: number;
}): Promise<number> {
  const { count, error } = await table("simulation_events")
    .select("*", { count: "exact", head: true })
    .eq("event_type", params.eventType)
    .gte("sim_seconds", params.minimumSimSeconds);

  if (error) {
    throw new Error(`Failed to count simulation events: ${error.message}`);
  }

  return count ?? 0;
}

export async function countAllSimulationEvents(): Promise<number> {
  const { count, error } = await table("simulation_events")
    .select("*", { count: "exact", head: true });

  if (error) {
    throw new Error(`Failed to count all simulation events: ${error.message}`);
  }

  return count ?? 0;
}

export async function insertPolicyEvaluation(entry: {
  actionType: string;
  amountCents: number;
  allowed: boolean;
  reason: string;
  incidentId?: string | null;
}): Promise<void> {
  const { error } = await table("policy_evaluations").insert({
    action_type: entry.actionType,
    amount_cents: entry.amountCents,
    allowed: entry.allowed,
    reason: entry.reason,
    incident_id: entry.incidentId ?? null,
  });

  if (error) {
    throw new Error(`Failed to write policy evaluation: ${error.message}`);
  }
}

export async function insertLedgerEntry(entry: {
  entryType: string;
  amountCents: number;
  referenceId: string;
  idempotencyKey: string;
  stripeReference?: string | null;
  metadata: Json;
}): Promise<{ created: boolean; id: string | null; stripeReference: string | null }> {
  const existing = await table("ledger")
    .select("id, stripe_reference")
    .eq("idempotency_key", entry.idempotencyKey)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`Failed to check ledger idempotency: ${existing.error.message}`);
  }

  if (existing.data) {
    const existingLedger = existing.data as { id?: string | null; stripe_reference?: string | null };
    return {
      created: false,
      id: existingLedger.id ?? null,
      stripeReference: existingLedger.stripe_reference ?? null,
    };
  }

  const { data, error } = await table("ledger")
    .insert({
      entry_type: entry.entryType,
      amount_cents: entry.amountCents,
      reference_id: entry.referenceId,
      idempotency_key: entry.idempotencyKey,
      stripe_reference: entry.stripeReference ?? null,
      metadata: entry.metadata,
    })
    .select("id, stripe_reference")
    .single();

  if (error) {
    const duplicate =
      typeof (error as DbRowError).message === "string" &&
      (error as DbRowError).message.toLowerCase().includes("duplicate");

    if (duplicate) {
      return { created: false, id: null, stripeReference: entry.stripeReference ?? null };
    }

    throw new Error(`Failed to insert ledger entry: ${error.message}`);
  }

  return {
    created: true,
    id: (data as { id?: string | null; stripe_reference?: string | null } | null)?.id ?? null,
    stripeReference:
      (data as { id?: string | null; stripe_reference?: string | null } | null)?.stripe_reference ??
      entry.stripeReference ??
      null,
  };
}

export async function getDriverById(driverId: string): Promise<{
  id: string;
  name: string;
  vehicleId: string;
  stripePayoutAccountId: string | null;
}> {
  const { data, error } = await table("drivers")
    .select("id, name, vehicle_id, stripe_payout_account_id")
    .eq("id", driverId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load driver ${driverId}: ${error.message}`);
  }

  const driver = data as DbDriver | null;
  if (!driver) {
    throw new Error(`Driver not found: ${driverId}`);
  }

  return {
    id: driver.id,
    name: driver.name,
    vehicleId: driver.vehicle_id,
    stripePayoutAccountId: driver.stripe_payout_account_id,
  };
}

export async function setDriverStripePayoutAccountId(params: {
  driverId: string;
  stripePayoutAccountId: string;
}): Promise<void> {
  const { error } = await table("drivers")
    .update({ stripe_payout_account_id: params.stripePayoutAccountId })
    .eq("id", params.driverId);

  if (error) {
    throw new Error(`Failed to persist Stripe payout account for driver ${params.driverId}: ${error.message}`);
  }
}

export async function insertCustomerNotification(entry: {
  orderId: string;
  channel: string;
  message: string;
}): Promise<void> {
  const { error } = await table("customer_notifications").insert({
    order_id: entry.orderId,
    channel: entry.channel,
    message: entry.message,
  });

  if (error) {
    throw new Error(`Failed to create customer notification: ${error.message}`);
  }
}

export async function insertAgentDecision(entry: {
  incidentId?: string | null;
  reasoningSummary?: string | null;
  options?: Json;
  selectedOption?: Json;
  expectedCostCents?: number | null;
  expectedBenefitCents?: number | null;
  policyResult?: string | null;
}): Promise<void> {
  const { error } = await table("agent_decisions").insert({
    incident_id: entry.incidentId ?? null,
    reasoning_summary: entry.reasoningSummary ?? null,
    options: entry.options ?? null,
    selected_option: entry.selectedOption ?? null,
    expected_cost_cents: entry.expectedCostCents ?? null,
    expected_benefit_cents: entry.expectedBenefitCents ?? null,
    policy_result: entry.policyResult ?? null,
  });

  if (error) {
    throw new Error(`Failed to record agent decision: ${error.message}`);
  }
}

export async function updateVehicleAssignment(params: {
  orderIds: string[];
  vehicleId: string;
  routeStatus?: SimulationWorld["vehicles"][number]["routeStatus"];
}): Promise<void> {
  if (params.orderIds.length === 0) {
    return;
  }

  const { error: orderError } = await table("orders")
    .update({ vehicle_id: params.vehicleId, status: "assigned" })
    .in("id", params.orderIds);

  if (orderError) {
    throw new Error(`Failed to reassign orders: ${orderError.message}`);
  }

  if (params.routeStatus) {
    const { error: vehicleError } = await table("vehicles")
      .update({ route_status: params.routeStatus })
      .eq("id", params.vehicleId);

    if (vehicleError) {
      throw new Error(`Failed to update vehicle route status: ${vehicleError.message}`);
    }

    await updateRedisVehicleStates({
      [params.vehicleId]: {
        routeStatus: params.routeStatus,
        status: "en_route",
        frozenAtSeconds: null,
      },
    });
  }
}

export async function persistDispatchPlan(params: {
  provider: SimulationWorld["vehicles"][number]["routingProvider"];
  assignments: Array<{ orderId: string; vehicleId: string }>;
  routes: Array<{
    vehicleId: string;
    route: [number, number][];
    routingPlan: SimulationWorld["vehicles"][number]["routingPlan"];
    routeStatus: SimulationWorld["vehicles"][number]["routeStatus"];
  }>;
}): Promise<{
  provider: SimulationWorld["vehicles"][number]["routingProvider"];
  routeCount: number;
  orderAssignmentCount: number;
}> {
  const [currentWorld, tick] = await Promise.all([
    loadSimulationWorld(),
    readTickState(),
  ]);
  const routeStartAtSeconds = tick.elapsedSeconds;
  const assignmentMap = new Map(
    params.assignments.map((assignment) => [assignment.orderId, assignment.vehicleId]),
  );
  const assignedOrderIds = new Set(assignmentMap.keys());
  const routedVehicleIds = params.routes.map((route) => route.vehicleId);
  const routedVehicleIdSet = new Set(routedVehicleIds);
  const staleVehicles = currentWorld.vehicles.filter(
    (vehicle) =>
      !routedVehicleIdSet.has(vehicle.id) &&
      vehicle.routingPlan?.assignedOrderIds.some((orderId) =>
        assignedOrderIds.has(orderId),
      ) === true,
  );

  for (const assignment of params.assignments) {
    const { error } = await table("orders")
      .update({
        vehicle_id: assignment.vehicleId,
        status: "assigned",
      })
      .eq("id", assignment.orderId);

    if (error) {
      throw new Error(`Failed to persist dispatch assignment: ${error.message}`);
    }
  }

  for (const route of params.routes) {
    const hasAssignedOrders = (route.routingPlan?.assignedOrderIds.length ?? 0) > 0;
    const normalizedRoutingPlan = route.routingPlan
      ? {
          ...route.routingPlan,
          routeStartAtSeconds: hasAssignedOrders ? routeStartAtSeconds : 0,
          orderedStops: route.routingPlan.orderedStops.map((stop) => ({
            ...stop,
            etaSeconds:
              stop.kind === "start"
                ? hasAssignedOrders
                  ? routeStartAtSeconds
                  : 0
                : stop.etaSeconds + (hasAssignedOrders ? routeStartAtSeconds : 0),
          })),
        }
      : route.routingPlan;
    const { error } = await table("vehicles")
      .update({
        route: route.route,
        routing_provider: params.provider,
        routing_plan: normalizedRoutingPlan,
        route_status: route.routeStatus,
        status: hasAssignedOrders ? "en_route" : "idle",
        frozen_at_seconds: null,
      })
      .eq("id", route.vehicleId);

    if (error) {
      throw new Error(`Failed to persist vehicle dispatch route: ${error.message}`);
    }
  }

  for (const vehicle of staleVehicles) {
    const parkedPoint =
      vehicle.routingPlan?.orderedStops[0]
        ? [
            vehicle.routingPlan.orderedStops[0].location.lng,
            vehicle.routingPlan.orderedStops[0].location.lat,
          ] as LngLat
        : ((vehicle.route[0] ?? [0, 0]) as LngLat);
    const { error } = await table("vehicles")
      .update({
        route: [parkedPoint],
        routing_provider: params.provider,
        routing_plan: buildParkedRoutingPlan(parkedPoint, params.provider),
        route_status: "normal",
        status: "idle",
        frozen_at_seconds: null,
      })
      .eq("id", vehicle.id);

    if (error) {
      throw new Error(`Failed to clear stale dispatch route: ${error.message}`);
    }
  }

  await updateRedisVehicleStates(
    {
      ...Object.fromEntries(
        params.routes.map((route) => {
          const hasAssignedOrders =
            (route.routingPlan?.assignedOrderIds.length ?? 0) > 0;
          return [
            route.vehicleId,
            {
              routeStatus: route.routeStatus,
              status: hasAssignedOrders ? "en_route" as const : "idle" as const,
              frozenAtSeconds: null,
            },
          ];
        }),
      ),
      ...Object.fromEntries(
        staleVehicles.map((vehicle) => [
          vehicle.id,
          {
            routeStatus: "normal" as const,
            status: "idle" as const,
            frozenAtSeconds: null,
          },
        ]),
      ),
    },
  );

  await insertSimulationEvent({
    eventType: "paid_order_dispatch_applied",
    payload: {
      provider: params.provider,
      routeCount: params.routes.length,
      orderAssignmentCount: assignmentMap.size,
      routedVehicleIds,
    },
  });

  return {
    provider: params.provider,
    routeCount: params.routes.length,
    orderAssignmentCount: assignmentMap.size,
  };
}

export async function getIncidentCreatedAt(
  incidentId: string,
): Promise<string> {
  const { data, error } = await table("incidents")
    .select("created_at")
    .eq("id", incidentId)
    .single();

  if (error) {
    throw new Error(`Failed to load incident timestamp: ${error.message}`);
  }

  return (data as { created_at: string }).created_at;
}

export async function completeSimulatedRecovery(params: {
  orderIds: string[];
  vehicleIds: string[];
  incidentId: string;
  incidentVehicleId: string;
}): Promise<void> {
  const activeReplacementOrdersResult = await table("orders")
    .select("id,status")
    .in("vehicle_id", params.vehicleIds);

  if (activeReplacementOrdersResult.error) {
    throw new Error(
      `Failed to load replacement vehicle orders: ${activeReplacementOrdersResult.error.message}`,
    );
  }

  const completedOrderIds = Array.from(
    new Set([
      ...params.orderIds,
      ...(activeReplacementOrdersResult.data as Array<{
        id: string;
        status?: SimulationWorld["orders"][number]["status"];
      }> | null ?? [])
        .filter(
          (order) =>
            order.status === "assigned" || order.status === "in_transit",
        )
        .map((order) => order.id),
    ]),
  );

  const { error: orderError } = await table("orders")
    .update({ status: "delivered" })
    .in("id", completedOrderIds);

  if (orderError) {
    throw new Error(`Failed to complete recovered orders: ${orderError.message}`);
  }

  const { error: vehicleError } = await table("vehicles")
    .update({ route_status: "normal", status: "completed" })
    .in("id", params.vehicleIds);

  if (vehicleError) {
    throw new Error(`Failed to complete recovery routes: ${vehicleError.message}`);
  }

  const { error: incidentVehicleError } = await table("vehicles")
    .update({ route_status: "completed", status: "completed" })
    .eq("id", params.incidentVehicleId);

  if (incidentVehicleError) {
    throw new Error(
      `Failed to resolve incident vehicle: ${incidentVehicleError.message}`,
    );
  }

  await updateRedisVehicleStates(
    Object.fromEntries([
      ...params.vehicleIds.map((vehicleId) => [
        vehicleId,
        {
          routeStatus: "normal" as const,
          status: "completed" as const,
          frozenAtSeconds: null,
        },
      ] as const),
      [
        params.incidentVehicleId,
        {
          routeStatus: "completed" as const,
          status: "completed" as const,
          frozenAtSeconds: null,
        },
      ] as const,
    ]),
  );

  await insertSimulationEvent({
    eventType: "delivery_recovery_completed",
    payload: {
      incidentId: params.incidentId,
      orderIds: completedOrderIds,
      vehicleIds: params.vehicleIds,
      incidentVehicleId: params.incidentVehicleId,
      humanInterventionCount: 0,
    },
  });
}
