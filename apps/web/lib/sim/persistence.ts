import type { SimClockStatus, SimTickState } from "@/lib/sim/clock";
import { latLngToLngLat } from "@/lib/sim/movement";
import {
  BREAKDOWN_VEHICLE_ID,
  createWorld,
  getSimulationSeed,
} from "@/lib/sim/world";
import { runMigrationIfNeeded } from "@/lib/db/migrate";
import { withPostgresTransaction, type PostgresClient } from "@/lib/db/postgres";
import { getRedis } from "@/lib/redis";
import { routeSimulationWorld } from "@/lib/routing/client";
import { provisionStripeConnectDrivers } from "@/lib/stripe/provision";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  type Incident,
  type IncidentType,
  isStripeBackedActiveOrder,
  type LngLat,
  type OrderStatus,
  type RoutingProviderName,
  type RouteStatus,
  type SimulationWorld,
  type VehicleRoutingPlan,
  type VehicleStatus,
} from "@/lib/sim/types";
import type { SolvedOrdersWorld } from "@/lib/routing/client";

const TICK_KEY = "sim:tick";
const VEHICLES_KEY = "sim:vehicles";
const WORLD_KEY = "sim:world";
const ROUTING_SYNC_KEY = "sim:routing:sync";
const ROUTING_PLANNING_KEY = "sim:routing:planning";
const SIMULATION_SNAPSHOT_CACHE_TTL_MS = 900;

interface CachedSimulationSnapshot {
  world: SimulationWorld;
  tick: PersistedTickState;
}

let simulationSnapshotCache:
  | {
      expiresAt: number;
      snapshot: CachedSimulationSnapshot;
    }
  | null = null;
let initializationPromise: Promise<void> | null = null;
let initializationComplete = false;

export interface RoutingPlanningState {
  status: "planning";
  phase: "initializing" | "resetting";
  provider: "cuopt-osrm";
  seed: number;
  startedAt: string;
}

export class RoutingPlanningError extends Error {
  planning: RoutingPlanningState;

  constructor(planning: RoutingPlanningState) {
    super(`Routing planning already in progress (${planning.phase})`);
    this.name = "RoutingPlanningError";
    this.planning = planning;
  }
}

export interface RedisVehicleState {
  routeStatus: RouteStatus;
  status: VehicleStatus;
  frozenAtSeconds: number | null;
}

export interface PersistedTickState extends SimTickState {
  seed: number;
}

export type SimulationScenario = "empty";

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
}

interface DbVehicle {
  id: string;
  driver_id: string;
  route: LngLat[];
  routing_provider: RoutingProviderName;
  routing_plan: VehicleRoutingPlan | null;
  route_status: RouteStatus;
  status: VehicleStatus;
  speed_mps: number;
  frozen_at_seconds: number | null;
}

interface DbOrder {
  id: string;
  customer_id: string;
  pickup_hub_id: string;
  vehicle_id: string;
  status: OrderStatus;
  revenue_cents: number;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_event_id: string | null;
}

interface DbIncident {
  id: string;
  type: IncidentType;
  vehicle_id: string | null;
  order_ids: string[];
  created_at_sim_seconds: number;
}

interface DbSimulationEvent {
  event_type: string;
  payload: unknown;
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function defaultTick(seed: number): PersistedTickState {
  return {
    elapsedSeconds: 0,
    speedMultiplier: 1,
    status: "idle",
    seed,
  };
}

export async function loadTickFromRedis(): Promise<PersistedTickState> {
  const redis = getRedis();
  const raw = await redis.get(TICK_KEY);
  if (!raw) {
    return defaultTick(getSimulationSeed());
  }
  return JSON.parse(raw) as PersistedTickState;
}

export async function saveTickToRedis(tick: PersistedTickState): Promise<void> {
  const redis = getRedis();
  await redis.set(TICK_KEY, JSON.stringify(tick));
  invalidateSimulationSnapshotCache();
}

export async function loadVehicleStatesFromRedis(): Promise<
  Record<string, RedisVehicleState>
> {
  const redis = getRedis();
  const raw = await redis.get(VEHICLES_KEY);
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, RedisVehicleState>;
}

export async function saveVehicleStatesToRedis(
  states: Record<string, RedisVehicleState>,
): Promise<void> {
  const redis = getRedis();
  await redis.set(VEHICLES_KEY, JSON.stringify(states));
  invalidateSimulationSnapshotCache();
}

export async function loadWorldSnapshotFromRedis(): Promise<SimulationWorld | null> {
  const redis = getRedis();
  const raw = await redis.get(WORLD_KEY);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as SimulationWorld;
}

export async function saveWorldSnapshotToRedis(
  world: SimulationWorld,
): Promise<void> {
  const redis = getRedis();
  await redis.set(WORLD_KEY, JSON.stringify(world));
  invalidateSimulationSnapshotCache();
}

export async function clearRedisSimulationState(): Promise<void> {
  const redis = getRedis();
  await redis.del(
    TICK_KEY,
    VEHICLES_KEY,
    WORLD_KEY,
    ROUTING_SYNC_KEY,
    ROUTING_PLANNING_KEY,
  );
  invalidateSimulationSnapshotCache();
}

function mergeVehicleStates(
  world: SimulationWorld,
  states: Record<string, RedisVehicleState>,
): SimulationWorld {
  if (Object.keys(states).length === 0) {
    return world;
  }

  return {
    ...world,
    vehicles: world.vehicles.map((vehicle) => {
      const state = states[vehicle.id];
      if (!state) {
        return vehicle;
      }

      const postgresShowsActiveDispatch =
        vehicle.status === "en_route" ||
        vehicle.route.length > 1 ||
        (vehicle.routingPlan?.assignedOrderIds.length ?? 0) > 0;
      const nextStatus =
        postgresShowsActiveDispatch && state.status === "idle"
          ? vehicle.status
          : state.status;
      const nextRouteStatus =
        postgresShowsActiveDispatch &&
        state.routeStatus === "normal" &&
        vehicle.routeStatus !== "normal"
          ? vehicle.routeStatus
          : state.routeStatus;
      const nextFrozenAtSeconds =
        postgresShowsActiveDispatch && state.frozenAtSeconds === null
          ? vehicle.frozenAtSeconds
          : state.frozenAtSeconds;

      return {
        ...vehicle,
        routeStatus: nextRouteStatus,
        status: nextStatus,
        frozenAtSeconds: nextFrozenAtSeconds,
      };
    }),
  };
}

function invalidateSimulationSnapshotCache(): void {
  simulationSnapshotCache = null;
}

function primeSimulationSnapshotCache(
  snapshot: CachedSimulationSnapshot,
  ttlMs = SIMULATION_SNAPSHOT_CACHE_TTL_MS,
): void {
  simulationSnapshotCache = {
    expiresAt: Date.now() + ttlMs,
    snapshot,
  };
}

export async function loadWorldFromPostgres(): Promise<SimulationWorld> {
  const supabase = getSupabaseAdmin();

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
    throw new Error(`Failed to load world from Postgres: ${firstError.message}`);
  }

