import { rm, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DASHBOARD_BASE_URL =
  process.env.HERMES_DASHBOARD_BASE_URL ?? "http://localhost:3001";
const MCP_BASE_URL =
  process.env.HERMES_MCP_BASE_URL ?? "http://127.0.0.1:8644/mcp";

interface DecisionResponse {
  decision: {
    incidentId: string;
    selectedStrategy: string;
    approvedBudget: number;
    expectedLossAvoided: number;
    expectedNetBenefit: number;
  };
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

interface DashboardSnapshot {
  finalRecoveryReport: {
    incidentId: string;
    affectedDeliveries: number;
    recoveredDeliveries: number;
    skillName: string | null;
    reusedSkill: {
      reused: boolean;
      skillName: string;
      learnedFromIncidentId: string | null;
    } | null;
  } | null;
}

interface SimStateResponse {
  world: {
    incidents: Array<{ id: string }>;
    orders: Array<{
      id: string;
      vehicleId: string;
      status: string;
      revenueCents: number;
    }>;
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withOperationsClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_BASE_URL), {
    requestInit: {
      headers: {
        "x-routiq-role": "operations",
      },
    },
  });
  const client = new Client(
    {
      name: "verify-skill-reuse-loop",
      version: "0.1.0",
    },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function triggerIncidentAndReason(): Promise<{
  incidentId: string;
  reason: DecisionResponse;
}> {
  const breakdown = await postJson<{ world: { incidents: Array<{ id: string }> } }>(
    `${DASHBOARD_BASE_URL}/api/sim/breakdown`,
    {},
  );
  const incidentId = breakdown.world.incidents.at(-1)?.id;
  if (!incidentId) {
    throw new Error("Breakdown did not create an incident.");
  }

  const reason = await postJson<DecisionResponse>(
    `${DASHBOARD_BASE_URL}/api/dashboard/reason`,
    { incidentId },
  );

  return { incidentId, reason };
}

async function recoverIncident(incidentId: string): Promise<unknown> {
  return postJson(`${DASHBOARD_BASE_URL}/api/dashboard/recover`, { incidentId });
}

async function main(): Promise<void> {
  const recoverySkillRootDir = resolve(
    process.cwd(),
    "../../skills/delivery-recovery",
  );
  const skillDir = resolve(recoverySkillRootDir, "vehicle_breakdown");
  const skillPath = resolve(skillDir, "SKILL.md");
  const metadataPath = resolve(skillDir, "metadata.json");

  await rm(recoverySkillRootDir, { recursive: true, force: true });

  await postJson(`${DASHBOARD_BASE_URL}/api/sim/control`, { action: "reset" });
  const incident1 = await triggerIncidentAndReason();
  let incident1RecoveryError: string | null = null;
  try {
    await recoverIncident(incident1.incidentId);
  } catch (error) {
    incident1RecoveryError =
      error instanceof Error ? error.message : String(error);
  }

  const incident1Snapshot = await getJson<DashboardSnapshot>(
    `${DASHBOARD_BASE_URL}/api/dashboard/snapshot`,
  );

  await postJson(`${DASHBOARD_BASE_URL}/api/sim/control`, { action: "reset" });
  await withOperationsClient(async (client) => {
    await client.callTool({
      name: "assign_replacement_driver",
      arguments: {
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        orderIds: ["order-2", "order-3"],
      },
    });
  });

  const preIncident2State = await getJson<SimStateResponse>(
    `${DASHBOARD_BASE_URL}/api/sim/state`,
  );

  const incident2 = await triggerIncidentAndReason();
  let incident2RecoveryError: string | null = null;
  try {
    await recoverIncident(incident2.incidentId);
  } catch (error) {
    incident2RecoveryError =
      error instanceof Error ? error.message : String(error);
  }

  const incident2Snapshot = await getJson<DashboardSnapshot>(
    `${DASHBOARD_BASE_URL}/api/dashboard/snapshot`,
  );

  const result = {
    incident1: {
      incidentId: incident1.incidentId,
      selectedStrategy: incident1.reason.decision.selectedStrategy,
      approvedBudget: incident1.reason.decision.approvedBudget,
      expectedLossAvoided: incident1.reason.decision.expectedLossAvoided,
      expectedNetBenefit: incident1.reason.decision.expectedNetBenefit,
      attempts: incident1.reason.attempts,
      latencyMs: incident1.reason.latencyMs,
      reusedSkill: incident1.reason.reusedSkill,
      recoveryError: incident1RecoveryError,
      skillFileExists: await pathExists(skillPath),
      metadataFileExists: await pathExists(metadataPath),
      finalRecoveryReport: incident1Snapshot.finalRecoveryReport,
    },
    incident2: {
      incidentId: incident2.incidentId,
      selectedStrategy: incident2.reason.decision.selectedStrategy,
      approvedBudget: incident2.reason.decision.approvedBudget,
      expectedLossAvoided: incident2.reason.decision.expectedLossAvoided,
      expectedNetBenefit: incident2.reason.decision.expectedNetBenefit,
      attempts: incident2.reason.attempts,
      latencyMs: incident2.reason.latencyMs,
      reusedSkill: incident2.reason.reusedSkill,
      recoveryError: incident2RecoveryError,
      preIncidentOrders: preIncident2State.world.orders,
      finalRecoveryReport: incident2Snapshot.finalRecoveryReport,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
