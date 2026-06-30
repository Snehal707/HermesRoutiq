import { getSupabaseAdmin } from "@/lib/supabase/server";
import Stripe from "stripe";
import { getStripeServer } from "@/lib/stripe/server";
import {
  loadTickFromRedis,
  loadWorldFromPostgres,
  persistTickAndVehicles,
} from "@/lib/sim/persistence";
import { getRedis } from "@/lib/redis";
import type { LngLat, SimulationWorld } from "@/lib/sim/types";

const BASE_DELIVERY_PRICE_CENTS = 650;
const MIN_DELIVERY_PRICE_CENTS = 900;
const MAX_DELIVERY_PRICE_CENTS = 2600;
const DEMO_SERVICE_AREA = {
  minLat: 37.778,
  maxLat: 37.793,
  minLng: -122.407,
  maxLng: -122.395,
} as const;

export type CheckoutScenario = "success" | "payment_declined";

export interface CheckoutOrderMetadata {
  orderId: string;
  customerId: string;
  pickupHubId: string;
  quotedPriceCents: number;
  vehicleId?: string;
}

export interface CheckoutOrderQuoteContext {
  customerId: string;
  pickupHubId: string;
  estimatedDistanceKm: number;
  activeOrderCount: number;
  baselineQuoteCents: number;
  minQuoteCents: number;
  maxQuoteCents: number;
}

export interface CheckoutOrderRequestInput {
  pickupHubId: string;
  customerName: string;
  destinationLat: number;
  destinationLng: number;
}

interface CheckoutOrderCandidate {
  orderId: string;
  customerId: string;
  pickupHubId: string;
  vehicleId?: string;
  quoteContext: CheckoutOrderQuoteContext;
  requestCustomerDraft?: {
    id: string;
    name: string;
    lat: number;
    lng: number;
  };
}

interface DbOrderInsertResult {
  id: string;
  status: string;
}

interface ExistingOrderRow {
  id: string;
  customer_id: string;
  pickup_hub_id: string;
  vehicle_id: string;
  status: string;
  revenue_cents: number;
}

interface SimulationOrderRow extends ExistingOrderRow {
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_event_id: string | null;
}

interface SimulationCustomerRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface LocationRow {
  lat: number;
  lng: number;
}

interface PickupHubRow extends LocationRow {
  id: string;
  name: string;
}

function isUniqueViolation(error: { code?: string; message: string } | null): boolean {
  if (!error) {
    return false;
  }

  return (
    error.code === "23505" ||
    error.message.toLowerCase().includes("duplicate key") ||
    error.message.toLowerCase().includes("unique constraint")
  );
}

export async function buildCheckoutOrderMetadata(params?: {
  orderId?: string;
  request?: CheckoutOrderRequestInput;
  blockOnIntake?: boolean;
}): Promise<CheckoutOrderMetadata> {
  if (params?.orderId) {
    const { data, error } = await getSupabaseAdmin()
      .from("orders")
      .select("id,customer_id,pickup_hub_id,vehicle_id,status,revenue_cents")
      .eq("id", params.orderId)
      .maybeSingle<ExistingOrderRow>();

    if (error) {
      throw new Error(`Failed to load checkout order ${params.orderId}: ${error.message}`);
    }

    if (!data) {
      throw new Error(`Checkout order not found: ${params.orderId}`);
    }

      return {
      orderId: data.id,
      customerId: data.customer_id,
      pickupHubId: data.pickup_hub_id,
      quotedPriceCents: data.revenue_cents,
      vehicleId: data.vehicle_id,
    };
  }

  const candidate = params?.request
    ? await buildCheckoutOrderCandidateFromRequest(params.request)
    : await buildCheckoutOrderCandidate();

  if (candidate.requestCustomerDraft) {
    await ensureCheckoutRequestCustomer(candidate.requestCustomerDraft);
  }

  const shouldBlockOnIntake = params?.blockOnIntake !== false;
  if (shouldBlockOnIntake) {
    const intakeDecision = await requestHermesOrderIntakeDecision(candidate);

    if (!intakeDecision.accepted) {
      throw new Error(
        intakeDecision.decisionSummary ||
          "Hermes declined the delivery because live capacity is too constrained right now.",
      );
    }

    return {
      orderId: candidate.orderId,
      customerId: candidate.customerId,
      pickupHubId: candidate.pickupHubId,
      quotedPriceCents: intakeDecision.quotedPriceCents,
      vehicleId: candidate.vehicleId,
    };
  }

  void requestHermesOrderIntakeDecision(candidate).catch((error: unknown) => {
    console.error("Background Hermes intake failed after checkout was unblocked", {
      orderId: candidate.orderId,
      error,
    });
  });

  return {
    orderId: candidate.orderId,
    customerId: candidate.customerId,
    pickupHubId: candidate.pickupHubId,
    quotedPriceCents: candidate.quoteContext.baselineQuoteCents,
    vehicleId: candidate.vehicleId,
  };
}