  const orders = (ordersResult.data as DbOrder[]) ?? [];
  const incidents = (incidentsResult.data as DbIncident[]) ?? [];
  const simulationEvents = (simulationEventsResult.data as DbSimulationEvent[]) ?? [];
  const resolvedIncidentIds = getResolvedIncidentIds({
    incidents,
    orders,
    simulationEvents,
  });

  const seed = getSimulationSeed();

  return {
    seed,
    breakdownVehicleId: BREAKDOWN_VEHICLE_ID,
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

export async function loadPersistedSimulation(): Promise<{
  world: SimulationWorld;
  tick: PersistedTickState;
}> {
  if (simulationSnapshotCache && simulationSnapshotCache.expiresAt > Date.now()) {
    return simulationSnapshotCache.snapshot;
  }

  const [cachedWorldResult, vehicleStatesResult, tickResult] = await Promise.allSettled([
    loadWorldSnapshotFromRedis(),
    loadVehicleStatesFromRedis(),
    loadTickFromRedis(),
  ]);
  const cachedWorld =
    cachedWorldResult.status === "fulfilled" ? cachedWorldResult.value : null;
  const vehicleStates =
    vehicleStatesResult.status === "fulfilled" ? vehicleStatesResult.value : {};
  const tick =
    tickResult.status === "fulfilled"
      ? tickResult.value
      : simulationSnapshotCache?.snapshot.tick ?? defaultTick(getSimulationSeed());
  const world =
    cachedWorld ??
    simulationSnapshotCache?.snapshot.world ??
    (await loadWorldFromPostgres());
  const snapshot = {
    world: mergeVehicleStates(world, vehicleStates),
    tick,
  };

  primeSimulationSnapshotCache(snapshot);
  return snapshot;
}

export function worldToVehicleStates(
  world: SimulationWorld,
): Record<string, RedisVehicleState> {
  return Object.fromEntries(
    world.vehicles.map((vehicle) => [
      vehicle.id,
      {
        routeStatus: vehicle.routeStatus,
        status: vehicle.status,
        frozenAtSeconds: vehicle.frozenAtSeconds,
      },
    ]),
  );
}

interface UntypedQuery {
  select(
    columns?: string,
    options?: { count?: "exact"; head?: boolean },
  ): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
    count?: number | null;
  }>;
  insert(values: unknown): PromiseLike<{ error: { message: string } | null }>;
  update(values: unknown): {
    eq(
      column: string,
      value: string,
    ): PromiseLike<{ error: { message: string } | null }>;
  };
  delete(): {
    neq(column: string, value: string): PromiseLike<unknown>;
  };
}

function db(table: string): UntypedQuery {
  return getSupabaseAdmin().from(table) as unknown as UntypedQuery;
}

interface VehicleRouteUpdateExecutor {
  updateVehicleRoute(params: {
    vehicleId: string;
    route: LngLat[];
    routingProvider: RoutingProviderName;
    routingPlan: VehicleRoutingPlan | null;
  }): Promise<void>;
}

const supabaseVehicleRouteUpdateExecutor: VehicleRouteUpdateExecutor = {
  async updateVehicleRoute(params) {
    const { error } = await db("vehicles")
      .update({
        route: params.route,
        routing_provider: params.routingProvider,
        routing_plan: params.routingPlan,
      })
      .eq("id", params.vehicleId);

    if (error) {
      throw new Error(
        `Failed to persist vehicle route for ${params.vehicleId}: ${error.message}`,
      );
    }
  },
};

function createPostgresVehicleRouteUpdateExecutor(
  client: PostgresClient,
): VehicleRouteUpdateExecutor {
  return {
    async updateVehicleRoute(params) {
      const result = await client.query(
        `
          UPDATE vehicles
          SET route = $2::jsonb,
              routing_provider = $3,
              routing_plan = $4::jsonb
          WHERE id = $1
        `,
        [
          params.vehicleId,
          JSON.stringify(params.route),
          params.routingProvider,
          JSON.stringify(params.routingPlan),
        ],
      );

      if (result.rowCount !== 1) {
        throw new Error(
          `Failed to persist vehicle route for ${params.vehicleId}: vehicle row missing.`,
        );
      }
    },
  };
}

async function seedPostgresFromWorld(world: SimulationWorld): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const existingDriversResult = await client.query<{
      id: string;
      stripe_payout_account_id: string | null;
    }>(
      `
        SELECT id, stripe_payout_account_id
        FROM drivers
      `,
    );
    const stripeAccountsByDriverId = new Map(
      existingDriversResult.rows.map((driver) => [
        driver.id,
        driver.stripe_payout_account_id,
      ]),
    );

