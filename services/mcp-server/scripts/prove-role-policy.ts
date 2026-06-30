import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";

const serviceRoot = new URL("..", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url);
const tsxCliPath = fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", repoRoot));
const serverEntrypointPath = fileURLToPath(new URL("src/index.ts", serviceRoot));
const serviceRootPath = fileURLToPath(new URL(".", serviceRoot));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

async function waitForHttpServerReady(serverProcess: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectReady(new Error(`Timed out waiting for HTTP MCP server on port ${port}. stderr:\n${stderr}`));
      }
    }, 10_000);

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

async function main(): Promise<void> {
  const httpPort = 8874;
  const httpServerProcess = spawn(
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

  const paymentHttpClient = new Client({
    name: "role-policy-proof-http",
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  const paymentHttpTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpPort}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": "payment",
        },
      },
    },
  );

  const stdioClient = new Client({
    name: "role-policy-proof-stdio",
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCliPath, serverEntrypointPath],
    cwd: serviceRootPath,
    env: {
      ...inheritedEnv,
      MCP_HTTP_ENABLED: "false",
    },
    stderr: "pipe",
  });

  try {
    await waitForHttpServerReady(httpServerProcess, httpPort);
    await paymentHttpClient.connect(paymentHttpTransport);
    await stdioClient.connect(stdioTransport);

    const paymentVisibleTools = (await paymentHttpClient.listTools()).tools
      .map((tool) => tool.name)
      .sort();

    const paymentPayout = await paymentHttpClient.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: "proof-driver",
        amountCents: 1_500,
        idempotencyKey: `proof-payout-${randomUUID()}`,
      },
    });

    let paymentReadDenied: unknown = null;
    try {
      paymentReadDenied = await paymentHttpClient.callTool({
        name: "get_business_snapshot",
        arguments: {},
      });
    } catch (error: unknown) {
      paymentReadDenied = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const spendingDenied = await stdioClient.callTool({
      name: "check_spending_policy",
      arguments: {
        actionType: "proof_over_cap",
        amountCents: 2_500,
      },
    });

    await delay(500);

    const supabase = getSupabaseAdminClient();
    const { data: policyRows, error } = await supabase
      .from("policy_evaluations")
      .select("action_type, amount_cents, allowed, reason, created_at")
      .in("action_type", [
        "role_tool_authorization:create_driver_payout",
        "proof_over_cap",
      ])
      .order("created_at", { ascending: false })
      .limit(6);

    if (error) {
      throw new Error(`Failed to load policy evaluation rows: ${error.message}`);
    }

    console.log(JSON.stringify({
      paymentVisibleTools,
      paymentPayout: paymentPayout.structuredContent,
      paymentReadDenied,
      spendingDenied: spendingDenied.structuredContent,
      policyEvaluations: policyRows ?? [],
    }, null, 2));
  } finally {
    await paymentHttpClient.close().catch(() => undefined);
    await paymentHttpTransport.close().catch(() => undefined);
    await stdioClient.close().catch(() => undefined);
    await stdioTransport.close().catch(() => undefined);
    await stopChildProcess(httpServerProcess);
    await closeSharedClients().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
