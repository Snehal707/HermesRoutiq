import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerReadTools } from "./tools.js";
import { toolOutputSchemas } from "./schemas.js";
import {
  incidentDecisionJsonSchema,
  incidentDecisionSchema,
  type IncidentDecision,
  type IncidentDecisionAction,
} from "./schemas/decision.js";
import { insertSimulationEvent, readTickState } from "./db.js";
import { getReasoningModelEnv } from "./env.js";
import { authorizeToolForRole } from "./policy.js";

type ToolHandler = (input: unknown) => Promise<{ structuredContent: unknown }>;

type IncidentDetails = typeof toolOutputSchemas.get_incident_details._type;
type FinancialExposure = typeof toolOutputSchemas.calculate_financial_exposure._type;
type AvailableDrivers = typeof toolOutputSchemas.get_available_drivers._type;
type RecoveryOptions = typeof toolOutputSchemas.compare_recovery_options._type;

type SupportedReadTool =
  | "get_incident_details"
  | "calculate_financial_exposure"
  | "get_available_drivers"
  | "compare_recovery_options";

interface ToolOutputs {
  incidentDetails: IncidentDetails;
  financialExposure: FinancialExposure;
  availableDrivers: AvailableDrivers;
  recoveryOptions: RecoveryOptions;
}

interface CandidateStrategy {
  optionId: string;
  label: string;
  approvedBudget: number;
  expectedLossAvoided: number;
  expectedNetBenefit: number;
  expectedLateDeliveries: number;
  viable: boolean;
  viabilityReason: string;
  actionPlan: IncidentDecisionAction[];
}

interface PlanningToolDescriptor {
  tool: string;
  role: "routing" | "finance" | "operations" | "payment";
  purpose: string;
  requiredArguments: Record<string, unknown>;
  notes?: string[];
}

interface ModelMessage {
  role: "system" | "user";
  content: string;
}

interface ModelResponse {
  provider: string;
  model: string;
  content: string;
}

