import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOL_NAMES } from "../../../packages/shared/types/mcp.js";
import { closeSharedClients, getSupabaseAdminClient } from "../src/clients.js";
import { getEnv } from "../src/env.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(currentDir, "..");
const repoRoot = resolve(serviceRoot, "..", "..");
const tsxCliPath = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const serverEntrypointPath = resolve(serviceRoot, "src", "index.ts");

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

interface Fixtures {
  driverId: string;
  vehicleId: string;
  orderId: string;
  incidentId: string;
}

let client: Client;
let transport: StdioClientTransport;
let fixtures: Fixtures;
let serverStderr = "";
let nextHttpPort = 8860;
let connectProvisionedDriverId: string | null = null;

async function ensureFixturesSeeded(): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const seedIds = {
    hubId: "test-hub-1",
    customerId: "test-customer-1",
    driverId: "test-driver-1",
    vehicleId: "test-vehicle-1",
    orderId: "test-order-1",
    incidentId: "test-incident-1",
  };

  const writes = await Promise.all([
    supabase.from("pickup_hubs").upsert({
      id: seedIds.hubId,
      name: "Test Hub",
      lat: 37.785,
      lng: -122.4,
    }),
    supabase.from("customer_locations").upsert({
      id: seedIds.customerId,
      name: "Test Customer",
      lat: 37.786,
      lng: -122.401,
    }),
    supabase.from("drivers").upsert({
      id: seedIds.driverId,
      name: "Test Driver",
      vehicle_id: seedIds.vehicleId,
    }),
  ]);

  const writeError = writes.find((result) => result.error)?.error;
  if (writeError) {
    throw new Error(`Failed to seed base fixtures: ${writeError.message}`);
  }

  const vehicleResult = await supabase.from("vehicles").upsert({
    id: seedIds.vehicleId,
    driver_id: seedIds.driverId,
    route: [
      [-122.4, 37.785],
      [-122.401, 37.786],
    ],
    routing_provider: "seed",
    routing_plan: null,
    route_status: "normal",
    status: "en_route",
    speed_mps: 8,
    frozen_at_seconds: null,
  });
  if (vehicleResult.error) {
    throw new Error(`Failed to seed vehicle fixture: ${vehicleResult.error.message}`);
  }

  const orderResult = await supabase.from("orders").upsert({
    id: seedIds.orderId,
    customer_id: seedIds.customerId,
    pickup_hub_id: seedIds.hubId,
    vehicle_id: seedIds.vehicleId,
    status: "in_transit",
    revenue_cents: 1400,
  });
  if (orderResult.error) {
    throw new Error(`Failed to seed order fixture: ${orderResult.error.message}`);
  }

  const incidentResult = await supabase.from("incidents").upsert({
    id: seedIds.incidentId,
    type: "vehicle_breakdown",
    vehicle_id: seedIds.vehicleId,
    order_ids: [seedIds.orderId],
    created_at_sim_seconds: 0,
  });
  if (incidentResult.error) {
    throw new Error(`Failed to seed incident fixture: ${incidentResult.error.message}`);
  }
}

