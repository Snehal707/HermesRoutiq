import { z } from "zod";
import { defaultModelResponder, type ModelResponder } from "./reasoning.js";
import { toolOutputSchemas } from "./schemas.js";

type BusinessSnapshot = typeof toolOutputSchemas.get_business_snapshot._type;
type ActiveOrders = typeof toolOutputSchemas.get_active_orders._type;
type RoutePreview = typeof toolOutputSchemas.request_route_optimisation._type;

const dispatchActionSchema = z.object({
  tool: z.enum(["dispatch_paid_order", "send_customer_notification"]),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

const paidOrderDispatchDecisionSchema = z.object({
  orderId: z.string().min(1),
  selectedStrategy: z.enum(["dispatch_now", "hold_for_capacity"]),
  decisionSummary: z.string().min(1),
  expectedRevenueCaptured: z.number().int().nonnegative().nullable().optional(),
  actions: z.array(dispatchActionSchema).min(1),
}).strict();

export type PaidOrderDispatchDecision = z.infer<
  typeof paidOrderDispatchDecisionSchema
>;

export interface DispatchStrategy {
  optionId: "dispatch_now" | "hold_for_capacity";
  label: string;
  viable: boolean;
  viabilityReason: string;
  actionPlan: PaidOrderDispatchDecision["actions"];
}

export interface DispatchContextRef {
  id: string;
  type: "fleet_capacity" | "route_preview" | "paid_order";
  summary: string;
}

export interface DispatchSkillRef {
  name: string;
  source: string;
  summary: string;
}

export interface DispatchPlannedTool {
  tool: string;
  purpose: string;
}

export interface PaidOrderDispatchContext {
  orderId: string;
  businessSnapshot: BusinessSnapshot;
  activeOrders: ActiveOrders;
  routePreview: RoutePreview;
}

export interface PaidOrderDispatchReasoningResult {
  decision: PaidOrderDispatchDecision;
  candidateStrategies: DispatchStrategy[];
  contextRefs: DispatchContextRef[];
  skillRefs: DispatchSkillRef[];
  plannedTools: DispatchPlannedTool[];
  provider: string;
  model: string;
  rawModelResponse: string;
  attempts: number;
  latencyMs: number;
}

function createDispatchSystemPrompt(): string {
  return [
    "You are Hermes, an autonomous delivery dispatch agent operating inside the NemoClaw sandbox.",
    "Return JSON only.",
    "Do not include markdown fences or commentary.",
    "Use the live paid order, fleet snapshot, and route preview to choose one dispatch strategy.",
    "Do not invent prices, capacity, or route assignments beyond the provided context.",
    "If the order is clearly assignable in the live route preview, prefer dispatch_now.",
    "If the order is not assignable or the preview is weak, use hold_for_capacity.",
    "Only use the available action tools listed in the prompt.",
  ].join(" ");
}

function buildDispatchOptionCatalog(
  context: PaidOrderDispatchContext,
): DispatchStrategy[] {
  const targetOrder =
    context.activeOrders.orders.find((order) => order.id === context.orderId) ??
    null;
  if (!targetOrder) {
    throw new Error(`Paid order ${context.orderId} is missing from the active order set.`);
  }

  const previewAssignment = context.routePreview.routes.find((route) =>
    route.routingPlan.assignedOrderIds.includes(context.orderId),
  );
  const previewUnassigned = context.routePreview.unassignedOrderIds.includes(
    context.orderId,
  );

  return [
    {
      optionId: "dispatch_now",
      label: "Dispatch the paid order now",
      viable: previewAssignment !== undefined && !previewUnassigned,
      viabilityReason: previewAssignment
        ? `Route preview assigned ${context.orderId} to ${previewAssignment.vehicleId}.`
        : `Route preview could not assign ${context.orderId} to any active vehicle.`,
      actionPlan: [
        {
          tool: "dispatch_paid_order",
          arguments: {
            orderId: context.orderId,
          },
        },
        {
          tool: "send_customer_notification",
          arguments: {
            orderId: context.orderId,
            channel: "push",
            message:
              "Hermes accepted your payment and released the delivery into the live fleet.",
          },
        },
      ],
    },
    {
      optionId: "hold_for_capacity",
      label: "Hold dispatch until capacity improves",
      viable: true,
      viabilityReason:
        "Always viable as a fallback when Hermes prefers to delay release instead of forcing a weak route assignment.",
      actionPlan: [
        {
          tool: "send_customer_notification",
          arguments: {
            orderId: context.orderId,
            channel: "push",
            message:
              "Hermes received your payment and queued dispatch while it waits for a stronger fleet slot.",
          },
        },
      ],
    },
  ];
}

function buildDispatchContextRefs(
  context: PaidOrderDispatchContext,
): DispatchContextRef[] {
  const targetOrder =
    context.activeOrders.orders.find((order) => order.id === context.orderId) ??
    null;
  const assignedPreview = context.routePreview.routes.find((route) =>
    route.routingPlan.assignedOrderIds.includes(context.orderId),
  );

  return [
    {
      id: `dispatch-fleet:${context.orderId}`,
      type: "fleet_capacity",
      summary:
        `${context.businessSnapshot.summary.availableDrivers} drivers available, ` +
        `${context.businessSnapshot.summary.activeOrders} active paid orders, ` +
        `${context.businessSnapshot.summary.activeVehicleRoutes} routed vehicles.`,
    },
    {
      id: `dispatch-preview:${context.orderId}`,
      type: "route_preview",
      summary: assignedPreview
        ? `Route preview assigned ${context.orderId} to ${assignedPreview.vehicleId}.`
        : `Route preview did not assign ${context.orderId}; Hermes may hold for capacity.`,
    },
    {
      id: `dispatch-order:${context.orderId}`,
      type: "paid_order",
      summary: targetOrder
        ? `Paid order ${context.orderId} is ${targetOrder.status} at $${(targetOrder.revenueCents / 100).toFixed(2)} revenue.`
        : `Paid order ${context.orderId} is awaiting active-order visibility.`,
    },
  ];
}

function buildDispatchSkillRefs(): DispatchSkillRef[] {
  return [
    {
      name: "paid_dispatch_release_policy",
      source: "repo_policy",
      summary:
        "Release immediately only when the live route preview can honestly assign the paid order.",
    },
  ];
}

function buildDispatchPlannedTools(
  decision: PaidOrderDispatchDecision,
): DispatchPlannedTool[] {
  return decision.actions.map((action) => ({
    tool: action.tool,
    purpose:
      action.tool === "dispatch_paid_order"
        ? "Persist the routed assignment so the paid order enters the live fleet."
        : "Notify the customer about Hermes' dispatch decision.",
  }));
}

function createDispatchUserPrompt(
  context: PaidOrderDispatchContext,
  optionCatalog: DispatchStrategy[],
  priorFailure?: string,
): string {
  const targetOrder = context.activeOrders.orders.find(
    (order) => order.id === context.orderId,
  );

  return JSON.stringify(
    {
      task: "paid_order_dispatch_decision",
      guidance: priorFailure
        ? `Your previous answer was rejected for this reason: ${priorFailure}. Correct it and return valid JSON only.`
        : "Inspect the live dispatch context and choose the most operationally sound strategy for this paid order.",
      order: targetOrder,
      fleetSnapshot: context.businessSnapshot,
      routePreview: context.routePreview,
      dispatchOptionCatalog: optionCatalog,
      availableActionTools: [
        {
          tool: "dispatch_paid_order",
          purpose:
            "Persist the route optimisation result so the paid order actually enters the live fleet.",
          requiredArguments: {
            orderId: context.orderId,
          },
        },
        {
          tool: "send_customer_notification",
          purpose:
            "Notify the customer whether Hermes dispatched immediately or intentionally queued the delivery.",
          requiredArguments: {
            orderId: context.orderId,
            channel: "push",
            message: "Customer-visible dispatch status message.",
          },
        },
      ],
      responseRules: {
        selectedStrategyMustBeOneOf: optionCatalog.map((option) => option.optionId),
        noFreeFormText: true,
        orderIdMustMatch: context.orderId,
      },
    },
    null,
    2,
  );
}

function parseDispatchDecisionResponse(
  rawResponse: string,
): PaidOrderDispatchDecision {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawResponse);
  } catch (error) {
    throw new Error(
      `Dispatch decision was not valid JSON: ${error instanceof Error ? error.message : String(error)}. Raw response: ${rawResponse}`,
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

  const parsed = paidOrderDispatchDecisionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Dispatch decision failed schema validation: ${parsed.error.message}. Raw response: ${rawResponse}`,
    );
  }

  return parsed.data;
}

function normalizeActionPlan(
  actions: PaidOrderDispatchDecision["actions"],
): PaidOrderDispatchDecision["actions"] {
  return actions.map((action) => ({
    tool: action.tool,
    arguments: action.arguments,
  }));
}

function validateDispatchDecision(
  decision: PaidOrderDispatchDecision,
  optionCatalog: DispatchStrategy[],
): void {
  const selected = optionCatalog.find(
    (strategy) => strategy.optionId === decision.selectedStrategy,
  );

  if (!selected) {
    throw new Error(
      `Selected dispatch strategy '${decision.selectedStrategy}' was not provided.`,
    );
  }

  if (!selected.viable) {
    throw new Error(
      `Selected dispatch strategy '${decision.selectedStrategy}' is not viable: ${selected.viabilityReason}`,
    );
  }

  const actionToolNames = new Set(decision.actions.map((action) => action.tool));
  if (
    decision.selectedStrategy === "dispatch_now" &&
    !actionToolNames.has("dispatch_paid_order")
  ) {
    throw new Error(
      "dispatch_now decisions must include a dispatch_paid_order action.",
    );
  }

  if (!actionToolNames.has("send_customer_notification")) {
    throw new Error(
      "Dispatch decisions must include a send_customer_notification action.",
    );
  }

  const normalizedDecisionActions = JSON.stringify(
    normalizeActionPlan(decision.actions),
  );
  const normalizedCatalogActions = JSON.stringify(
    normalizeActionPlan(selected.actionPlan),
  );

  if (normalizedDecisionActions !== normalizedCatalogActions) {
    throw new Error(
      `Dispatch decision actions for '${decision.selectedStrategy}' did not match the allowed action plan.`,
    );
  }
}

export async function reasonAboutPaidOrderDispatch(
  context: PaidOrderDispatchContext,
  responder: ModelResponder = defaultModelResponder,
): Promise<PaidOrderDispatchReasoningResult> {
  const optionCatalog = buildDispatchOptionCatalog(context);
  const contextRefs = buildDispatchContextRefs(context);
  const skillRefs = buildDispatchSkillRefs();
  const startedAt = Date.now();
  let priorFailure: string | undefined;
  let lastRawResponse = "";
  let lastProvider = "unknown";
  let lastModel = "unknown";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await responder({
      messages: [
        { role: "system", content: createDispatchSystemPrompt() },
        {
          role: "user",
          content: createDispatchUserPrompt(
            context,
            optionCatalog,
            priorFailure,
          ),
        },
      ],
    });

    lastRawResponse = response.content;
    lastProvider = response.provider;
    lastModel = response.model;

    try {
      const decision = parseDispatchDecisionResponse(response.content);
      validateDispatchDecision(decision, optionCatalog);

      return {
        decision,
        candidateStrategies: optionCatalog,
        contextRefs,
        skillRefs,
        plannedTools: buildDispatchPlannedTools(decision),
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
    `Dispatch reasoning failed to produce a valid decision: ${lastRawResponse || `${lastProvider}:${lastModel}`}`,
  );
}
