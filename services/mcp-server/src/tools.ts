import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Json } from "../../../apps/web/lib/supabase/database.types.js";
import {
  createInfrastructureUpgradeBillingArtifact,
  getStripeBillingServer,
} from "../../../apps/web/lib/stripe/projects-pattern.js";
import {
  createDriverPayoutTransfer,
  findDriverPayoutTransferByAppIdempotencyKey,
  getStripeConnectServer,
} from "../../../apps/web/lib/stripe/connect.js";
import type {
  LngLat,
  SimulationWorld,
} from "../../../packages/shared/types/index.js";
import {
  isStripeBackedActiveOrder,
  isStripeBackedOrder,
} from "../../../packages/shared/types/index.js";
import type {
  McpActionToolName,
  McpReadToolName,
  McpToolName,
} from "../../../packages/shared/types/mcp.js";
import {
  MCP_ACTION_TOOL_NAMES,
  MCP_READ_TOOL_NAMES,
} from "../../../packages/shared/types/mcp.js";
import { getSupabaseAdminClient } from "./clients.js";
import {
  completeSimulatedRecovery,
  countAllSimulationEvents,
  countSimulationEvents,
  getDriverById,
  getIncidentCreatedAt,
  insertAgentDecision,
  insertCustomerNotification,
  insertLedgerEntry,
  insertSimulationEvent,
  loadSimulationWorld,
  persistDispatchPlan,
  readTickState,
  updateVehicleAssignment,
} from "./db.js";
import { writeActionAudit } from "./audit.js";
import { authorizeToolForRole, checkSpendingPolicy, resolveClaimedRole } from "./policy.js";
import { getStripeProjectsStatus } from "./stripe-projects.js";
import { toolInputSchemas, toolOutputSchemas } from "./schemas.js";
import { getEnv } from "./env.js";

type ToolStructuredContent = Record<string, unknown>;

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..", "..", "..");

type ToolContentResult<T extends ToolStructuredContent> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
};

function toLocation([lng, lat]: LngLat): { lat: number; lng: number } {
  return { lat, lng };
}

function extractSeedStops(route: LngLat[]): LngLat[] {
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

const HUB_MATCH_RADIUS_METERS = 40;

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

function getVehicleAnchorPoint(
  vehicle: SimulationWorld["vehicles"][number],
): LngLat | null {
  const routedAnchor = vehicle.routingPlan?.orderedStops[0]?.location;
  if (routedAnchor) {
    return [routedAnchor.lng, routedAnchor.lat];
  }

  return vehicle.route[0] ?? null;
}

async function waitForDemoRecoveryWindow(
  incidentCreatedAt: string,
): Promise<void> {
  // Leave a small allowance for final verification/audit writes so the
  // end-to-end incident timestamp lands near the demo's 58-second target.
  const targetRecoveryMs = 55_000;
  const minimumBlueRouteMs = 5_000;
  const elapsedMs = Date.now() - new Date(incidentCreatedAt).getTime();
  const waitMs = Math.max(minimumBlueRouteMs, targetRecoveryMs - elapsedMs);
  await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
}

function isVehicleStagedAtHub(
  vehicle: SimulationWorld["vehicles"][number],
  hubLocation: { lat: number; lng: number },
): boolean {
  const anchor = getVehicleAnchorPoint(vehicle);
  if (!anchor) {
    return false;
  }

  return haversineMeters(anchor, [hubLocation.lng, hubLocation.lat]) <= HUB_MATCH_RADIUS_METERS;
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
  orderedStops: Array<{
    location: { lat: number; lng: number };
  }>,
): LngLat[] {
  return dedupeConsecutivePoints(
    orderedStops.map((stop) => [stop.location.lng, stop.location.lat] as LngLat),
  );
}

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
  orderedStops: Array<{
    location: { lat: number; lng: number };
  }>,
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

function jsonResult<T extends ToolStructuredContent>(structuredContent: T): ToolContentResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function asJson(value: unknown): Json {
  return value as Json;
}

function getDashboardBaseUrl(): string {
  return process.env.HERMES_DASHBOARD_BASE_URL?.trim() || "http://127.0.0.1:3001";
}

async function getPlaceholderCheckoutVehicleId(): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const { data: vehicles, error } = await supabase
    .from("vehicles")
    .select("id")
    .order("id", { ascending: true })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load placeholder vehicle: ${error.message}`);
  }

  const vehicleId = vehicles?.[0]?.id;
  if (!vehicleId) {
    throw new Error("No vehicle is available to hold a checkout order before dispatch.");
  }

  return vehicleId;
}

async function findExistingPaidCheckoutOrder(reference: {
  stripeEventId: string;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string;
}): Promise<{ id: string } | null> {
  const supabase = getSupabaseAdminClient();

  const byEvent = await supabase
    .from("orders")
    .select("id")
    .eq("stripe_event_id", reference.stripeEventId)
    .maybeSingle<{ id: string }>();
  if (byEvent.error) {
    throw new Error(`Failed to check existing order by event: ${byEvent.error.message}`);
  }
  if (byEvent.data) {
    return byEvent.data;
  }

  if (reference.stripePaymentIntentId) {
    const byPaymentIntent = await supabase
      .from("orders")
      .select("id")
      .eq("stripe_payment_intent_id", reference.stripePaymentIntentId)
      .maybeSingle<{ id: string }>();
    if (byPaymentIntent.error) {
      throw new Error(
        `Failed to check existing order by payment intent: ${byPaymentIntent.error.message}`,
      );
    }
    if (byPaymentIntent.data) {
      return byPaymentIntent.data;
    }
  }

  const bySession = await supabase
    .from("orders")
    .select("id")
    .eq("stripe_checkout_session_id", reference.stripeCheckoutSessionId)
    .eq("status", "paid")
    .maybeSingle<{ id: string }>();
  if (bySession.error) {
    throw new Error(`Failed to check existing order by session: ${bySession.error.message}`);
  }

  return bySession.data;
}

async function findLatestPaymentDeclinedIncidentId(
  orderId: string,
): Promise<string | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("incidents")
    .select("id,order_ids")
    .eq("type", "payment_declined")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load payment recovery incident: ${error.message}`);
  }

  const matching = (data ?? []).find((incident) => {
    const orderIds = Array.isArray(incident.order_ids) ? incident.order_ids : [];
    return orderIds.includes(orderId);
  }) as { id: string } | undefined;

  return matching?.id ?? null;
}

