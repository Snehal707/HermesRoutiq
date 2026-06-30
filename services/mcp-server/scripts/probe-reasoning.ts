import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";
import {
  buildCandidateStrategies,
  gatherReasoningInputs,
  reasonAboutIncident,
  type ModelResponder,
} from "../src/reasoning.js";

type Mode = "real" | "fixture-valid" | "malformed-prose" | "malformed-truncated";

function parseArgs(): { incidentId?: string; mode: Mode } {
  const args = process.argv.slice(2);
  let incidentId: string | undefined;
  let mode: Mode = "real";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--incident") {
      incidentId = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      const requestedMode = args[index + 1] as Mode | undefined;
      if (requestedMode) {
        mode = requestedMode;
      }
      index += 1;
    }
  }

  return { incidentId, mode };
}

async function resolveIncidentId(explicitIncidentId?: string): Promise<string> {
  if (explicitIncidentId) {
    return explicitIncidentId;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from("incidents").select("id").limit(1);
  if (error) {
    throw new Error(`Failed to fetch incident fixture: ${error.message}`);
  }

  const incidentId = data?.[0]?.id;
  if (!incidentId) {
    throw new Error("No incident found. Trigger a breakdown first, then rerun the reasoning probe.");
  }

  return incidentId;
}

function createFixtureResponder(incidentId: string, mode: Mode): ModelResponder {
  return async () => {
    if (mode === "malformed-prose") {
      return {
        provider: "fixture",
        model: "fixture-malformed-prose",
        content: "The best choice is one_driver_recovery because it looks strongest overall.",
      };
    }

    if (mode === "malformed-truncated") {
      return {
        provider: "fixture",
        model: "fixture-malformed-truncated",
        content: `{"incidentId":"${incidentId}","selectedStrategy":"one_driver_recovery"`,
      };
    }

    const toolOutputs = await gatherReasoningInputs(incidentId);
    const candidateStrategies = buildCandidateStrategies(toolOutputs);
    const bestStrategy = candidateStrategies
      .filter((strategy) => strategy.viable)
      .sort((left, right) => right.expectedNetBenefit - left.expectedNetBenefit)[0];

    if (!bestStrategy) {
      throw new Error("No viable strategy available for fixture responder.");
    }

    return {
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
    };
  };
}

async function main(): Promise<void> {
  const { incidentId: explicitIncidentId, mode } = parseArgs();
  try {
    const incidentId = await resolveIncidentId(explicitIncidentId);
    const toolOutputs = await gatherReasoningInputs(incidentId);
    const candidateStrategies = buildCandidateStrategies(toolOutputs);
    const responder = mode === "real" ? undefined : createFixtureResponder(incidentId, mode);

    try {
      const result = await reasonAboutIncident(incidentId, responder);
      console.log(JSON.stringify({
        incidentId,
        mode,
        provider: result.provider,
        model: result.model,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        toolOutputs,
        candidateStrategies,
        decision: result.decision,
        rawModelResponse: result.rawModelResponse,
      }, null, 2));
    } catch (error) {
      console.error(JSON.stringify({
        incidentId,
        mode,
        toolOutputs,
        candidateStrategies,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await closeSharedClients();
  }
}

void main();
