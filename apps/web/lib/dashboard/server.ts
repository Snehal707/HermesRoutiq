import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadPersistedSimulation, readRoutingPlanningState } from "@/lib/sim/persistence";
import type {
  DashboardActiveIncident,
  DashboardCurrentRequest,
  DashboardSnapshot,
} from "./types";
import type { Json } from "@/lib/supabase/database.types";
import {
  isStripeBackedOperationalOrder,
  isStripeBackedOrder,
} from "@hermes-routiq/shared";

// Match the frontend Operations panel: only orders already assigned to a driver
// or currently moving should count as active fleet deliveries.
const ACTIVE_ORDER_STATUSES = new Set(["assigned", "in_transit"]);
const INCIDENT_ORDER_STATUSES = new Set(["assigned", "in_transit", "delivered"]);
const PAYOUT_ENTRY_TYPES = new Set(["driver_payout", "customer_refund"]);
const INCIDENT_SPEND_ENTRY_TYPES = new Set([
  "driver_payout",
  "emergency_premium",
  "reroute_cost",
]);

interface OrderRow {
  id: string;
  customer_id: string;
  pickup_hub_id: string;
  status: string;
  revenue_cents: number;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
}

interface CustomerRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface PickupHubRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface LedgerRow {
  id: string;
  entry_type: string;
  amount_cents: number;
  stripe_reference: string | null;
  created_at: string;
  metadata: Json | null;
}

interface IncidentRow {
  id: string;
  type: string;
  order_ids: string[];
  created_at: string;
}

interface PolicyEvaluationRow {
  id: string;
  action_type: string;
  amount_cents: number;
  allowed: boolean;
  reason: string | null;
  incident_id: string | null;
  created_at: string;
}

interface SimulationEventRow {
  event_type: string;
  payload: Json;
  created_at: string;
}

function buildEmptyDashboardSnapshot(): DashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    headline: {
      walletBalanceCents: 0,
      activeDeliveries: 0,
      activeIncidents: 0,
      expectedProfitCents: 0,
      paidRevenueCents: 0,
      operatingCostCents: 0,
    },
    currentRequest: null,
    requestHistory: [],
    activeIncident: null,
    policyEvaluations: [],
    agentTimeline: [],
    stripeTransactions: [],
    finalRecoveryReport: null,
  };
}

function summarizeTimelineValue(
  value: Json | undefined,
): Json | undefined {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }

    if (
      value.every(
        (entry) =>
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      )
    ) {
      return value.length <= 4
        ? value
        : `${value.length} items`;
    }

    return `${value.length} items`;
  }

  if (typeof value !== "object") {
    return value;
  }

  const record = asRecord(value);
  const summarized: Record<string, Json | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "route" ||
      key === "routes" ||
      key === "orderedStops" ||
      key === "assignments" ||
      key === "unassignedOrderIds"
    ) {
      summarized[key] = Array.isArray(entry) ? `${entry.length} items` : "present";
      continue;
    }

    if (key === "routingPlan" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      const plan = asRecord(entry as Json);
      summarized[key] = {
        provider: payloadString(plan, "provider"),
        geometryMode: payloadString(plan, "geometryMode"),
        assignedOrderIds: Array.isArray(plan.assignedOrderIds)
          ? `${plan.assignedOrderIds.length} items`
          : undefined,
        totalDistanceMeters:
          typeof plan.totalDistanceMeters === "number" ? plan.totalDistanceMeters : undefined,
        totalDurationSeconds:
          typeof plan.totalDurationSeconds === "number" ? plan.totalDurationSeconds : undefined,
      };
      continue;
    }

    summarized[key] = summarizeTimelineValue(entry);
  }

  return summarized;
}

function summarizeTimelineRecord(
  value: Json | undefined,
): Record<string, Json | undefined> {
  return asRecord(summarizeTimelineValue(value) as Json | undefined);
}

function latestOrderEvent(
  events: SimulationEventRow[],
  orderId: string,
  eventTypes: string[],
): SimulationEventRow | null {
  return [...events]
    .filter((event) => eventTypes.includes(event.event_type))
    .filter((event) => payloadString(asRecord(event.payload), "orderId") === orderId)
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
    )[0] ?? null;
}

function toAgentTimelineItem(event: SimulationEventRow, index: number) {
  const payload = asRecord(event.payload);
  return {
    id: `${event.event_type}:${event.created_at}:${index}`,
    toolName: event.event_type.replace(/^mcp\./, ""),
    incidentId:
      typeof payload.incidentId === "string"
        ? payload.incidentId
        : null,
    idempotencyKey:
      typeof payload.idempotencyKey === "string"
        ? payload.idempotencyKey
        : null,
    input: summarizeTimelineRecord(payload.input as Json | undefined),
    output: summarizeTimelineRecord(payload.output as Json | undefined),
    createdAt: event.created_at,
  };
}