interface LearnedRecoverySkillContext {
  skillName: string;
  skillPath: string;
  markdown: string;
  learnedFromIncidentId: string | null;
  createdAt: string | null;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function readNumberField(
  payload: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function normalizeOptionId(
  value: string,
): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function resolveSelectedStrategyIdentifier(
  rawValue: unknown,
  candidateStrategies: CandidateStrategy[],
): string | null {
  const candidatesByOptionId = new Map(
    candidateStrategies.map((strategy) => [
      normalizeOptionId(strategy.optionId),
      strategy.optionId,
    ]),
  );
  const candidatesByLabel = new Map(
    candidateStrategies.map((strategy) => [
      normalizeOptionId(strategy.label),
      strategy.optionId,
    ]),
  );

  const tryResolve = (value: string | null): string | null => {
    if (!value) {
      return null;
    }

    const normalized = normalizeOptionId(value);
    return (
      candidatesByOptionId.get(normalized) ??
      candidatesByLabel.get(normalized) ??
      null
    );
  };

  if (typeof rawValue === "string") {
    return tryResolve(rawValue);
  }

  const record = asUnknownRecord(rawValue);
  if (!record) {
    return null;
  }

  return (
    tryResolve(
      readStringField(record, [
        "optionId",
        "option_id",
        "selectedStrategy",
        "selected_strategy",
        "strategy",
        "strategyId",
        "strategy_id",
        "label",
      ]),
    ) ?? null
  );
}

function normalizeDecisionPayload(params: {
  rawDecision: unknown;
  incidentId: string;
  candidateStrategies: CandidateStrategy[];
}): unknown {
  let rawDecision = params.rawDecision;
  const outerRecord = asUnknownRecord(rawDecision);
  if (outerRecord && asUnknownRecord(outerRecord.decision)) {
    rawDecision = outerRecord.decision;
  }

  const decisionRecord = asUnknownRecord(rawDecision);
  if (!decisionRecord) {
    return rawDecision;
  }

  const selectedStrategy =
    resolveSelectedStrategyIdentifier(
      decisionRecord.selectedStrategy ??
        decisionRecord.selected_strategy ??
        decisionRecord.selectedOption ??
        decisionRecord.selected_option ??
        decisionRecord.strategy ??
        decisionRecord.strategyId ??
        decisionRecord.strategy_id ??
        decisionRecord.optionId ??
        decisionRecord.option_id,
      params.candidateStrategies,
    );
  const selectedCandidate =
    params.candidateStrategies.find(
      (strategy) => strategy.optionId === selectedStrategy,
    ) ?? null;

  const approvedBudget =
    readNumberField(decisionRecord, [
      "approvedBudget",
      "approved_budget",
      "approvedBudgetCents",
      "budgetCents",
      "expectedCostCents",
      "expected_cost_cents",
    ]) ?? selectedCandidate?.approvedBudget;
  const expectedLossAvoided =
    readNumberField(decisionRecord, [
      "expectedLossAvoided",
      "expected_loss_avoided",
      "expectedLossAvoidedCents",
      "expectedBenefitCents",
      "expected_benefit_cents",
      "lossAvoidedCents",
    ]) ?? selectedCandidate?.expectedLossAvoided;
  const expectedNetBenefit =
    readNumberField(decisionRecord, [
      "expectedNetBenefit",
      "expected_net_benefit",
      "expectedNetBenefitCents",
      "netBenefitCents",
      "net_benefit_cents",
    ]) ?? selectedCandidate?.expectedNetBenefit;
  const rawActions = Array.isArray(decisionRecord.actions)
    ? decisionRecord.actions
    : null;
  const actions =
    rawActions && rawActions.length > 0
      ? rawActions
      : selectedCandidate?.actionPlan ?? null;

  return {
    incidentId:
      readStringField(decisionRecord, ["incidentId", "incident_id"]) ??
      params.incidentId,
    selectedStrategy,
    approvedBudget,
    expectedLossAvoided,
    expectedNetBenefit,
    actions,
  };
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..", "..", "..");

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

export interface ReasoningResult {
  toolOutputs: ToolOutputs;
  candidateStrategies: CandidateStrategy[];
  decision: IncidentDecision;
  provider: string;
  model: string;
  rawModelResponse: string;
  attempts: number;
  latencyMs: number;
  reusedSkill: {
    loaded: boolean;
    injectedIntoModelContext: boolean;
    skillName: string;
    skillPath: string;
    learnedFromIncidentId: string | null;
    createdAt: string | null;
  } | null;
}

export class ModelDecisionValidationError extends Error {
  constructor(message: string, readonly rawResponse: string) {
    super(message);
    this.name = "ModelDecisionValidationError";
  }
}

export type ModelResponder = (request: {
  messages: ModelMessage[];
  responseFormat?: {
    name: string;
    schema: Record<string, unknown>;
  };
}) => Promise<ModelResponse>;

function createReadToolRegistry(): Map<SupportedReadTool, ToolHandler> {
  const handlers = new Map<SupportedReadTool, ToolHandler>();

  registerReadTools({
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      if (
        name === "get_incident_details" ||
        name === "calculate_financial_exposure" ||
        name === "get_available_drivers" ||
        name === "compare_recovery_options"
      ) {
        handlers.set(name, handler);
      }
    },
  } as never);

  return handlers;
}

async function callReadTool<T>(handlers: Map<SupportedReadTool, ToolHandler>, toolName: SupportedReadTool, input: unknown, schema: { parse: (value: unknown) => T }): Promise<T> {
  const handler = handlers.get(toolName);
  if (!handler) {
    throw new Error(`Missing read tool handler for ${toolName}`);
  }

  const result = await handler(input);
  return schema.parse(result.structuredContent);
}

export async function gatherReasoningInputs(incidentId: string): Promise<ToolOutputs> {
  const handlers = createReadToolRegistry();
  const authorizations = await Promise.all([
    authorizeToolForRole({
      role: "monitoring",
      toolName: "get_incident_details",
      incidentId,
    }),
    authorizeToolForRole({
      role: "finance",
      toolName: "calculate_financial_exposure",
      incidentId,
    }),
    authorizeToolForRole({
      role: "routing",
      toolName: "get_available_drivers",
      incidentId,
    }),
    authorizeToolForRole({
      role: "finance",
      toolName: "compare_recovery_options",
      incidentId,
    }),
  ]);
  const denied = authorizations.find((authorization) => !authorization.allowed);
  if (denied) {
    throw new Error(denied.reason);
  }

  const [incidentDetails, financialExposure, availableDrivers, recoveryOptions] = await Promise.all([
    callReadTool(handlers, "get_incident_details", { incidentId }, toolOutputSchemas.get_incident_details),
    callReadTool(handlers, "calculate_financial_exposure", { incidentId }, toolOutputSchemas.calculate_financial_exposure),
    callReadTool(handlers, "get_available_drivers", {}, toolOutputSchemas.get_available_drivers),
    callReadTool(handlers, "compare_recovery_options", { incidentId }, toolOutputSchemas.compare_recovery_options),
  ]);

  return {
    incidentDetails,
    financialExposure,
    availableDrivers,
    recoveryOptions,
  };
}

function inferDriversRequired(optionId: string): number {
  if (optionId.includes("two_driver")) {
    return 2;
  }

  if (optionId.includes("one_driver")) {
    return 1;
  }

  return 0;
}

function buildActionPlan(optionId: string, toolOutputs: ToolOutputs): IncidentDecisionAction[] {
  const impactedOrderIds = toolOutputs.incidentDetails.orders.map((order) => order.id);
  const availableDrivers = toolOutputs.availableDrivers.drivers.filter(
    (driver) => driver.vehicleId !== toolOutputs.incidentDetails.incident.vehicleId,
  );
  const incidentType = toolOutputs.incidentDetails.incident.type;

  if (incidentType === "congestion") {
    if (optionId !== "reroute_affected_vehicle") {
      return [];
    }

    return [
      {
        tool: "request_route_optimisation",
        arguments: {
          incidentId: "{{incidentId}}",
          routeStatus: "recovery",
        },
      },
      {
        tool: "apply_congestion_recovery_route",
        arguments: {
          incidentId: "{{incidentId}}",
        },
      },
      {
        tool: "create_recovery_skill",
        arguments: {
          skillName: "congestion_recovery",
          incidentId: "{{incidentId}}",
          incidentType,
          markdown: [
            "# congestion_recovery",
            "",
            "Recover a live congestion event by freezing the affected vehicle,",
            "requesting a verified reroute around the blocked zone,",
            "releasing the vehicle back into motion after the new route is persisted,",
            "and storing the successful reroute pattern for reuse.",
          ].join("\n"),
        },
      },
    ];
  }

  if (optionId === "one_driver_recovery") {
    const driver = availableDrivers[0];
    if (!driver) {
      return [];
    }

    return [
      {
        tool: "assign_replacement_driver",
        arguments: {
          driverId: driver.id,
          vehicleId: driver.vehicleId,
          orderIds: impactedOrderIds,
        },
      },
      {
        tool: "apply_breakdown_recovery_reroute",
        arguments: {
          incidentId: "{{incidentId}}",
        },
      },
      {
        tool: "create_driver_payout",
        arguments: {
          driverId: driver.id,
          amountCents: 400,
          incidentId: "{{incidentId}}",
          idempotencyKey: "{{incidentId}}:driver-payout:" + driver.id,
        },
      },
      {
        tool: "complete_delivery_recovery",
        arguments: {
          incidentId: "{{incidentId}}",
          orderIds: impactedOrderIds,
          vehicleIds: [driver.vehicleId],
          incidentVehicleId:
            toolOutputs.incidentDetails.incident.vehicleId ?? "incident-vehicle-id",
        },
      },
      ...impactedOrderIds.map((orderId) => ({
        tool: "send_customer_notification",
        arguments: {
          orderId,
          channel: "sms",
          message: "Your delivery was recovered and completed successfully.",
        },
      })),
      {
        tool: "create_recovery_skill",
        arguments: {
          skillName: "vehicle_breakdown_recovery",
          incidentId: "{{incidentId}}",
          incidentType: toolOutputs.incidentDetails.incident.type,
          markdown: [
            "# vehicle_breakdown_recovery",
            "",
            "Recover a breakdown by reassigning affected orders to replacement drivers,",
            "paying each replacement driver a fixed recovery incentive,",
            "confirming delivery recovery, and notifying the affected customers.",
          ].join("\n"),
        },
      },
    ];
  }

  if (optionId === "two_driver_recovery") {
    const chosenDrivers = availableDrivers.slice(0, 2);
    if (chosenDrivers.length < 2) {
      return [];
    }

    const assignments = chosenDrivers.map((driver, index) => ({
      tool: "assign_replacement_driver",
      arguments: {
        driverId: driver.id,
        vehicleId: driver.vehicleId,
        orderIds: impactedOrderIds.filter((_orderId, orderIndex) => orderIndex % 2 === index),
      },
    })).filter((action) => Array.isArray(action.arguments.orderIds) && action.arguments.orderIds.length > 0);

    return [
      ...assignments,
      {
        tool: "apply_breakdown_recovery_reroute",
        arguments: {
          incidentId: "{{incidentId}}",
        },
      },
      ...assignments.map((action) => ({
        tool: "create_driver_payout" as const,
        arguments: {
          driverId: String(action.arguments.driverId),
          amountCents: 400,
          incidentId: "{{incidentId}}",
          idempotencyKey: `{{incidentId}}:driver-payout:${String(action.arguments.driverId)}`,
        },
      })),
      {
        tool: "complete_delivery_recovery",
        arguments: {
          incidentId: "{{incidentId}}",
          orderIds: impactedOrderIds,
          vehicleIds: assignments.map((action) => String(action.arguments.vehicleId)),
          incidentVehicleId:
            toolOutputs.incidentDetails.incident.vehicleId ?? "incident-vehicle-id",
        },
      },
      ...impactedOrderIds.map((orderId) => ({
        tool: "send_customer_notification",
        arguments: {
          orderId,
          channel: "sms",
          message: "Your delivery was recovered and completed successfully.",
        },
      })),
      {
        tool: "create_recovery_skill",
        arguments: {
          skillName: "vehicle_breakdown_recovery",
          incidentId: "{{incidentId}}",
          incidentType: toolOutputs.incidentDetails.incident.type,
          markdown: [
            "# vehicle_breakdown_recovery",
            "",
            "Recover a three-delivery vehicle breakdown by comparing expected net benefit,",
            "assigning two replacement drivers, paying recovery incentives,",
            "verifying completion, and notifying the affected customers.",
          ].join("\n"),
        },
      },
    ];
  }

  if (
    optionId === "send_payment_recovery_link" ||
    optionId === "retry_payment_method"
  ) {
    const orderId = impactedOrderIds[0];
    if (!orderId) {
      return [];
    }

    return [{
      tool: "send_customer_notification",
      arguments: {
        orderId,
        channel: "email",
        message:
          optionId === "send_payment_recovery_link"
            ? "Your payment did not complete. Hermes has held dispatch and sent you a secure retry path to finish checkout."
            : "Your payment did not complete. Please retry checkout so Hermes can release your delivery into dispatch.",
      },
    },
    {
      tool: "create_recovery_skill",
      arguments: {
        skillName: "payment_declined_recovery",
        incidentId: "{{incidentId}}",
        incidentType: toolOutputs.incidentDetails.incident.type,
        markdown: [
          "# payment_declined_recovery",
          "",
          "Recover a declined checkout by keeping dispatch blocked,",
          "contacting the customer with a payment retry path,",
          "and preserving fleet capacity until payment succeeds.",
        ].join("\n"),
      },
    }];
  }

  return [];
}

function buildPlanningToolCatalog(
  toolOutputs: ToolOutputs,
  candidateStrategies: CandidateStrategy[],
): PlanningToolDescriptor[] {
  const incidentType = toolOutputs.incidentDetails.incident.type;
  const sharedNotes = [
    "Use only tools listed here.",
    "Do not invent arguments outside the required schema.",
  ];

  if (incidentType === "payment_declined") {
    return [
      {
        tool: "send_customer_notification",
        role: "operations",
        purpose: "Notify the customer how to recover from a declined payment while dispatch remains blocked.",
        requiredArguments: {
          orderId: toolOutputs.incidentDetails.incident.orderIds[0] ?? "order-id",
          channel: "email",
          message: "Clear payment recovery instruction tied to the selected strategy.",
        },
        notes: sharedNotes,
      },
      {
        tool: "create_recovery_skill",
        role: "operations",
        purpose: "Write the learned payment recovery procedure so Hermes can reuse it later.",
        requiredArguments: {
          skillName: "payment_declined_recovery",
          incidentId: toolOutputs.incidentDetails.incident.id,
          incidentType: toolOutputs.incidentDetails.incident.type,
          markdown: "Markdown playbook for the chosen payment recovery flow.",
        },
        notes: sharedNotes,
      },
    ];
  }

  if (incidentType === "congestion") {
    return [
      {
        tool: "request_route_optimisation",
        role: "routing",
        purpose: "Request the recovery route geometry for the selected incident.",
        requiredArguments: {
          incidentId: toolOutputs.incidentDetails.incident.id,
          routeStatus: "recovery",
        },
        notes: sharedNotes,
      },
      {
        tool: "apply_congestion_recovery_route",
        role: "routing",
        purpose: "Persist the verified congestion-avoidance route into the live fleet state.",
        requiredArguments: {
          incidentId: toolOutputs.incidentDetails.incident.id,
        },
        notes: sharedNotes,
      },
      {
        tool: "create_recovery_skill",
        role: "operations",
        purpose: "Write the learned congestion recovery procedure after the reroute succeeds.",
        requiredArguments: {
          skillName: "congestion_recovery",
          incidentId: toolOutputs.incidentDetails.incident.id,
          incidentType: toolOutputs.incidentDetails.incident.type,
          markdown: "Markdown playbook describing the successful congestion reroute pattern.",
        },
        notes: sharedNotes,
      },
    ];
  }

  const exampleStrategy = candidateStrategies.find(
    (strategy) => strategy.optionId === "two_driver_recovery" || strategy.optionId === "one_driver_recovery",
  );

  return [
    {
      tool: "assign_replacement_driver",
      role: "operations",
      purpose: "Reassign affected orders from the incident vehicle to a replacement vehicle.",
      requiredArguments: {
        driverId: exampleStrategy?.actionPlan.find((action) => action.tool === "assign_replacement_driver")?.arguments.driverId ?? "driver-id",
        vehicleId: exampleStrategy?.actionPlan.find((action) => action.tool === "assign_replacement_driver")?.arguments.vehicleId ?? "vehicle-id",
        orderIds: toolOutputs.incidentDetails.incident.orderIds,
      },
      notes: [
        ...sharedNotes,
        "Split orders across replacement drivers when the selected strategy uses multiple drivers.",
      ],
    },
    {
      tool: "apply_breakdown_recovery_reroute",
      role: "routing",
      purpose: "Persist rerouted recovery geometry for the replacement vehicles and park the broken vehicle.",
      requiredArguments: {
        incidentId: toolOutputs.incidentDetails.incident.id,
      },
      notes: [
        ...sharedNotes,
        "Run this after assign_replacement_driver actions so the live world reflects Hermes's chosen replacement vehicles.",
      ],
    },
    {
      tool: "create_driver_payout",
      role: "payment",
      purpose: "Pay each replacement driver the approved fixed incentive amount for incident recovery.",
      requiredArguments: {
        driverId: "same driverId used in assign_replacement_driver",
        amountCents: 400,
        incidentId: toolOutputs.incidentDetails.incident.id,
        idempotencyKey: `${toolOutputs.incidentDetails.incident.id}:driver-payout:<driverId>`,
      },
      notes: [
        ...sharedNotes,
        "Create one payout action per replacement driver assignment.",
      ],
    },
    {
      tool: "complete_delivery_recovery",
      role: "operations",
      purpose: "Wait for the demo recovery window, then mark the reassigned orders as delivered and close the incident vehicle.",
      requiredArguments: {
        incidentId: toolOutputs.incidentDetails.incident.id,
        orderIds: toolOutputs.incidentDetails.incident.orderIds,
        vehicleIds: [
          exampleStrategy?.actionPlan.find((action) => action.tool === "assign_replacement_driver")?.arguments.vehicleId ?? "replacement-vehicle-id",
        ],
        incidentVehicleId:
          toolOutputs.incidentDetails.incident.vehicleId ?? "incident-vehicle-id",
      },
      notes: [
        ...sharedNotes,
        "Run this after reroute and driver payout actions so the visible recovery route has time to play before completion is recorded.",
      ],
    },
    {
      tool: "send_customer_notification",
      role: "operations",
      purpose: "Notify each affected customer after recovery completes.",
      requiredArguments: {
        orderId: toolOutputs.incidentDetails.incident.orderIds[0] ?? "order-id",
        channel: "sms",
        message: "Confirmation that the delivery was recovered successfully.",
      },
      notes: [
        ...sharedNotes,
        "Create one notification action per affected order.",
      ],
    },
    {
      tool: "create_recovery_skill",
      role: "operations",
      purpose: "Write the learned breakdown recovery procedure for future reuse.",
      requiredArguments: {
        skillName: "vehicle_breakdown_recovery",
        incidentId: toolOutputs.incidentDetails.incident.id,
        incidentType: toolOutputs.incidentDetails.incident.type,
        markdown: "Markdown playbook describing the successful breakdown recovery pattern.",
      },
      notes: sharedNotes,
    },
  ];
}

export function buildCandidateStrategies(toolOutputs: ToolOutputs): CandidateStrategy[] {
  const incidentType = toolOutputs.incidentDetails.incident.type;
  const availableDriverCount = toolOutputs.availableDrivers.drivers.filter(
    (driver) => driver.vehicleId !== toolOutputs.incidentDetails.incident.vehicleId,
  ).length;

  return toolOutputs.recoveryOptions.options.map((option) => {
    const driversRequired = inferDriversRequired(option.optionId);
    const executableCongestionOption =
      incidentType !== "congestion" || option.optionId === "reroute_affected_vehicle";
    const hasRequiredDrivers = availableDriverCount >= driversRequired;
    const viable = executableCongestionOption && hasRequiredDrivers;
    const viabilityReason =
      incidentType === "congestion" && !executableCongestionOption
        ? "This congestion option is not wired for live execution in the current demo runtime."
        : hasRequiredDrivers
          ? "Sufficient replacement drivers are available for this strategy."
          : `Only ${availableDriverCount} replacement drivers are available, but ${driversRequired} are required.`;

    return {
      optionId: option.optionId,
      label: option.label,
      approvedBudget: option.expectedCostCents,
      expectedLossAvoided: option.expectedBenefitCents,
      expectedNetBenefit: option.expectedNetBenefitCents,
      expectedLateDeliveries: option.expectedLateDeliveries,
      viable,
      viabilityReason,
      actionPlan: buildActionPlan(option.optionId, toolOutputs),
    };
  });
}

function createSystemPrompt(): string {
  return [
    "You are Hermes, an autonomous delivery operations agent.",
    "Return JSON only.",
    "Do not include markdown fences or commentary.",
    "Choose the viable strategy with the highest expectedNetBenefit.",
    "Do not invent financial numbers. Use only the provided tool data and strategy comparison.",
    "Use the available action tool catalog to build the recovery plan.",
    "Do not propose executing the actions now; only recommend them in the JSON.",
  ].join(" ");
}

async function loadLearnedRecoverySkillContext(
  incidentType: string,
): Promise<LearnedRecoverySkillContext | null> {
  const typedPaths = getRecoverySkillStoragePaths(incidentType);
  const legacyPaths = {
    skillPath: resolve(repoRoot, "skills", "delivery-recovery", "SKILL.md"),
    metadataPath: resolve(repoRoot, "skills", "delivery-recovery", "metadata.json"),
  };

  let skillPath = typedPaths.skillPath;
  let metadataPath = typedPaths.metadataPath;

  try {
    await access(skillPath, fsConstants.F_OK | fsConstants.R_OK);
  } catch {
    if (incidentType !== "vehicle_breakdown") {
      return null;
    }

    try {
      await access(legacyPaths.skillPath, fsConstants.F_OK | fsConstants.R_OK);
      skillPath = legacyPaths.skillPath;
      metadataPath = legacyPaths.metadataPath;
    } catch {
      return null;
    }
  }

  const markdown = await readFile(skillPath, "utf8");
  let learnedFromIncidentId: string | null = null;
  let createdAt: string | null = null;
  let skillName = "vehicle_breakdown_recovery";

  try {
    const rawMetadata = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(rawMetadata) as {
      incidentId?: unknown;
      createdAt?: unknown;
      skillName?: unknown;
    };
    learnedFromIncidentId =
      typeof parsed.incidentId === "string" ? parsed.incidentId : null;
    createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : null;
    skillName =
      typeof parsed.skillName === "string" ? parsed.skillName : skillName;
  } catch {
    // Fall back to the default name and no provenance metadata when only the
    // markdown file is present.
  }

  return {
    skillName,
    skillPath,
    markdown,
    learnedFromIncidentId,
    createdAt,
  };
}

function createUserPrompt(
  toolOutputs: ToolOutputs,
  candidateStrategies: CandidateStrategy[],
  priorFailure?: string,
  learnedSkill?: LearnedRecoverySkillContext | null,
): string {
  const guidance = priorFailure
    ? `Your previous answer was rejected for this reason: ${priorFailure}. Correct it and return valid JSON only.`
    : "Compare at least two strategies and choose the best one by expected net benefit.";

  return JSON.stringify({
    task: "incident_recovery_decision",
    guidance,
    previouslyLearnedRecoveryProcedure: learnedSkill
      ? {
          skillName: learnedSkill.skillName,
          learnedFromIncidentId: learnedSkill.learnedFromIncidentId,
          procedureMarkdown: learnedSkill.markdown,
          instruction:
            "This procedure was learned from a previous successful recovery. Reuse it when it fits the current incident, but still obey the provided financial numbers and select the highest-net-benefit viable strategy.",
        }
      : null,
    financialModel: {
      expectedNetBenefit: "expectedLossAvoided - approvedBudget",
      expectedLossAvoided: "Use the provided expectedLossAvoided figures from the strategy comparison.",
      approvedBudget: "Use the provided approvedBudget figures from the strategy comparison.",
    },
    toolOutputs,
    candidateStrategies,
    availableActionTools: buildPlanningToolCatalog(
      toolOutputs,
      candidateStrategies,
    ),
    constraints: {
      selectedStrategyMustBeHighestNetBenefit: true,
      compareAtLeastTwoStrategies: true,
      noFreeFormText: true,
      neverExecuteActions: true,
    },
  }, null, 2);
}

function extractContentFromChoice(choice: unknown): string {
  if (
    choice &&
    typeof choice === "object" &&
    "message" in choice &&
    choice.message &&
    typeof choice.message === "object" &&
    "content" in choice.message
  ) {
    const content = choice.message.content;
    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }

          if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
            return entry.text;
          }

          return "";
        })
        .join("");
    }
  }

  throw new Error("Model response did not include a string message content.");
}

