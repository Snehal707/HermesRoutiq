import type { IncomingHttpHeaders } from "node:http";
import type { McpToolName } from "../../../packages/shared/types/mcp.js";
import { getEnv } from "./env.js";
import { insertPolicyEvaluation } from "./db.js";

export interface PolicyDecision extends Record<string, unknown> {
  allowed: boolean;
  reason: string;
  amountCents: number;
  autoCapCents: number;
}

export const ROUTIQ_ROLE_HEADER = "x-routiq-role";

const ROUTIQ_ROLE_NAMES = [
  "monitoring",
  "routing",
  "finance",
  "operations",
  "payment",
] as const;

export type RoutiqRole = (typeof ROUTIQ_ROLE_NAMES)[number];

export interface ToolAuthorizationDecision extends Record<string, unknown> {
  allowed: boolean;
  reason: string;
  role: RoutiqRole;
  toolName: McpToolName;
  policyLayer: "application_role_tool_authorization";
}

const ALLOWED_TOOLS_BY_ROLE: Record<RoutiqRole, readonly McpToolName[]> = {
  monitoring: [
    "get_business_snapshot",
    "get_active_orders",
    "get_incident_details",
  ],
  routing: [
    "get_driver_location",
    "get_available_drivers",
    "preview_paid_order_dispatch",
    "request_route_optimisation",
    "apply_congestion_recovery_route",
    "apply_breakdown_recovery_reroute",
    "dispatch_paid_order",
  ],
  finance: [
    "calculate_financial_exposure",
    "check_spending_policy",
    "compare_recovery_options",
    "provision_event_surge_capacity",
  ],
  operations: [
    "assign_replacement_driver",
    "provision_infrastructure",
    "ensure_pending_checkout_order",
    "mark_checkout_order_paid",
    "record_payment_declined_incident",
    "record_operational_event",
    "complete_delivery_recovery",
    "verify_delivery_recovery",
    "send_customer_notification",
    "record_agent_decision",
    "create_recovery_skill",
  ],
  payment: [
    "create_driver_payout",
    "issue_customer_refund",
  ],
};

export function getAllowedToolsForRole(role: RoutiqRole): readonly McpToolName[] {
  return ALLOWED_TOOLS_BY_ROLE[role];
}

function isRoutiqRole(value: string): value is RoutiqRole {
  return (ROUTIQ_ROLE_NAMES as readonly string[]).includes(value);
}

export function resolveClaimedRole(headers: IncomingHttpHeaders | Headers | undefined): RoutiqRole | null {
  if (!headers) {
    return null;
  }

  const rawValue = headers instanceof Headers
    ? headers.get(ROUTIQ_ROLE_HEADER)
    : headers[ROUTIQ_ROLE_HEADER];
  const normalized = Array.isArray(rawValue) ? rawValue[0] : rawValue;

  if (typeof normalized !== "string") {
    return null;
  }

  const role = normalized.trim().toLowerCase();
  return isRoutiqRole(role) ? role : null;
}

export async function authorizeToolForRole(params: {
  role: RoutiqRole;
  toolName: McpToolName;
  incidentId?: string | null;
}): Promise<ToolAuthorizationDecision> {
  const allowed = ALLOWED_TOOLS_BY_ROLE[params.role].includes(params.toolName);
  const reason = allowed
    ? `Allowed: role ${params.role} may call ${params.toolName}`
    : `Denied: role ${params.role} is not authorized for tool ${params.toolName}`;

  await insertPolicyEvaluation({
    actionType: `role_tool_authorization:${params.toolName}`,
    amountCents: 0,
    allowed,
    reason,
    incidentId: params.incidentId ?? null,
  });

  return {
    allowed,
    reason,
    role: params.role,
    toolName: params.toolName,
    policyLayer: "application_role_tool_authorization",
  };
}

export async function checkSpendingPolicy(params: {
  actionType: string;
  amountCents: number;
  incidentId?: string | null;
}): Promise<PolicyDecision> {
  const autoCapCents = getEnv().MAX_AUTOMATIC_INCIDENT_SPEND * 100;
  const allowed = params.amountCents <= autoCapCents;
  const reason = allowed
    ? `Allowed under automatic incident cap of ${autoCapCents} cents`
    : `Denied: exceeds automatic incident cap of ${autoCapCents} cents`;

  await insertPolicyEvaluation({
    actionType: params.actionType,
    amountCents: params.amountCents,
    allowed,
    reason,
    incidentId: params.incidentId ?? null,
  });

  return {
    allowed,
    reason,
    amountCents: params.amountCents,
    autoCapCents,
  };
}