    await client.query(`
      TRUNCATE
        policy_evaluations,
        customer_notifications,
        simulation_events,
        ledger,
        agent_decisions,
        incidents,
        orders,
        vehicles,
        drivers,
        customer_locations,
        pickup_hubs
      CASCADE
    `);

    const serializedPickupHubs = JSON.stringify(
      world.pickupHubs.map((hub) => ({
        id: hub.id,
        name: hub.name,
        lat: hub.location.lat,
        lng: hub.location.lng,
      })),
    );
    if (world.pickupHubs.length > 0) {
      await client.query(
        `
          INSERT INTO pickup_hubs (id, name, lat, lng)
          SELECT id, name, lat, lng
          FROM jsonb_to_recordset($1::jsonb) AS rows(
            id TEXT,
            name TEXT,
            lat DOUBLE PRECISION,
            lng DOUBLE PRECISION
          )
        `,
        [serializedPickupHubs],
      );
    }

    const serializedCustomers = JSON.stringify(
      world.customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        lat: customer.location.lat,
        lng: customer.location.lng,
      })),
    );
    if (world.customers.length > 0) {
      await client.query(
        `
          INSERT INTO customer_locations (id, name, lat, lng)
          SELECT id, name, lat, lng
          FROM jsonb_to_recordset($1::jsonb) AS rows(
            id TEXT,
            name TEXT,
            lat DOUBLE PRECISION,
            lng DOUBLE PRECISION
          )
        `,
        [serializedCustomers],
      );
    }

    const serializedDrivers = JSON.stringify(
      world.drivers.map((driver) => ({
        id: driver.id,
        name: driver.name,
        vehicle_id: driver.vehicleId,
        stripe_payout_account_id: stripeAccountsByDriverId.get(driver.id) ?? null,
      })),
    );
    if (world.drivers.length > 0) {
      await client.query(
        `
          INSERT INTO drivers (id, name, vehicle_id, stripe_payout_account_id)
          SELECT id, name, vehicle_id, stripe_payout_account_id
          FROM jsonb_to_recordset($1::jsonb) AS rows(
            id TEXT,
            name TEXT,
            vehicle_id TEXT,
            stripe_payout_account_id TEXT
          )
        `,
        [serializedDrivers],
      );
    }

    const serializedVehicles = JSON.stringify(
      world.vehicles.map((vehicle) => ({
        id: vehicle.id,
        driver_id: vehicle.driverId,
        route: vehicle.route,
        routing_provider: vehicle.routingProvider,
        routing_plan: vehicle.routingPlan,
        route_status: vehicle.routeStatus,
        status: vehicle.status,
        speed_mps: vehicle.speedMps,
        frozen_at_seconds: vehicle.frozenAtSeconds,
      })),
    );
    if (world.vehicles.length > 0) {
      await client.query(
        `
          INSERT INTO vehicles (
            id,
            driver_id,
            route,
            routing_provider,
            routing_plan,
            route_status,
            status,
            speed_mps,
            frozen_at_seconds
          )
          SELECT
            id,
            driver_id,
            route,
            routing_provider,
            routing_plan,
            route_status,
            status,
            speed_mps,
            frozen_at_seconds
          FROM jsonb_to_recordset($1::jsonb) AS rows(
            id TEXT,
            driver_id TEXT,
            route JSONB,
            routing_provider TEXT,
            routing_plan JSONB,
            route_status TEXT,
            status TEXT,
            speed_mps DOUBLE PRECISION,
            frozen_at_seconds DOUBLE PRECISION
          )
        `,
        [serializedVehicles],
      );
    }

    const serializedOrders = JSON.stringify(
      world.orders.map((order) => ({
        id: order.id,
        customer_id: order.customerId,
        pickup_hub_id: order.pickupHubId,
        vehicle_id: order.vehicleId,
        status: order.status,
        revenue_cents: order.revenueCents,
        stripe_checkout_session_id: order.stripeCheckoutSessionId ?? null,
        stripe_payment_intent_id: order.stripePaymentIntentId ?? null,
        stripe_event_id: order.stripeEventId ?? null,
      })),
    );
    if (world.orders.length > 0) {
      await client.query(
        `
          INSERT INTO orders (
            id,
            customer_id,
            pickup_hub_id,
            vehicle_id,
            status,
            revenue_cents,
            stripe_checkout_session_id,
            stripe_payment_intent_id,
            stripe_event_id
          )
          SELECT
            id,
            customer_id,
            pickup_hub_id,
            vehicle_id,
            status,
            revenue_cents,
            stripe_checkout_session_id,
            stripe_payment_intent_id,
            stripe_event_id
          FROM jsonb_to_recordset($1::jsonb) AS rows(
            id TEXT,
            customer_id TEXT,
            pickup_hub_id TEXT,
            vehicle_id TEXT,
            status TEXT,
            revenue_cents INTEGER,
            stripe_checkout_session_id TEXT,
            stripe_payment_intent_id TEXT,
            stripe_event_id TEXT
          )
        `,
        [serializedOrders],
      );
    }
  });
}