function toOrderRecord(order: OrderRow) {
  return {
    id: order.id,
    customerId: order.customer_id,
    pickupHubId: order.pickup_hub_id,
    vehicleId: "",
    status: order.status as never,
    revenueCents: order.revenue_cents,
    stripeCheckoutSessionId: order.stripe_checkout_session_id,
    stripePaymentIntentId: order.stripe_payment_intent_id,
  };
}

function formatDestinationLabel(customer: CustomerRow | undefined): string | null {
  if (!customer) {
    return null;
  }

  return `${customer.lat.toFixed(5)}, ${customer.lng.toFixed(5)}`;
}

function haversineMeters(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
): number {
  const lat1 = (start.lat * Math.PI) / 180;
  const lat2 = (end.lat * Math.PI) / 180;
  const dLat = ((end.lat - start.lat) * Math.PI) / 180;
  const dLng = ((end.lng - start.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6_371_000 * c;
}

function isAgentAuditEvent(eventType: string): boolean {
  return eventType.startsWith("mcp.");
}

function asRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function payloadNumber(
  payload: Record<string, Json | undefined>,
  key: string,
): number | null {
  return typeof payload[key] === "number" ? (payload[key] as number) : null;
}

function payloadString(
  payload: Record<string, Json | undefined>,
  key: string,
): string | null {
  return typeof payload[key] === "string" ? (payload[key] as string) : null;
}

function payloadRecordArray(
  payload: Record<string, Json | undefined>,
  key: string,
): Array<Record<string, Json | undefined>> {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => asRecord(entry as Json));
}

function getResolvedIncidentIds(params: {
  incidents: IncidentRow[];
  orders: OrderRow[];
  simulationEvents: SimulationEventRow[];
}): Set<string> {
  const paidOrClosedOrderIds = new Set(
    params.orders
      .filter((order) =>
        ["paid", "assigned", "in_transit", "delivered", "cancelled"].includes(
          order.status,
        ),
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
        return order ? ["delivered", "cancelled"].includes(order.status) : false;
      }),
    )
    .map((incident) => incident.id);

  return new Set([
    ...paymentResolvedIds,
    ...completedOperationalIncidentIds,
  ]);
}

function deriveRequestFunnelStatus(params: {
  orderId: string;
  order: OrderRow | null;
  resolvedIncidentIds: Set<string>;
  incidents: IncidentRow[];
}): "pending" | "declined" | "paid" | "recovered" {
  const relatedIncident = params.incidents.find((incident) =>
    incident.order_ids.includes(params.orderId),
  );

  if (relatedIncident) {
    if (
      params.resolvedIncidentIds.has(relatedIncident.id)
    ) {
      return "recovered";
    }

    if (relatedIncident.type === "payment_declined") {
      return "declined";
    }
  }

  if (
    params.order &&
    ["paid", "assigned", "in_transit", "delivered"].includes(params.order.status)
  ) {
    return "paid";
  }

  return "pending";
}

