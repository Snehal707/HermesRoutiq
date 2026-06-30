import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";
import {
  ModelDecisionValidationError,
  buildCandidateStrategies,
  gatherReasoningInputs,
  reasonAboutIncident,
  type ModelResponder,
} from "../src/reasoning.js";

async function fetchIncidentId(): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from("incidents").select("id").limit(1);

  if (error) {
    throw new Error(`Failed to fetch incident fixture: ${error.message}`);
  }

  const incidentId = data?.[0]?.id;
  assert.ok(incidentId, "expected at least one incident fixture");
  return incidentId;
}

after(async () => {
  await closeSharedClients();
});

test("produces a validated decision from real incident tool data", async () => {
  const incidentId = await fetchIncidentId();
  const toolOutputs = await gatherReasoningInputs(incidentId);
  const candidateStrategies = buildCandidateStrategies(toolOutputs);
  const bestStrategy = candidateStrategies
    .filter((strategy) => strategy.viable)
    .sort((left, right) => right.expectedNetBenefit - left.expectedNetBenefit)[0];

  assert.ok(bestStrategy, "expected at least one viable strategy");

  const responder: ModelResponder = async () => ({
    provider: "fixture",
    model: "fixture-valid",
    content: JSON.stringify({
      incidentId,
      selectedStrategy: bestStrategy.optionId,
      approvedBudget: bestStrategy.approvedBudget,
      expectedLossAvoided: bestStrategy.expectedLossAvoided,
      expectedNetBenefit: bestStrategy.expectedNetBenefit,
      actions: bestStrategy.actionPlan,
    }),
  });

  const result = await reasonAboutIncident(incidentId, responder);
  assert.equal(result.decision.selectedStrategy, bestStrategy.optionId);
  assert.equal(result.decision.expectedNetBenefit, bestStrategy.expectedNetBenefit);
  assert.ok(result.candidateStrategies.length >= 2);
});

test("rejects prose model output and does not produce a decision", async () => {
  const incidentId = await fetchIncidentId();
  let calls = 0;

  const responder: ModelResponder = async () => {
    calls += 1;
    return {
      provider: "fixture",
      model: "fixture-prose",
      content: "Use one driver and then pay them immediately.",
    };
  };

  await assert.rejects(
    () => reasonAboutIncident(incidentId, responder),
    (error: unknown) => {
      assert.ok(error instanceof ModelDecisionValidationError);
      assert.match(error.message, /not valid JSON|schema validation/i);
      return true;
    },
  );

  assert.equal(calls, 2, "expected one corrective retry for malformed prose output");
});

test("rejects truncated JSON model output and does not produce a decision", async () => {
  const incidentId = await fetchIncidentId();
  let calls = 0;

  const responder: ModelResponder = async () => {
    calls += 1;
    return {
      provider: "fixture",
      model: "fixture-truncated",
      content: `{"incidentId":"${incidentId}","selectedStrategy":"one_driver_recovery"`,
    };
  };

  await assert.rejects(
    () => reasonAboutIncident(incidentId, responder),
    (error: unknown) => {
      assert.ok(error instanceof ModelDecisionValidationError);
      assert.match(error.message, /not valid JSON/i);
      return true;
    },
  );

  assert.equal(calls, 2, "expected one corrective retry for truncated output");
});

test("accepts Hermes responses that wrap the decision payload", async () => {
  const incidentId = await fetchIncidentId();
  const toolOutputs = await gatherReasoningInputs(incidentId);
  const candidateStrategies = buildCandidateStrategies(toolOutputs);
  const bestStrategy = candidateStrategies
    .filter((strategy) => strategy.viable)
    .sort((left, right) => right.expectedNetBenefit - left.expectedNetBenefit)[0];

  assert.ok(bestStrategy, "expected at least one viable strategy");

  const responder: ModelResponder = async () => ({
    provider: "fixture",
    model: "fixture-wrapped-decision",
    content: JSON.stringify({
      decision: {
        incidentId,
        selectedStrategy: bestStrategy.optionId,
        approvedBudget: bestStrategy.approvedBudget,
        expectedLossAvoided: bestStrategy.expectedLossAvoided,
        expectedNetBenefit: bestStrategy.expectedNetBenefit,
        actions: bestStrategy.actionPlan,
      },
    }),
  });

  const result = await reasonAboutIncident(incidentId, responder);
  assert.equal(result.decision.selectedStrategy, bestStrategy.optionId);
});

test("normalizes Hermes decision aliases and fills the strategy action plan without a retry", async () => {
  const incidentId = await fetchIncidentId();
  const toolOutputs = await gatherReasoningInputs(incidentId);
  const candidateStrategies = buildCandidateStrategies(toolOutputs);
  const bestStrategy = candidateStrategies
    .filter((strategy) => strategy.viable)
    .sort((left, right) => right.expectedNetBenefit - left.expectedNetBenefit)[0];

  assert.ok(bestStrategy, "expected at least one viable strategy");

  let calls = 0;
  const responder: ModelResponder = async () => {
    calls += 1;
    return {
      provider: "fixture",
      model: "fixture-normalized-aliases",
      content: JSON.stringify({
        decision: {
          incidentId,
          strategy: bestStrategy.label,
          expectedCostCents: bestStrategy.approvedBudget,
          expectedBenefitCents: bestStrategy.expectedLossAvoided,
          expectedNetBenefitCents: bestStrategy.expectedNetBenefit,
        },
      }),
    };
  };

  const result = await reasonAboutIncident(incidentId, responder);
  assert.equal(result.decision.selectedStrategy, bestStrategy.optionId);
  assert.deepEqual(result.decision.actions, bestStrategy.actionPlan);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});