async function fetchFixtures(): Promise<Fixtures> {
  const supabase = getSupabaseAdminClient();
  const [{ data: drivers }, { data: orders }, { data: incidents }] = await Promise.all([
    supabase.from("drivers").select("id, vehicle_id").limit(1),
    supabase.from("orders").select("id, vehicle_id").limit(1),
    supabase.from("incidents").select("id").limit(1),
  ]);

  if (!drivers?.[0] || !orders?.[0]) {
    await ensureFixturesSeeded();
    return fetchFixtures();
  }

  assert.ok(drivers?.[0], "expected at least one driver fixture");
  assert.ok(orders?.[0], "expected at least one order fixture");
  let incidentId = incidents?.[0]?.id;
  if (!incidentId) {
    incidentId = `test-incident-${randomUUID()}`;
    const { error } = await supabase.from("incidents").insert({
      id: incidentId,
      type: "vehicle_breakdown",
      vehicle_id: orders[0].vehicle_id,
      order_ids: [orders[0].id],
      created_at_sim_seconds: 0,
    });

    if (error) {
      throw new Error(`Failed to create incident fixture: ${error.message}`);
    }
  }

  return {
    driverId: drivers[0].id,
    vehicleId: orders[0].vehicle_id,
    orderId: orders[0].id,
    incidentId,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return client.callTool({
    name,
    arguments: args,
  });
}

async function withHttpRoleClient<T>(
  role: string,
  run: (httpClient: Client) => Promise<T>,
): Promise<T> {
  const httpPort = nextHttpPort++;
  const scopedServerProcess = spawn(
    process.execPath,
    [tsxCliPath, serverEntrypointPath],
    {
      cwd: serviceRoot,
      env: {
        ...process.env,
        MCP_HTTP_ENABLED: "true",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: String(httpPort),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const httpTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpPort}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": role,
        },
      },
    },
  );

  const httpClient = new Client({
    name: `services-mcp-server-http-${role}`,
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  try {
    await waitForHttpServerReady(scopedServerProcess, httpPort);
    await httpClient.connect(httpTransport);
    return await run(httpClient);
  } finally {
    await httpClient.close().catch(() => undefined);
    await httpTransport.close().catch(() => undefined);
    await stopChildProcess(scopedServerProcess);
  }
}

async function waitForHttpServerReady(serverProcess: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    let stderr = "";
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

async function expectToolFailure(name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  try {
    const result = await callTool(name, args);
    assert.equal(result.isError, true, `${name} should fail`);
    const textContent = result.content.find((entry) => entry.type === "text");
    assert.ok(textContent, `${name} should return an error message`);
    assert.match(textContent.text, pattern);
  } catch (error) {
    assert.match(String(error), pattern);
  }
}

async function countLedgerEntries(idempotencyKey: string): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { count, error } = await supabase
    .from("ledger")
    .select("id", { count: "exact", head: true })
    .eq("idempotency_key", idempotencyKey);

  if (error) {
    throw new Error(`Failed to count ledger rows: ${error.message}`);
  }

  return count ?? 0;
}

async function countAuditRows(eventType: string): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { count, error } = await supabase
    .from("simulation_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", eventType);

  if (error) {
    throw new Error(`Failed to count audit rows: ${error.message}`);
  }

  return count ?? 0;
}

async function seedPendingCheckoutOrder(): Promise<string> {
  const supabase = getSupabaseAdminClient();
  await ensureFixturesSeeded();
  const orderId = `test-pending-order-${randomUUID()}`;
  const { error } = await supabase.from("orders").insert({
    id: orderId,
    customer_id: "test-customer-1",
    pickup_hub_id: "test-hub-1",
    vehicle_id: "test-vehicle-1",
    status: "pending",
    revenue_cents: 1100,
    stripe_checkout_session_id: `checkout-${orderId}`,
  });

  if (error) {
    throw new Error(`Failed to seed pending checkout order: ${error.message}`);
  }

  return orderId;
}

async function fetchConnectProvisionedDriverId(): Promise<string | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("drivers")
    .select("id, stripe_payout_account_id")
    .not("stripe_payout_account_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Stripe Connect driver fixture: ${error.message}`);
  }

  return typeof data?.id === "string" ? data.id : null;
}

before(async () => {
  getEnv();

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCliPath, serverEntrypointPath],
    cwd: serviceRoot,
    env: {
      ...process.env,
      MCP_HTTP_ENABLED: "false",
    },
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer | string) => {
      serverStderr += chunk.toString();
    });
  }

  client = new Client({
    name: "services-mcp-server-tests",
    version: "0.1.0",
  }, {
    capabilities: {},
  });

  await client.connect(transport);
  fixtures = await fetchFixtures();
  connectProvisionedDriverId = await fetchConnectProvisionedDriverId();
});

after(async () => {
  await client.close();
  await transport.close();
  await closeSharedClients();
});

test("exposes all documented tools", async () => {
  const result = await client.listTools();
  const toolNames = result.tools.map((tool) => tool.name).sort();
  const expected = [...MCP_TOOL_NAMES].sort();

  assert.deepEqual(toolNames, expected);
});

test("calls representative read tools successfully", async () => {
  const snapshot = await callTool("get_business_snapshot", {});
  assert.equal(snapshot.isError, undefined);
  assert.equal(snapshot.structuredContent?.summary.totalOrders !== undefined, true);

  const activeOrders = await callTool("get_active_orders", {});
  assert.equal(activeOrders.isError, undefined);
  assert.ok(Array.isArray(activeOrders.structuredContent?.orders));

  const driverLocation = await callTool("get_driver_location", { driverId: fixtures.driverId });
  assert.equal(driverLocation.isError, undefined);
  assert.equal(driverLocation.structuredContent?.driverId, fixtures.driverId);
});