async function ensureSeededDriversHaveStripeConnectAccounts(): Promise<void> {
  const { data: drivers, error } = await getSupabaseAdmin()
    .from("drivers")
    .select("id,stripe_payout_account_id");
  if (error) {
    throw new Error(
      `Failed to inspect Stripe Connect driver mappings: ${error.message}`,
    );
  }

  const hasMissingPayoutAccount = (drivers ?? []).some((driver) => {
    const payoutAccountId = driver.stripe_payout_account_id as string | null;
    return !payoutAccountId || payoutAccountId.trim().length === 0;
  });

  if (!hasMissingPayoutAccount) {
    return;
  }

  await provisionStripeConnectDrivers();
}

async function purgeLegacySeededCheckoutOrders(): Promise<number> {
  return withPostgresTransaction(async (client) => {
    const legacyOrderResult = await client.query<{
      id: string;
      customer_id: string;
    }>(
      `
        SELECT id, customer_id
        FROM orders
        WHERE id LIKE 'order-checkout-%'
          AND customer_id NOT LIKE 'customer-request-%'
          AND status = 'pending'
      `,
    );

    const legacyOrders = legacyOrderResult.rows;
    if (legacyOrders.length === 0) {
      return 0;
    }

    const legacyOrderIds = legacyOrders.map((order) => order.id);
    const legacyCustomerIds = legacyOrders.map((order) => order.customer_id);

    await client.query(
      `
        DELETE FROM customer_notifications
        WHERE order_id = ANY($1::text[])
      `,
      [legacyOrderIds],
    );

    await client.query(
      `
        DELETE FROM incidents
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(order_ids) AS order_id
          WHERE order_id = ANY($1::text[])
        )
      `,
      [legacyOrderIds],
    );

    await client.query(
      `
        DELETE FROM simulation_events
        WHERE payload->>'orderId' = ANY($1::text[])
           OR payload->>'customerId' = ANY($2::text[])
      `,
      [legacyOrderIds, legacyCustomerIds],
    );

    await client.query(
      `
        DELETE FROM orders
        WHERE id = ANY($1::text[])
      `,
      [legacyOrderIds],
    );

    return legacyOrders.length;
  });
}

function getRoutingSyncMarker(seed: number): string {
  return `seed:${seed}:provider:cuopt-osrm:v1`;
}

async function readRoutingSyncMarker(): Promise<string | null> {
  const redis = getRedis();
  return redis.get(ROUTING_SYNC_KEY);
}

async function writeRoutingSyncMarker(marker: string): Promise<void> {
  const redis = getRedis();
  await redis.set(ROUTING_SYNC_KEY, marker);
}

export async function readRoutingPlanningState(): Promise<RoutingPlanningState | null> {
  const redis = getRedis();
  const raw = await redis.get(ROUTING_PLANNING_KEY);
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as RoutingPlanningState;
}

async function clearRoutingPlanningState(): Promise<void> {
  const redis = getRedis();
  await redis.del(ROUTING_PLANNING_KEY);
}

async function acquireRoutingPlanningState(
  phase: RoutingPlanningState["phase"],
  seed: number,
): Promise<RoutingPlanningState> {
  const redis = getRedis();
  const planning: RoutingPlanningState = {
    status: "planning",
    phase,
    provider: "cuopt-osrm",
    seed,
    startedAt: new Date().toISOString(),
  };

  const acquired = await redis.set(
    ROUTING_PLANNING_KEY,
    JSON.stringify(planning),
    "EX",
    300,
    "NX",
  );

  if (acquired !== "OK") {
    throw new RoutingPlanningError((await readRoutingPlanningState()) ?? planning);
  }

  return planning;
}

async function withRoutingPlanning<T>(
  phase: RoutingPlanningState["phase"],
  seed: number,
  work: () => Promise<T>,
): Promise<T> {
  await acquireRoutingPlanningState(phase, seed);

  try {
    return await work();
  } finally {
    await clearRoutingPlanningState();
  }
}

async function persistVehicleRoutes(
  world: SimulationWorld,
  vehicleIds: Set<string> | null = null,
  executor: VehicleRouteUpdateExecutor = supabaseVehicleRouteUpdateExecutor,
): Promise<void> {
  for (const vehicle of world.vehicles) {
    if (vehicleIds && !vehicleIds.has(vehicle.id)) {
      continue;
    }
    await executor.updateVehicleRoute({
      vehicleId: vehicle.id,
      route: vehicle.route,
      routingProvider: vehicle.routingProvider,
      routingPlan: vehicle.routingPlan,
    });
  }
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
    routeStartAtSeconds: 0,
    orderedStops: [
      {
        id: "parked",
        kind: "start",
        orderId: null,
        etaSeconds: 0,
        location: { lng: point[0], lat: point[1] },
      },
    ],
  };
}

