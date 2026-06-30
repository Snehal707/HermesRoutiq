import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

async function main(): Promise<void> {
  const httpPort = 8880;
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

  const wrongRoleTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpPort}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": "payment",
        },
      },
    },
  );

  const operationsTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpPort}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": "operations",
        },
      },
    },
  );

  const wrongRoleClient = new Client({ name: "infra-proof-denied", version: "0.1.0" }, { capabilities: {} });
  const operationsClient = new Client({ name: "infra-proof-allowed", version: "0.1.0" }, { capabilities: {} });

  try {
    await waitForHttpServerReady(serverProcess, httpPort);
    await wrongRoleClient.connect(wrongRoleTransport);
    await operationsClient.connect(operationsTransport);

    const wrongRole = await wrongRoleClient.callTool({
      name: "provision_infrastructure",
      arguments: {
        infraType: "queue",
        triggerReason: "Rising event volume requires queue capacity",
      },
    });

    const allowed = await operationsClient.callTool({
      name: "provision_infrastructure",
      arguments: {
        infraType: "queue",
        triggerReason: "Rising event volume requires queue capacity",
      },
    });

    const ledgerRowId = (allowed.structuredContent as { ledgerRowId?: string | null } | undefined)?.ledgerRowId ?? null;
    if (!ledgerRowId) {
      throw new Error(`Expected ledgerRowId from allowed tool call. Raw output: ${JSON.stringify(allowed, null, 2)}`);
    }

    const supabase = getSupabaseAdminClient();
    const [{ data: ledgerRow, error: ledgerError }, { data: policyRows, error: policyError }] = await Promise.all([
      supabase
        .from("ledger")
        .select("id, entry_type, amount_cents, reference_id, stripe_reference, metadata, created_at")
        .eq("id", ledgerRowId)
        .maybeSingle(),
      supabase
        .from("policy_evaluations")
        .select("action_type, amount_cents, allowed, reason, created_at")
        .in("action_type", [
          "role_tool_authorization:provision_infrastructure",
          "provision_infrastructure",
        ])
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (ledgerError) {
      throw new Error(`Failed to load infrastructure ledger row: ${ledgerError.message}`);
    }

    if (policyError) {
      throw new Error(`Failed to load infrastructure policy rows: ${policyError.message}`);
    }

    console.log(JSON.stringify({
      wrongRole: wrongRole.structuredContent,
      allowed: allowed.structuredContent,
      ledgerRow,
      policyEvaluations: policyRows ?? [],
    }, null, 2));
  } finally {
    await wrongRoleClient.close().catch(() => undefined);
    await operationsClient.close().catch(() => undefined);
    await wrongRoleTransport.close().catch(() => undefined);
    await operationsTransport.close().catch(() => undefined);
    await stopChildProcess(serverProcess);
    await closeSharedClients().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
