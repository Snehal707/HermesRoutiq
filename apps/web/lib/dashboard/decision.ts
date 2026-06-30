export interface DecisionOption {
  optionId: string;
  label: string;
  approvedBudget: number;
  expectedLossAvoided: number;
  expectedNetBenefit: number;
  expectedLateDeliveries: number;
  viable: boolean;
}

export interface ValidatedIncidentDecision {
  incidentId: string;
  selectedStrategy: string;
  approvedBudget: number;
  expectedLossAvoided: number;
  expectedNetBenefit: number;
  actions: Array<{
    tool: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface ReasoningResponse {
  candidateStrategies: DecisionOption[];
  decision: ValidatedIncidentDecision;
  provider: string;
  model: string;
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