function buildCurrentRequestSummary(params: {
  orderId: string;
  payload: Record<string, Json | undefined>;
  orderReferenceById: Map<string, {
    id: string;
    customerLabel: string | null;
    pickupHubLabel: string | null;
    destinationLabel: string | null;
    status: string;
  }>;
  orders: OrderRow[];
  resolvedIncidentIds: Set<string>;
  incidents: IncidentRow[];
  simulationEvents: SimulationEventRow[];
}) {
  const orderReference = params.orderReferenceById.get(params.orderId) ?? null;
  const order = params.orders.find((candidate) => candidate.id === params.orderId) ?? null;
  const contextRefs = payloadRecordArray(params.payload, "contextRefs").map((entry, index) => ({
    id: payloadString(entry, "id") ?? `${params.orderId}:context:${index}`,
    type: payloadString(entry, "type") ?? "unknown",
    summary: payloadString(entry, "summary") ?? "No summary available.",
  }));
  const skillRefs = payloadRecordArray(params.payload, "skillRefs").map((entry, index) => ({
    name: payloadString(entry, "name") ?? `skill_${index + 1}`,
    source: payloadString(entry, "source"),
    summary: payloadString(entry, "summary") ?? "No summary available.",
  }));
  const plannedTools = payloadRecordArray(params.payload, "plannedTools").map((entry, index) => ({
    tool: payloadString(entry, "tool") ?? `tool_${index + 1}`,
    purpose: payloadString(entry, "purpose") ?? "No purpose available.",
  }));
  const dispatchRequestedEvent = latestOrderEvent(
    params.simulationEvents,
    params.orderId,
    ["checkout_order_dispatch_requested"],
  );
  const dispatchCompletedEvent = latestOrderEvent(
    params.simulationEvents,
    params.orderId,
    ["checkout_order_dispatched"],
  );
  const dispatchFailedEvent = latestOrderEvent(
    params.simulationEvents,
    params.orderId,
    ["checkout_order_dispatch_failed"],
  );
  const dispatchRequestedAt = dispatchRequestedEvent
    ? new Date(dispatchRequestedEvent.created_at).getTime()
    : null;
  const dispatchCompletedAt = dispatchCompletedEvent
    ? new Date(dispatchCompletedEvent.created_at).getTime()
    : null;
  const dispatchFailedAt = dispatchFailedEvent
    ? new Date(dispatchFailedEvent.created_at).getTime()
    : null;
  const latestDispatchPayload =
    dispatchFailedAt !== null &&
    dispatchFailedAt >= (dispatchCompletedAt ?? -1) &&
    dispatchFailedAt >= (dispatchRequestedAt ?? -1)
      ? asRecord(dispatchFailedEvent?.payload)
      : dispatchCompletedAt !== null &&
          dispatchCompletedAt >= (dispatchRequestedAt ?? -1)
        ? asRecord(dispatchCompletedEvent?.payload)
        : {};
  const dispatchContextRefs = payloadRecordArray(
    latestDispatchPayload,
    "contextRefs",
  ).map((entry, index) => ({
    id: payloadString(entry, "id") ?? `${params.orderId}:dispatch-context:${index}`,
    type: payloadString(entry, "type") ?? "unknown",
    summary: payloadString(entry, "summary") ?? "No summary available.",
  }));
  const dispatchSkillRefs = payloadRecordArray(
    latestDispatchPayload,
    "skillRefs",
  ).map((entry, index) => ({
    name: payloadString(entry, "name") ?? `dispatch_skill_${index + 1}`,
    source: payloadString(entry, "source"),
    summary: payloadString(entry, "summary") ?? "No summary available.",
  }));
  const dispatchPlannedTools = payloadRecordArray(
    latestDispatchPayload,
    "plannedTools",
  ).map((entry, index) => ({
    tool: payloadString(entry, "tool") ?? `dispatch_tool_${index + 1}`,
    purpose: payloadString(entry, "purpose") ?? "No purpose available.",
  }));
  const dispatchStatus: "idle" | "reasoning" | "released" | "held" | "failed" =
    dispatchFailedAt !== null &&
    dispatchFailedAt >= (dispatchCompletedAt ?? -1) &&
    dispatchFailedAt >= (dispatchRequestedAt ?? -1)
      ? "failed"
      : dispatchCompletedAt !== null &&
          dispatchCompletedAt >= (dispatchRequestedAt ?? -1)
        ? latestDispatchPayload.dispatched === true
          ? "released"
          : payloadString(latestDispatchPayload, "selectedStrategy") === "hold_for_capacity"
            ? "held"
            : "held"
        : dispatchRequestedAt !== null
          ? "reasoning"
          : "idle";

  return {
    orderId: params.orderId,
    customerLabel: orderReference?.customerLabel ?? null,
    pickupHubLabel: orderReference?.pickupHubLabel ?? null,
    destinationLabel: orderReference?.destinationLabel ?? null,
    quotedPriceCents: payloadNumber(params.payload, "quotedPriceCents"),
    baselineQuoteCents: payloadNumber(params.payload, "baselineQuoteCents"),
    estimatedDistanceKm: payloadNumber(params.payload, "estimatedDistanceKm"),
    strategy:
      payloadString(params.payload, "strategy"),
    accepted:
      typeof params.payload.accepted === "boolean"
        ? (params.payload.accepted as boolean)
        : null,
    status: order?.status ?? null,
    decisionSource: payloadString(params.payload, "decisionSource"),
    decisionSummary: payloadString(params.payload, "decisionSummary"),
    provider: payloadString(params.payload, "provider"),
    model: payloadString(params.payload, "model"),
    contextRefs,
    skillRefs,
    plannedTools,
    dispatchStatus,
    dispatchStrategy: payloadString(latestDispatchPayload, "selectedStrategy"),
    dispatchDecisionSource: payloadString(latestDispatchPayload, "decisionSource"),
    dispatchDecisionSummary:
      payloadString(latestDispatchPayload, "decisionSummary") ??
      payloadString(latestDispatchPayload, "error"),
    dispatchProvider: payloadString(latestDispatchPayload, "provider"),
    dispatchModel: payloadString(latestDispatchPayload, "model"),
    dispatchAssignedVehicleId: payloadString(latestDispatchPayload, "assignedVehicleId"),
    dispatchContextRefs,
    dispatchSkillRefs,
    dispatchPlannedTools,
    funnelStatus: deriveRequestFunnelStatus({
      orderId: params.orderId,
      order,
      resolvedIncidentIds: params.resolvedIncidentIds,
      incidents: params.incidents,
    }),
  };
}