function getVehicleRouteEndAtSeconds(
  vehicle: SimulationWorld["vehicles"][number],
): number {
  const routeStartAtSeconds =
    vehicle.routingPlan?.routeStartAtSeconds ??
    vehicle.routingPlan?.orderedStops[0]?.etaSeconds ??
    0;
  const routedDurationSeconds = vehicle.routingPlan?.totalDurationSeconds ?? 0;
  const lastStopEtaSeconds =
    vehicle.routingPlan?.orderedStops.at(-1)?.etaSeconds ?? routeStartAtSeconds;

  return Math.max(
    routeStartAtSeconds + routedDurationSeconds,
    lastStopEtaSeconds,
  );
}

function getVehicleCompletionPoint(
  vehicle: SimulationWorld["vehicles"][number],
): LngLat {
  const finalStop = vehicle.routingPlan?.orderedStops.at(-1);
  if (finalStop) {
    return latLngToLngLat(finalStop.location);
  }

  return (
    (vehicle.route[vehicle.route.length - 1] ??
      vehicle.route[0] ??
      [0, 0]) as LngLat
  );
}

function vehicleStateChanged(
  previous: SimulationWorld["vehicles"][number],
  next: SimulationWorld["vehicles"][number],
): boolean {
  return (
    previous.status !== next.status ||
    previous.routeStatus !== next.routeStatus ||
    previous.routingProvider !== next.routingProvider ||
    previous.frozenAtSeconds !== next.frozenAtSeconds ||
    JSON.stringify(previous.route) !== JSON.stringify(next.route) ||
    JSON.stringify(previous.routingPlan) !== JSON.stringify(next.routingPlan)
  );
}

async function syncRoutesWithRoutingService(world: SimulationWorld): Promise<SimulationWorld> {
  try {
    const routed = await routeSimulationWorld(world, "cuopt-osrm");
    return routed.world;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown routing service failure";
    throw new Error(
      `Routing service sync failed (${message}). Start the standalone service with ` +
        "`python3.10.exe -m uvicorn app.main:app --reload --port 8001` from services/routing, or set ROUTING_SERVICE_URL to the running service.",
    );
  }
}

function hasActiveOrders(world: SimulationWorld): boolean {
  return world.orders.some((order) => isStripeBackedActiveOrder(order));
}

async function buildScenarioWorld(
  seed: number,
  scenario: SimulationScenario,
): Promise<SimulationWorld> {
  void scenario;
  return createWorld(seed);
}

async function ensureRoadGeometrySynced(): Promise<void> {
  const seed = getSimulationSeed();
  const expectedMarker = getRoutingSyncMarker(seed);
  const currentMarker = await readRoutingSyncMarker();
  if (currentMarker === expectedMarker) {
    return;
  }

  if (await readRoutingPlanningState()) {
    throw new RoutingPlanningError(
      (await readRoutingPlanningState()) ?? {
        status: "planning",
        phase: "initializing",
        provider: "cuopt-osrm",
        seed,
        startedAt: new Date().toISOString(),
      },
    );
  }

  const currentWorld = await loadWorldFromPostgres();
  if (!hasActiveOrders(currentWorld)) {
    await saveWorldSnapshotToRedis(currentWorld);
    await saveVehicleStatesToRedis(worldToVehicleStates(currentWorld));
    await writeRoutingSyncMarker(expectedMarker);
    return;
  }

  const routedWorld = await withRoutingPlanning("initializing", seed, async () =>
    syncRoutesWithRoutingService(currentWorld),
  );
  await persistVehicleRoutes(routedWorld);
  await saveWorldSnapshotToRedis(routedWorld);
  await saveVehicleStatesToRedis(worldToVehicleStates(routedWorld));
  await writeRoutingSyncMarker(expectedMarker);
}

export async function ensureInitialized(): Promise<void> {
  if (initializationComplete) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = (async () => {
    await runMigrationIfNeeded();

  const { count, error } = await db("drivers").select("*", {
    count: "exact",
    head: true,
  });

  if (error) {
    const hint = process.env.DATABASE_URL?.trim()
      ? "Migration may have failed — check DATABASE_URL and Supabase logs."
      : "Set DATABASE_URL in apps/web/.env.local (Supabase → Settings → Database → URI). Migration runs automatically on the next request.";
    throw new Error(
      `Database not ready (${error.message}). ${hint}`,
    );
  }

  if ((count ?? 0) === 0) {
    const seed = getSimulationSeed();
    const world = createWorld(seed);
    await seedPostgresFromWorld(world);
    await ensureSeededDriversHaveStripeConnectAccounts();
    await saveWorldSnapshotToRedis(world);
    await writeRoutingSyncMarker(getRoutingSyncMarker(world.seed));
    initializationComplete = true;
    return;
  }

  const purgedLegacyOrderCount = await purgeLegacySeededCheckoutOrders();
  if (purgedLegacyOrderCount > 0) {
    console.info("Purged legacy seeded checkout orders", {
      purgedLegacyOrderCount,
    });
  }

  await ensureRoadGeometrySynced();
  initializationComplete = true;
  })().catch((error) => {
    initializationComplete = false;
    throw error;
  }).finally(() => {
    initializationPromise = null;
  });

  await initializationPromise;
}