test("calls the remaining read tools successfully", async () => {
  const incidentDetails = await callTool("get_incident_details", { incidentId: fixtures.incidentId });
  assert.equal(incidentDetails.isError, undefined);
  assert.equal(incidentDetails.structuredContent?.incident.id, fixtures.incidentId);

  const exposure = await callTool("calculate_financial_exposure", { incidentId: fixtures.incidentId });
  assert.equal(exposure.isError, undefined);
  assert.equal(typeof exposure.structuredContent?.estimatedNetExposureCents, "number");

  const options = await callTool("compare_recovery_options", { incidentId: fixtures.incidentId });
  assert.equal(options.isError, undefined);
  assert.ok(Array.isArray(options.structuredContent?.options));
});

test("calls representative action tools successfully", async () => {
  const routeResult = await callTool("request_route_optimisation", {
    incidentId: fixtures.incidentId,
    routeStatus: "recovery",
  });
  assert.equal(routeResult.isError, undefined);
  assert.equal(routeResult.structuredContent?.provider, "cuopt-osrm");

  const policyResult = await callTool("check_spending_policy", {
    actionType: "test_action",
    amountCents: 500,
    incidentId: fixtures.incidentId,
  });
  assert.equal(policyResult.isError, undefined);
  assert.equal(policyResult.structuredContent?.allowed, true);
});

test("rejects malformed input for multiple tools", async () => {
  await expectToolFailure("get_driver_location", {}, /driverId|validation|invalid/i);
  await expectToolFailure("create_driver_payout", {
    driverId: fixtures.driverId,
    amountCents: "500",
    idempotencyKey: randomUUID(),
  }, /amountCents|validation|invalid/i);
  await expectToolFailure("send_customer_notification", {
    orderId: fixtures.orderId,
    channel: "fax",
    message: "Invalid channel test",
  }, /channel|validation|invalid/i);
});

test("enforces the $20 spending policy cap", async () => {
  const allowed = await callTool("check_spending_policy", {
    actionType: "driver_support",
    amountCents: 1_500,
    incidentId: fixtures.incidentId,
  });
  assert.equal(allowed.structuredContent?.allowed, true);
  assert.equal(allowed.structuredContent?.autoCapCents, 2_000);

  const denied = await callTool("check_spending_policy", {
    actionType: "driver_support",
    amountCents: 2_500,
    incidentId: fixtures.incidentId,
  });
  assert.equal(denied.structuredContent?.allowed, false);
  assert.equal(denied.structuredContent?.autoCapCents, 2_000);
});

test("keeps create_driver_payout idempotent", async (t) => {
  if (!connectProvisionedDriverId) {
    t.skip("Stripe Connect driver accounts have not been provisioned in this environment.");
    return;
  }

  const idempotencyKey = `payout-${randomUUID()}`;

  const beforeCount = await countLedgerEntries(idempotencyKey);
  assert.equal(beforeCount, 0);

  const first = await callTool("create_driver_payout", {
    driverId: connectProvisionedDriverId,
    amountCents: 500,
    incidentId: fixtures.incidentId,
    idempotencyKey,
  });
  assert.equal(first.structuredContent?.created, true);

  const second = await callTool("create_driver_payout", {
    driverId: connectProvisionedDriverId,
    amountCents: 500,
    incidentId: fixtures.incidentId,
    idempotencyKey,
  });
  assert.equal(second.structuredContent?.created, false);

  const afterCount = await countLedgerEntries(idempotencyKey);
  assert.equal(afterCount, 1);
});

test("keeps issue_customer_refund idempotent", async () => {
  const idempotencyKey = `refund-${randomUUID()}`;

  const beforeCount = await countLedgerEntries(idempotencyKey);
  assert.equal(beforeCount, 0);

  const first = await callTool("issue_customer_refund", {
    orderId: fixtures.orderId,
    amountCents: 500,
    incidentId: fixtures.incidentId,
    idempotencyKey,
  });
  assert.equal(first.structuredContent?.created, true);

  const second = await callTool("issue_customer_refund", {
    orderId: fixtures.orderId,
    amountCents: 500,
    incidentId: fixtures.incidentId,
    idempotencyKey,
  });
  assert.equal(second.structuredContent?.created, false);

  const afterCount = await countLedgerEntries(idempotencyKey);
  assert.equal(afterCount, 1);
});

