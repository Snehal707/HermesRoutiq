import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getStripeBillingServer } from "../../../apps/web/lib/stripe/projects-pattern.js";
import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";
import { getEnv } from "../src/env.js";
import { insertSimulationEvent, readTickState } from "../src/db.js";

const serviceRoot = new URL("..", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url);
const tsxCliPath = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", repoRoot));
const serverEntrypointPath = fileURLToPath(new URL("src/index.ts", serviceRoot));
const serviceRootPath = fileURLToPath(new URL(".", serviceRoot));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

interface StripeBillingClient {
  products: {
    retrieve: (id: string) => Promise<{
      id: string;
      name: string;
      metadata: Record<string, string>;
    }>;
  };
  prices: {
    retrieve: (id: string) => Promise<{
      id: string;
      product: string;
      unit_amount: number | null;
      recurring: { interval: string } | null;
      metadata: Record<string, string>;
    }>;
  };
}

function asPatternResult(value: unknown): {
  stripeProductId?: string | null;
  stripePriceId?: string | null;
} {
  return (value ?? {}) as {
    stripeProductId?: string | null;
    stripePriceId?: string | null;
  };
}

async function waitForHttpServerReady(serverProcess: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectReady(new Error(`Timed out waiting for HTTP MCP server on port ${port}. stderr:\n${stderr}`));
      }
    }, 12_000);

    serverProcess.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (!settled && stderr.includes(`http://127.0.0.1:${port}/mcp`)) {
        settled = true;
        clearTimeout(timeout);
        resolveReady();
      }
    });

    serverProcess.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectReady(new Error(`HTTP MCP server exited before becoming ready (code=${code}, signal=${signal}). stderr:\n${stderr}`));
      }
    });
  });
}

async function stopChildProcess(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (serverProcess.killed || serverProcess.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolveStopped) => {
    serverProcess.once("exit", () => resolveStopped());
    serverProcess.kill("SIGINT");
    setTimeout(() => {
      if (!serverProcess.killed && serverProcess.exitCode === null) {
        serverProcess.kill("SIGTERM");
      }
    }, 2_000);
  });
}

async function fetchIncidentId(): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("incidents")
    .select("id")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load incident fixture: ${error.message}`);
  }

  if (!data?.id || typeof data.id !== "string") {
    throw new Error("No incident fixture found in Postgres for Stripe Projects pattern proof.");
  }

  return data.id;
}

async function seedEventBurst(eventType: string, count: number, simSeconds: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await insertSimulationEvent({
      eventType,
      simSeconds,
      payload: {
        proof: "phase10",
        ordinal: index + 1,
      },
    });
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const stripe = getStripeBillingServer(env.STRIPE_SECRET_KEY) as unknown as StripeBillingClient;
  const httpPort = 8878;
  const serverProcess = spawn(
    process.execPath,
    [tsxCliPath, serverEntrypointPath],
    {
      cwd: serviceRootPath,
      env: {
        ...inheritedEnv,
        MCP_HTTP_ENABLED: "true",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: String(httpPort),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpPort}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": "finance",
        },
      },
    },
  );

  const client = new Client({
    name: "stripe-projects-pattern-proof",
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  try {
    const incidentId = await fetchIncidentId();
    const tick = await readTickState();
    const eventType = `phase10_event_surge_${randomUUID()}`;
    const threshold = 4;
    const windowSeconds = 120;
    const amountCents = 1500;
    const idempotencyKey = `phase10-pattern-${randomUUID()}`;

    await seedEventBurst(eventType, 2, tick.elapsedSeconds);
    await waitForHttpServerReady(serverProcess, httpPort);
    await client.connect(transport);

    const belowThreshold = await client.callTool({
      name: "provision_event_surge_capacity",
      arguments: {
        eventType,
        threshold,
        windowSeconds,
        amountCents,
        serviceCategory: "observability",
        incidentId,
        idempotencyKey: `${idempotencyKey}-below-threshold`,
      },
    });

    await seedEventBurst(eventType, 3, tick.elapsedSeconds);

    const provisioned = await client.callTool({
      name: "provision_event_surge_capacity",
      arguments: {
        eventType,
        threshold,
        windowSeconds,
        amountCents,
        serviceCategory: "observability",
        incidentId,
        idempotencyKey,
      },
    });

    const provisionedRepeat = await client.callTool({
      name: "provision_event_surge_capacity",
      arguments: {
        eventType,
        threshold,
        windowSeconds,
        amountCents,
        serviceCategory: "observability",
        incidentId,
        idempotencyKey,
      },
    });

    const stripeProductId = String(asPatternResult(provisioned.structuredContent).stripeProductId ?? "");
    const stripePriceId = String(asPatternResult(provisioned.structuredContent).stripePriceId ?? "");
    if (!stripeProductId || !stripePriceId) {
      throw new Error(
        `Missing Stripe product/price ids from tool output.\nbelowThreshold=${JSON.stringify(belowThreshold, null, 2)}\nprovisioned=${JSON.stringify(provisioned, null, 2)}`,
      );
    }

    const [product, price] = await Promise.all([
      stripe.products.retrieve(stripeProductId),
      stripe.prices.retrieve(stripePriceId),
    ]);

    const supabase = getSupabaseAdminClient();
    const [{ data: ledgerRows, error: ledgerError }, { data: policyRows, error: policyError }] = await Promise.all([
      supabase
        .from("ledger")
        .select("entry_type, reference_id, idempotency_key, stripe_reference, amount_cents, metadata, created_at")
        .eq("idempotency_key", idempotencyKey)
        .order("created_at", { ascending: true }),
      supabase
        .from("policy_evaluations")
        .select("action_type, amount_cents, allowed, reason, incident_id, created_at")
        .in("action_type", [
          "role_tool_authorization:provision_event_surge_capacity",
          "provision_event_surge_capacity",
        ])
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (ledgerError) {
      throw new Error(`Failed to load Phase 10 ledger rows: ${ledgerError.message}`);
    }

    if (policyError) {
      throw new Error(`Failed to load Phase 10 policy rows: ${policyError.message}`);
    }

    console.log(JSON.stringify({
      triggerCondition: {
        eventType,
        threshold,
        windowSeconds,
        amountCents,
      },
      belowThreshold: belowThreshold.structuredContent,
      provisioned: provisioned.structuredContent,
      provisionedRepeat: provisionedRepeat.structuredContent,
      stripeProduct: product,
      stripePrice: price,
      ledgerRows: ledgerRows ?? [],
      policyEvaluations: policyRows ?? [],
    }, null, 2));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await stopChildProcess(serverProcess);
    await closeSharedClients().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
