import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getStripeConnectServer } from "../../../apps/web/lib/stripe/connect.js";
import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";
import { getEnv } from "../src/env.js";

const serviceRoot = new URL("..", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url);
const tsxCliPath = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", repoRoot));
const serverEntrypointPath = fileURLToPath(new URL("src/index.ts", serviceRoot));
const serviceRootPath = fileURLToPath(new URL(".", serviceRoot));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

function asPayoutResult(value: unknown): { stripeTransferId?: string | null } {
  return (value ?? {}) as { stripeTransferId?: string | null };
}

function describeToolResult(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

interface StripeTransferClient {
  transfers: {
    list: (params: { limit: number }) => Promise<{ data: Array<{ metadata: Record<string, string | undefined> }> }>;
    retrieve: (transferId: string) => Promise<{
      id: string;
      amount: number;
      destination: unknown;
      metadata: Record<string, string>;
    }>;
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

async function fetchDrivers(): Promise<Array<{
  id: string;
  name: string;
  stripe_payout_account_id: string | null;
}>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("drivers")
    .select("id, name, stripe_payout_account_id")
    .order("id", { ascending: true })
    .limit(8);

  if (error) {
    throw new Error(`Failed to load drivers: ${error.message}`);
  }

  return (data ?? []) as Array<{
    id: string;
    name: string;
    stripe_payout_account_id: string | null;
  }>;
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
    throw new Error("No incident fixture found in Postgres for payout proof.");
  }

  return data.id;
}

async function countTransfersByIdempotency(stripe: StripeTransferClient, idempotencyKey: string): Promise<number> {
  const transfers = await stripe.transfers.list({ limit: 100 });
  return transfers.data.filter((transfer) => transfer.metadata.idempotencyKey === idempotencyKey).length;
}

async function main(): Promise<void> {
  const env = getEnv();
  const stripe = getStripeConnectServer(env.STRIPE_CONNECT_SECRET_KEY) as unknown as StripeTransferClient;
  const httpPort = 8876;
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
          "x-routiq-role": "payment",
        },
      },
    },
  );

  const client = new Client({
    name: "stripe-payout-proof",
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  try {
    const drivers = await fetchDrivers();
    const incidentId = await fetchIncidentId();
    const driversWithAccounts = drivers.filter((driver) => typeof driver.stripe_payout_account_id === "string");
    if (driversWithAccounts.length < 2) {
      throw new Error("At least two drivers need stripe_payout_account_id populated before running the payout proof.");
    }

    await waitForHttpServerReady(serverProcess, httpPort);
    await client.connect(transport);

    const firstDriver = driversWithAccounts[0]!;
    const secondDriver = driversWithAccounts[1]!;
    const underCapKey = `connect-proof-under-cap-${randomUUID()}`;
    const overCapKey = `connect-proof-over-cap-${randomUUID()}`;
    const flowKeyA = `connect-proof-flow-a-${randomUUID()}`;
    const flowKeyB = `connect-proof-flow-b-${randomUUID()}`;

    const underCapFirst = await client.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: firstDriver.id,
        amountCents: 700,
        incidentId,
        idempotencyKey: underCapKey,
      },
    });

    const underCapSecond = await client.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: firstDriver.id,
        amountCents: 700,
        incidentId,
        idempotencyKey: underCapKey,
      },
    });

    const overCap = await client.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: firstDriver.id,
        amountCents: 2_500,
        incidentId,
        idempotencyKey: overCapKey,
      },
    });

    const flowPayoutA = await client.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: firstDriver.id,
        amountCents: 500,
        incidentId,
        idempotencyKey: flowKeyA,
      },
    });

    const flowPayoutB = await client.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: secondDriver.id,
        amountCents: 600,
        incidentId,
        idempotencyKey: flowKeyB,
      },
    });

    const underCapTransferId = String(asPayoutResult(underCapFirst.structuredContent).stripeTransferId ?? "");
    const flowTransferIdA = String(asPayoutResult(flowPayoutA.structuredContent).stripeTransferId ?? "");
    const flowTransferIdB = String(asPayoutResult(flowPayoutB.structuredContent).stripeTransferId ?? "");

    if (!underCapTransferId || !flowTransferIdA || !flowTransferIdB) {
      throw new Error(
        `Missing Stripe transfer id from payout tool output.\nunderCapFirst=${describeToolResult(underCapFirst)}\nunderCapSecond=${describeToolResult(underCapSecond)}\nflowPayoutA=${describeToolResult(flowPayoutA)}\nflowPayoutB=${describeToolResult(flowPayoutB)}\noverCap=${describeToolResult(overCap)}`,
      );
    }

    const [
      underCapTransfer,
      flowTransferA,
      flowTransferB,
      duplicateTransferCount,
      deniedTransferCount,
    ] = await Promise.all([
      stripe.transfers.retrieve(underCapTransferId),
      stripe.transfers.retrieve(flowTransferIdA),
      stripe.transfers.retrieve(flowTransferIdB),
      countTransfersByIdempotency(stripe, underCapKey),
      countTransfersByIdempotency(stripe, overCapKey),
    ]);

    const supabase = getSupabaseAdminClient();
    const { data: ledgerRows, error: ledgerError } = await supabase
      .from("ledger")
      .select("reference_id, idempotency_key, stripe_reference, amount_cents, created_at")
      .in("idempotency_key", [underCapKey, flowKeyA, flowKeyB])
      .order("created_at", { ascending: true });

    if (ledgerError) {
      throw new Error(`Failed to load ledger proof rows: ${ledgerError.message}`);
    }

    console.log(JSON.stringify({
      driverAccounts: drivers.map((driver) => ({
        driverId: driver.id,
        stripePayoutAccountId: driver.stripe_payout_account_id,
      })),
      underCapFirst: underCapFirst.structuredContent,
      underCapSecond: underCapSecond.structuredContent,
      underCapTransfer: {
        id: underCapTransfer.id,
        amount: underCapTransfer.amount,
        destination: underCapTransfer.destination,
        metadata: underCapTransfer.metadata,
      },
      duplicateTransferCount,
      overCap: overCap.structuredContent,
      deniedTransferCount,
      flowPayoutA: flowPayoutA.structuredContent,
      flowPayoutB: flowPayoutB.structuredContent,
      flowTransferA: {
        id: flowTransferA.id,
        amount: flowTransferA.amount,
        destination: flowTransferA.destination,
      },
      flowTransferB: {
        id: flowTransferB.id,
        amount: flowTransferB.amount,
        destination: flowTransferB.destination,
      },
      ledgerRows: ledgerRows ?? [],
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