test("writes an audit row for action tools", async () => {
  const eventType = "mcp.send_customer_notification";
  const beforeCount = await countAuditRows(eventType);

  const result = await callTool("send_customer_notification", {
    orderId: fixtures.orderId,
    channel: "sms",
    message: `Audit verification ${randomUUID()}`,
  });

  assert.equal(result.structuredContent?.delivered, true);

  const afterCount = await countAuditRows(eventType);
  assert.equal(afterCount, beforeCount + 1, `server stderr:\n${serverStderr}`);
});

test("records a declined checkout incident through the MCP tool surface", async () => {
  const orderId = await seedPendingCheckoutOrder();
  const result = await callTool("record_payment_declined_incident", {
    orderId,
    checkoutSessionId: `checkout-${orderId}`,
    stripeEventId: `evt_${randomUUID().replaceAll("-", "")}`,
    stripePaymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`,
    errorMessage: "Card was declined during test recovery flow.",
    declineCode: "insufficient_funds",
  });

  if (result.isError) {
    const message = result.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n");
    throw new Error(`record_payment_declined_incident failed: ${message}`);
  }
  assert.equal(result.structuredContent?.orderId, orderId);
  assert.equal(result.structuredContent?.created, true);
  assert.equal(result.structuredContent?.status, "pending");
  assert.equal(typeof result.structuredContent?.incidentId, "string");
});

test("calls the remaining action tools successfully", async () => {
  const reassignment = await callTool("assign_replacement_driver", {
    driverId: fixtures.driverId,
    vehicleId: fixtures.vehicleId,
    orderIds: [fixtures.orderId],
  });
  assert.equal(reassignment.isError, undefined);
  assert.deepEqual(reassignment.structuredContent?.reassignedOrderIds, [fixtures.orderId]);

  const recovery = await callTool("verify_delivery_recovery", {
    orderIds: [fixtures.orderId],
  });
  assert.equal(recovery.isError, undefined);
  assert.equal(typeof recovery.structuredContent?.recovered, "boolean");

  const decision = await callTool("record_agent_decision", {
    incidentId: fixtures.incidentId,
    reasoningSummary: "Picked the lowest-cost recovery option under the automatic cap.",
    options: [
      { optionId: "one_driver_recovery", expectedCostCents: 450 },
      { optionId: "wait_for_original_vehicle", expectedCostCents: 300 },
    ],
    selectedOption: { optionId: "wait_for_original_vehicle", expectedCostCents: 300 },
    expectedCostCents: 300,
    expectedBenefitCents: 800,
    policyResult: "allowed",
  });
  assert.equal(decision.isError, undefined);
  assert.equal(decision.structuredContent?.recorded, true);
});

test("can create the recovery skill file", async () => {
  const markdown = `# Delivery Recovery\n\nGenerated at ${new Date().toISOString()}\n`;
  const result = await callTool("create_recovery_skill", {
    skillName: "delivery_recovery",
    markdown,
  });

  assert.equal(result.structuredContent?.written, true);

  const skillPath = String(result.structuredContent?.skillPath ?? "");
  assert.match(
    skillPath,
    /skills[\\/]+delivery-recovery[\\/]+[^\\/]+[\\/]SKILL\.md$/i,
  );

  const stream = createReadStream(skillPath, { encoding: "utf8" });
  let fileContent = "";
  for await (const chunk of stream) {
    fileContent += chunk;
  }
  assert.match(fileContent, /Delivery Recovery/);
});

test("enforces payment role tool restrictions over HTTP transport", async (t) => {
  if (!connectProvisionedDriverId) {
    t.skip("Stripe Connect driver accounts have not been provisioned in this environment.");
    return;
  }

  await withHttpRoleClient("payment", async (httpClient) => {
    const toolNames = (await httpClient.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ["create_driver_payout", "issue_customer_refund"]);

    const payout = await httpClient.callTool({
      name: "create_driver_payout",
      arguments: {
        driverId: connectProvisionedDriverId,
        amountCents: 1_500,
        incidentId: fixtures.incidentId,
        idempotencyKey: `payment-role-${randomUUID()}`,
      },
    });

    assert.equal(payout.isError, undefined);
    assert.equal(payout.structuredContent?.created, true);
    assert.equal(payout.structuredContent?.policy.allowed, true);

    const hiddenToolAttempt = await httpClient.callTool({
      name: "get_business_snapshot",
      arguments: {},
    });
    assert.equal(hiddenToolAttempt.isError, true);
    const hiddenToolMessage = hiddenToolAttempt.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n");
    assert.match(hiddenToolMessage, /unknown|not found|not authorized|method/i);
  });
});