function buildFallbackRequestSummary(params: {
  order: OrderRow;
  orderReferenceById: Map<string, {
    id: string;
    customerLabel: string | null;
    pickupHubLabel: string | null;
    destinationLabel: string | null;
    status: string;
  }>;
  customerById: Map<string, CustomerRow>;
  pickupHubById: Map<string, PickupHubRow>;
  resolvedIncidentIds: Set<string>;
  incidents: IncidentRow[];
  simulationEvents: SimulationEventRow[];
}) {
  const orderReference = params.orderReferenceById.get(params.order.id) ?? null;
  const customer = params.customerById.get(params.order.customer_id);
  const pickupHub = params.pickupHubById.get(params.order.pickup_hub_id);
  const estimatedDistanceKm =
    customer && pickupHub
      ? Number(
          (
            haversineMeters(
              { lat: customer.lat, lng: customer.lng },
              { lat: pickupHub.lat, lng: pickupHub.lng },
            ) / 1_000
          ).toFixed(2),
        )
      : null;
  const fallbackDispatchEvent = latestOrderEvent(
    params.simulationEvents,
    params.order.id,
    ["checkout_order_dispatched"],
  );
  const fallbackDispatchPayload = fallbackDispatchEvent
    ? asRecord(fallbackDispatchEvent.payload)
    : {};
  const fallbackDispatchFailed = latestOrderEvent(
    params.simulationEvents,
    params.order.id,
    ["checkout_order_dispatch_failed"],
  );
  const fallbackDispatchStatus: "idle" | "reasoning" | "released" | "held" | "failed" =
    fallbackDispatchFailed
      ? "failed"
      : fallbackDispatchEvent
        ? fallbackDispatchPayload.dispatched === true
          ? "released"
          : payloadString(fallbackDispatchPayload, "selectedStrategy") === "hold_for_capacity"
            ? "held"
            : "held"
        : latestOrderEvent(
              params.simulationEvents,
              params.order.id,
              ["checkout_order_dispatch_requested"],
            )
          ? "reasoning"
          : "idle";

  return {
    orderId: params.order.id,
    customerLabel: orderReference?.customerLabel ?? null,
    pickupHubLabel: orderReference?.pickupHubLabel ?? null,
    destinationLabel: orderReference?.destinationLabel ?? null,
    quotedPriceCents: params.order.revenue_cents,
    baselineQuoteCents: params.order.revenue_cents,
    estimatedDistanceKm,
    strategy: null,
    accepted:
      ["paid", "assigned", "in_transit", "delivered"].includes(params.order.status)
        ? true
      : null,
    status: params.order.status,
    decisionSource: null,
    decisionSummary: null,
    provider: null,
    model: null,
    contextRefs: [],
    skillRefs: [],
    plannedTools: [],
    dispatchStatus: fallbackDispatchStatus,
    dispatchStrategy: payloadString(fallbackDispatchPayload, "selectedStrategy"),
    dispatchDecisionSource: payloadString(fallbackDispatchPayload, "decisionSource"),
    dispatchDecisionSummary:
      payloadString(fallbackDispatchPayload, "decisionSummary"),
    dispatchProvider: payloadString(fallbackDispatchPayload, "provider"),
    dispatchModel: payloadString(fallbackDispatchPayload, "model"),
    dispatchAssignedVehicleId: payloadString(fallbackDispatchPayload, "assignedVehicleId"),
    dispatchContextRefs: [],
    dispatchSkillRefs: [],
    dispatchPlannedTools: [],
    funnelStatus: deriveRequestFunnelStatus({
      orderId: params.order.id,
      order: params.order,
      resolvedIncidentIds: params.resolvedIncidentIds,
      incidents: params.incidents,
    }),
  };
}

function synchronizeRequestWithLiveWorld(
  request: DashboardCurrentRequest | null,
  liveWorld: Awaited<ReturnType<typeof loadPersistedSimulation>>["world"] | null,
): DashboardCurrentRequest | null {
  if (!request || !liveWorld) {
    return request;
  }

  const liveOrder = liveWorld.orders.find((order) => order.id === request.orderId);
  if (!liveOrder) {
    return request;
  }

  const liveVehicle = liveWorld.vehicles.find(
    (vehicle) => vehicle.id === liveOrder.vehicleId,
  );
  const liveDispatchReleased =
    Boolean(liveOrder.vehicleId) &&
    ["assigned", "in_transit", "delivered"].includes(liveOrder.status);
  const dispatchStatus =
    liveDispatchReleased &&
    (request.dispatchStatus === "idle" || request.dispatchStatus === "reasoning")
      ? "released"
      : request.dispatchStatus;

  return {
    ...request,
    status: liveOrder.status,
    dispatchStatus,
    dispatchAssignedVehicleId:
      request.dispatchAssignedVehicleId ?? liveOrder.vehicleId,
    dispatchDecisionSummary:
      request.dispatchDecisionSummary ??
      (liveDispatchReleased
        ? liveVehicle?.route.length && liveVehicle.route.length > 1
          ? "Dispatch is released and the road route is live on the map."
          : "Dispatch is released and Hermes is still hydrating the map route."
        : request.dispatchDecisionSummary),
    funnelStatus:
      request.funnelStatus === "pending" && liveDispatchReleased
        ? "paid"
        : request.funnelStatus,
  };
}

