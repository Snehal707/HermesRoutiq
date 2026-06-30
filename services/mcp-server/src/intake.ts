import { z } from "zod";
import { defaultModelResponder, type ModelResponder } from "./reasoning.js";
import { toolOutputSchemas } from "./schemas.js";

type BusinessSnapshot = typeof toolOutputSchemas.get_business_snapshot._type;
type ActiveOrders = typeof toolOutputSchemas.get_active_orders._type;

const orderIntakeDecisionSchema = z.object({
  orderId: z.string().min(1),
  selectedStrategy: z.enum(["accept_and_quote", "reject_order"]),
  accepted: z.boolean(),
  quotedPriceCents: z.number().int().nonnegative(),
  decisionSummary: z.string().min(1),
  expectedRevenueCaptured: z.number().int().nonnegative().nullable().optional(),
}).strict();

export type OrderIntakeDecision = z.infer<typeof orderIntakeDecisionSchema>;

export interface OrderIntakeContext {
  orderId: string;
  customerId: string;
  pickupHubId: string;
  estimatedDistanceKm: number;
  baselineQuoteCents: number;
  minQuoteCents: number;
  maxQuoteCents: number;
  businessSnapshot: BusinessSnapshot;
  activeOrders: ActiveOrders;
}

export interface OrderIntakeStrategy {
  optionId: "accept_and_quote" | "reject_order";
  label: string;
  viable: boolean;
  viabilityReason: string;
}

export interface OrderIntakeContextRef {
  id: string;
  type: "fleet_capacity" | "request_profile" | "recent_order";
  summary: string;
}

export interface OrderIntakeSkillRef {
  name: string;
  source: string;
  summary: string;
}

export interface OrderIntakePlannedTool {
  tool: string;
  purpose: string;
}

export interface OrderIntakeReasoningResult {
  decision: OrderIntakeDecision;
  candidateStrategies: OrderIntakeStrategy[];
  contextRefs: OrderIntakeContextRef[];
  skillRefs: OrderIntakeSkillRef[];
  plannedTools: OrderIntakePlannedTool[];
  provider: string;
  model: string;
  rawModelResponse: string;
  attempts: number;
  latencyMs: number;
}

function createOrderIntakeSystemPrompt(): string {
  return [
    "You are Hermes, an autonomous delivery intake agent operating inside the NemoClaw sandbox.",
    "Return JSON only.",
    "Do not include markdown fences or commentary.",
    "Decide whether to accept the incoming delivery request and what price to quote.",
    "Use only the live fleet snapshot, active order list, and quote band provided in the prompt.",
    "Prefer accept_and_quote when capacity exists and the quote band supports healthy margin.",
    "Use reject_order only when live capacity is too constrained to responsibly release more work.",
    "Never quote outside the minQuoteCents and maxQuoteCents band.",
  ].join(" ");
}

function buildOrderIntakeStrategyCatalog(
  context: OrderIntakeContext,
): OrderIntakeStrategy[] {
  const availableDrivers = context.businessSnapshot.summary.availableDrivers;
  const activeOrders = context.businessSnapshot.summary.activeOrders;
  const activeVehicleRoutes = context.businessSnapshot.summary.activeVehicleRoutes;
  const fleetPressure = activeVehicleRoutes > 0
    ? activeOrders / Math.max(1, activeVehicleRoutes)
    : activeOrders;
  const acceptViable = availableDrivers > 0 && fleetPressure <= 4;

  return [
    {
      optionId: "accept_and_quote",
      label: "Accept the order and issue a checkout quote",
      viable: acceptViable,
      viabilityReason: acceptViable
        ? `Live capacity exists with ${availableDrivers} available drivers and fleet pressure ${fleetPressure.toFixed(2)}.`
        : `Live capacity is constrained with ${availableDrivers} available drivers and fleet pressure ${fleetPressure.toFixed(2)}.`,
    },
    {
      optionId: "reject_order",
      label: "Reject the order because current live capacity is too constrained",
      viable: true,
      viabilityReason:
        "Always viable when Hermes believes accepting more paid work would misrepresent current fleet capacity.",
    },
  ];
}

function formatDollarsFromCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function buildOrderIntakeContextRefs(
  context: OrderIntakeContext,
): OrderIntakeContextRef[] {
  const recentOrderRefs = context.activeOrders.orders
    .slice(-2)
    .map((order) => ({
      id: order.id,
      type: "recent_order" as const,
      summary:
        `Recent live order ${order.id} is ${order.status} from ${order.pickupHubId} ` +
        `at ${formatDollarsFromCents(order.revenueCents)} revenue.`,
    }));

  return [
    {
      id: `fleet:${context.orderId}`,
      type: "fleet_capacity",
      summary:
        `${context.businessSnapshot.summary.availableDrivers} drivers available, ` +
        `${context.businessSnapshot.summary.activeOrders} active paid orders, ` +
        `${context.businessSnapshot.summary.activeVehicleRoutes} routed vehicles.`,
    },
    {
      id: `request:${context.orderId}`,
      type: "request_profile",
      summary:
        `${context.pickupHubId} -> ${context.estimatedDistanceKm.toFixed(2)} km lane, ` +
        `baseline ${formatDollarsFromCents(context.baselineQuoteCents)}, ` +
        `guardrails ${formatDollarsFromCents(context.minQuoteCents)}-${formatDollarsFromCents(context.maxQuoteCents)}.`,
    },
    ...recentOrderRefs,
  ];
}

function buildOrderIntakeSkillRefs(): OrderIntakeSkillRef[] {
  return [
    {
      name: "delivery_intake_policy",
      source: "repo_policy",
      summary:
        "Accept only when live fleet capacity exists and keep quotes inside the allowed commerce band.",
    },
  ];
}