export async function persistBreakdown(
  world: SimulationWorld,
  incident: Incident,
): Promise<void> {
  const { error: incidentError } = await db("incidents").insert({
    id: incident.id,
    type: incident.type,
    vehicle_id: incident.vehicleId,
    order_ids: incident.orderIds,
    created_at_sim_seconds: incident.createdAtSimSeconds,
  });

  if (incidentError) {
    throw new Error(`Failed to persist incident: ${incidentError.message}`);
  }

  const brokenVehicle = world.vehicles.find(
    (vehicle) => vehicle.id === incident.vehicleId,
  );
  if (!brokenVehicle || !incident.vehicleId) {
    return;
  }

  const { error: vehicleError } = await db("vehicles")
    .update({
      route_status: brokenVehicle.routeStatus,
      status: brokenVehicle.status,
      frozen_at_seconds: brokenVehicle.frozenAtSeconds,
    })
    .eq("id", brokenVehicle.id);

  if (vehicleError) {
    throw new Error(`Failed to update vehicle: ${vehicleError.message}`);
  }

  await saveWorldSnapshotToRedis(world);
  await saveVehicleStatesToRedis(worldToVehicleStates(world));
}

export async function resetSimulation(
  seed: number,
  scenario: SimulationScenario = "empty",
): Promise<{
  world: SimulationWorld;
  tick: PersistedTickState;
}> {
  return withRoutingPlanning("resetting", seed, async () => {
    const debugReset = process.env.DEBUG_SIM_RESET === "1";
    const startedAt = Date.now();
    let previousStepAt = startedAt;
    const logResetStep = (label: string): void => {
      if (!debugReset) {
        return;
      }
      const now = Date.now();
      console.info("[sim-reset]", label, {
        stepMs: now - previousStepAt,
        totalMs: now - startedAt,
      });
      previousStepAt = now;
    };

    const world = await buildScenarioWorld(seed, scenario);
    logResetStep("buildScenarioWorld");
    await seedPostgresFromWorld(world);
    logResetStep("seedPostgresFromWorld");
    await ensureSeededDriversHaveStripeConnectAccounts();
    logResetStep("ensureSeededDriversHaveStripeConnectAccounts");
    await clearRedisSimulationState();
    logResetStep("clearRedisSimulationState");

    const tick = defaultTick(seed);
    await saveTickToRedis(tick);
    await saveWorldSnapshotToRedis(world);
    await saveVehicleStatesToRedis(worldToVehicleStates(world));
    await writeRoutingSyncMarker(getRoutingSyncMarker(world.seed));
    primeSimulationSnapshotCache({ world, tick });
    logResetStep("persistRedisAndCache");

    return { world, tick };
  });
}

export async function persistTickAndVehicles(
  tick: PersistedTickState,
  world: SimulationWorld,
): Promise<void> {
  await saveTickToRedis(tick);
  await saveWorldSnapshotToRedis(world);
  await saveVehicleStatesToRedis(worldToVehicleStates(world));
  primeSimulationSnapshotCache({ world, tick });
}