function buildDashboardIncident(
  params: {
    id: string;
    type: string;
    orderIds: string[];
  },
  orderReferenceById: Map<string, {
    id: string;
    customerLabel: string | null;
    pickupHubLabel: string | null;
    destinationLabel: string | null;
    status: string;
  }>,
): DashboardActiveIncident {
  return {
    id: params.id,
    type: params.type,
    orderIds: params.orderIds,
    orders: params.orderIds.map((orderId) =>
      orderReferenceById.get(orderId) ?? {
        id: orderId,
        customerLabel: null,
        pickupHubLabel: null,
        destinationLabel: null,
        status: "unknown",
      },
    ),
  };
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const planning = await readRoutingPlanningState();
  if (planning?.phase === "resetting") {
    return buildEmptyDashboardSnapshot();
  }

  const supabase = getSupabaseAdmin();
  const [
    ordersResult,
    customersResult,
    pickupHubsResult,
    incidentsResult,
    ledgerResult,
    policyEvaluationsResult,
    simulationEventsResult,
    liveSimulation,
  ] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id,customer_id,pickup_hub_id,status,revenue_cents,stripe_checkout_session_id,stripe_payment_intent_id,created_at",
      ),
    supabase.from("customer_locations").select("id,name,lat,lng"),
    supabase.from("pickup_hubs").select("id,name,lat,lng"),
    supabase
      .from("incidents")
      .select("id,type,order_ids,created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("ledger")
      .select(
        "id,entry_type,amount_cents,stripe_reference,created_at,metadata",
      ),
    supabase
      .from("policy_evaluations")
      .select("id,action_type,amount_cents,allowed,reason,incident_id,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("simulation_events")
      .select("event_type,payload,created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    loadPersistedSimulation().catch(() => null),
  ]);

  const error =
    ordersResult.error ??
    customersResult.error ??
    pickupHubsResult.error ??
    incidentsResult.error ??
    ledgerResult.error ??
    policyEvaluationsResult.error ??
    simulationEventsResult.error;

  if (error) {
    throw new Error(`Failed to load dashboard snapshot: ${error.message}`);
  }

  const orders = (ordersResult.data ?? []) as OrderRow[];
  const customers = (customersResult.data ?? []) as CustomerRow[];
  const pickupHubs = (pickupHubsResult.data ?? []) as PickupHubRow[];
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const pickupHubById = new Map(pickupHubs.map((hub) => [hub.id, hub]));
  const stripeBackedOrders = orders.filter((order) =>
    isStripeBackedOrder(toOrderRecord(order)),
  );
  const ledger = (ledgerResult.data ?? []) as LedgerRow[];
  const policyEvaluations =
    (policyEvaluationsResult.data ?? []) as PolicyEvaluationRow[];
  const incidents = (incidentsResult.data ?? []) as IncidentRow[];
  const simulationEvents =
    (simulationEventsResult.data ?? []) as SimulationEventRow[];
  const paidRevenueCents = orders.reduce(
    (total, order) =>
      stripeBackedOrders.some((candidate) => candidate.id === order.id) &&
      order.status !== "pending"
        ? total + order.revenue_cents
        : total,
    0,
  );
  const orderReferenceById = new Map(
    orders.map((order) => {
      const customer = customerById.get(order.customer_id);
      const pickupHub = pickupHubById.get(order.pickup_hub_id);

      return [order.id, {
        id: order.id,
        customerLabel: customer?.name ?? null,
        pickupHubLabel: pickupHub?.name ?? null,
        destinationLabel: formatDestinationLabel(customer),
        status: order.status,
      }];
    }),
  );
  const walletPayoutCents = ledger.reduce(
    (total, entry) =>
      PAYOUT_ENTRY_TYPES.has(entry.entry_type)
        ? total + entry.amount_cents
        : total,
    0,
  );
  const operatingCostCents = ledger.reduce(
    (total, entry) =>
      entry.amount_cents > 0 ? total + entry.amount_cents : total,
    0,
  );
  const checkoutTransactions = stripeBackedOrders.flatMap((order) => {
    if (order.status === "pending") {
      return [];
    }

    const stripeReference =
      order.stripe_payment_intent_id ?? order.stripe_checkout_session_id;
    if (!stripeReference) {
      return [];
    }

    return [{
      id: `checkout:${order.id}`,
      kind: "checkout_payment" as const,
      label: "Stripe Checkout payment",
      amountCents: order.revenue_cents,
      direction: "incoming" as const,
      stripeReference,
      createdAt: order.created_at,
      orderId: order.id,
      customerLabel: orderReferenceById.get(order.id)?.customerLabel ?? null,
      pickupHubLabel: orderReferenceById.get(order.id)?.pickupHubLabel ?? null,
      destinationLabel: orderReferenceById.get(order.id)?.destinationLabel ?? null,
    }];
  });
  const ledgerTransactions = ledger.flatMap((entry) => {
    if (
      !entry.stripe_reference ||
      (entry.entry_type !== "driver_payout" &&
        entry.entry_type !== "customer_refund")
    ) {
      return [];
    }

    const kind =
      entry.entry_type === "driver_payout"
        ? "driver_payout" as const
        : "customer_refund" as const;

    return [{
      id: `ledger:${entry.id}`,
      kind,
      label:
        entry.entry_type === "driver_payout"
          ? "Replacement driver payout"
          : "Customer refund",
      amountCents: entry.amount_cents,
      direction: "outgoing" as const,
      stripeReference: entry.stripe_reference,
      createdAt: entry.created_at,
      orderId:
        typeof asRecord(entry.metadata).orderId === "string"
          ? (asRecord(entry.metadata).orderId as string)
          : null,
      customerLabel: null,
      pickupHubLabel: null,
      destinationLabel: null,
    }];
  });
  const hydratedLedgerTransactions = ledgerTransactions.map((transaction) => {
    if (!transaction.orderId) {
      return transaction;
    }

    const orderReference = orderReferenceById.get(transaction.orderId);
    return {
      ...transaction,
      customerLabel: orderReference?.customerLabel ?? null,
      pickupHubLabel: orderReference?.pickupHubLabel ?? null,
      destinationLabel: orderReference?.destinationLabel ?? null,
    };
  });
  const recoveredIncidentIds = getResolvedIncidentIds({
    incidents,
    orders,
    simulationEvents,
  });
  const liveWorld = liveSimulation?.world ?? null;
  const liveActiveDeliveryCount = liveWorld
    ? liveWorld.orders.filter(
        (order) =>
          ACTIVE_ORDER_STATUSES.has(order.status) &&
          isStripeBackedOperationalOrder(order),
      ).length
    : 0;
  const liveUnresolvedIncidents = liveWorld
    ? liveWorld.incidents.filter(
        (incident) => !recoveredIncidentIds.has(incident.id),
      )
    : [];
  const unresolvedIncidents = incidents.filter(
    (incident) => !recoveredIncidentIds.has(incident.id),
  );
  const latestActiveIncident = unresolvedIncidents[0] ?? null;
  const latestLiveIncident = liveUnresolvedIncidents.at(-1) ?? null;
  const latestIncident = incidents[0] ?? null;
  const completedRecoveryEvent = latestIncident
    ? simulationEvents.find(
        (event) =>
          event.event_type === "delivery_recovery_completed" &&
          asRecord(event.payload).incidentId === latestIncident.id,
      ) ?? null
    : null;
  const recoveryReportEvent = latestIncident
    ? simulationEvents.find(
        (event) =>
          (event.event_type === "delivery_recovery_rerouted" ||
            event.event_type === "delivery_recovery_completed") &&
          asRecord(event.payload).incidentId === latestIncident.id,
      ) ?? null
    : null;
  const skillEvent = latestIncident
    ? simulationEvents.find(
        (event) =>
          event.event_type === "mcp.create_recovery_skill" &&
          new Date(event.created_at).getTime() >=
            new Date(latestIncident.created_at).getTime(),
      ) ?? null
    : null;
  const reusedSkillEvent = latestIncident
    ? simulationEvents.find(
        (event) =>
          event.event_type === "reasoning.reused_recovery_skill" &&
          asRecord(event.payload).incidentId === latestIncident.id,
      ) ?? null
    : null;
  const latestIncidentOrderIds = new Set(latestIncident?.order_ids ?? []);
  const protectedOrders = orders.filter(
    (order) =>
      latestIncidentOrderIds.has(order.id) &&
      INCIDENT_ORDER_STATUSES.has(order.status) &&
      isStripeBackedOperationalOrder(toOrderRecord(order)),
  );
  const recoveryPayload = recoveryReportEvent
    ? asRecord(recoveryReportEvent.payload)
    : {};
  const recoveryPayloadNumber = (key: string): number | null =>
    typeof recoveryPayload[key] === "number"
      ? (recoveryPayload[key] as number)
      : null;
  const customerRevenueProtectedCents = protectedOrders.reduce(
    (total, order) => total + order.revenue_cents,
    0,
  );
  const deliveredProtectedOrders = protectedOrders.filter(
    (order) => order.status === "delivered",
  );
  const incidentLedger = latestIncident
    ? ledger.filter(
        (entry) =>
          asRecord(entry.metadata).incidentId === latestIncident.id &&
          INCIDENT_SPEND_ENTRY_TYPES.has(entry.entry_type),
      )
    : [];
  const emergencySpendingCents =
    recoveryPayloadNumber("emergencySpendingCents") ??
    incidentLedger.reduce((total, entry) => total + entry.amount_cents, 0);
  const refundsAvoidedCents =
    recoveryPayloadNumber("refundsAvoidedCents") ??
    Math.round(customerRevenueProtectedCents * (3 / 7));
  const churnLossAvoidedCents =
    recoveryPayloadNumber("churnLossAvoidedCents") ??
    Math.round(customerRevenueProtectedCents * (2 / 7));
  const skillPayload = skillEvent ? asRecord(skillEvent.payload) : {};
  const skillOutput = asRecord(skillPayload.output as Json | undefined);
  const reusedSkillPayload = reusedSkillEvent
    ? asRecord(reusedSkillEvent.payload)
    : {};
  const latestIncidentCreatedAtMs = latestIncident
    ? new Date(latestIncident.created_at).getTime()
    : null;
  const recoveryEventCreatedAtMs = recoveryReportEvent
    ? new Date(recoveryReportEvent.created_at).getTime()
    : null;
  const latestActiveIncidentCreatedAtMs = latestActiveIncident
    ? new Date(latestActiveIncident.created_at).getTime()
    : null;
  const activeRecoveryEventCreatedAtMs =
    latestActiveIncident &&
    completedRecoveryEvent &&
    asRecord(completedRecoveryEvent.payload).incidentId === latestActiveIncident.id
      ? new Date(completedRecoveryEvent.created_at).getTime()
      : null;
  const latestCurrentRequestEvent = [...simulationEvents]
    .filter((event) => event.event_type === "order_intake_decision_completed")
    .sort((left, right) => {
      const leftPayload = asRecord(left.payload);
      const rightPayload = asRecord(right.payload);
      const leftOrderId =
        typeof leftPayload.orderId === "string" ? leftPayload.orderId : null;
      const rightOrderId =
        typeof rightPayload.orderId === "string" ? rightPayload.orderId : null;
      const leftCreatedAtMs = new Date(
        orders.find((order) => order.id === leftOrderId)?.created_at ??
          left.created_at,
      ).getTime();
      const rightCreatedAtMs = new Date(
        orders.find((order) => order.id === rightOrderId)?.created_at ??
          right.created_at,
      ).getTime();

      return rightCreatedAtMs - leftCreatedAtMs;
    })[0] ?? null;
  const latestCurrentRequestPayload = latestCurrentRequestEvent
    ? asRecord(latestCurrentRequestEvent.payload)
    : {};
  const latestCurrentRequestOrderId =
    typeof latestCurrentRequestPayload.orderId === "string"
      ? latestCurrentRequestPayload.orderId
      : null;
  const requestHistoryFromIntake = simulationEvents
    .filter((event) => event.event_type === "order_intake_decision_completed")
    .map((event) => {
      const payload = asRecord(event.payload);
      const orderId =
        typeof payload.orderId === "string" ? payload.orderId : null;

      if (!orderId) {
        return null;
      }

      return buildCurrentRequestSummary({
        orderId,
        payload,
        orderReferenceById,
        orders,
        resolvedIncidentIds: recoveredIncidentIds,
        incidents,
        simulationEvents,
      });
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .slice(0, 4);
  const latestStripeBackedOrder =
    [...stripeBackedOrders].sort(
      (left, right) =>
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
    )[0] ?? null;
  const shouldUseFallbackCurrentRequest =
    latestStripeBackedOrder !== null &&
    (!latestCurrentRequestOrderId ||
      latestCurrentRequestOrderId !== latestStripeBackedOrder.id);
  const fallbackCurrentRequest =
    shouldUseFallbackCurrentRequest && latestStripeBackedOrder
      ? buildFallbackRequestSummary({
          order: latestStripeBackedOrder,
          orderReferenceById,
          customerById,
          pickupHubById,
          resolvedIncidentIds: recoveredIncidentIds,
          incidents,
          simulationEvents,
        })
      : null;
  const requestHistory = fallbackCurrentRequest
    ? [
        fallbackCurrentRequest,
        ...requestHistoryFromIntake.filter(
          (request) => request.orderId !== fallbackCurrentRequest.orderId,
        ),
      ].slice(0, 4)
    : requestHistoryFromIntake;
  const synchronizedRequestHistory = requestHistory.map((request) =>
    synchronizeRequestWithLiveWorld(request, liveWorld) ?? request,
  );
  const activeRequestAnchorOrderId =
    latestCurrentRequestOrderId ?? fallbackCurrentRequest?.orderId ?? null;
  const activeRequestAnchorMs = activeRequestAnchorOrderId
    ? new Date(
        orders.find((order) => order.id === activeRequestAnchorOrderId)?.created_at ??
          latestOrderEvent(
            simulationEvents,
            activeRequestAnchorOrderId,
            [
              "order_intake_decision_completed",
              "checkout_order_pending_created",
              "checkout_order_paid",
              "checkout_order_dispatch_requested",
              "checkout_order_dispatched",
              "checkout_order_dispatch_failed",
            ],
          )?.created_at ??
          new Date().toISOString(),
      ).getTime()
    : null;
  const agentTimeline = latestActiveIncident
    ? simulationEvents
        .filter((event) => isAgentAuditEvent(event.event_type))
        .filter((event) => {
          const payload = asRecord(event.payload);
          const incidentId = typeof payload.incidentId === "string"
            ? payload.incidentId
            : null;
          if (incidentId === latestActiveIncident.id) {
            return true;
          }

          if (!latestActiveIncidentCreatedAtMs) {
            return false;
          }

          const eventTime = new Date(event.created_at).getTime();
          if (eventTime < latestActiveIncidentCreatedAtMs) {
            return false;
          }

          if (activeRecoveryEventCreatedAtMs && eventTime > activeRecoveryEventCreatedAtMs) {
            return false;
          }

          return incidentId === null;
        })
        .map(toAgentTimelineItem)
        .sort(
          (left, right) =>
            new Date(left.createdAt).getTime() -
            new Date(right.createdAt).getTime(),
        )
    : activeRequestAnchorMs
      ? simulationEvents
          .filter((event) => isAgentAuditEvent(event.event_type))
          .filter((event) => {
            const payload = asRecord(event.payload);
            const incidentId =
              typeof payload.incidentId === "string"
                ? payload.incidentId
                : null;
            if (incidentId !== null) {
              return false;
            }

            const eventTime = new Date(event.created_at).getTime();
            return eventTime >= activeRequestAnchorMs - 15_000;
          })
          .map(toAgentTimelineItem)
          .sort(
            (left, right) =>
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime(),
          )
          .slice(-16)
      : [];
  const currentRequest = synchronizeRequestWithLiveWorld(
    latestCurrentRequestOrderId
      ? buildCurrentRequestSummary({
          orderId: latestCurrentRequestOrderId,
          payload: latestCurrentRequestPayload,
          orderReferenceById,
          orders,
          resolvedIncidentIds: recoveredIncidentIds,
          incidents,
          simulationEvents,
        })
      : fallbackCurrentRequest,
    liveWorld,
  );
  const effectiveActiveIncident = latestActiveIncident
    ? buildDashboardIncident(
        {
          id: latestActiveIncident.id,
          type: latestActiveIncident.type,
          orderIds: latestActiveIncident.order_ids,
        },
        orderReferenceById,
      )
    : latestLiveIncident
      ? buildDashboardIncident(
          {
            id: latestLiveIncident.id,
            type: latestLiveIncident.type,
            orderIds: latestLiveIncident.orderIds,
          },
          orderReferenceById,
        )
      : null;
  const headlineActiveDeliveries = orders.filter((order) =>
    ACTIVE_ORDER_STATUSES.has(order.status) &&
    isStripeBackedOperationalOrder(toOrderRecord(order)),
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    headline: {
      walletBalanceCents: paidRevenueCents - walletPayoutCents,
      activeDeliveries: Math.max(
        headlineActiveDeliveries,
        liveActiveDeliveryCount,
      ),
      activeIncidents: Math.max(
        unresolvedIncidents.length,
        liveUnresolvedIncidents.length,
      ),
      expectedProfitCents: paidRevenueCents - operatingCostCents,
      paidRevenueCents,
      operatingCostCents,
    },
    currentRequest,
    requestHistory: synchronizedRequestHistory,
    activeIncident: effectiveActiveIncident,
    policyEvaluations: policyEvaluations.map((evaluation) => ({
      id: evaluation.id,
      actionType: evaluation.action_type,
      amountCents: evaluation.amount_cents,
      allowed: evaluation.allowed,
      reason: evaluation.reason,
      incidentId: evaluation.incident_id,
      createdAt: evaluation.created_at,
    })),
    agentTimeline,
    stripeTransactions: [...checkoutTransactions, ...hydratedLedgerTransactions]
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )
      .slice(0, 12),
    finalRecoveryReport:
      latestIncident && recoveryReportEvent
        ? {
            incidentId: latestIncident.id,
            affectedOrders: protectedOrders.map((order) =>
              orderReferenceById.get(order.id) ?? {
                id: order.id,
                customerLabel: null,
                pickupHubLabel: null,
                destinationLabel: null,
                status: order.status,
              }),
            affectedDeliveries: protectedOrders.length,
            recoveredDeliveries: deliveredProtectedOrders.length,
            customerRevenueProtectedCents:
              recoveryPayloadNumber("customerRevenueProtectedCents") ??
              customerRevenueProtectedCents,
            emergencySpendingCents,
            refundsAvoidedCents,
            churnLossAvoidedCents,
            netFinancialBenefitCents:
              refundsAvoidedCents +
              churnLossAvoidedCents -
              emergencySpendingCents,
            humanInterventionCount:
              typeof recoveryPayload.humanInterventionCount === "number"
                ? recoveryPayload.humanInterventionCount
                : 0,
            policyViolationCount: policyEvaluations.filter(
              (evaluation) =>
                evaluation.incident_id === latestIncident.id &&
                !evaluation.allowed,
            ).length,
            recoverySeconds: Math.max(
              0,
              Math.round(
                (new Date(
                  (completedRecoveryEvent ?? recoveryReportEvent).created_at,
                ).getTime() -
                  new Date(latestIncident.created_at).getTime()) /
                  1_000,
              ),
            ),
            skillName:
              typeof skillOutput.skillName === "string"
                ? skillOutput.skillName
                : null,
            reusedSkill:
              typeof reusedSkillPayload.skillName === "string"
                ? {
                    reused: true,
                    skillName: reusedSkillPayload.skillName,
                    learnedFromIncidentId:
                      typeof reusedSkillPayload.learnedFromIncidentId ===
                      "string"
                        ? reusedSkillPayload.learnedFromIncidentId
                        : null,
                  }
                : null,
          }
        : null,
  };
}