async function recordDeclinedCheckoutIncident(params: {
  orderId: string;
  checkoutSessionId?: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  errorMessage?: string | null;
  declineCode?: string | null;
}): Promise<{ incidentId: string; created: boolean; status: "pending" }> {
  const supabase = getSupabaseAdminClient();
  const orderResult = await supabase
    .from("orders")
    .select("id,status,stripe_checkout_session_id,stripe_event_id,stripe_payment_intent_id")
    .eq("id", params.orderId)
    .maybeSingle<{
      id: string;
      status: string;
      stripe_checkout_session_id: string | null;
      stripe_event_id: string | null;
      stripe_payment_intent_id: string | null;
    }>();

  if (orderResult.error) {
    throw new Error(`Failed to load checkout order ${params.orderId}: ${orderResult.error.message}`);
  }

  const order = orderResult.data;
  if (!order) {
    throw new Error(`Declined checkout order not found: ${params.orderId}`);
  }

  const existingIncidentId = await findLatestPaymentDeclinedIncidentId(params.orderId);
  if (params.stripeEventId && order.stripe_event_id === params.stripeEventId && existingIncidentId) {
    return {
      incidentId: existingIncidentId,
      created: false,
      status: "pending",
    };
  }

  if (order.status !== "pending") {
    if (existingIncidentId) {
      return {
        incidentId: existingIncidentId,
        created: false,
        status: "pending",
      };
    }

    throw new Error(
      `Payment declined incidents can only be created for pending orders. Order ${params.orderId} is ${order.status}.`,
    );
  }

  const nextStripeCheckoutSessionId =
    params.checkoutSessionId ?? order.stripe_checkout_session_id ?? null;
  const nextStripeEventId = params.stripeEventId ?? order.stripe_event_id ?? null;
  const nextStripePaymentIntentId =
    params.stripePaymentIntentId ?? order.stripe_payment_intent_id ?? null;

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      stripe_checkout_session_id: nextStripeCheckoutSessionId,
      stripe_event_id: nextStripeEventId,
      stripe_payment_intent_id: nextStripePaymentIntentId,
    })
    .eq("id", params.orderId);

  if (updateError) {
    throw new Error(`Failed to update declined checkout order ${params.orderId}: ${updateError.message}`);
  }

  if (params.stripeEventId || params.stripePaymentIntentId) {
    await insertSimulationEvent({
      eventType: "stripe_payment_failed",
      payload: {
        orderId: params.orderId,
        stripeEventId: params.stripeEventId ?? null,
        stripePaymentIntentId: params.stripePaymentIntentId ?? null,
        errorMessage: params.errorMessage ?? null,
        declineCode: params.declineCode ?? null,
      },
    });
  }

  if (existingIncidentId) {
    return {
      incidentId: existingIncidentId,
      created: false,
      status: "pending",
    };
  }

  const incidentId = createHash("sha256")
    .update(
      JSON.stringify({
        orderId: params.orderId,
        stripeEventId: params.stripeEventId ?? null,
        stripePaymentIntentId: params.stripePaymentIntentId ?? null,
        checkoutSessionId: nextStripeCheckoutSessionId,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const tick = await readTickState();
  const insertResult = await supabase
    .from("incidents")
    .insert({
      id: incidentId,
      type: "payment_declined",
      vehicle_id: null,
      order_ids: [params.orderId],
      created_at_sim_seconds: tick.elapsedSeconds,
    })
    .select("id")
    .single<{ id: string }>();

  if (insertResult.error) {
    const duplicateIncidentId = await findLatestPaymentDeclinedIncidentId(params.orderId);
    if (duplicateIncidentId) {
      return {
        incidentId: duplicateIncidentId,
        created: false,
        status: "pending",
      };
    }

    throw new Error(
      `Failed to persist payment declined incident for ${params.orderId}: ${insertResult.error.message}`,
    );
  }

  await insertSimulationEvent({
    eventType: "payment_declined_incident_created",
    payload: {
      incidentId: insertResult.data.id,
      orderId: params.orderId,
      stripeCheckoutSessionId: nextStripeCheckoutSessionId,
      stripePaymentIntentId: params.stripePaymentIntentId ?? null,
      declineCode: params.declineCode ?? null,
      errorMessage: params.errorMessage ?? null,
    },
  });

  return {
    incidentId: insertResult.data.id,
    created: true,
    status: "pending",
  };
}

function getRecoverySkillStoragePaths(incidentType: string): {
  skillDir: string;
  skillPath: string;
  metadataPath: string;
} {
  const skillDir = resolve(
    repoRoot,
    "skills",
    "delivery-recovery",
    incidentType,
  );

  return {
    skillDir,
    skillPath: resolve(skillDir, "SKILL.md"),
    metadataPath: resolve(skillDir, "metadata.json"),
  };
}

async function resolveIncidentTypeForSkill(params: {
  incidentId?: string;
  incidentType?: string;
}): Promise<string> {
  if (params.incidentType) {
    return params.incidentType;
  }

  if (!params.incidentId) {
    return "vehicle_breakdown";
  }

  const world = await loadSimulationWorld();
  const incident = world.incidents.find(
    (candidate) => candidate.id === params.incidentId,
  );

  if (!incident) {
    throw new Error(`Incident not found: ${params.incidentId}`);
  }

  return incident.type;
}

function buildDeterministicIdempotencyKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function extractIncidentId(input: unknown): string | null {
  if (!input || typeof input !== "object" || !("incidentId" in input)) {
    return null;
  }

  const incidentId = (input as { incidentId?: unknown }).incidentId;
  return typeof incidentId === "string" ? incidentId : null;
}

function buildAuthorizationDeniedResult(params: {
  role: string;
  toolName: McpToolName;
  reason: string;
}) {
  const structuredContent = {
    allowed: false,
    reason: params.reason,
    role: params.role,
    toolName: params.toolName,
    policy: {
      layer: "application_role_tool_authorization",
      allowed: false,
      reason: params.reason,
    },
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true as const,
  };
}

function withRoleAuthorization<T extends ToolStructuredContent>(
  toolName: McpToolName,
  handler: (input: unknown) => Promise<ToolContentResult<T>>,
) {
  return async (
    input: unknown,
    extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<ToolContentResult<T> | ReturnType<typeof buildAuthorizationDeniedResult>> => {
    const role = resolveClaimedRole(extra?.requestInfo?.headers);
    if (!role) {
      return handler(input);
    }

    // This is our own application-layer least-privilege gate, not a NemoClaw-native tool policy.
    const authorization = await authorizeToolForRole({
      role,
      toolName,
      incidentId: extractIncidentId(input),
    });

    if (authorization.allowed) {
      return handler(input);
    }

    const denied = buildAuthorizationDeniedResult({
      role,
      toolName,
      reason: authorization.reason,
    });

    await writeActionAudit({
      toolName,
      input: asJson(input),
      output: asJson(denied.structuredContent),
      incidentId: extractIncidentId(input),
    });

    return denied;
  };
}

function buildBusinessSnapshot(world: SimulationWorld, tick: Awaited<ReturnType<typeof readTickState>>) {
  const activeOrders = world.orders.filter((order) =>
    isStripeBackedActiveOrder(order),
  ).length;

  const availableDriverIds = new Set(
    world.vehicles
      .filter((vehicle) => vehicle.status !== "incident")
      .map((vehicle) => vehicle.driverId),
  );

  return {
    tick,
    summary: {
      totalOrders: world.orders.length,
      activeOrders,
      availableDrivers: availableDriverIds.size,
      activeIncidents: world.incidents.length,
      activeVehicleRoutes: world.vehicles.filter((vehicle) => vehicle.route.length > 1).length,
    },
  };
}

let stripeClient: unknown = null;
let stripeBillingClient: unknown = null;

function getStripeClient(): unknown {
  if (!stripeClient) {
    stripeClient = getStripeConnectServer(getEnv().STRIPE_CONNECT_SECRET_KEY);
  }

  return stripeClient;
}

function getStripeBillingClient(): unknown {
  if (!stripeBillingClient) {
    stripeBillingClient = getStripeBillingServer(getEnv().STRIPE_SECRET_KEY);
  }

  return stripeBillingClient;
}

async function requestRouteOptimisation(
  world: SimulationWorld,
  routeStatus: "normal" | "at_risk" | "incident" | "recovery",
  incidentId?: string,
) {
  const { ROUTING_SERVICE_URL } = getEnv();
  const customerById = new Map(world.customers.map((customer) => [customer.id, customer]));
  const incident = incidentId
    ? world.incidents.find((candidate) => candidate.id === incidentId) ?? null
    : null;
  const activeOrders = world.orders.filter((order) =>
    isStripeBackedActiveOrder(order),
  );
  const routedOrders = incident
    ? activeOrders.filter((order) => incident.orderIds.includes(order.id))
    : activeOrders;

  if (incident && routedOrders.length === 0) {
    throw new Error(
      `No active incident orders remain for ${incidentId}. Recovery routing cannot be prepared.`,
    );
  }

  const drivers = world.vehicles
    .filter((vehicle) =>
      !(
        incident?.type === "vehicle_breakdown" &&
        routeStatus === "recovery" &&
        incident.vehicleId === vehicle.id
      ),
    )
    .map((vehicle) => {
    const stops = vehicle.routingPlan?.orderedStops.length
      ? vehicle.routingPlan.orderedStops
      : extractSeedStops(vehicle.route).map((stop, index, array) => ({
          id: `${vehicle.id}:${index}`,
          kind:
            index === 0 ? "start" : index === array.length - 1 ? "end" : "order",
          orderId: index === 0 || index === array.length - 1 ? null : `${vehicle.id}-stop-${index}`,
          etaSeconds: 0,
          location: toLocation(stop),
        }));

    const start = stops[0]?.location ?? toLocation(vehicle.route[0] as LngLat);

    return {
      id: vehicle.driverId,
      name: vehicle.driverId,
      vehicle_id: vehicle.id,
      start_location: start,
      end_location: start,
      capacity: 4,
      current_load: 0,
      time_window: { start: 0, end: 86_400 },
    };
  });

  const orders = routedOrders.map((order, index) => {
    const customer = customerById.get(order.customerId);
    if (!customer) {
      throw new Error(
        `Order ${order.id} references missing customer ${order.customerId}.`,
      );
    }

    return {
      id: order.id,
      location: customer.location,
      demand: 1,
      service_time_seconds: 0,
      assigned_driver_id: order.vehicleId ? world.vehicles.find((vehicle) => vehicle.id === order.vehicleId)?.driverId ?? null : null,
      sequence: index,
    };
  });

  const response = await fetch(new URL("/route", ROUTING_SERVICE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "cuopt-osrm",
      drivers,
      orders,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Routing service optimisation failed: ${detail}`);
  }

  const payload = (await response.json()) as {
    provider: string;
    assignments: Array<{ order_id: string; driver_id: string }>;
    unassigned_order_ids: string[];
    routes: Array<{
      driver_id: string;
      vehicle_id: string;
      ordered_stops: Array<{
        id: string;
        kind: "start" | "order" | "end";
        eta_seconds: number;
        order_id: string | null;
        location: { lat: number; lng: number };
      }>;
      geometry: number[][];
      distance_meters: number;
      duration_seconds: number;
    }>;
  };

  return {
      provider: payload.provider,
      routeCount: payload.routes.length,
      assignments: payload.assignments.length,
      unassignedOrderIds: payload.unassigned_order_ids,
      routes: payload.routes.map((route) => {
        const sanitized = sanitizeRouteGeometry(
          route.geometry,
          route.ordered_stops,
        );

        return {
          vehicleId: route.vehicle_id,
          driverId: route.driver_id,
          route: sanitized.route,
          routingPlan: {
            provider: payload.provider,
            assignedOrderIds: route.ordered_stops
              .map((stop) => stop.order_id)
              .filter((orderId): orderId is string => orderId !== null),
            totalDistanceMeters: route.distance_meters,
            totalDurationSeconds: route.duration_seconds,
            geometryMode: sanitized.geometryMode,
            orderedStops: route.ordered_stops.map((stop) => ({
              id: stop.id,
              kind: stop.kind,
              etaSeconds: stop.eta_seconds,
              orderId: stop.order_id,
              location: stop.location,
            })),
          },
          routeStatus,
        };
      }),
  };
}

async function requestHubScopedDispatchPlan(
  world: SimulationWorld,
  orderId: string,
) {
  const { ROUTING_SERVICE_URL } = getEnv();
  const targetOrder = world.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    throw new Error(`Dispatch order not found: ${orderId}`);
  }

  const targetHub = world.pickupHubs.find((hub) => hub.id === targetOrder.pickupHubId);
  if (!targetHub) {
    throw new Error(`Pickup hub ${targetOrder.pickupHubId} was not found for order ${orderId}.`);
  }

  const targetCustomer = world.customers.find(
    (customer) => customer.id === targetOrder.customerId,
  );
  if (!targetCustomer) {
    throw new Error(`Customer ${targetOrder.customerId} was not found for order ${orderId}.`);
  }

  const candidateVehicles = world.vehicles.filter(
    (vehicle) =>
      vehicle.status === "idle" &&
      vehicle.routeStatus === "normal" &&
      isVehicleStagedAtHub(vehicle, targetHub.location),
  );

  if (candidateVehicles.length === 0) {
    throw new Error(
      `No idle vehicles are currently staged at ${targetHub.name}, so Hermes cannot honestly dispatch ${orderId} from that hub yet.`,
    );
  }

  const drivers = candidateVehicles.map((vehicle) => {
    const anchor = getVehicleAnchorPoint(vehicle);
    if (!anchor) {
      throw new Error(`Vehicle ${vehicle.id} is missing a dispatch anchor point.`);
    }

    const start = toLocation(anchor);

    return {
      id: vehicle.driverId,
      name: vehicle.driverId,
      vehicle_id: vehicle.id,
      start_location: start,
      end_location: start,
      capacity: 4,
      current_load: 0,
      time_window: { start: 0, end: 86_400 },
    };
  });

  const response = await fetch(new URL("/route", ROUTING_SERVICE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "cuopt-osrm",
      drivers,
      orders: [{
        id: targetOrder.id,
        location: {
          lat: targetCustomer.location.lat,
          lng: targetCustomer.location.lng,
        },
        demand: 1,
        service_time_seconds: 0,
        assigned_driver_id: null,
        sequence: 0,
      }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Routing service optimisation failed: ${detail}`);
  }

  const payload = (await response.json()) as {
    provider: string;
    assignments: Array<{ order_id: string; driver_id: string }>;
    unassigned_order_ids: string[];
    routes: Array<{
      driver_id: string;
      vehicle_id: string;
      ordered_stops: Array<{
        id: string;
        kind: "start" | "order" | "end";
        eta_seconds: number;
        order_id: string | null;
        location: { lat: number; lng: number };
      }>;
      geometry: number[][];
      distance_meters: number;
      duration_seconds: number;
    }>;
  };

  return {
    provider: payload.provider,
    routeCount: payload.routes.length,
    assignments: payload.assignments.length,
    unassignedOrderIds: payload.unassigned_order_ids,
    routes: payload.routes.map((route) => {
      const sanitized = sanitizeRouteGeometry(
        route.geometry,
        route.ordered_stops,
      );

      return {
        vehicleId: route.vehicle_id,
        driverId: route.driver_id,
        route: sanitized.route,
        routingPlan: {
          provider: payload.provider,
          assignedOrderIds: route.ordered_stops
            .map((stop) => stop.order_id)
            .filter((candidateOrderId): candidateOrderId is string => candidateOrderId !== null),
          totalDistanceMeters: route.distance_meters,
          totalDurationSeconds: route.duration_seconds,
          geometryMode: sanitized.geometryMode,
          orderedStops: route.ordered_stops.map((stop) => ({
            id: stop.id,
            kind: stop.kind,
            etaSeconds: stop.eta_seconds,
            orderId: stop.order_id,
            location: stop.location,
          })),
        },
        routeStatus: "normal" as const,
      };
    }),
  };
}

async function previewPaidOrderDispatch(
  world: SimulationWorld,
  orderId: string,
) {
  const targetOrder = world.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    throw new Error(`Dispatch order not found: ${orderId}`);
  }

  const targetHub = world.pickupHubs.find((hub) => hub.id === targetOrder.pickupHubId);
  if (!targetHub) {
    throw new Error(`Pickup hub ${targetOrder.pickupHubId} was not found for order ${orderId}.`);
  }

  const candidateVehicle = world.vehicles.find(
    (vehicle) =>
      vehicle.status === "idle" &&
      vehicle.routeStatus === "normal" &&
      isVehicleStagedAtHub(vehicle, targetHub.location),
  );

  if (!candidateVehicle) {
    return {
      provider: "availability-preview",
      routeCount: 0,
      assignments: 0,
      unassignedOrderIds: [orderId],
      routes: [],
    };
  }

  return requestHubScopedDispatchPlan(world, orderId);
}

export function registerReadTools(
  server: McpServer,
  options?: { allowedTools?: ReadonlySet<McpToolName> },
): void {
  const readTools: Record<McpReadToolName, (input: unknown) => Promise<ToolContentResult<ToolStructuredContent>>> = {
    get_business_snapshot: async () => {
      const [world, tick] = await Promise.all([loadSimulationWorld(), readTickState()]);
      return jsonResult(buildBusinessSnapshot(world, tick));
    },
    get_active_orders: async (input) => {
      const parsed = toolInputSchemas.get_active_orders.parse(input);
      const world = await loadSimulationWorld();
      const orders = parsed.status
        ? world.orders.filter(
            (order) =>
              order.status === parsed.status && isStripeBackedOrder(order),
          )
        : world.orders.filter((order) => isStripeBackedOrder(order));

      return jsonResult({
        orders: orders.map((order) => ({
          id: order.id,
          customerId: order.customerId,
          pickupHubId: order.pickupHubId,
          vehicleId: order.vehicleId,
          status: order.status,
          revenueCents: order.revenueCents,
        })),
      });
    },
    get_available_drivers: async () => {
      const world = await loadSimulationWorld();
      const incidentVehicleIds = new Set(
        world.vehicles.filter((vehicle) => vehicle.status === "incident").map((vehicle) => vehicle.id),
      );

      return jsonResult({
        drivers: world.drivers
          .filter((driver) => !incidentVehicleIds.has(driver.vehicleId))
          .map((driver) => ({
            id: driver.id,
            name: driver.name,
            vehicleId: driver.vehicleId,
          })),
      });
    },
    get_driver_location: async (input) => {
      const parsed = toolInputSchemas.get_driver_location.parse(input);
      const world = await loadSimulationWorld();
      const driver = world.drivers.find((candidate) => candidate.id === parsed.driverId);
      if (!driver) {
        throw new Error(`Driver not found: ${parsed.driverId}`);
      }
      const vehicle = world.vehicles.find((candidate) => candidate.driverId === parsed.driverId);
      if (!vehicle) {
        throw new Error(`Vehicle not found for driver: ${parsed.driverId}`);
      }
      const point = (vehicle.route[0] ?? [-122.4, 37.785]) as LngLat;

      return jsonResult({
        driverId: driver.id,
        vehicleId: vehicle.id,
        status: vehicle.status,
        routeStatus: vehicle.routeStatus,
        location: toLocation(point),
      });
    },
    preview_paid_order_dispatch: async (input) => {
      const parsed = toolInputSchemas.preview_paid_order_dispatch.parse(input);
      const world = await loadSimulationWorld();
      return jsonResult(await previewPaidOrderDispatch(world, parsed.orderId));
    },
    get_incident_details: async (input) => {
      const parsed = toolInputSchemas.get_incident_details.parse(input);
      const world = await loadSimulationWorld();
      const incident = world.incidents.find((candidate) => candidate.id === parsed.incidentId);
      if (!incident) {
        throw new Error(`Incident not found: ${parsed.incidentId}`);
      }

      return jsonResult({
        incident,
        orders: world.orders
          .filter((order) => incident.orderIds.includes(order.id))
          .map((order) => ({
            id: order.id,
            vehicleId: order.vehicleId,
            revenueCents: order.revenueCents,
            status: order.status,
          })),
      });
    },
    calculate_financial_exposure: async (input) => {
      const parsed = toolInputSchemas.calculate_financial_exposure.parse(input);
      const world = await loadSimulationWorld();
      const incident = world.incidents.find((candidate) => candidate.id === parsed.incidentId);
      if (!incident) {
        throw new Error(`Incident not found: ${parsed.incidentId}`);
      }
      const impactedOrders = world.orders.filter((order) => incident.orderIds.includes(order.id));
      const revenueAtRiskCents = impactedOrders.reduce((sum, order) => sum + order.revenueCents, 0);
      const estimatedRefundExposureCents =
        incident.type === "payment_declined"
          ? 0
          : Math.round(
              revenueAtRiskCents * (incident.type === "congestion" ? 0.3 : 0.6),
            );
      const estimatedReplacementCostCents =
        incident.type === "payment_declined"
          ? 0
          : incident.type === "congestion"
            ? Math.max(50, impactedOrders.length * 60)
            : impactedOrders.length * 450;

      return jsonResult({
        incidentId: incident.id,
        impactedOrderCount: impactedOrders.length,
        revenueAtRiskCents,
        estimatedRefundExposureCents,
        estimatedReplacementCostCents,
        estimatedNetExposureCents:
          estimatedRefundExposureCents + estimatedReplacementCostCents - revenueAtRiskCents,
      });
    },
    compare_recovery_options: async (input) => {
      const parsed = toolInputSchemas.compare_recovery_options.parse(input);
      const world = await loadSimulationWorld();
      const incident = world.incidents.find((candidate) => candidate.id === parsed.incidentId);
      if (!incident) {
        throw new Error(`Incident not found: ${parsed.incidentId}`);
      }
      const impactedOrderCount = incident.orderIds.length;
      const revenueAtRiskCents = world.orders
        .filter((order) => incident.orderIds.includes(order.id))
        .reduce((sum, order) => sum + order.revenueCents, 0);

      if (incident.type === "payment_declined") {
        return jsonResult({
          incidentId: incident.id,
          options: [
            {
              optionId: "send_payment_recovery_link",
              label: "Send payment recovery link",
              expectedCostCents: 0,
              expectedBenefitCents: revenueAtRiskCents,
              expectedNetBenefitCents: revenueAtRiskCents,
              expectedLateDeliveries: 0,
            },
            {
              optionId: "retry_payment_method",
              label: "Prompt customer to retry payment",
              expectedCostCents: 0,
              expectedBenefitCents: Math.round(revenueAtRiskCents * 0.9),
              expectedNetBenefitCents: Math.round(revenueAtRiskCents * 0.9),
              expectedLateDeliveries: 0,
            },
            {
              optionId: "hold_dispatch_until_paid",
              label: "Hold dispatch until paid",
              expectedCostCents: 0,
              expectedBenefitCents: Math.round(revenueAtRiskCents * 0.4),
              expectedNetBenefitCents: Math.round(revenueAtRiskCents * 0.4),
              expectedLateDeliveries: 0,
            },
          ],
        });
      }

      if (incident.type === "congestion") {
        const rerouteCostCents = Math.max(50, impactedOrderCount * 60);
        const rerouteBenefitCents = Math.max(
          200,
          Math.round(revenueAtRiskCents * 0.7),
        );
        const waitBenefitCents = Math.round(revenueAtRiskCents * 0.2);
        const reassignCostCents = Math.max(250, impactedOrderCount * 250);
        const reassignBenefitCents = Math.round(revenueAtRiskCents * 0.55);

        return jsonResult({
          incidentId: incident.id,
          options: [
            {
              optionId: "reroute_affected_vehicle",
              label: "Reroute around congestion",
              expectedCostCents: rerouteCostCents,
              expectedBenefitCents: rerouteBenefitCents,
              expectedNetBenefitCents:
                rerouteBenefitCents - rerouteCostCents,
              expectedLateDeliveries: 0,
            },
            {
              optionId: "wait_for_congestion_clear",
              label: "Wait for congestion to clear",
              expectedCostCents: 0,
              expectedBenefitCents: waitBenefitCents,
              expectedNetBenefitCents: waitBenefitCents,
              expectedLateDeliveries: impactedOrderCount,
            },
            {
              optionId: "reassign_to_nearest_vehicle",
              label: "Hand off to nearest vehicle",
              expectedCostCents: reassignCostCents,
              expectedBenefitCents: reassignBenefitCents,
              expectedNetBenefitCents:
                reassignBenefitCents - reassignCostCents,
              expectedLateDeliveries: Math.min(1, impactedOrderCount),
            },
          ],
        });
      }

      const replacementDriverPayoutCents = 400;
      const emergencyPremiumPerOrderCents = 100;

      return jsonResult({
        incidentId: incident.id,
        options: [
          {
            optionId: "one_driver_recovery",
            label: "Assign one replacement driver",
            expectedCostCents:
              replacementDriverPayoutCents +
              impactedOrderCount * emergencyPremiumPerOrderCents,
            expectedBenefitCents: impactedOrderCount * 400,
            expectedNetBenefitCents:
              impactedOrderCount * 400 -
              replacementDriverPayoutCents -
              impactedOrderCount * emergencyPremiumPerOrderCents,
            expectedLateDeliveries: Math.min(1, impactedOrderCount),
          },
          {
            optionId: "two_driver_recovery",
            label: "Split across two replacement drivers",
            expectedCostCents:
              replacementDriverPayoutCents * 2 +
              impactedOrderCount * emergencyPremiumPerOrderCents,
            expectedBenefitCents: impactedOrderCount * 400 + 800,
            expectedNetBenefitCents:
              impactedOrderCount * 400 +
              800 -
              replacementDriverPayoutCents * 2 -
              impactedOrderCount * emergencyPremiumPerOrderCents,
            expectedLateDeliveries: 0,
          },
          {
            optionId: "wait_for_original_vehicle",
            label: "Wait for original vehicle recovery",
            expectedCostCents: 0,
            expectedBenefitCents: 0,
            expectedNetBenefitCents: 0,
            expectedLateDeliveries: impactedOrderCount,
          },
        ],
      });
    },
  };

  for (const toolName of MCP_READ_TOOL_NAMES) {
    if (options?.allowedTools && !options.allowedTools.has(toolName)) {
      continue;
    }

    server.registerTool(toolName, {
      description: toolName,
      inputSchema: toolInputSchemas[toolName].shape,
      outputSchema: toolOutputSchemas[toolName].shape,
    }, withRoleAuthorization(toolName, readTools[toolName]));
  }
}

export function registerActionTools(
  server: McpServer,
  options?: { allowedTools?: ReadonlySet<McpToolName> },
): void {
  const actionTools: Record<McpActionToolName, (input: unknown) => Promise<ToolContentResult<ToolStructuredContent>>> = {
    request_route_optimisation: async (input) => {
      const parsed = toolInputSchemas.request_route_optimisation.parse(input);
      const world = await loadSimulationWorld();
      const result = await requestRouteOptimisation(
        world,
        parsed.routeStatus,
        parsed.incidentId,
      );
      await writeActionAudit({
        toolName: "request_route_optimisation",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
      });
      return jsonResult(result);
    },
    check_spending_policy: async (input) => {
      const parsed = toolInputSchemas.check_spending_policy.parse(input);
      const result = await checkSpendingPolicy(parsed);
      await writeActionAudit({
        toolName: "check_spending_policy",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
      });
      return jsonResult(result);
    },
    assign_replacement_driver: async (input) => {
      const parsed = toolInputSchemas.assign_replacement_driver.parse(input);
      await updateVehicleAssignment({
        orderIds: parsed.orderIds,
        vehicleId: parsed.vehicleId,
        routeStatus: "recovery",
      });
      const result = {
        reassignedOrderIds: parsed.orderIds,
        driverId: parsed.driverId,
        vehicleId: parsed.vehicleId,
        routeStatus: "recovery",
      };
      await writeActionAudit({
        toolName: "assign_replacement_driver",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    apply_congestion_recovery_route: async (input) => {
      const parsed = toolInputSchemas.apply_congestion_recovery_route.parse(input);
      const response = await fetch(
        new URL("/api/sim/congestion/recover", getDashboardBaseUrl()),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ incidentId: parsed.incidentId }),
        },
      );
      const payload = (await response.json()) as { error?: string } & Record<string, unknown>;
      if (!response.ok) {
        throw new Error(payload.error ?? "Congestion reroute request failed");
      }
      const result = toolOutputSchemas.apply_congestion_recovery_route.parse(payload);
      await writeActionAudit({
        toolName: "apply_congestion_recovery_route",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId,
      });
      return jsonResult(result);
    },
    apply_breakdown_recovery_reroute: async (input) => {
      const parsed = toolInputSchemas.apply_breakdown_recovery_reroute.parse(input);
      const world = await loadSimulationWorld();
      const incident = world.incidents.find((candidate) => candidate.id === parsed.incidentId);
      if (!incident) {
        throw new Error(`Incident not found: ${parsed.incidentId}`);
      }
      const brokenVehicleId = incident.vehicleId;
      if (!brokenVehicleId) {
        throw new Error(`Breakdown incident ${parsed.incidentId} is missing its affected vehicle.`);
      }

      const affectedOrderIds = new Set(incident.orderIds);
      const plannedAssignments = Array.from(
        world.orders.reduce((map, order) => {
          if (
            !affectedOrderIds.has(order.id) ||
            order.vehicleId === brokenVehicleId ||
            !["assigned", "in_transit", "paid"].includes(order.status)
          ) {
            return map;
          }

          const existing = map.get(order.vehicleId) ?? [];
          existing.push(order.id);
          map.set(order.vehicleId, existing);
          return map;
        }, new Map<string, string[]>()),
      ).map(([vehicleId, orderIds]) => ({ vehicleId, orderIds }));

      if (plannedAssignments.length < 1) {
        throw new Error(
          `No reassigned incident orders were found for ${parsed.incidentId}; run assign_replacement_driver before apply_breakdown_recovery_reroute.`,
        );
      }
      const response = await fetch(
        new URL("/api/sim/breakdown/recover", getDashboardBaseUrl()),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            incidentId: parsed.incidentId,
            plannedAssignments,
            simulatePersistFailure: parsed.simulatePersistFailure,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string } & Record<string, unknown>;
      if (!response.ok) {
        throw new Error(payload.error ?? "Breakdown reroute request failed");
      }
      const result = toolOutputSchemas.apply_breakdown_recovery_reroute.parse(payload);
      await writeActionAudit({
        toolName: "apply_breakdown_recovery_reroute",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId,
      });
      return jsonResult(result);
    },
    dispatch_paid_order: async (input) => {
      const parsed = toolInputSchemas.dispatch_paid_order.parse(input);
      const world = await loadSimulationWorld();
      const targetOrder = world.orders.find((order) => order.id === parsed.orderId);
      if (!targetOrder) {
        throw new Error(`Dispatch order not found: ${parsed.orderId}`);
      }
      if (!isStripeBackedOrder(targetOrder)) {
        throw new Error(
          `Dispatch order ${parsed.orderId} is not a Stripe-backed live order.`,
        );
      }
      if (!["paid", "assigned", "in_transit"].includes(targetOrder.status)) {
        throw new Error(
          `Dispatch order ${parsed.orderId} is not dispatchable from status ${targetOrder.status}.`,
        );
      }
      const currentAssignment = world.vehicles.find((vehicle) =>
        vehicle.routingPlan?.assignedOrderIds.includes(parsed.orderId) &&
        (vehicle.status === "en_route" || vehicle.status === "incident")
      );
      if (currentAssignment) {
        const result = {
          orderId: parsed.orderId,
          dispatched: true,
          assignedVehicleId: currentAssignment.id,
          provider: currentAssignment.routingProvider,
          routeCount: 1,
          orderAssignmentCount: 1,
          unassignedOrderIds: [],
        };
        await writeActionAudit({
          toolName: "dispatch_paid_order",
          input: asJson(parsed),
          output: asJson(result),
        });
        return jsonResult(result);
      }

      const routePlan = await requestHubScopedDispatchPlan(world, parsed.orderId);
      const assignment =
        routePlan.routes.find((route) =>
          route.routingPlan.assignedOrderIds.includes(parsed.orderId),
        ) ??
        null;
      if (assignment && targetOrder.pickupHubId) {
        const assignedVehicle = world.vehicles.find(
          (vehicle) => vehicle.id === assignment.vehicleId,
        );
        const targetHub = world.pickupHubs.find(
          (hub) => hub.id === targetOrder.pickupHubId,
        );
        if (
          !assignedVehicle ||
          !targetHub ||
          !isVehicleStagedAtHub(assignedVehicle, targetHub.location)
        ) {
          throw new Error(
            `Dispatch solver assigned ${parsed.orderId} to ${assignment?.vehicleId ?? "unknown"}, but that vehicle is not staged at ${targetHub?.name ?? targetOrder.pickupHubId}.`,
          );
        }
      }
      const persisted = await persistDispatchPlan({
        provider: routePlan.provider as SimulationWorld["vehicles"][number]["routingProvider"],
        assignments: routePlan.routes.flatMap((route) =>
          route.routingPlan.assignedOrderIds.map((orderId) => ({
            orderId,
            vehicleId: route.vehicleId,
          })),
        ),
        routes: routePlan.routes.map((route) => ({
          vehicleId: route.vehicleId,
          route: route.route,
          routingPlan: {
            ...route.routingPlan,
            provider: route.routingPlan.provider as SimulationWorld["vehicles"][number]["routingProvider"],
          },
          routeStatus: route.routeStatus as SimulationWorld["vehicles"][number]["routeStatus"],
        })),
      });

      const result = {
        orderId: parsed.orderId,
        dispatched: assignment !== null,
        assignedVehicleId: assignment?.vehicleId ?? null,
        provider: persisted.provider,
        routeCount: persisted.routeCount,
        orderAssignmentCount: persisted.orderAssignmentCount,
        unassignedOrderIds: routePlan.unassignedOrderIds,
      };
      await writeActionAudit({
        toolName: "dispatch_paid_order",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    provision_event_surge_capacity: async (input) => {
      const parsed = toolInputSchemas.provision_event_surge_capacity.parse(input);
      const tick = await readTickState();
      const minimumSimSeconds = Math.max(0, tick.elapsedSeconds - parsed.windowSeconds);
      const observedEventCount = await countSimulationEvents({
        eventType: parsed.eventType,
        minimumSimSeconds,
      });

      if (observedEventCount < parsed.threshold) {
        const denied = {
          created: false,
          triggered: false,
          eventType: parsed.eventType,
          observedEventCount,
          threshold: parsed.threshold,
          windowSeconds: parsed.windowSeconds,
          amountCents: parsed.amountCents,
          serviceCategory: parsed.serviceCategory,
          idempotencyKey: parsed.idempotencyKey,
          stripeProductId: null,
          stripePriceId: null,
          policy: {
            allowed: false,
            reason: `Denied: only ${observedEventCount} ${parsed.eventType} events in ${parsed.windowSeconds}s; threshold is ${parsed.threshold}`,
          },
          note:
            "Stripe Projects provisioning pattern - KYC gate prevented direct CLI usage in sandbox; threshold was not met so no Stripe Billing artifact was created.",
        };
        await writeActionAudit({
          toolName: "provision_event_surge_capacity",
          input: asJson(parsed),
          output: asJson(denied),
          incidentId: parsed.incidentId ?? null,
          idempotencyKey: parsed.idempotencyKey,
        });
        return jsonResult(denied);
      }

      const policy = await checkSpendingPolicy({
        actionType: "provision_event_surge_capacity",
        amountCents: parsed.amountCents,
        incidentId: parsed.incidentId,
      });
      if (!policy.allowed) {
        const denied = {
          created: false,
          triggered: true,
          eventType: parsed.eventType,
          observedEventCount,
          threshold: parsed.threshold,
          windowSeconds: parsed.windowSeconds,
          amountCents: parsed.amountCents,
          serviceCategory: parsed.serviceCategory,
          idempotencyKey: parsed.idempotencyKey,
          stripeProductId: null,
          stripePriceId: null,
          policy: { allowed: false, reason: policy.reason },
          note:
            "Stripe Projects provisioning pattern - KYC gate prevented direct CLI usage in sandbox; spend policy denied the equivalent Billing artifact.",
        };
        await writeActionAudit({
          toolName: "provision_event_surge_capacity",
          input: asJson(parsed),
          output: asJson(denied),
          incidentId: parsed.incidentId ?? null,
          idempotencyKey: parsed.idempotencyKey,
        });
        return jsonResult(denied);
      }

      const artifact = await createInfrastructureUpgradeBillingArtifact(getStripeBillingClient(), {
        amountCents: parsed.amountCents,
        eventType: parsed.eventType,
        idempotencyKey: parsed.idempotencyKey,
        observedEventCount,
        serviceCategory: parsed.serviceCategory,
        threshold: parsed.threshold,
        windowSeconds: parsed.windowSeconds,
      });
      const ledger = await insertLedgerEntry({
        entryType: "stripe_projects_pattern_upgrade",
        amountCents: parsed.amountCents,
        referenceId: parsed.serviceCategory,
        idempotencyKey: parsed.idempotencyKey,
        stripeReference: artifact.price.id,
        metadata: {
          incidentId: parsed.incidentId ?? null,
          eventType: parsed.eventType,
          observedEventCount,
          serviceCategory: parsed.serviceCategory,
          stripeProductId: artifact.product.id,
          stripePriceId: artifact.price.id,
          threshold: parsed.threshold,
          windowSeconds: parsed.windowSeconds,
          note:
            "Stripe Projects provisioning pattern - KYC gate prevented direct CLI usage in sandbox; equivalent workflow recorded via Stripe Billing artifact.",
        },
      });
      const result = {
        created: ledger.created,
        triggered: true,
        eventType: parsed.eventType,
        observedEventCount,
        threshold: parsed.threshold,
        windowSeconds: parsed.windowSeconds,
        amountCents: parsed.amountCents,
        serviceCategory: parsed.serviceCategory,
        idempotencyKey: parsed.idempotencyKey,
        stripeProductId: artifact.product.id,
        stripePriceId: ledger.stripeReference ?? artifact.price.id,
        policy: { allowed: true, reason: policy.reason },
        note:
          "Stripe Projects provisioning pattern - KYC gate prevented direct CLI usage in sandbox; equivalent workflow executed via Stripe Billing.",
      };
      await writeActionAudit({
        toolName: "provision_event_surge_capacity",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
        idempotencyKey: parsed.idempotencyKey,
      });
      return jsonResult(result);
    },
    provision_infrastructure: async (input) => {
      const parsed = toolInputSchemas.provision_infrastructure.parse(input);
      const triggerThreshold = parsed.infraType === "queue" ? 5 : 3;
      const observedCount = await countAllSimulationEvents();
      const triggered = observedCount >= triggerThreshold;

      if (!triggered) {
        const denied = {
          created: false,
          triggered: false,
          infraType: parsed.infraType,
          triggerReason: parsed.triggerReason,
          triggerMetric: {
            source: "simulation_events.total_count",
            observedCount,
            threshold: triggerThreshold,
          },
          ledgerRowId: null,
          stripeReference: null,
          projectStatus: {},
          policy: {
            allowed: false,
            reason:
              `Denied: simulation_events total count ${observedCount} is below the ` +
              `${triggerThreshold} threshold for ${parsed.infraType}`,
          },
        };
        await writeActionAudit({
          toolName: "provision_infrastructure",
          input: asJson(parsed),
          output: asJson(denied),
          incidentId: parsed.incidentId ?? null,
        });
        return jsonResult(denied);
      }

      const policy = await checkSpendingPolicy({
        actionType: "provision_infrastructure",
        amountCents: 0,
        incidentId: parsed.incidentId,
      });

      const { projectId, status } = await getStripeProjectsStatus(resolve(process.cwd(), "..", ".."));
      const idempotencyKey = buildDeterministicIdempotencyKey([
        "provision_infrastructure",
        parsed.infraType,
        parsed.triggerReason,
        projectId,
      ]);

      const reason =
        parsed.infraType === "queue"
          ? "Provisioned inngest/app queue infrastructure in response to rising event volume"
          : "Provisioned observability infrastructure in response to rising event volume";

      const ledger = await insertLedgerEntry({
        entryType: "provision_infrastructure",
        amountCents: 0,
        referenceId: parsed.infraType,
        idempotencyKey,
        stripeReference: projectId,
        metadata: {
          actionType: "provision_infrastructure",
          allowed: policy.allowed,
          infraType: parsed.infraType,
          projectId,
          projectStatus: asJson(status),
          reason,
          triggerMetric: {
            source: "simulation_events.total_count",
            observedCount,
            threshold: triggerThreshold,
          },
          triggerReason: parsed.triggerReason,
        },
      });

      const result = {
        created: ledger.created,
        triggered: true,
        infraType: parsed.infraType,
        triggerReason: parsed.triggerReason,
        triggerMetric: {
          source: "simulation_events.total_count",
          observedCount,
          threshold: triggerThreshold,
        },
        ledgerRowId: ledger.id,
        stripeReference: ledger.stripeReference ?? projectId,
        projectStatus: status,
        policy: {
          allowed: policy.allowed,
          reason,
        },
      };
      await writeActionAudit({
        toolName: "provision_infrastructure",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
        idempotencyKey,
      });
      return jsonResult(result);
    },
    create_driver_payout: async (input) => {
      const parsed = toolInputSchemas.create_driver_payout.parse(input);
      const policy = await checkSpendingPolicy({
        actionType: "create_driver_payout",
        amountCents: parsed.amountCents,
        incidentId: parsed.incidentId,
      });
      if (!policy.allowed) {
        const denied = {
          created: false,
          driverId: parsed.driverId,
          amountCents: parsed.amountCents,
          idempotencyKey: parsed.idempotencyKey,
          stripeTransferId: null,
          policy: { allowed: false, reason: policy.reason },
        };
        await writeActionAudit({
          toolName: "create_driver_payout",
          input: asJson(parsed),
          output: asJson(denied),
          incidentId: parsed.incidentId ?? null,
          idempotencyKey: parsed.idempotencyKey,
        });
        return jsonResult(denied);
      }
      const driver = await getDriverById(parsed.driverId);
      if (!driver.stripePayoutAccountId) {
        throw new Error(
          `Driver ${parsed.driverId} does not have a Stripe payout account. Run the payout account provisioning script first.`,
        );
      }
      const stripeClient = getStripeClient();
      const existingTransfer =
        await findDriverPayoutTransferByAppIdempotencyKey(
          stripeClient,
          parsed.idempotencyKey,
        );
      const transfer = existingTransfer ?? await createDriverPayoutTransfer(stripeClient, {
        amountCents: parsed.amountCents,
        payoutAccountId: driver.stripePayoutAccountId,
        appIdempotencyKey: parsed.idempotencyKey,
        stripeIdempotencyKey: buildDeterministicIdempotencyKey([
          parsed.idempotencyKey,
          "stripe-transfer-retryable",
          Date.now().toString(),
        ]),
        incidentId: parsed.incidentId ?? null,
        driverId: parsed.driverId,
      });
      const ledger = await insertLedgerEntry({
        entryType: "driver_payout",
        amountCents: parsed.amountCents,
        referenceId: parsed.driverId,
        idempotencyKey: parsed.idempotencyKey,
        stripeReference: transfer.id,
        metadata: {
          driverId: parsed.driverId,
          incidentId: parsed.incidentId ?? null,
          stripePayoutAccountId: driver.stripePayoutAccountId,
        },
      });
      const result = {
        created: ledger.created,
        driverId: parsed.driverId,
        amountCents: parsed.amountCents,
        idempotencyKey: parsed.idempotencyKey,
        stripeTransferId: ledger.stripeReference ?? transfer.id,
        policy: { allowed: true, reason: policy.reason },
      };
      await writeActionAudit({
        toolName: "create_driver_payout",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
        idempotencyKey: parsed.idempotencyKey,
      });
      return jsonResult(result);
    },
    issue_customer_refund: async (input) => {
      const parsed = toolInputSchemas.issue_customer_refund.parse(input);
      const policy = await checkSpendingPolicy({
        actionType: "issue_customer_refund",
        amountCents: parsed.amountCents,
        incidentId: parsed.incidentId,
      });
      if (!policy.allowed) {
        const denied = {
          created: false,
          orderId: parsed.orderId,
          amountCents: parsed.amountCents,
          idempotencyKey: parsed.idempotencyKey,
          policy: { allowed: false, reason: policy.reason },
        };
        await writeActionAudit({
          toolName: "issue_customer_refund",
          input: asJson(parsed),
          output: asJson(denied),
          incidentId: parsed.incidentId ?? null,
          idempotencyKey: parsed.idempotencyKey,
        });
        return jsonResult(denied);
      }
      const ledger = await insertLedgerEntry({
        entryType: "customer_refund",
        amountCents: parsed.amountCents,
        referenceId: parsed.orderId,
        idempotencyKey: parsed.idempotencyKey,
        metadata: {
          orderId: parsed.orderId,
          incidentId: parsed.incidentId ?? null,
        },
      });
      const result = {
        created: ledger.created,
        orderId: parsed.orderId,
        amountCents: parsed.amountCents,
        idempotencyKey: parsed.idempotencyKey,
        policy: { allowed: true, reason: policy.reason },
      };
      await writeActionAudit({
        toolName: "issue_customer_refund",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
        idempotencyKey: parsed.idempotencyKey,
      });
      return jsonResult(result);
    },
    ensure_pending_checkout_order: async (input) => {
      const parsed = toolInputSchemas.ensure_pending_checkout_order.parse(input);
      const supabase = getSupabaseAdminClient();
      const placeholderVehicleId =
        parsed.metadata.vehicleId ?? (await getPlaceholderCheckoutVehicleId());

      const existing = await supabase
        .from("orders")
        .select("id,status")
        .eq("id", parsed.metadata.orderId)
        .maybeSingle<{ id: string; status: string }>();

      if (existing.error) {
        throw new Error(
          `Failed to load checkout order ${parsed.metadata.orderId}: ${existing.error.message}`,
        );
      }

      if (existing.data) {
        const nextStatus = existing.data.status === "paid" ? "paid" : "pending";
        const { error: updateError } = await supabase
          .from("orders")
          .update({
            status: nextStatus,
            stripe_checkout_session_id: parsed.stripeCheckoutSessionId,
            revenue_cents: parsed.metadata.quotedPriceCents,
          })
          .eq("id", parsed.metadata.orderId);

        if (updateError) {
          throw new Error(`Failed to update pending checkout order: ${updateError.message}`);
        }

        const result = {
          orderId: parsed.metadata.orderId,
          created: false,
          status: nextStatus,
        };
        await writeActionAudit({
          toolName: "ensure_pending_checkout_order",
          input: asJson(parsed),
          output: asJson(result),
        });
        return jsonResult(result);
      }

      const insertResult = await supabase
        .from("orders")
        .insert({
          id: parsed.metadata.orderId,
          customer_id: parsed.metadata.customerId,
          pickup_hub_id: parsed.metadata.pickupHubId,
          vehicle_id: placeholderVehicleId,
          status: "pending",
          revenue_cents: parsed.metadata.quotedPriceCents,
          stripe_checkout_session_id: parsed.stripeCheckoutSessionId,
        })
        .select("id")
        .single<{ id: string }>();

      if (insertResult.error) {
        throw new Error(`Failed to create pending checkout order: ${insertResult.error.message}`);
      }

      await insertSimulationEvent({
        eventType: "checkout_order_pending_created",
        payload: {
          orderId: insertResult.data.id,
          source: "stripe_checkout",
          customerId: parsed.metadata.customerId,
          pickupHubId: parsed.metadata.pickupHubId,
          quotedPriceCents: parsed.metadata.quotedPriceCents,
          stripeCheckoutSessionId: parsed.stripeCheckoutSessionId,
        },
      });

      const result = {
        orderId: insertResult.data.id,
        created: true,
        status: "pending",
      };
      await writeActionAudit({
        toolName: "ensure_pending_checkout_order",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    mark_checkout_order_paid: async (input) => {
      const parsed = toolInputSchemas.mark_checkout_order_paid.parse(input);
      const existingPaidOrder = await findExistingPaidCheckoutOrder({
        stripeEventId: parsed.stripeEventId,
        stripePaymentIntentId: parsed.stripePaymentIntentId,
        stripeCheckoutSessionId: parsed.stripeCheckoutSessionId,
      });

      if (existingPaidOrder) {
        const result = {
          orderId: existingPaidOrder.id,
          created: false,
          status: "paid",
          resolvedIncidentId: null,
        };
        await writeActionAudit({
          toolName: "mark_checkout_order_paid",
          input: asJson(parsed),
          output: asJson(result),
        });
        return jsonResult(result);
      }

      const supabase = getSupabaseAdminClient();
      const pendingOrder = await supabase
        .from("orders")
        .select("id,status")
        .eq("id", parsed.metadata.orderId)
        .maybeSingle<{ id: string; status: string }>();

      if (pendingOrder.error) {
        throw new Error(`Failed to load pending checkout order: ${pendingOrder.error.message}`);
      }

      if (pendingOrder.data) {
        const previousStatus = pendingOrder.data.status;
        const nextStatus =
          previousStatus === "pending" || previousStatus === "paid"
            ? "paid"
            : previousStatus;
        const { error: updateError } = await supabase
          .from("orders")
          .update({
            status: nextStatus,
            revenue_cents: parsed.metadata.quotedPriceCents,
            stripe_checkout_session_id: parsed.stripeCheckoutSessionId,
            stripe_payment_intent_id: parsed.stripePaymentIntentId,
            stripe_event_id: parsed.stripeEventId,
          })
          .eq("id", parsed.metadata.orderId);

        if (updateError) {
          throw new Error(`Failed to mark checkout order paid: ${updateError.message}`);
        }

        let resolvedIncidentId: string | null = null;
        if (previousStatus === "pending") {
          await insertSimulationEvent({
            eventType: "checkout_order_paid",
            payload: {
              orderId: parsed.metadata.orderId,
              source: "stripe_checkout",
              quotedPriceCents: parsed.metadata.quotedPriceCents,
              stripeCheckoutSessionId: parsed.stripeCheckoutSessionId,
              stripePaymentIntentId: parsed.stripePaymentIntentId,
              stripeEventId: parsed.stripeEventId,
            },
          });

          resolvedIncidentId = await findLatestPaymentDeclinedIncidentId(
            parsed.metadata.orderId,
          );
          if (resolvedIncidentId) {
            await insertSimulationEvent({
              eventType: "payment_recovery_completed",
              payload: {
                incidentId: resolvedIncidentId,
                incidentType: "payment_declined",
                orderIds: [parsed.metadata.orderId],
                stripeCheckoutSessionId: parsed.stripeCheckoutSessionId,
                stripePaymentIntentId: parsed.stripePaymentIntentId,
                stripeEventId: parsed.stripeEventId,
                resolutionSource: "stripe_checkout_completed",
              },
            });
          }
        }

        const result = {
          orderId: parsed.metadata.orderId,
          created: previousStatus === "pending",
          status: nextStatus,
          resolvedIncidentId,
        };
        await writeActionAudit({
          toolName: "mark_checkout_order_paid",
          input: asJson(parsed),
          output: asJson(result),
        });
        return jsonResult(result);
      }

      const placeholderVehicleId =
        parsed.metadata.vehicleId ?? (await getPlaceholderCheckoutVehicleId());
      const insertResult = await supabase
        .from("orders")
        .insert({
          id: parsed.metadata.orderId,
          customer_id: parsed.metadata.customerId,
          pickup_hub_id: parsed.metadata.pickupHubId,
          vehicle_id: placeholderVehicleId,
          status: "paid",
          revenue_cents: parsed.metadata.quotedPriceCents,
          stripe_checkout_session_id: parsed.stripeCheckoutSessionId,
          stripe_payment_intent_id: parsed.stripePaymentIntentId,
          stripe_event_id: parsed.stripeEventId,
        })
        .select("id")
        .single<{ id: string }>();

      if (insertResult.error) {
        throw new Error(`Failed to create paid order: ${insertResult.error.message}`);
      }

      await insertSimulationEvent({
        eventType: "checkout_order_paid",
        payload: {
          orderId: insertResult.data.id,
          source: "stripe_checkout",
          quotedPriceCents: parsed.metadata.quotedPriceCents,
          stripeCheckoutSessionId: parsed.stripeCheckoutSessionId,
          stripePaymentIntentId: parsed.stripePaymentIntentId,
          stripeEventId: parsed.stripeEventId,
        },
      });

      const result = {
        orderId: insertResult.data.id,
        created: true,
        status: "paid",
        resolvedIncidentId: null,
      };
      await writeActionAudit({
        toolName: "mark_checkout_order_paid",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    record_payment_declined_incident: async (input) => {
      const parsed = toolInputSchemas.record_payment_declined_incident.parse(input);
      const result = await recordDeclinedCheckoutIncident(parsed);
      const payload = {
        ...result,
        orderId: parsed.orderId,
      };
      await writeActionAudit({
        toolName: "record_payment_declined_incident",
        input: asJson(parsed),
        output: asJson(payload),
        incidentId: result.incidentId,
      });
      return jsonResult(payload);
    },
    send_customer_notification: async (input) => {
      const parsed = toolInputSchemas.send_customer_notification.parse(input);
      await insertCustomerNotification(parsed);
      const result = {
        orderId: parsed.orderId,
        channel: parsed.channel,
        message: parsed.message,
        delivered: true,
      };
      await writeActionAudit({
        toolName: "send_customer_notification",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    record_operational_event: async (input) => {
      const parsed = toolInputSchemas.record_operational_event.parse(input);
      await insertSimulationEvent({
        eventType: parsed.eventType,
        payload: parsed.payload as Json,
      });
      const result = {
        recorded: true,
        eventType: parsed.eventType,
      };
      const incidentId =
        typeof parsed.payload.incidentId === "string"
          ? parsed.payload.incidentId
          : null;
      await writeActionAudit({
        toolName: "record_operational_event",
        input: asJson(parsed),
        output: asJson(result),
        incidentId,
      });
      return jsonResult(result);
    },
    complete_delivery_recovery: async (input) => {
      const parsed = toolInputSchemas.complete_delivery_recovery.parse(input);
      const incidentCreatedAt = await getIncidentCreatedAt(parsed.incidentId);
      await waitForDemoRecoveryWindow(incidentCreatedAt);
      await completeSimulatedRecovery({
        orderIds: parsed.orderIds,
        vehicleIds: parsed.vehicleIds,
        incidentId: parsed.incidentId,
        incidentVehicleId: parsed.incidentVehicleId,
      });
      const result = {
        completed: true,
        incidentId: parsed.incidentId,
        recoveredOrderIds: parsed.orderIds,
        replacementVehicleIds: parsed.vehicleIds,
        incidentVehicleId: parsed.incidentVehicleId,
      };
      await writeActionAudit({
        toolName: "complete_delivery_recovery",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId,
      });
      return jsonResult(result);
    },
    verify_delivery_recovery: async (input) => {
      const parsed = toolInputSchemas.verify_delivery_recovery.parse(input);
      const world = await loadSimulationWorld();
      const recoveredOrderIds = world.orders
        .filter((order) => parsed.orderIds.includes(order.id) && order.status === "delivered")
        .map((order) => order.id);
      const unresolvedOrderIds = parsed.orderIds.filter((orderId) => !recoveredOrderIds.includes(orderId));
      const result = {
        recovered: unresolvedOrderIds.length === 0,
        recoveredOrderIds,
        unresolvedOrderIds,
      };
      await writeActionAudit({
        toolName: "verify_delivery_recovery",
        input: asJson(parsed),
        output: asJson(result),
      });
      return jsonResult(result);
    },
    record_agent_decision: async (input) => {
      const parsed = toolInputSchemas.record_agent_decision.parse(input);
      await insertAgentDecision({
        incidentId: parsed.incidentId ?? null,
        reasoningSummary: parsed.reasoningSummary,
        options: asJson(parsed.options),
        selectedOption: asJson(parsed.selectedOption),
        expectedCostCents: parsed.expectedCostCents ?? null,
        expectedBenefitCents: parsed.expectedBenefitCents ?? null,
        policyResult: parsed.policyResult ?? null,
      });
      const result = {
        recorded: true,
        incidentId: parsed.incidentId ?? null,
      };
      await writeActionAudit({
        toolName: "record_agent_decision",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
      });
      return jsonResult(result);
    },
    create_recovery_skill: async (input) => {
      const parsed = toolInputSchemas.create_recovery_skill.parse(input);
      const incidentType = await resolveIncidentTypeForSkill({
        incidentId: parsed.incidentId,
        incidentType: parsed.incidentType,
      });
      const { skillDir, skillPath, metadataPath } =
        getRecoverySkillStoragePaths(incidentType);
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, parsed.markdown, "utf8");
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            skillName: parsed.skillName,
            incidentId: parsed.incidentId ?? null,
            incidentType,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      const result = {
        written: true,
        skillPath,
        skillName: parsed.skillName,
        metadataPath,
      };
      await writeActionAudit({
        toolName: "create_recovery_skill",
        input: asJson(parsed),
        output: asJson(result),
        incidentId: parsed.incidentId ?? null,
      });
      return jsonResult(result);
    },
  };

  for (const toolName of MCP_ACTION_TOOL_NAMES) {
    if (options?.allowedTools && !options.allowedTools.has(toolName)) {
      continue;
    }

    server.registerTool(toolName, {
      description: toolName,
      inputSchema: toolInputSchemas[toolName].shape,
      outputSchema: toolOutputSchemas[toolName].shape,
    }, withRoleAuthorization(toolName, actionTools[toolName]));
  }
}