export async function reconcileSimulationProgress(
  tick: PersistedTickState,
): Promise<void> {
  if (tick.status !== "running") {
    return;
  }

  const world = await loadWorldFromPostgres();

  const activeOrderStatuses = new Set(["assigned", "in_transit"]);
  const blockedVehicleIds = new Set(
    world.vehicles
      .filter(
        (vehicle) =>
          vehicle.frozenAtSeconds !== null ||
          vehicle.status === "incident" ||
          vehicle.routeStatus === "at_risk" ||
          vehicle.routeStatus === "incident",
      )
      .map((vehicle) => vehicle.id),
  );
  const activeOrderIdsByVehicleId = new Map<string, Set<string>>();
  for (const order of world.orders) {
    if (!activeOrderStatuses.has(order.status)) {
      continue;
    }

    const current = activeOrderIdsByVehicleId.get(order.vehicleId) ?? new Set<string>();
    current.add(order.id);
    activeOrderIdsByVehicleId.set(order.vehicleId, current);
  }

  const deliveredOrderIds = world.orders
    .filter((order) => activeOrderStatuses.has(order.status))
    .filter((order) => !blockedVehicleIds.has(order.vehicleId))
    .filter((order) => {
      const vehicle = world.vehicles.find(
        (candidate) => candidate.id === order.vehicleId,
      );
      const stop = vehicle?.routingPlan?.orderedStops.find(
        (candidate) => candidate.orderId === order.id,
      );
      return Boolean(stop && tick.elapsedSeconds >= stop.etaSeconds);
    })
    .map((order) => order.id);
  const inTransitOrderIds = world.orders
    .filter((order) => activeOrderStatuses.has(order.status))
    .filter((order) => !deliveredOrderIds.includes(order.id))
    .filter((order) => !blockedVehicleIds.has(order.vehicleId))
    .filter((order) => {
      const vehicle = world.vehicles.find(
        (candidate) => candidate.id === order.vehicleId,
      );
      const routeStartAtSeconds =
        vehicle?.routingPlan?.routeStartAtSeconds ??
        vehicle?.routingPlan?.orderedStops[0]?.etaSeconds ??
        0;
      return Boolean(vehicle && tick.elapsedSeconds >= routeStartAtSeconds);
    })
    .map((order) => order.id);

  const deliveredOrderIdSet = new Set(deliveredOrderIds);
  const inTransitOrderIdSet = new Set(inTransitOrderIds);
  const nextWorld: SimulationWorld = {
    ...world,
    orders: world.orders.map((order) =>
      deliveredOrderIdSet.has(order.id)
        ? { ...order, status: "delivered" as const }
        : inTransitOrderIdSet.has(order.id) && order.status === "assigned"
          ? { ...order, status: "in_transit" as const }
        : order,
    ),
    vehicles: world.vehicles.map((vehicle) => {
      if (
        vehicle.routeStatus === "at_risk" ||
        vehicle.routeStatus === "incident" ||
        vehicle.routeStatus === "recovery" ||
        vehicle.routeStatus === "completed"
      ) {
        return vehicle;
      }

      const remainingAssignedOrders =
        [...(activeOrderIdsByVehicleId.get(vehicle.id) ?? new Set<string>())].filter(
          (orderId) => !deliveredOrderIdSet.has(orderId),
        );
      const routeEndAtSeconds = getVehicleRouteEndAtSeconds(vehicle);
      const shouldStillBeEnRoute =
        remainingAssignedOrders.length > 0 ||
        (vehicle.route.length > 1 && tick.elapsedSeconds < routeEndAtSeconds);
      const hadActiveRoute =
        vehicle.status === "en_route" ||
        vehicle.route.length > 1 ||
        (vehicle.routingPlan?.assignedOrderIds.length ?? 0) > 0 ||
        routeEndAtSeconds > 0;

      if (shouldStillBeEnRoute) {
        return {
          ...vehicle,
          status: "en_route",
        };
      }

      if (!hadActiveRoute) {
        return vehicle;
      }

      const parkedPoint = getVehicleCompletionPoint(vehicle);

      return {
        ...vehicle,
        route: [parkedPoint],
        routingPlan: buildParkedRoutingPlan(parkedPoint, vehicle.routingProvider),
        routeStatus: "completed",
        status: "idle",
        frozenAtSeconds: null,
      };
    }),
  };

  const vehicleStateWasUpdated = nextWorld.vehicles.some((vehicle, index) => {
    const previous = world.vehicles[index];
    return previous ? vehicleStateChanged(previous, vehicle) : false;
  });

  if (deliveredOrderIds.length === 0 && !vehicleStateWasUpdated) {
    return;
  }

  await withPostgresTransaction(async (client) => {
    if (deliveredOrderIds.length > 0) {
      await client.query(
        `
          UPDATE orders
          SET status = 'delivered'
          WHERE id = ANY($1::text[])
        `,
        [deliveredOrderIds],
      );
    }

    const changedVehicleIds = new Set(
      nextWorld.vehicles
        .filter((vehicle, index) => {
          const previous = world.vehicles[index];
          return previous ? vehicleStateChanged(previous, vehicle) : false;
        })
        .map((vehicle) => vehicle.id),
    );

    await persistVehicleRoutes(
      nextWorld,
      changedVehicleIds,
      createPostgresVehicleRouteUpdateExecutor(client),
    );

    for (const vehicle of nextWorld.vehicles) {
      const previous = world.vehicles.find((candidate) => candidate.id === vehicle.id);
      if (!previous || !vehicleStateChanged(previous, vehicle)) {
        continue;
      }

      const result = await client.query(
        `
          UPDATE vehicles
          SET route_status = $2,
              status = $3,
              frozen_at_seconds = $4
          WHERE id = $1
        `,
        [
          vehicle.id,
          vehicle.routeStatus,
          vehicle.status,
          vehicle.frozenAtSeconds,
        ],
      );

      if (result.rowCount !== 1) {
        throw new Error(
          `Failed to persist runtime vehicle status for ${vehicle.id}.`,
        );
      }
    }
  });

  await saveWorldSnapshotToRedis(nextWorld);
  await saveVehicleStatesToRedis(worldToVehicleStates(nextWorld));
  primeSimulationSnapshotCache({ world: nextWorld, tick });
}

export async function updateTickControl(
  tick: PersistedTickState,
): Promise<PersistedTickState> {
  await saveTickToRedis(tick);
  return tick;
}

export async function persistSolvedFleetState(
  world: SimulationWorld,
  solved: SolvedOrdersWorld,
): Promise<{
  provider: RoutingProviderName;
  routeCount: number;
  orderAssignmentCount: number;
}> {
  return persistSolvedFleetStateSubset(world, solved);
}