export function parseDecisionResponse(
  rawResponse: string,
  options?: {
    incidentId?: string;
    candidateStrategies?: CandidateStrategy[];
  },
): IncidentDecision {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawResponse);
  } catch (error) {
    throw new ModelDecisionValidationError(
      `Model response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      rawResponse,
    );
  }

  if (options?.incidentId && options.candidateStrategies) {
    parsedJson = normalizeDecisionPayload({
      rawDecision: parsedJson,
      incidentId: options.incidentId,
      candidateStrategies: options.candidateStrategies,
    });
  } else if (
    parsedJson &&
    typeof parsedJson === "object" &&
    "decision" in parsedJson &&
    parsedJson.decision &&
    typeof parsedJson.decision === "object"
  ) {
    parsedJson = parsedJson.decision;
  }

  const parsedDecision = incidentDecisionSchema.safeParse(parsedJson);
  if (!parsedDecision.success) {
    throw new ModelDecisionValidationError(
      `Model response failed decision schema validation: ${parsedDecision.error.message}`,
      rawResponse,
    );
  }

  return parsedDecision.data;
}

export function validateDecisionAgainstStrategies(
  decision: IncidentDecision,
  candidateStrategies: CandidateStrategy[],
): void {
  const selectedStrategy = candidateStrategies.find((strategy) => strategy.optionId === decision.selectedStrategy);
  if (!selectedStrategy) {
    throw new ModelDecisionValidationError(
      `Selected strategy '${decision.selectedStrategy}' was not one of the compared strategies.`,
      JSON.stringify(decision),
    );
  }

  if (!selectedStrategy.viable) {
    throw new ModelDecisionValidationError(
      `Selected strategy '${decision.selectedStrategy}' is not viable: ${selectedStrategy.viabilityReason}`,
      JSON.stringify(decision),
    );
  }

  const highestNetBenefit = candidateStrategies
    .filter((strategy) => strategy.viable)
    .reduce((best, current) => (current.expectedNetBenefit > best.expectedNetBenefit ? current : best), candidateStrategies[0] as CandidateStrategy);

  if (decision.selectedStrategy !== highestNetBenefit.optionId) {
    throw new ModelDecisionValidationError(
      `Selected strategy '${decision.selectedStrategy}' does not match the highest-net-benefit option '${highestNetBenefit.optionId}'.`,
      JSON.stringify(decision),
    );
  }

  if (
    decision.approvedBudget !== selectedStrategy.approvedBudget ||
    decision.expectedLossAvoided !== selectedStrategy.expectedLossAvoided ||
    decision.expectedNetBenefit !== selectedStrategy.expectedNetBenefit
  ) {
    throw new ModelDecisionValidationError(
      `Decision numbers do not match the selected strategy '${selectedStrategy.optionId}'.`,
      JSON.stringify(decision),
    );
  }
}

export function validateDecisionActions(
  decision: IncidentDecision,
  toolOutputs: ToolOutputs,
): void {
  const incidentType = toolOutputs.incidentDetails.incident.type;

  if (incidentType === "payment_declined") {
    const notificationCount = decision.actions.filter(
      (action) => action.tool === "send_customer_notification",
    ).length;
    const skillCount = decision.actions.filter(
      (action) => action.tool === "create_recovery_skill",
    ).length;
    if (notificationCount < 1) {
      throw new ModelDecisionValidationError(
        "Payment recovery decisions must include at least one send_customer_notification action.",
        JSON.stringify(decision),
      );
    }
    if (skillCount < 1) {
      throw new ModelDecisionValidationError(
        "Payment recovery decisions must include a create_recovery_skill action.",
        JSON.stringify(decision),
      );
    }
    return;
  }

  if (incidentType === "congestion") {
    const skillCount = decision.actions.filter(
      (action) => action.tool === "create_recovery_skill",
    ).length;
    if (skillCount < 1) {
      throw new ModelDecisionValidationError(
        "Congestion recovery decisions must include a create_recovery_skill action.",
        JSON.stringify(decision),
      );
    }
    return;
  }

  const assignmentActions = decision.actions.filter(
    (action) => action.tool === "assign_replacement_driver",
  );
  const payoutActions = decision.actions.filter(
    (action) => action.tool === "create_driver_payout",
  );
  const notificationActions = decision.actions.filter(
    (action) => action.tool === "send_customer_notification",
  );
  const completionActions = decision.actions.filter(
    (action) => action.tool === "complete_delivery_recovery",
  );
  const skillActions = decision.actions.filter(
    (action) => action.tool === "create_recovery_skill",
  );

  if (assignmentActions.length < 1) {
    throw new ModelDecisionValidationError(
      "Breakdown recovery decisions must include at least one assign_replacement_driver action.",
      JSON.stringify(decision),
    );
  }

  if (payoutActions.length !== assignmentActions.length) {
    throw new ModelDecisionValidationError(
      "Breakdown recovery decisions must include one create_driver_payout action per replacement driver assignment.",
      JSON.stringify(decision),
    );
  }

  if (notificationActions.length < toolOutputs.incidentDetails.incident.orderIds.length) {
    throw new ModelDecisionValidationError(
      "Breakdown recovery decisions must include customer notification actions for the affected orders.",
      JSON.stringify(decision),
    );
  }

  if (completionActions.length < 1) {
    throw new ModelDecisionValidationError(
      "Breakdown recovery decisions must include a complete_delivery_recovery action.",
      JSON.stringify(decision),
    );
  }

  if (skillActions.length < 1) {
    throw new ModelDecisionValidationError(
      "Breakdown recovery decisions must include a create_recovery_skill action.",
      JSON.stringify(decision),
    );
  }
}

export async function defaultModelResponder(request: {
  messages: ModelMessage[];
  responseFormat?: {
    name: string;
    schema: Record<string, unknown>;
  };
}): Promise<ModelResponse> {
  const modelEnv = getReasoningModelEnv();
  const baseUrl = modelEnv.baseUrl;
  if (!baseUrl || (modelEnv.provider !== "hermes_local" && !modelEnv.apiKey)) {
    throw new Error("Missing HTTP model endpoint configuration for non-Hermes responder.");
  }

  const endpoint = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (modelEnv.apiKey) {
    headers.Authorization = `Bearer ${modelEnv.apiKey}`;
  }

  if (modelEnv.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/snehalx7/hermes-routiq";
    headers["X-Title"] = "HermesRoutiq";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelEnv.model,
      messages: request.messages,
      temperature: 0,
      stream: false,
      ...(modelEnv.provider === "hermes_local"
        ? {}
        : request.responseFormat
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: request.responseFormat.name,
                  strict: true,
                  schema: request.responseFormat.schema,
                },
              },
            }
          : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Reasoning model request failed (${response.status}): ${detail}`);
  }

  const payload = await response.json() as {
    choices?: unknown[];
    model?: string;
    provider?: string;
  };

  const firstChoice = payload.choices?.[0];
  if (!firstChoice) {
    throw new Error("Reasoning model response did not contain any choices.");
  }

  return {
    provider:
      modelEnv.provider === "hermes_local" &&
      typeof payload.provider === "string" &&
      payload.provider.length > 0
        ? payload.provider
        : modelEnv.provider,
    model: payload.model ?? modelEnv.model,
    content: extractContentFromChoice(firstChoice),
  };
}
export async function reasonAboutIncident(
  incidentId: string,
  responder: ModelResponder = defaultModelResponder,
): Promise<ReasoningResult> {
  const toolOutputs = await gatherReasoningInputs(incidentId);
  const candidateStrategies = buildCandidateStrategies(toolOutputs);
  const learnedSkill = await loadLearnedRecoverySkillContext(
    toolOutputs.incidentDetails.incident.type,
  );
  const startedAt = Date.now();

  if (learnedSkill) {
    const tick = await readTickState();
    await insertSimulationEvent({
      eventType: "reasoning.reused_recovery_skill",
      payload: {
        incidentId,
        skillName: learnedSkill.skillName,
        skillPath: learnedSkill.skillPath,
        learnedFromIncidentId: learnedSkill.learnedFromIncidentId,
        injectedIntoModelContext: true,
        createdAt: new Date().toISOString(),
      },
      simSeconds: tick.elapsedSeconds,
    });
  }

  let priorFailure: string | undefined;
  let lastRawResponse = "";
  let lastProvider = "unknown";
  let lastModel = "unknown";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await responder({
      messages: [
        { role: "system", content: createSystemPrompt() },
        {
          role: "user",
          content: createUserPrompt(
            toolOutputs,
            candidateStrategies,
            priorFailure,
            learnedSkill,
          ),
        },
      ],
      responseFormat: {
        name: "incident_recovery_decision",
        schema: incidentDecisionJsonSchema,
      },
    });

    lastRawResponse = response.content;
    lastProvider = response.provider;
    lastModel = response.model;

    try {
      const decision = parseDecisionResponse(response.content, {
        incidentId,
        candidateStrategies,
      });
      validateDecisionAgainstStrategies(decision, candidateStrategies);
      validateDecisionActions(decision, toolOutputs);

      return {
        toolOutputs,
        candidateStrategies,
        decision,
        provider: response.provider,
        model: response.model,
        rawModelResponse: response.content,
        attempts: attempt + 1,
        latencyMs: Date.now() - startedAt,
        reusedSkill: learnedSkill
          ? {
              loaded: true,
              injectedIntoModelContext: true,
              skillName: learnedSkill.skillName,
              skillPath: learnedSkill.skillPath,
              learnedFromIncidentId: learnedSkill.learnedFromIncidentId,
              createdAt: learnedSkill.createdAt,
            }
          : null,
      };
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }

      priorFailure = error instanceof Error ? error.message : String(error);
    }
  }

  throw new ModelDecisionValidationError(
    "Reasoning model failed to produce a valid decision after one retry.",
    lastRawResponse || JSON.stringify({ provider: lastProvider, model: lastModel }),
  );
}
