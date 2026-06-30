export interface DashboardHeadlineMetrics {
  walletBalanceCents: number;
  activeDeliveries: number;
  activeIncidents: number;
  expectedProfitCents: number;
  paidRevenueCents: number;
  operatingCostCents: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  headline: DashboardHeadlineMetrics;
  currentRequest: DashboardCurrentRequest | null;
  requestHistory: DashboardCurrentRequest[];
  activeIncident: DashboardActiveIncident | null;
  policyEvaluations: DashboardPolicyEvaluation[];
  agentTimeline: DashboardAgentTimelineItem[];
  stripeTransactions: DashboardStripeTransaction[];
  finalRecoveryReport: DashboardRecoveryReport | null;
}

export interface DashboardCurrentRequest {
  orderId: string;
  customerLabel: string | null;
  pickupHubLabel: string | null;
  destinationLabel: string | null;
  quotedPriceCents: number | null;
  baselineQuoteCents: number | null;
  estimatedDistanceKm: number | null;
  strategy: string | null;
  accepted: boolean | null;
  status: string | null;
  decisionSource: string | null;
  decisionSummary: string | null;
  provider: string | null;
  model: string | null;
  contextRefs: DashboardHermesContextRef[];
  skillRefs: DashboardHermesSkillRef[];
  plannedTools: DashboardHermesPlannedTool[];
  dispatchStatus: "idle" | "reasoning" | "released" | "held" | "failed";
  dispatchStrategy: string | null;
  dispatchDecisionSource: string | null;
  dispatchDecisionSummary: string | null;
  dispatchProvider: string | null;
  dispatchModel: string | null;
  dispatchAssignedVehicleId: string | null;
  dispatchContextRefs: DashboardHermesContextRef[];
  dispatchSkillRefs: DashboardHermesSkillRef[];
  dispatchPlannedTools: DashboardHermesPlannedTool[];
  funnelStatus: "pending" | "declined" | "paid" | "recovered";
}

export interface DashboardHermesContextRef {
  id: string;
  type: string;
  summary: string;
}

export interface DashboardHermesSkillRef {
  name: string;
  source: string | null;
  summary: string;
}

export interface DashboardHermesPlannedTool {
  tool: string;
  purpose: string;
}

export interface DashboardActiveIncident {
  id: string;
  type: string;
  orderIds: string[];
  orders: DashboardOrderReference[];
}

export interface DashboardPolicyEvaluation {
  id: string;
  actionType: string;
  amountCents: number;
  allowed: boolean;
  reason: string | null;
  incidentId: string | null;
  createdAt: string;
}

export interface DashboardAgentTimelineItem {
  id: string;
  toolName: string;
  incidentId: string | null;
  idempotencyKey: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardStripeTransaction {
  id: string;
  kind: "checkout_payment" | "driver_payout" | "customer_refund";
  label: string;
  amountCents: number;
  direction: "incoming" | "outgoing";
  stripeReference: string;
  createdAt: string;
  orderId: string | null;
  customerLabel: string | null;
  pickupHubLabel: string | null;
  destinationLabel: string | null;
}

export interface DashboardOrderReference {
  id: string;
  customerLabel: string | null;
  pickupHubLabel: string | null;
  destinationLabel: string | null;
  status: string;
}

export interface DashboardRecoveryReport {
  incidentId: string;
  affectedOrders: DashboardOrderReference[];
  affectedDeliveries: number;
  recoveredDeliveries: number;
  customerRevenueProtectedCents: number;
  emergencySpendingCents: number;
  refundsAvoidedCents: number;
  churnLossAvoidedCents: number;
  netFinancialBenefitCents: number;
  humanInterventionCount: number;
  policyViolationCount: number;
  recoverySeconds: number;
  skillName: string | null;
  reusedSkill: {
    reused: boolean;
    skillName: string;
    learnedFromIncidentId: string | null;
  } | null;
}