export async function persistSolvedFleetStateSubset(
  world: SimulationWorld,
  solved: SolvedOrdersWorld,
  options?: {
    orderIds?: string[];
    vehicleIds?: string[];
    routeStatusByVehicleId?: Record<string, RouteStatus>;
    vehicleOverridesById?: Record<
      string,
      Partial<SimulationWorld["vehicles"][number]>
    >;
    simulatePersistFailure?: boolean;
  },
): Promise<{
  provider: RoutingProviderName;
  routeCount: number;
  orderAssignmentCount: number;
}> {
  const tick = await loadTickFromRedis();
  const routeStartAtSeconds = tick.elapsedSeconds;
  const assignmentsByOrderId = new Map(
    solved.assignments.map((assignment) => [assignment.orderId, assignment.vehicleId]),
  );
  const solvedRoutesByVehicleId = new Map(
    solved.routes.map((route) => [route.vehicleId, route]),
  );
  const targetOrderIds = new Set(
    options?.orderIds ??
      world.orders
        .filter((order) =>
          order.status === "paid" ||
          order.status === "assigned" ||
          order.status === "in_transit",
        )
        .map((order) => order.id),
  );
  const vehicleOverrideIds = Object.keys(options?.vehicleOverridesById ?? {});
  const targetVehicleIds = new Set(
    [
      ...(options?.vehicleIds ?? solved.routes.map((route) => route.vehicleId)),
      ...vehicleOverrideIds,
    ],
  );
  const targetOrders = world.orders.filter((order) => targetOrderIds.has(order.id));

  if (solved.unassignedOrderIds.length > 0) {
    throw new Error(
      `cuOpt returned unassigned orders: ${solved.unassignedOrderIds.join(", ")}`,
    );
  }

  for (const order of targetOrders) {
    if (!assignmentsByOrderId.has(order.id)) {
      throw new Error(`cuOpt did not return an assignment for order ${order.id}.`);
    }
  }

  const nextWorld: SimulationWorld = {
    ...world,
    orders: world.orders.map((order) => {
      if (!targetOrderIds.has(order.id)) {
        return order;
      }
      const nextVehicleId = assignmentsByOrderId.get(order.id);
      if (!nextVehicleId) {
        return order;
      }

      return {
        ...order,
        vehicleId: nextVehicleId,
        status: order.status === "paid" ? "assigned" : order.status,
      };
    }),
    vehicles: world.vehicles.map((vehicle) => {
      const vehicleOverride = options?.vehicleOverridesById?.[vehicle.id];
      let nextVehicle = vehicle;

      if (targetVehicleIds.has(vehicle.id)) {
        const solvedRoute = solvedRoutesByVehicleId.get(vehicle.id);
        if (solvedRoute) {
          const hasAssignedOrders = solvedRoute.routingPlan.assignedOrderIds.length > 0;
          const routedPlan = {
            ...solvedRoute.routingPlan,
            routeStartAtSeconds,
            orderedStops: solvedRoute.routingPlan.orderedStops.map((stop) => ({
              ...stop,
              etaSeconds: stop.etaSeconds + routeStartAtSeconds,
            })),
          };
          nextVehicle = {
            ...nextVehicle,
            route: solvedRoute.route,
            routingProvider: solved.provider,
            routingPlan: routedPlan,
            routeStatus:
              options?.routeStatusByVehicleId?.[vehicle.id] ??
              solvedRoute.routeStatus,
            status:
              nextVehicle.status === "incident" ||
              nextVehicle.status === "completed"
                ? nextVehicle.status
                : hasAssignedOrders
                  ? "en_route"
                  : nextVehicle.status,
          };
        }
      }

      if (vehicleOverride) {
        nextVehicle = {
          ...nextVehicle,
          ...vehicleOverride,
          routeStatus:
            vehicleOverride.routeStatus ??
            options?.routeStatusByVehicleId?.[vehicle.id] ??
            nextVehicle.routeStatus,
        };
      }

      return nextVehicle;
    }),
  };

  await withPostgresTransaction(async (client) => {
    await persistVehicleRoutes(
      nextWorld,
      targetVehicleIds,
      createPostgresVehicleRouteUpdateExecutor(client),
    );

    for (const vehicle of nextWorld.vehicles) {
      if (!targetVehicleIds.has(vehicle.id)) {
        continue;
      }

      const result = await client.query(
        `
          UPDATE vehicles
          SET route_status = $2,
              status = $3,
              frozen_at_seconds = $4
          WHERE id = $1
        `,
        [
          vehicle.id,
          vehicle.routeStatus,
          vehicle.status,
          vehicle.frozenAtSeconds,
        ],
      );

      if (result.rowCount !== 1) {
        throw new Error(
          `Failed to persist vehicle state for ${vehicle.id}: vehicle row missing.`,
        );
      }
    }

    if (options?.simulatePersistFailure) {
      throw new Error("Simulated fleet persistence failure");
    }

    for (const order of nextWorld.orders) {
      if (!targetOrderIds.has(order.id)) {
        continue;
      }
      const nextVehicleId = assignmentsByOrderId.get(order.id);
      if (!nextVehicleId) {
        continue;
      }

      const result = await client.query(
        `
          UPDATE orders
          SET vehicle_id = $2,
              status = $3
          WHERE id = $1
        `,
        [order.id, nextVehicleId, order.status],
      );

      if (result.rowCount !== 1) {
        throw new Error(
          `Failed to persist order assignment for ${order.id}: order row missing.`,
        );
      }
    }
  });
  await saveWorldSnapshotToRedis(nextWorld);
  await saveVehicleStatesToRedis(worldToVehicleStates(nextWorld));
  primeSimulationSnapshotCache({ world: nextWorld, tick });

  return {
    provider: solved.provider,
    routeCount: solved.routeCount,
    orderAssignmentCount: assignmentsByOrderId.size,
  };
}

export function isSimClockStatus(value: string): value is SimClockStatus {
  return value === "idle" || value === "running" || value === "paused";
}
