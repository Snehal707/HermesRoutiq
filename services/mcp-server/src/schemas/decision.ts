import { z } from "zod";

export const decisionActionSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

export const incidentDecisionSchema = z.object({
  incidentId: z.string().min(1),
  selectedStrategy: z.string().min(1),
  approvedBudget: z.number().int().nonnegative(),
  expectedLossAvoided: z.number().int().nonnegative(),
  expectedNetBenefit: z.number().int(),
  actions: z.array(decisionActionSchema),
}).strict();

export type IncidentDecision = z.infer<typeof incidentDecisionSchema>;
export type IncidentDecisionAction = z.infer<typeof decisionActionSchema>;

export const incidentDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    incidentId: {
      type: "string",
      description: "The incident identifier being analyzed.",
    },
    selectedStrategy: {
      type: "string",
      description: "The strategy ID selected from the provided recovery options.",
    },
    approvedBudget: {
      type: "integer",
      minimum: 0,
      description: "Approved recovery budget in cents.",
    },
    expectedLossAvoided: {
      type: "integer",
      minimum: 0,
      description: "Expected loss avoided in cents.",
    },
    expectedNetBenefit: {
      type: "integer",
      description: "Expected net benefit in cents.",
    },
    actions: {
      type: "array",
      description: "Recommended tool calls to carry out later. Do not execute them in this phase.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: {
            type: "string",
            description: "Tool name to invoke later.",
          },
          arguments: {
            type: "object",
            description: "Typed arguments for the tool call.",
            additionalProperties: true,
          },
        },
        required: ["tool", "arguments"],
      },
    },
  },
  required: [
    "incidentId",
    "selectedStrategy",
    "approvedBudget",
    "expectedLossAvoided",
    "expectedNetBenefit",
    "actions",
  ],
} as const;