function buildOrderIntakePlannedTools(): OrderIntakePlannedTool[] {
  return [
    {
      tool: "dispatch_paid_order",
      purpose: "Release the paid order into routing once checkout clears.",
    },
    {
      tool: "request_route_optimisation",
      purpose: "Ask cuOpt/OSRM for the assigned vehicle route after dispatch.",
    },
  ];
}

function createOrderIntakeUserPrompt(
  context: OrderIntakeContext,
  candidateStrategies: OrderIntakeStrategy[],
  priorFailure?: string,
): string {
  return JSON.stringify(
    {
      task: "delivery_order_intake",
      guidance: priorFailure
        ? `Your previous answer was rejected for this reason: ${priorFailure}. Correct it and return valid JSON only.`
        : "Inspect the incoming delivery request and choose whether Hermes should accept it now or reject it due to live capacity constraints.",
      orderRequest: {
        orderId: context.orderId,
        customerId: context.customerId,
        pickupHubId: context.pickupHubId,
        estimatedDistanceKm: context.estimatedDistanceKm,
      },
      pricing: {
        baselineQuoteCents: context.baselineQuoteCents,
        minQuoteCents: context.minQuoteCents,
        maxQuoteCents: context.maxQuoteCents,
      },
      fleetSnapshot: context.businessSnapshot,
      activeOrders: context.activeOrders,
      candidateStrategies,
      responseRules: {
        orderIdMustMatch: context.orderId,
        selectedStrategyMustBeOneOf: candidateStrategies.map((strategy) => strategy.optionId),
        acceptedMustMatchStrategy: {
          accept_and_quote: true,
          reject_order: false,
        },
        quotedPriceCentsMustBeWithinBandWhenAccepted: true,
        quotedPriceCentsMustBeZeroWhenRejected: true,
      },
    },
    null,
    2,
  );
}

function parseOrderIntakeDecisionResponse(
  rawResponse: string,
): OrderIntakeDecision {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawResponse);
  } catch (error) {
    throw new Error(
      `Order intake decision was not valid JSON: ${error instanceof Error ? error.message : String(error)}. Raw response: ${rawResponse}`,
    );
  }

  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    "decision" in parsedJson &&
    parsedJson.decision &&
    typeof parsedJson.decision === "object"
  ) {
    parsedJson = parsedJson.decision;
  }

  const parsed = orderIntakeDecisionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Order intake decision failed schema validation: ${parsed.error.message}. Raw response: ${rawResponse}`,
    );
  }

  return parsed.data;
}

function validateOrderIntakeDecision(
  context: OrderIntakeContext,
  decision: OrderIntakeDecision,
  candidateStrategies: OrderIntakeStrategy[],
): void {
  if (decision.orderId !== context.orderId) {
    throw new Error(
      `Order intake decision returned mismatched orderId ${decision.orderId}. Expected ${context.orderId}.`,
    );
  }

  const selectedStrategy = candidateStrategies.find(
    (strategy) => strategy.optionId === decision.selectedStrategy,
  );
  if (!selectedStrategy) {
    throw new Error(
      `Selected intake strategy '${decision.selectedStrategy}' was not provided.`,
    );
  }

  if (!selectedStrategy.viable && decision.selectedStrategy !== "reject_order") {
    throw new Error(
      `Selected intake strategy '${decision.selectedStrategy}' is not viable: ${selectedStrategy.viabilityReason}`,
    );
  }

  if (decision.selectedStrategy === "accept_and_quote") {
    if (!decision.accepted) {
      throw new Error("accept_and_quote decisions must set accepted=true.");
    }

    if (
      decision.quotedPriceCents < context.minQuoteCents ||
      decision.quotedPriceCents > context.maxQuoteCents
    ) {
      throw new Error(
        `Accepted intake quote ${decision.quotedPriceCents} is outside the allowed band ${context.minQuoteCents}-${context.maxQuoteCents}.`,
      );
    }

    return;
  }

  if (decision.accepted) {
    throw new Error("reject_order decisions must set accepted=false.");
  }

  if (decision.quotedPriceCents !== 0) {
    throw new Error("reject_order decisions must set quotedPriceCents=0.");
  }
}

export async function reasonAboutOrderIntake(
  context: OrderIntakeContext,
  responder: ModelResponder = defaultModelResponder,
): Promise<OrderIntakeReasoningResult> {
  const candidateStrategies = buildOrderIntakeStrategyCatalog(context);
  const contextRefs = buildOrderIntakeContextRefs(context);
  const skillRefs = buildOrderIntakeSkillRefs();
  const plannedTools = buildOrderIntakePlannedTools();
  const startedAt = Date.now();
  let priorFailure: string | undefined;
  let lastRawResponse = "";
  let lastProvider = "unknown";
  let lastModel = "unknown";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await responder({
      messages: [
        { role: "system", content: createOrderIntakeSystemPrompt() },
        {
          role: "user",
          content: createOrderIntakeUserPrompt(
            context,
            candidateStrategies,
            priorFailure,
          ),
        },
      ],
    });

    lastRawResponse = response.content;
    lastProvider = response.provider;
    lastModel = response.model;

    try {
      const decision = parseOrderIntakeDecisionResponse(response.content);
      validateOrderIntakeDecision(context, decision, candidateStrategies);

      return {
        decision,
        candidateStrategies,
        contextRefs,
        skillRefs,
        plannedTools,
        provider: response.provider,
        model: response.model,
        rawModelResponse: response.content,
        attempts: attempt + 1,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }

      priorFailure = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `Order intake reasoning failed to produce a valid decision: ${lastRawResponse || `${lastProvider}:${lastModel}`}`,
  );
}