async function buildCheckoutOrderCandidate(): Promise<CheckoutOrderCandidate> {
  const supabase = getSupabaseAdmin();
  const [{ data: customers, error: customerError }, { data: hubs, error: hubError }] =
    await Promise.all([
      supabase.from("customer_locations").select("id").order("id", { ascending: true }),
      supabase.from("pickup_hubs").select("id").order("id", { ascending: true }),
    ]);

  const firstError = customerError ?? hubError;
  if (firstError) {
    throw new Error(`Failed to prepare checkout order: ${firstError.message}`);
  }

  if (!customers?.length || !hubs?.length) {
    throw new Error("Simulation seed data is missing; run the simulation reset first.");
  }

  const suffix = crypto.randomUUID();
  const customer = customers[Date.now() % customers.length];
  const hub = hubs[Date.now() % hubs.length];
  return {
    orderId: `order-checkout-${suffix}`,
    customerId: customer.id,
    pickupHubId: hub.id,
    quoteContext: await getCheckoutOrderQuoteContext({
      customerId: customer.id,
      pickupHubId: hub.id,
    }),
  };
}

function normalizeRequestCustomerName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || "Customer Request";
}

function assertDestinationCoordinate(
  label: "latitude" | "longitude",
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Request ${label} must be a valid number.`);
  }

  if (label === "latitude" && (value < -90 || value > 90)) {
    throw new Error("Request latitude must be between -90 and 90.");
  }

  if (label === "longitude" && (value < -180 || value > 180)) {
    throw new Error("Request longitude must be between -180 and 180.");
  }
}

function assertDestinationWithinDemoArea(params: {
  latitude: number;
  longitude: number;
}): void {
  const { latitude, longitude } = params;
  const withinLat =
    latitude >= DEMO_SERVICE_AREA.minLat &&
    latitude <= DEMO_SERVICE_AREA.maxLat;
  const withinLng =
    longitude >= DEMO_SERVICE_AREA.minLng &&
    longitude <= DEMO_SERVICE_AREA.maxLng;

  if (withinLat && withinLng) {
    return;
  }

  throw new Error(
    "Destination must stay inside the San Francisco demo zone. Use a drop-off near FiDi / SoMa.",
  );
}

async function buildCheckoutOrderCandidateFromRequest(
  request: CheckoutOrderRequestInput,
): Promise<CheckoutOrderCandidate> {
  assertDestinationCoordinate("latitude", request.destinationLat);
  assertDestinationCoordinate("longitude", request.destinationLng);
  assertDestinationWithinDemoArea({
    latitude: request.destinationLat,
    longitude: request.destinationLng,
  });

  const { data: hub, error } = await getSupabaseAdmin()
    .from("pickup_hubs")
    .select("id,name,lat,lng")
    .eq("id", request.pickupHubId)
    .maybeSingle<PickupHubRow>();

  if (error) {
    throw new Error(`Failed to load pickup hub ${request.pickupHubId}: ${error.message}`);
  }

  if (!hub) {
    throw new Error(`Pickup hub not found: ${request.pickupHubId}`);
  }

  const suffix = crypto.randomUUID();
  const customerId = `customer-request-${suffix}`;
  const customerLocation = {
    lat: Number(request.destinationLat.toFixed(6)),
    lng: Number(request.destinationLng.toFixed(6)),
  };

  return {
    orderId: `order-checkout-${suffix}`,
    customerId,
    pickupHubId: hub.id,
    quoteContext: await buildCheckoutOrderQuoteContextFromLocations({
      customerId,
      pickupHubId: hub.id,
      customerLocation,
      pickupHubLocation: { lat: hub.lat, lng: hub.lng },
    }),
    requestCustomerDraft: {
      id: customerId,
      name: normalizeRequestCustomerName(request.customerName),
      lat: customerLocation.lat,
      lng: customerLocation.lng,
    },
  };
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

export async function getCheckoutOrderQuoteContext(params: {
  customerId: string;
  pickupHubId: string;
}): Promise<CheckoutOrderQuoteContext> {
  const supabase = getSupabaseAdmin();
  const [
    customerResult,
    hubResult,
    activeOrdersResult,
  ] = await Promise.all([
    supabase
      .from("customer_locations")
      .select("lat,lng")
      .eq("id", params.customerId)
      .maybeSingle<LocationRow>(),
    supabase
      .from("pickup_hubs")
      .select("lat,lng")
      .eq("id", params.pickupHubId)
      .maybeSingle<LocationRow>(),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .in("status", ["paid", "assigned", "in_transit"]),
  ]);

  const firstError =
    customerResult.error ?? hubResult.error ?? activeOrdersResult.error;
  if (firstError) {
    throw new Error(`Failed to quote delivery price: ${firstError.message}`);
  }

  if (!customerResult.data || !hubResult.data) {
    throw new Error("Cannot quote delivery price without hub and customer locations.");
  }

  return buildCheckoutOrderQuoteContextFromLocations({
    customerId: params.customerId,
    pickupHubId: params.pickupHubId,
    customerLocation: customerResult.data,
    pickupHubLocation: hubResult.data,
    activeOrderCount: activeOrdersResult.count ?? 0,
  });
}

async function buildCheckoutOrderQuoteContextFromLocations(params: {
  customerId: string;
  pickupHubId: string;
  customerLocation: LocationRow;
  pickupHubLocation: LocationRow;
  activeOrderCount?: number;
}): Promise<CheckoutOrderQuoteContext> {
  const activeOrderCount =
    typeof params.activeOrderCount === "number"
      ? params.activeOrderCount
      : await getActiveCheckoutOrderCount();

  const distanceKm =
    haversineMeters(params.customerLocation, params.pickupHubLocation) / 1_000;
  const distanceComponent = Math.round(distanceKm * 180);
  const loadSurcharge = Math.min(360, activeOrderCount * 45);
  const rounded =
    Math.round(
      (BASE_DELIVERY_PRICE_CENTS + distanceComponent + loadSurcharge) / 25,
    ) * 25;
  const baselineQuoteCents = Math.max(
    MIN_DELIVERY_PRICE_CENTS,
    Math.min(MAX_DELIVERY_PRICE_CENTS, rounded),
  );

  return {
    customerId: params.customerId,
    pickupHubId: params.pickupHubId,
    estimatedDistanceKm: Number(distanceKm.toFixed(2)),
    activeOrderCount,
    baselineQuoteCents,
    minQuoteCents: Math.max(MIN_DELIVERY_PRICE_CENTS, baselineQuoteCents - 150),
    maxQuoteCents: Math.min(MAX_DELIVERY_PRICE_CENTS, baselineQuoteCents + 250),
  };
}

async function getActiveCheckoutOrderCount(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("orders")
    .select("id", { count: "exact", head: true })
    .in("status", ["paid", "assigned", "in_transit"]);

  if (error) {
    throw new Error(`Failed to load active order count: ${error.message}`);
  }

  return count ?? 0;
}

export async function quoteDeliveryPriceCents(params: {
  customerId: string;
  pickupHubId: string;
}): Promise<number> {
  const quoteContext = await getCheckoutOrderQuoteContext(params);
  return quoteContext.baselineQuoteCents;
}

export async function ensurePendingCheckoutOrder(params: {
  metadata: CheckoutOrderMetadata;
  stripeCheckoutSessionId: string;
}): Promise<{ orderId: string; created: boolean }> {
  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  const response = await fetch(new URL("/dashboard/checkout/pending", mcpCoreUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    orderId?: string;
    created?: boolean;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to ensure pending checkout order");
  }

  if (typeof payload.orderId !== "string" || typeof payload.created !== "boolean") {
    throw new Error("Pending checkout order response was incomplete.");
  }

  await syncCheckoutOrderIntoSimulationWorld(payload.orderId);

  return {
    orderId: payload.orderId,
    created: payload.created,
  };
}

export async function markCheckoutOrderPaid(params: {
  stripeEventId: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  metadata: CheckoutOrderMetadata;
}): Promise<{ orderId: string; created: boolean }> {
  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  const response = await fetch(new URL("/dashboard/checkout/mark-paid", mcpCoreUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    orderId?: string;
    created?: boolean;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to mark checkout order paid");
  }

  if (typeof payload.orderId !== "string" || typeof payload.created !== "boolean") {
    throw new Error("Checkout payment reconciliation response was incomplete.");
  }

  await syncCheckoutOrderIntoSimulationWorld(payload.orderId);

  return {
    orderId: payload.orderId,
    created: payload.created,
  };
}

export async function recordPaymentDeclinedIncident(params: {
  orderId: string;
  checkoutSessionId: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  errorMessage?: string | null;
  declineCode?: string | null;
}): Promise<{ incidentId: string; created: boolean }> {
  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  const response = await fetch(new URL("/dashboard/checkout/declined", mcpCoreUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    incidentId?: string;
    created?: boolean;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to record payment declined incident");
  }

  if (typeof payload.incidentId !== "string" || typeof payload.created !== "boolean") {
    throw new Error("Payment declined incident response was incomplete.");
  }

  return {
    incidentId: payload.incidentId,
    created: payload.created,
  };
}

export async function recordStripeCheckoutPaymentFailure(params: {
  stripeEventId: string;
  stripePaymentIntentId: string;
  orderId: string;
  errorMessage: string | null;
  declineCode: string | null;
}): Promise<{ incidentId: string; created: boolean }> {
  return recordPaymentDeclinedIncident({
    orderId: params.orderId,
    checkoutSessionId: null,
    stripeEventId: params.stripeEventId,
    stripePaymentIntentId: params.stripePaymentIntentId,
    errorMessage: params.errorMessage,
    declineCode: params.declineCode,
  });
}

export async function runStripePaymentDeclineDemo(params?: {
  orderId?: string;
  request?: CheckoutOrderRequestInput;
}): Promise<{
  orderId: string;
  incidentId: string;
  created: boolean;
  declineCode: string | null;
  errorMessage: string | null;
  paymentIntentId: string | null;
}> {
  const metadata = await buildCheckoutOrderMetadata({
    orderId: params?.orderId,
    request: params?.request,
  });
  const checkoutSessionId = `decline-demo:${metadata.orderId}`;

  await ensurePendingCheckoutOrder({
    metadata,
    stripeCheckoutSessionId: checkoutSessionId,
  });

  const stripe = getStripeServer();

  try {
    await stripe.paymentIntents.create({
      amount: metadata.quotedPriceCents,
      currency: "usd",
      confirm: true,
      payment_method: "pm_card_visa_chargeDeclinedInsufficientFunds",
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: {
        orderId: metadata.orderId,
        checkoutScenario: "payment_declined",
      },
    });
  } catch (error: unknown) {
    if (error instanceof Stripe.errors.StripeCardError) {
      const rawStripeError = error.raw as
        | { payment_intent?: Stripe.PaymentIntent }
        | undefined;
      const paymentIntent = rawStripeError?.payment_intent as
        | Stripe.PaymentIntent
        | undefined;
      const paymentIntentId = paymentIntent?.id ?? null;

      const incident = await recordStripeCheckoutPaymentFailure({
        stripeEventId: `stripe-sync:${paymentIntentId ?? metadata.orderId}`,
        stripePaymentIntentId:
          paymentIntentId ?? `stripe-sync:${metadata.orderId}`,
        orderId: metadata.orderId,
        errorMessage: error.message ?? null,
        declineCode: error.decline_code ?? error.code ?? null,
      });

      return {
        orderId: metadata.orderId,
        incidentId: incident.incidentId,
        created: incident.created,
        declineCode: error.decline_code ?? error.code ?? null,
        errorMessage: error.message ?? null,
        paymentIntentId,
      };
    }

    throw error;
  }

  throw new Error(
    "Stripe decline demo unexpectedly succeeded. The test payment method did not fail.",
  );
}

export function parseCheckoutMetadata(
  metadata: Record<string, string> | null | undefined,
): CheckoutOrderMetadata {
  const orderId = metadata?.orderId?.trim();
  const customerId = metadata?.customerId?.trim();
  const pickupHubId = metadata?.pickupHubId?.trim();
  const vehicleId = metadata?.vehicleId?.trim();
  const quotedPriceCents = Number.parseInt(metadata?.quotedPriceCents ?? "", 10);

  if (!orderId || !customerId || !pickupHubId || Number.isNaN(quotedPriceCents)) {
    throw new Error("Checkout session metadata is incomplete.");
  }

  return {
    orderId,
    customerId,
    pickupHubId,
    quotedPriceCents,
    vehicleId,
  };
}

async function insertRoutingEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  const response = await fetch(new URL("/dashboard/event", mcpCoreUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType, payload }),
    cache: "no-store",
  });

  if (!response.ok) {
    const responsePayload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      responsePayload.error ?? `Dashboard event endpoint returned ${response.status}`,
    );
  }
}

async function ensureCheckoutRequestCustomer(customer: {
  id: string;
  name: string;
  lat: number;
  lng: number;
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("customer_locations").insert({
    id: customer.id,
    name: customer.name,
    lat: customer.lat,
    lng: customer.lng,
  });

  if (error && !isUniqueViolation(error)) {
    throw new Error(`Failed to persist checkout request customer: ${error.message}`);
  }
}

async function syncCheckoutOrderIntoSimulationWorld(orderId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      "id,customer_id,pickup_hub_id,vehicle_id,status,revenue_cents,stripe_checkout_session_id,stripe_payment_intent_id,stripe_event_id",
    )
    .eq("id", orderId)
    .maybeSingle<SimulationOrderRow>();

  if (orderError) {
    throw new Error(`Failed to sync checkout order ${orderId}: ${orderError.message}`);
  }

  if (!order) {
    return;
  }

  const { data: customer, error: customerError } = await supabase
    .from("customer_locations")
    .select("id,name,lat,lng")
    .eq("id", order.customer_id)
    .maybeSingle<SimulationCustomerRow>();

  if (customerError) {
    throw new Error(
      `Failed to sync checkout customer ${order.customer_id}: ${customerError.message}`,
    );
  }

  const [world, tick] = await Promise.all([
    loadWorldFromPostgres(),
    loadTickFromRedis(),
  ]);
  const nextCustomers = customer
    ? [
        ...world.customers.filter((entry) => entry.id !== customer.id),
        {
          id: customer.id,
          name: customer.name,
          location: { lat: customer.lat, lng: customer.lng },
        },
      ]
    : world.customers;
  const nextOrders = [
    ...world.orders.filter((entry) => entry.id !== order.id),
    {
      id: order.id,
      customerId: order.customer_id,
      pickupHubId: order.pickup_hub_id,
      vehicleId: order.vehicle_id,
      status: order.status as SimulationWorld["orders"][number]["status"],
      revenueCents: order.revenue_cents,
      stripeCheckoutSessionId: order.stripe_checkout_session_id,
      stripePaymentIntentId: order.stripe_payment_intent_id,
      stripeEventId: order.stripe_event_id,
    },
  ];

  await persistTickAndVehicles(
    tick,
    {
      ...world,
      customers: nextCustomers,
      orders: nextOrders,
    },
  );
}

async function requestHermesOrderIntakeDecision(
  candidate: CheckoutOrderCandidate,
): Promise<{
  accepted: boolean;
  quotedPriceCents: number;
  decisionSummary: string;
}> {
  type IntakeDecisionResult = {
    accepted: boolean;
    quotedPriceCents: number;
    decisionSummary: string;
  };

  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  let responseDecision: IntakeDecisionResult | null = null;
  let responseError: Error | null = null;

  void fetch(new URL("/dashboard/intake", mcpCoreUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: candidate.orderId,
        customerId: candidate.customerId,
        pickupHubId: candidate.pickupHubId,
        estimatedDistanceKm: candidate.quoteContext.estimatedDistanceKm,
        baselineQuoteCents: candidate.quoteContext.baselineQuoteCents,
        minQuoteCents: candidate.quoteContext.minQuoteCents,
        maxQuoteCents: candidate.quoteContext.maxQuoteCents,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    })
    .then(async (response) => {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        accepted?: boolean;
        quotedPriceCents?: number;
        decisionSummary?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Hermes order intake failed");
      }

      responseDecision = {
        accepted: payload.accepted === true,
        quotedPriceCents:
          typeof payload.quotedPriceCents === "number"
            ? payload.quotedPriceCents
            : candidate.quoteContext.baselineQuoteCents,
        decisionSummary:
          payload.decisionSummary ??
          "Hermes approved the order for checkout.",
      };
    })
    .catch((error: unknown) => {
      responseError =
        error instanceof Error
          ? error
          : new Error("Hermes order intake failed");
    });

  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (responseDecision) {
      return responseDecision;
    }

    const persistedDecision = await loadPersistedOrderIntakeDecision(
      candidate.orderId,
    );
    if (persistedDecision) {
      return persistedDecision;
    }

    if (attempt < 14) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  if (responseDecision) {
    return responseDecision;
  }

  if (responseError) {
    throw responseError;
  }

  throw new Error(
    "Hermes intake did not produce a usable decision within 30 seconds.",
  );
}

async function loadPersistedOrderIntakeDecision(orderId: string): Promise<{
  accepted: boolean;
  quotedPriceCents: number;
  decisionSummary: string;
} | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("simulation_events")
    .select("payload,created_at")
    .eq("event_type", "order_intake_decision_completed")
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) {
    console.error("Failed to load persisted Hermes intake decision", {
      orderId,
      error: error.message,
    });
    return null;
  }

  const matchingEvent = (data ?? []).find((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return payload?.orderId === orderId;
  }) as
    | {
        payload: Record<string, unknown> | null;
      }
    | undefined;

  if (!matchingEvent?.payload) {
    return null;
  }

  const accepted = matchingEvent.payload.accepted === true;
  const quotedPriceCents = Number(matchingEvent.payload.quotedPriceCents);
  if (!Number.isFinite(quotedPriceCents)) {
    return null;
  }

  return {
    accepted,
    quotedPriceCents,
    decisionSummary:
      typeof matchingEvent.payload.decisionSummary === "string"
        ? matchingEvent.payload.decisionSummary
        : accepted
          ? "Hermes intake decision was persisted successfully, so checkout is continuing from the stored quote even though the MCP HTTP response timed out."
          : "Hermes intake decision was persisted as rejected, even though the MCP HTTP response timed out.",
  };
}


export async function dispatchPaidOrderWithHermes(orderId: string): Promise<void> {
  const mcpCoreUrl = process.env.MCP_CORE_URL?.trim() || "http://127.0.0.1:8644";
  await insertRoutingEvent("checkout_order_dispatch_requested", { orderId });

  try {
    const response = await fetch(new URL("/dashboard/dispatch", mcpCoreUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      error?: string;
      selectedStrategy?: { optionId?: string };
      decisionSource?: string;
      decisionSummary?: string;
      contextRefs?: Array<Record<string, unknown>>;
      skillRefs?: Array<Record<string, unknown>>;
      plannedTools?: Array<Record<string, unknown>>;
      execution?: {
        provider?: string;
        routeCount?: number;
        orderAssignmentCount?: number;
        assignedVehicleId?: string | null;
        unassignedOrderIds?: string[];
        dispatched?: boolean;
      };
      provider?: string;
      model?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error ?? "Hermes paid-order dispatch failed");
    }

    await insertRoutingEvent("checkout_order_dispatched", {
      orderId,
      selectedStrategy: payload.selectedStrategy?.optionId ?? null,
      decisionSource: payload.decisionSource ?? null,
      decisionSummary: payload.decisionSummary ?? null,
      contextRefs: payload.contextRefs ?? [],
      skillRefs: payload.skillRefs ?? [],
      plannedTools: payload.plannedTools ?? [],
      provider: payload.execution?.provider ?? payload.provider ?? null,
      model: payload.model ?? null,
      routeCount: payload.execution?.routeCount ?? null,
      orderAssignmentCount: payload.execution?.orderAssignmentCount ?? null,
      assignedVehicleId: payload.execution?.assignedVehicleId ?? null,
      unassignedOrderIds: payload.execution?.unassignedOrderIds ?? [],
      dispatched: payload.execution?.dispatched ?? false,
    });

    await hydrateLiveDispatchState({
      orderId,
      assignedVehicleId: payload.execution?.assignedVehicleId ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Hermes dispatch failure";
    await insertRoutingEvent("checkout_order_dispatch_failed", {
      orderId,
      error: message,
    });
    console.error("Hermes paid-order dispatch failed", { orderId, error });
    throw error;
  }
}

export async function ensureHermesDispatchForPaidOrder(orderId: string): Promise<{
  dispatched: boolean;
  skippedReason:
    | "missing_order"
    | "not_paid"
    | "already_dispatched"
    | "dispatch_in_progress"
    | null;
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("orders")
    .select("id,status")
    .eq("id", orderId)
    .maybeSingle<{ id: string; status: string }>();

  if (error) {
    throw new Error(`Failed to load paid order dispatch state: ${error.message}`);
  }

  if (!data) {
    return {
      dispatched: false,
      skippedReason: "missing_order",
    };
  }

  if (data.status !== "paid") {
    if (
      data.status === "assigned" ||
      data.status === "in_transit" ||
      data.status === "delivered"
    ) {
      return {
        dispatched: false,
        skippedReason: "already_dispatched",
      };
    }
    return {
      dispatched: false,
      skippedReason: "not_paid",
    };
  }

  const redis = getRedis();
  const dispatchLockKey = `checkout_dispatch_lock:${orderId}`;
  const acquired = await redis.set(
    dispatchLockKey,
    String(Date.now()),
    "EX",
    180,
    "NX",
  );
  if (!acquired) {
    return {
      dispatched: false,
      skippedReason: "dispatch_in_progress",
    };
  }

  try {
    await dispatchPaidOrderWithHermes(orderId);
    return {
      dispatched: true,
      skippedReason: null,
    };
  } finally {
    await redis.del(dispatchLockKey);
  }
}

export const DELIVERY_PRICE_CENTS = BASE_DELIVERY_PRICE_CENTS;

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

async function hydrateLiveDispatchState(params: {
  orderId: string;
  assignedVehicleId: string | null;
}): Promise<void> {
  if (!params.assignedVehicleId) {
    return;
  }

  const [world, tick] = await Promise.all([
    loadWorldFromPostgres(),
    loadTickFromRedis(),
  ]);
  const targetVehicle = world.vehicles.find(
    (vehicle) => vehicle.id === params.assignedVehicleId,
  );
  if (!targetVehicle?.routingPlan) {
    return;
  }

  const targetProvider = targetVehicle.routingProvider;
  const nextWorld: SimulationWorld = {
    ...world,
    vehicles: world.vehicles.map((vehicle) => {
      const routingPlan = vehicle.routingPlan;
      const hasTargetOrder =
        routingPlan?.assignedOrderIds.includes(params.orderId) ?? false;
      if (!hasTargetOrder) {
        return vehicle;
      }

      if (vehicle.id !== params.assignedVehicleId) {
        const parkedPoint =
          routingPlan?.orderedStops[0]
            ? ([
                routingPlan.orderedStops[0].location.lng,
                routingPlan.orderedStops[0].location.lat,
              ] as LngLat)
            : ((vehicle.route[0] ?? [0, 0]) as LngLat);

        return {
          ...vehicle,
          route: [parkedPoint],
          routingPlan: buildParkedRoutingPlan(parkedPoint, targetProvider),
          routeStatus: "normal",
          status: "idle",
          frozenAtSeconds: null,
        };
      }

      if (!routingPlan) {
        return vehicle;
      }

      const currentRouteStart =
        routingPlan.routeStartAtSeconds ?? 0;
      const shouldOffset =
        currentRouteStart <= 0 &&
        routingPlan.orderedStops.some((stop) => stop.etaSeconds > 0);
      const effectiveRouteStart =
        currentRouteStart > 0 ? currentRouteStart : tick.elapsedSeconds;

      return {
        ...vehicle,
        routeStatus: "normal",
        status: "en_route",
        frozenAtSeconds: null,
        routingPlan: {
          ...routingPlan,
          provider: routingPlan.provider ?? targetProvider,
          routeStartAtSeconds: effectiveRouteStart,
          orderedStops: routingPlan.orderedStops.map((stop) => ({
            ...stop,
            etaSeconds:
              stop.kind === "start"
                ? effectiveRouteStart
                : shouldOffset
                  ? stop.etaSeconds + effectiveRouteStart
                  : stop.etaSeconds,
          })),
        },
      };
    }),
  };

  const supabase = getSupabaseAdmin();
  for (const vehicle of nextWorld.vehicles) {
    const { error } = await supabase
      .from("vehicles")
      .update({
        route: vehicle.route,
        routing_provider: vehicle.routingProvider,
        routing_plan: vehicle.routingPlan,
        route_status: vehicle.routeStatus,
        status: vehicle.status,
        frozen_at_seconds: vehicle.frozenAtSeconds,
      })
      .eq("id", vehicle.id);

    if (error) {
      throw new Error(`Failed to hydrate live dispatch state for ${vehicle.id}: ${error.message}`);
    }
  }

  await persistTickAndVehicles(
    tick.status === "running"
      ? tick
      : {
          ...tick,
          status: "running",
        },
    nextWorld,
  );
}
