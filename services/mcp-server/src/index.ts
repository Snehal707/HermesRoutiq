import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import type { Json } from "../../../apps/web/lib/supabase/database.types.js";
import type { McpActionToolName } from "../../../packages/shared/types/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getEnv, type McpServerEnv } from "./env.js";
import {
  insertAgentDecision,
  insertLedgerEntry,
} from "./db.js";
import {
  buildCandidateStrategies,
  gatherReasoningInputs,
  reasonAboutIncident,
  type ReasoningResult,
} from "./reasoning.js";
import { reasonAboutPaidOrderDispatch } from "./dispatch.js";
import { reasonAboutOrderIntake } from "./intake.js";
import { registerActionTools, registerReadTools } from "./tools.js";
import type { IncidentDecisionAction } from "./schemas/decision.js";
import { getAllowedToolsForRole, resolveClaimedRole, type RoutiqRole } from "./policy.js";

type HttpTransport = StreamableHTTPServerTransport | SSEServerTransport;

type TransportRegistry = Record<string, HttpTransport>;
type DemoRole = RoutiqRole;
const preparedRecoveryRoutes = new Map<string, Record<string, unknown>>();
const reasoningRuns = new Map<string, Promise<ReasoningResult>>();
const reasoningResults = new Map<string, ReasoningResult>();
const recoveryRuns = new Map<string, Promise<unknown>>();
const recoveryResults = new Map<string, unknown>();
const ACTION_TOOL_ROLES: Partial<Record<McpActionToolName, DemoRole>> = {
  request_route_optimisation: "routing",
  apply_congestion_recovery_route: "routing",
  apply_breakdown_recovery_reroute: "routing",
  dispatch_paid_order: "routing",
  check_spending_policy: "finance",
  assign_replacement_driver: "operations",
  provision_event_surge_capacity: "finance",
  provision_infrastructure: "operations",
  create_driver_payout: "payment",
  issue_customer_refund: "payment",
  ensure_pending_checkout_order: "operations",
  mark_checkout_order_paid: "operations",
  record_payment_declined_incident: "operations",
  send_customer_notification: "operations",
  record_operational_event: "operations",
  complete_delivery_recovery: "operations",
  verify_delivery_recovery: "operations",
  record_agent_decision: "operations",
  create_recovery_skill: "operations",
};

async function createRoleClient(params: {
  port: number;
  role: DemoRole;
}): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${params.port}/mcp`),
    {
      requestInit: {
        headers: {
          "x-routiq-role": params.role,
        },
      },
    },
  );
  const client = new Client(
    {
      name: `dashboard-${params.role}`,
      version: "0.1.0",
    },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

async function getOrCreateRoleConnection(params: {
  env: McpServerEnv;
  role: DemoRole;
  connectionCache: Partial<Record<DemoRole, Awaited<ReturnType<typeof createRoleClient>>>>;
  roleConnections: Array<Awaited<ReturnType<typeof createRoleClient>>>;
}): Promise<Awaited<ReturnType<typeof createRoleClient>>> {
  const existing = params.connectionCache[params.role];
  if (existing) {
    return existing;
  }

  const created = await createRoleClient({
    port: params.env.MCP_HTTP_PORT,
    role: params.role,
  });
  params.connectionCache[params.role] = created;
  params.roleConnections.push(created);
  return created;
}

function interpolateActionArguments(
  value: unknown,
  context: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replaceAll(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => (
      context[key] ?? `{{${key}}}`
    ));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => interpolateActionArguments(entry, context));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateActionArguments(entry, context),
      ]),
    );
  }

  return value;
}

async function executeHermesActionPlan(params: {
  env: McpServerEnv;
  incidentId: string;
  selectedStrategy: string;
  actions: IncidentDecisionAction[];
  roleConnections: Array<Awaited<ReturnType<typeof createRoleClient>>>;
  connectionCache: Partial<Record<DemoRole, Awaited<ReturnType<typeof createRoleClient>>>>;
}): Promise<Partial<Record<McpActionToolName, unknown[]>>> {
  const results: Partial<Record<McpActionToolName, unknown[]>> = {};

  for (const action of params.actions) {
    const toolName = action.tool as McpActionToolName;
    const role = ACTION_TOOL_ROLES[toolName];
    if (!role) {
      throw new Error(`Hermes proposed unsupported action tool: ${action.tool}`);
    }

    const connection = await getOrCreateRoleConnection({
      env: params.env,
      role,
      connectionCache: params.connectionCache,
      roleConnections: params.roleConnections,
    });

    const rawArguments = interpolateActionArguments(action.arguments, {
      incidentId: params.incidentId,
      selectedStrategy: params.selectedStrategy,
    }) as Record<string, unknown>;
    // These tools block until the recovering vehicle reaches the customer, which
    // can exceed the SDK's default 60s call timeout. Give them the same headroom
    // as the recover route's maxDuration.
    const callOptions =
      toolName === "complete_delivery_recovery" ||
      toolName === "apply_congestion_recovery_route"
        ? { timeout: 290_000, maxTotalTimeout: 290_000 }
        : undefined;
    const result = structuredContent(
      await connection.client.callTool(
        {
          name: toolName,
          arguments: rawArguments,
        },
        undefined,
        callOptions,
      ),
      toolName,
    );
    const existing = results[toolName] ?? [];
    existing.push(result);
    results[toolName] = existing;
  }

  return results;
}

function structuredContent<T>(result: unknown, toolName = "MCP tool"): T {
  const typed = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (typed.isError || typed.structuredContent === undefined) {
    const detail = typed.content
      ?.filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .filter(Boolean)
      .join("\n");
    throw new Error(`${toolName} failed${detail ? `: ${detail}` : ""}`);
  }

  return typed.structuredContent as T;
}

function createServer(role?: DemoRole | null): McpServer {
  const server = new McpServer({
    name: "hermes-routiq-mcp-server",
    version: "0.1.0",
  });

  const allowedTools = role ? new Set(getAllowedToolsForRole(role)) : undefined;

  registerReadTools(server, { allowedTools });
  registerActionTools(server, { allowedTools });

  return server;
}

function splitAllowedHosts(value: string | undefined, port: number): string[] | undefined {
  const configuredHosts = value
    ? value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean)
    : [];

  const hosts = configuredHosts.length > 0
    ? configuredHosts
    : [
        "127.0.0.1",
        "localhost",
        "host.docker.internal",
        "172.20.96.1",
      ];

  const withPort = hosts.flatMap((host) => (
    host.includes(":") ? [host] : [host, `${host}:${port}`]
  ));

  return [...new Set(withPort)];
}

async function startStdioTransport(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hermes Routiq MCP server running on stdio");
}

async function startHttpTransport(env: McpServerEnv): Promise<void> {
  if (!env.MCP_HTTP_ENABLED) {
    return;
  }

  const transportRegistry: TransportRegistry = {};
  const allowedHosts = splitAllowedHosts(env.MCP_ALLOWED_HOSTS, env.MCP_HTTP_PORT);
  const app = createMcpExpressApp({
    host: env.MCP_HTTP_HOST,
    allowedHosts,
  });

  const closeTransport = async (transport: HttpTransport): Promise<void> => {
    const sessionId = transport.sessionId;
    if (sessionId && transportRegistry[sessionId]) {
      delete transportRegistry[sessionId];
    }

    await transport.close();
  };

  app.all(env.MCP_HTTP_PATH, async (req: Request, res: Response) => {
    try {
      const rawSessionId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transportRegistry[sessionId] instanceof StreamableHTTPServerTransport) {
        transport = transportRegistry[sessionId] as StreamableHTTPServerTransport;
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        const claimedRole = resolveClaimedRole(req.headers);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            transportRegistry[initializedSessionId] = transport!;
          },
        });

        transport.onclose = () => {
          const activeSessionId = transport?.sessionId;
          if (activeSessionId && transportRegistry[activeSessionId]) {
            delete transportRegistry[activeSessionId];
          }
        };

        const server = createServer(claimedRole);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid Streamable HTTP session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      console.error("Error handling Streamable HTTP MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get(env.MCP_SSE_PATH, async (_req: Request, res: Response) => {
    try {
      const transport = new SSEServerTransport(env.MCP_SSE_MESSAGES_PATH, res);
      transportRegistry[transport.sessionId] = transport;
      transport.onclose = () => {
        if (transportRegistry[transport.sessionId]) {
          delete transportRegistry[transport.sessionId];
        }
      };

      const server = createServer();
      await server.connect(transport);
    } catch (error: unknown) {
      console.error("Error handling SSE session startup:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.post(env.MCP_SSE_MESSAGES_PATH, async (req: Request, res: Response) => {
    const rawSessionId = req.query.sessionId;
    const sessionId = typeof rawSessionId === "string"
      ? rawSessionId
      : Array.isArray(rawSessionId) && typeof rawSessionId[0] === "string"
        ? rawSessionId[0]
        : undefined;
    const transport = sessionId ? transportRegistry[sessionId] : undefined;

    if (!(transport instanceof SSEServerTransport)) {
      res.status(400).send("No SSE transport found for sessionId");
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error: unknown) {
      console.error("Error handling SSE MCP message:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.post("/dashboard/reason", async (req: Request, res: Response) => {
    const incidentId =
      req.body && typeof req.body.incidentId === "string"
        ? req.body.incidentId
        : null;

    if (!incidentId) {
      res.status(400).json({ error: "incidentId is required" });
      return;
    }

    try {
      const cached = reasoningResults.get(incidentId);
      if (cached) {
        res.json(cached);
        return;
      }

      const activeRun =
        reasoningRuns.get(incidentId) ??
        (async () => {
          const result = await reasonAboutIncident(incidentId);
          const needsRoutePreparation =
            result.toolOutputs.incidentDetails.incident.type !== "payment_declined";

          if (needsRoutePreparation) {
            const connection = await createRoleClient({
              port: env.MCP_HTTP_PORT,
              role: "routing",
            });
            try {
              const routeResult = await connection.client.callTool({
                name: "request_route_optimisation",
                arguments: { incidentId, routeStatus: "recovery" },
              });
              const preparedRoute = structuredContent<Record<string, unknown>>(
                routeResult,
                "request_route_optimisation",
              );
              preparedRecoveryRoutes.set(incidentId, preparedRoute);
            } finally {
              await connection.client.close().catch(() => undefined);
              await connection.transport.close().catch(() => undefined);
            }
          }

          await insertAgentDecision({
            incidentId,
            reasoningSummary: `Hermes selected ${result.decision.selectedStrategy} after comparing ${result.candidateStrategies.length} strategies.`,
            options: result.candidateStrategies as unknown as Json,
            selectedOption: result.decision as unknown as Json,
            expectedCostCents: result.decision.approvedBudget,
            expectedBenefitCents: result.decision.expectedLossAvoided,
            policyResult: "schema_validated",
          });
          reasoningResults.set(incidentId, result);
          return result;
        })();

      reasoningRuns.set(incidentId, activeRun);
      const result = await activeRun;
      res.json(result);
    } catch (error: unknown) {
      console.error("Dashboard reasoning failed", { incidentId, error });
      const message =
        error instanceof Error ? error.message : "Reasoning request failed";
      res.status(500).json({ error: message });
    } finally {
      reasoningRuns.delete(incidentId);
    }
  });

  app.post("/dashboard/recover", async (req: Request, res: Response) => {
    const incidentId =
      req.body && typeof req.body.incidentId === "string"
        ? req.body.incidentId
        : null;
    const simulateBreakdownRoutePersistFailure =
      req.body?.simulateBreakdownRoutePersistFailure === true;

    if (!incidentId) {
      res.status(400).json({ error: "incidentId is required" });
      return;
    }

    try {
      const cached = recoveryResults.get(incidentId);
      if (cached) {
        res.json(cached);
        return;
      }

      const activeRun =
        recoveryRuns.get(incidentId) ??
        (async () => {
          const roleConnections: Array<Awaited<ReturnType<typeof createRoleClient>>> = [];
          const connectionCache: Partial<Record<DemoRole, Awaited<ReturnType<typeof createRoleClient>>>> = {};
          try {
            const reasonResult =
              reasoningResults.get(incidentId) ??
              (reasoningRuns.has(incidentId)
                ? await reasoningRuns.get(incidentId)!
                : await reasonAboutIncident(incidentId));
            reasoningResults.set(incidentId, reasonResult);

            const toolOutputs = reasonResult.toolOutputs;
            const incidentType = toolOutputs.incidentDetails.incident.type;
            const selectedStrategy = reasonResult.candidateStrategies.find(
              (strategy) =>
                strategy.optionId === reasonResult.decision.selectedStrategy,
            );
            const plannedActions = reasonResult.decision.actions;

            if (incidentType === "payment_declined") {
              if (!selectedStrategy) {
                throw new Error("No viable payment recovery strategy is available.");
              }

              const finance = await getOrCreateRoleConnection({
                env,
                role: "finance",
                connectionCache,
                roleConnections,
              });
              const operations = await getOrCreateRoleConnection({
                env,
                role: "operations",
                connectionCache,
                roleConnections,
              });
              const policyResult = await finance.client.callTool({
                name: "check_spending_policy",
                arguments: {
                  actionType: "incident_recovery",
                  amountCents: selectedStrategy.approvedBudget,
                  incidentId,
                },
              });
              const policy = structuredContent<{ allowed: boolean; reason: string }>(
                policyResult,
                "check_spending_policy",
              );
              if (!policy.allowed) {
                throw new Error(policy.reason);
              }

              const actionResults = await executeHermesActionPlan({
                env,
                incidentId,
                selectedStrategy: selectedStrategy.optionId,
                actions: plannedActions,
                roleConnections,
                connectionCache,
              });
              const notifications = actionResults.send_customer_notification ?? [];
              const skill = (actionResults.create_recovery_skill?.[0] ?? null) as
                | Record<string, unknown>
                | null;

              await operations.client.callTool({
                name: "record_operational_event",
                arguments: {
                  eventType: "payment_recovery_contacted",
                  payload: {
                    incidentId,
                    incidentType,
                    orderIds: toolOutputs.incidentDetails.incident.orderIds,
                    recoveryStrategy: selectedStrategy.optionId,
                    customerRevenueProtectedCents:
                      toolOutputs.financialExposure.revenueAtRiskCents,
                  },
                },
              });

              await operations.client.callTool({
                name: "record_agent_decision",
                arguments: {
                  incidentId,
                  reasoningSummary:
                    `Hermes selected ${selectedStrategy.optionId} to keep dispatch blocked ` +
                    `until payment is recovered through a customer retry path.`,
                  options: reasonResult.candidateStrategies,
                  selectedOption: selectedStrategy,
                  expectedCostCents: selectedStrategy.approvedBudget,
                  expectedBenefitCents: selectedStrategy.expectedLossAvoided,
                  policyResult: policy.reason,
                },
              });

              const response = {
                incidentId,
                incidentType,
                policy,
                selectedStrategy,
                execution: {
                  status: "completed",
                  dispatchReleased: false,
                  notificationCount: notifications.length,
                  orderIds: toolOutputs.incidentDetails.incident.orderIds,
                },
                notifications,
                skill,
                provider: reasonResult.provider,
                model: reasonResult.model,
              };
              recoveryResults.set(incidentId, response);
              return response;
            }

            if (incidentType === "congestion") {
              if (!selectedStrategy) {
                throw new Error("No viable congestion recovery strategy is available.");
              }

              const routing = await getOrCreateRoleConnection({
                env,
                role: "routing",
                connectionCache,
                roleConnections,
              });
              const finance = await getOrCreateRoleConnection({
                env,
                role: "finance",
                connectionCache,
                roleConnections,
              });
              const operations = await getOrCreateRoleConnection({
                env,
                role: "operations",
                connectionCache,
                roleConnections,
              });

              const preparedRoute = preparedRecoveryRoutes.get(incidentId);
              const routeResult = preparedRoute
                ? { structuredContent: preparedRoute }
                : await routing.client.callTool({
                    name: "request_route_optimisation",
                    arguments: { incidentId, routeStatus: "recovery" },
                  });
              preparedRecoveryRoutes.delete(incidentId);

              const policyResult = await finance.client.callTool({
                name: "check_spending_policy",
                arguments: {
                  actionType: "incident_recovery",
                  amountCents: selectedStrategy.approvedBudget,
                  incidentId,
                },
              });
              const policy = structuredContent<{ allowed: boolean; reason: string }>(
                policyResult,
                "check_spending_policy",
              );
              if (!policy.allowed) {
                throw new Error(policy.reason);
              }

              if (selectedStrategy.optionId !== "reroute_affected_vehicle") {
                throw new Error(
                  `Congestion recovery selected ${selectedStrategy.optionId}, but only reroute_affected_vehicle execution is wired.`,
                );
              }

              const actionResults = await executeHermesActionPlan({
                env,
                incidentId,
                selectedStrategy: selectedStrategy.optionId,
                actions: plannedActions,
                roleConnections,
                connectionCache,
              });
              const execution = (actionResults.apply_congestion_recovery_route?.[0] ?? null) as {
                incidentId: string;
                vehicleId: string;
                orderIds: string[];
                provider: string;
                beforeRoute: Array<[number, number]>;
                afterRoute: Array<[number, number]>;
                beforeIntersectsCongestion: boolean;
                afterIntersectsCongestion: boolean;
                routeChanged: boolean;
                routeCount: number;
                orderAssignmentCount: number;
                untouchedVehicleIds: string[];
              } | null;
              if (!execution) {
                throw new Error(
                  "Hermes did not execute the congestion reroute application step.",
                );
              }
              const refundsAvoidedCents = Math.min(
                selectedStrategy.expectedLossAvoided,
                toolOutputs.financialExposure.estimatedRefundExposureCents,
              );
              const churnLossAvoidedCents = Math.max(
                0,
                selectedStrategy.expectedLossAvoided - refundsAvoidedCents,
              );
              const rerouteLedger = await insertLedgerEntry({
                entryType: "reroute_cost",
                amountCents: selectedStrategy.approvedBudget,
                referenceId: incidentId,
                idempotencyKey: `${incidentId}:reroute-cost`,
                metadata: {
                  incidentId,
                  incidentType,
                  strategy: selectedStrategy.optionId,
                  vehicleId: execution.vehicleId,
                  routeChanged: execution.routeChanged,
                },
              });
              await operations.client.callTool({
                name: "record_operational_event",
                arguments: {
                  eventType: "delivery_recovery_rerouted",
                  payload: {
                    incidentId,
                    incidentType,
                    orderIds: execution.orderIds,
                    vehicleIds: [execution.vehicleId],
                    incidentVehicleId: execution.vehicleId,
                    humanInterventionCount: 0,
                    affectedDeliveries: execution.orderIds.length,
                    recoveredDeliveries: execution.orderIds.length,
                    customerRevenueProtectedCents:
                      toolOutputs.financialExposure.revenueAtRiskCents,
                    emergencySpendingCents: selectedStrategy.approvedBudget,
                    refundsAvoidedCents,
                    churnLossAvoidedCents,
                    delayAvoidedDeliveries:
                      execution.orderIds.length -
                      selectedStrategy.expectedLateDeliveries,
                    recoveryStrategy: selectedStrategy.optionId,
                    routeChanged: execution.routeChanged,
                    beforeIntersectsCongestion:
                      execution.beforeIntersectsCongestion,
                    afterIntersectsCongestion:
                      execution.afterIntersectsCongestion,
                  },
                },
              });

              await operations.client.callTool({
                name: "record_agent_decision",
                arguments: {
                  incidentId,
                  reasoningSummary:
                    `Hermes selected ${selectedStrategy.optionId} as the highest-net-benefit congestion response. ` +
                    `Persisted a verified reroute for ${execution.vehicleId} that avoids the congestion zone.`,
                  options: reasonResult.candidateStrategies,
                  selectedOption: selectedStrategy,
                  expectedCostCents: selectedStrategy.approvedBudget,
                  expectedBenefitCents: selectedStrategy.expectedLossAvoided,
                  policyResult: policy.reason,
                },
              });
              const skill = (actionResults.create_recovery_skill?.[0] ?? null) as
                | Record<string, unknown>
                | null;

              const response = {
                incidentId,
                incidentType,
                route: routeResult.structuredContent,
                policy,
                selectedStrategy,
                execution: {
                  status: "completed",
                  ...execution,
                },
                ledger: rerouteLedger,
                skill,
                provider: reasonResult.provider,
                model: reasonResult.model,
              };
              recoveryResults.set(incidentId, response);
              return response;
            }

            if (!selectedStrategy) {
              throw new Error("Validated breakdown recovery strategy is unavailable.");
            }

            const routing = await getOrCreateRoleConnection({
              env,
              role: "routing",
              connectionCache,
              roleConnections,
            });
            const finance = await getOrCreateRoleConnection({
              env,
              role: "finance",
              connectionCache,
              roleConnections,
            });
            const operations = await getOrCreateRoleConnection({
              env,
              role: "operations",
              connectionCache,
              roleConnections,
            });

            const preparedRoute = preparedRecoveryRoutes.get(incidentId);
            const routeResult = preparedRoute
              ? { structuredContent: preparedRoute }
              : await routing.client.callTool({
                  name: "request_route_optimisation",
                  arguments: { incidentId, routeStatus: "recovery" },
                });
            preparedRecoveryRoutes.delete(incidentId);
            const policyResult = await finance.client.callTool({
              name: "check_spending_policy",
              arguments: {
                actionType: "incident_recovery",
                amountCents: selectedStrategy.approvedBudget,
                incidentId,
              },
            });
            const policy = structuredContent<{ allowed: boolean; reason: string }>(
              policyResult,
              "check_spending_policy",
            );
            if (!policy.allowed) {
              throw new Error(policy.reason);
            }

            const assignmentActions = plannedActions.filter(
              (action) => action.tool === "assign_replacement_driver",
            );
            const plannedAssignments = assignmentActions.map((action) => {
              const args = action.arguments as {
                driverId: string;
                vehicleId: string;
                orderIds: string[];
              };
              return {
                reassignedOrderIds: args.orderIds.map(String),
                driverId: String(args.driverId),
                vehicleId: String(args.vehicleId),
                routeStatus: "recovery",
              };
            });
            if (plannedAssignments.length < 1) {
              throw new Error("Hermes did not propose any replacement driver assignment actions.");
            }

            const preRecoveryActions = plannedActions
              .filter(
                (action) =>
                  action.tool !== "send_customer_notification" &&
                  action.tool !== "create_recovery_skill",
              )
              .map((action) => (
                action.tool === "apply_breakdown_recovery_reroute"
                  ? {
                      ...action,
                      arguments: {
                        ...action.arguments,
                        simulatePersistFailure:
                          simulateBreakdownRoutePersistFailure,
                      },
                    }
                  : action
              ));

            const actionResults = await executeHermesActionPlan({
              env,
              incidentId,
              selectedStrategy: selectedStrategy.optionId,
              actions: preRecoveryActions,
              roleConnections,
              connectionCache,
            });
            const executedAssignments = (actionResults.assign_replacement_driver ?? []) as Array<{
              reassignedOrderIds: string[];
              driverId: string;
              vehicleId: string;
              routeStatus: string;
            }>;
            if (executedAssignments.length < 1) {
              throw new Error("Hermes did not execute any replacement driver assignment actions.");
            }
            const rerouteExecution = (actionResults.apply_breakdown_recovery_reroute?.[0] ?? null) as {
              incidentId: string;
              orderIds: string[];
              provider: string;
              routeCount: number;
              orderAssignmentCount: number;
              replacementRoutes: Array<{
                vehicleId: string;
                orderIds: string[];
                beforeRoute: Array<[number, number]>;
                afterRoute: Array<[number, number]>;
                routeChanged: boolean;
              }>;
              brokenVehicle: {
                vehicleId: string;
                beforeRoute: Array<[number, number]>;
                afterRoute: Array<[number, number]>;
                parkedLocation: [number, number];
              };
              untouchedVehicleIds: string[];
            } | null;
            if (!rerouteExecution) {
              throw new Error(
                "Hermes did not execute the breakdown reroute application step.",
              );
            }
            const payouts = (actionResults.create_driver_payout ?? []) as unknown[];
            const recoveryCompletion = (actionResults.complete_delivery_recovery?.[0] ?? null) as {
              completed: boolean;
              incidentId: string;
              recoveredOrderIds: string[];
              replacementVehicleIds: string[];
              incidentVehicleId: string;
            } | null;
            if (!recoveryCompletion?.completed) {
              throw new Error(
                "Hermes did not execute the delivery recovery completion step.",
              );
            }

            const premiumCents =
              selectedStrategy.approvedBudget -
              executedAssignments.length * 400;
            const premiumLedger = await insertLedgerEntry({
              entryType: "emergency_premium",
              amountCents: premiumCents,
              referenceId: incidentId,
              idempotencyKey: `${incidentId}:emergency-premium`,
              metadata: {
                incidentId,
                reason: "Emergency recovery coordination premium",
              },
            });

            const recoveredOrderIds =
              recoveryCompletion.recoveredOrderIds;
            const replacementVehicleIds =
              recoveryCompletion.replacementVehicleIds;
            const incidentVehicleId = recoveryCompletion.incidentVehicleId;

            const postRecoveryActionResults = await executeHermesActionPlan({
              env,
              incidentId,
              selectedStrategy: selectedStrategy.optionId,
              actions: plannedActions.filter(
                (action) =>
                  action.tool === "send_customer_notification" ||
                  action.tool === "create_recovery_skill",
              ),
              roleConnections,
              connectionCache,
            });
            const verification = structuredContent(
              await operations.client.callTool({
                name: "verify_delivery_recovery",
                arguments: { orderIds: recoveredOrderIds },
              }),
              "verify_delivery_recovery",
            );
            await operations.client.callTool({
              name: "record_agent_decision",
              arguments: {
                incidentId,
                reasoningSummary:
                  `Hermes selected ${selectedStrategy.optionId} and executed ${executedAssignments.length} replacement assignment actions under policy.`,
                options: reasonResult.candidateStrategies,
                selectedOption: selectedStrategy,
                expectedCostCents: selectedStrategy.approvedBudget,
                expectedBenefitCents: selectedStrategy.expectedLossAvoided,
                policyResult: policy.reason,
              },
            });
            const skill = (postRecoveryActionResults.create_recovery_skill?.[0] ?? null) as
              | Record<string, unknown>
              | null;

            const response = {
              incidentId,
              route: routeResult.structuredContent,
              policy,
              assignments: plannedAssignments,
              execution: {
                status: "completed",
                ...rerouteExecution,
              },
              payouts,
              premiumLedger,
              notifications: postRecoveryActionResults.send_customer_notification ?? [],
              verification,
              skill,
              provider: reasonResult.provider,
              model: reasonResult.model,
            };
            recoveryResults.set(incidentId, response);
            return response;
          } finally {
            await Promise.all(
              roleConnections.flatMap(({ client, transport }) => [
                client.close().catch(() => undefined),
                transport.close().catch(() => undefined),
              ]),
            );
          }
        })();

      recoveryRuns.set(incidentId, activeRun);
      const response = await activeRun;
      res.json(response);
    } catch (error: unknown) {
      console.error("Dashboard recovery failed", { incidentId, error });
      const message =
        error instanceof Error ? error.message : "Recovery execution failed";
      res.status(500).json({ error: message });
    } finally {
      recoveryRuns.delete(incidentId);
    }
  });

  app.post("/dashboard/dispatch", async (req: Request, res: Response) => {
    const orderId =
      req.body && typeof req.body.orderId === "string" ? req.body.orderId : null;

    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

    const roleConnections: Array<Awaited<ReturnType<typeof createRoleClient>>> = [];
    const connectionCache: Partial<
      Record<DemoRole, Awaited<ReturnType<typeof createRoleClient>>>
    > = {};

    try {
      const monitoring = await getOrCreateRoleConnection({
        env,
        role: "monitoring",
        connectionCache,
        roleConnections,
      });
      const routing = await getOrCreateRoleConnection({
        env,
        role: "routing",
        connectionCache,
        roleConnections,
      });
      const operations = await getOrCreateRoleConnection({
        env,
        role: "operations",
        connectionCache,
        roleConnections,
      });

      const businessSnapshot = structuredContent<
        typeof import("./schemas.js").toolOutputSchemas.get_business_snapshot._type
      >(
        await monitoring.client.callTool({
          name: "get_business_snapshot",
          arguments: {},
        }),
        "get_business_snapshot",
      );
      const activeOrders = structuredContent<
        typeof import("./schemas.js").toolOutputSchemas.get_active_orders._type
      >(
        await monitoring.client.callTool({
          name: "get_active_orders",
          arguments: {},
        }),
        "get_active_orders",
      );
      const routePreview = structuredContent<
        typeof import("./schemas.js").toolOutputSchemas.preview_paid_order_dispatch._type
      >(
        await routing.client.callTool({
          name: "preview_paid_order_dispatch",
          arguments: { orderId },
        }),
        "preview_paid_order_dispatch",
      );

      const reasoning = await reasonAboutPaidOrderDispatch({
        orderId,
        businessSnapshot,
        activeOrders,
        routePreview,
      });
      const decision = reasoning.decision;
      const selectedStrategy =
        reasoning.candidateStrategies.find(
          (strategy) => strategy.optionId === decision.selectedStrategy,
        ) ?? null;
      if (!selectedStrategy) {
        throw new Error(`Hermes selected unknown dispatch strategy ${decision.selectedStrategy}.`);
      }

      const actionResults = await executeHermesActionPlan({
        env,
        incidentId: orderId,
        selectedStrategy: selectedStrategy.optionId,
        actions: decision.actions as IncidentDecisionAction[],
        roleConnections,
        connectionCache,
      });
      const dispatchResult = (actionResults.dispatch_paid_order?.[0] ?? null) as
        | Record<string, unknown>
        | null;
      const notifications = actionResults.send_customer_notification ?? [];

      await operations.client.callTool({
        name: "record_operational_event",
        arguments: {
          eventType:
            selectedStrategy.optionId === "dispatch_now"
              ? "paid_order_dispatch_completed"
              : "paid_order_dispatch_deferred",
          payload: {
            orderId,
            decisionSource: "hermes_dispatch_agent",
            decisionSummary: decision.decisionSummary,
            contextRefs: reasoning.contextRefs,
            skillRefs: reasoning.skillRefs,
            plannedTools: reasoning.plannedTools,
            provider: reasoning.provider,
            model: reasoning.model,
            strategy: selectedStrategy.optionId,
            assignedVehicleId:
              typeof dispatchResult?.assignedVehicleId === "string"
                ? dispatchResult.assignedVehicleId
                : null,
            dispatched: dispatchResult?.dispatched === true,
            notificationCount: notifications.length,
          },
        },
      });

      await operations.client.callTool({
        name: "record_agent_decision",
        arguments: {
          incidentId: null,
          reasoningSummary:
            `Hermes selected ${selectedStrategy.optionId} for paid order ${orderId}. ` +
            decision.decisionSummary,
          options: reasoning.candidateStrategies,
          selectedOption: decision,
          expectedCostCents: 0,
          expectedBenefitCents: decision.expectedRevenueCaptured ?? null,
          policyResult: selectedStrategy.optionId === "dispatch_now"
            ? "dispatch_preview_validated"
            : "dispatch_held_for_capacity",
        },
      });

      res.json({
        orderId,
        selectedStrategy,
        execution: dispatchResult ?? {
          orderId,
          dispatched: false,
          assignedVehicleId: null,
        },
        notifications,
        decisionSource: "hermes_dispatch_agent",
        decisionSummary: decision.decisionSummary,
        contextRefs: reasoning.contextRefs,
        skillRefs: reasoning.skillRefs,
        plannedTools: reasoning.plannedTools,
        provider: reasoning.provider,
        model: reasoning.model,
        candidateStrategies: reasoning.candidateStrategies,
        decision,
        routePreview,
      });
    } catch (error: unknown) {
      console.error("Dashboard dispatch failed", { orderId, error });
      const message =
        error instanceof Error ? error.message : "Dispatch execution failed";
      res.status(500).json({ error: message });
    } finally {
      await Promise.all(
        roleConnections.flatMap(({ client, transport }) => [
          client.close().catch(() => undefined),
          transport.close().catch(() => undefined),
        ]),
      );
    }
  });

  app.post("/dashboard/intake", async (req: Request, res: Response) => {
    const orderId =
      req.body && typeof req.body.orderId === "string" ? req.body.orderId : null;
    const customerId =
      req.body && typeof req.body.customerId === "string" ? req.body.customerId : null;
    const pickupHubId =
      req.body && typeof req.body.pickupHubId === "string" ? req.body.pickupHubId : null;
    const baselineQuoteCents =
      req.body && typeof req.body.baselineQuoteCents === "number"
        ? req.body.baselineQuoteCents
        : null;
    const minQuoteCents =
      req.body && typeof req.body.minQuoteCents === "number"
        ? req.body.minQuoteCents
        : null;
    const maxQuoteCents =
      req.body && typeof req.body.maxQuoteCents === "number"
        ? req.body.maxQuoteCents
        : null;
    const estimatedDistanceKm =
      req.body && typeof req.body.estimatedDistanceKm === "number"
        ? req.body.estimatedDistanceKm
        : null;

    if (
      !orderId ||
      !customerId ||
      !pickupHubId ||
      baselineQuoteCents === null ||
      minQuoteCents === null ||
      maxQuoteCents === null ||
      estimatedDistanceKm === null
    ) {
      res.status(400).json({
        error:
          "orderId, customerId, pickupHubId, baselineQuoteCents, minQuoteCents, maxQuoteCents, and estimatedDistanceKm are required",
      });
      return;
    }

    const roleConnections: Array<Awaited<ReturnType<typeof createRoleClient>>> = [];
    const connectionCache: Partial<
      Record<DemoRole, Awaited<ReturnType<typeof createRoleClient>>>
    > = {};

    try {
      const monitoring = await getOrCreateRoleConnection({
        env,
        role: "monitoring",
        connectionCache,
        roleConnections,
      });
      const operations = await getOrCreateRoleConnection({
        env,
        role: "operations",
        connectionCache,
        roleConnections,
      });

      const businessSnapshot = structuredContent<
        typeof import("./schemas.js").toolOutputSchemas.get_business_snapshot._type
      >(
        await monitoring.client.callTool({
          name: "get_business_snapshot",
          arguments: {},
        }),
        "get_business_snapshot",
      );
      const activeOrders = structuredContent<
        typeof import("./schemas.js").toolOutputSchemas.get_active_orders._type
      >(
        await monitoring.client.callTool({
          name: "get_active_orders",
          arguments: {},
        }),
        "get_active_orders",
      );

      const reasoning = await reasonAboutOrderIntake({
        orderId,
        customerId,
        pickupHubId,
        baselineQuoteCents,
        minQuoteCents,
        maxQuoteCents,
        estimatedDistanceKm,
        businessSnapshot,
        activeOrders,
      });

      await operations.client.callTool({
        name: "record_operational_event",
        arguments: {
          eventType: "order_intake_decision_completed",
          payload: {
            orderId,
            customerId,
            pickupHubId,
            decisionSource: "hermes_intake_agent",
            accepted: reasoning.decision.accepted,
            strategy: reasoning.decision.selectedStrategy,
            quotedPriceCents: reasoning.decision.quotedPriceCents,
            decisionSummary: reasoning.decision.decisionSummary,
            baselineQuoteCents,
            minQuoteCents,
            maxQuoteCents,
            estimatedDistanceKm,
            contextRefs: reasoning.contextRefs,
            skillRefs: reasoning.skillRefs,
            plannedTools: reasoning.plannedTools,
            provider: reasoning.provider,
            model: reasoning.model,
          },
        },
      });

      const intakeDecisionSummary =
        `Hermes evaluated checkout intake for ${orderId} and selected ${reasoning.decision.selectedStrategy}. ` +
        reasoning.decision.decisionSummary;

      await operations.client.callTool({
        name: "record_agent_decision",
        arguments: {
          incidentId: null,
          reasoningSummary: intakeDecisionSummary,
          options: reasoning.candidateStrategies,
          selectedOption: reasoning.decision,
          expectedCostCents: 0,
          expectedBenefitCents: reasoning.decision.expectedRevenueCaptured ?? null,
          policyResult: reasoning.decision.accepted
            ? "intake_quote_approved"
            : "intake_rejected_for_capacity",
        },
      });

      res.json({
        orderId,
        accepted: reasoning.decision.accepted,
        quotedPriceCents: reasoning.decision.quotedPriceCents,
        selectedStrategy: reasoning.decision.selectedStrategy,
        decisionSummary: reasoning.decision.decisionSummary,
        decisionSource: "hermes_intake_agent",
        contextRefs: reasoning.contextRefs,
        skillRefs: reasoning.skillRefs,
        plannedTools: reasoning.plannedTools,
        provider: reasoning.provider,
        model: reasoning.model,
        candidateStrategies: reasoning.candidateStrategies,
        decision: reasoning.decision,
      });
    } catch (error: unknown) {
      console.error("Dashboard intake failed", { orderId, error });
      const message =
        error instanceof Error ? error.message : "Order intake execution failed";
      res.status(500).json({ error: message });
    } finally {
      await Promise.all(
        roleConnections.flatMap(({ client, transport }) => [
          client.close().catch(() => undefined),
          transport.close().catch(() => undefined),
        ]),
      );
    }
  });

  app.post("/dashboard/checkout/pending", async (req: Request, res: Response) => {
    const stripeCheckoutSessionId =
      typeof req.body?.stripeCheckoutSessionId === "string"
        ? req.body.stripeCheckoutSessionId
        : null;
    const metadata =
      req.body?.metadata && typeof req.body.metadata === "object"
        ? req.body.metadata
        : null;

    if (!stripeCheckoutSessionId || !metadata) {
      res.status(400).json({ error: "metadata and stripeCheckoutSessionId are required" });
      return;
    }

    let connection:
      | Awaited<ReturnType<typeof createRoleClient>>
      | null = null;
    try {
      connection = await createRoleClient({
        port: env.MCP_HTTP_PORT,
        role: "operations",
      });
      const result = await connection.client.callTool({
        name: "ensure_pending_checkout_order",
        arguments: {
          metadata,
          stripeCheckoutSessionId,
        },
      });
      res.json(
        structuredContent<Record<string, unknown>>(
          result,
          "ensure_pending_checkout_order",
        ),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Pending checkout order creation failed";
      res.status(500).json({ error: message });
    } finally {
      if (connection) {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }
    }
  });

  app.post("/dashboard/checkout/mark-paid", async (req: Request, res: Response) => {
    const stripeEventId =
      typeof req.body?.stripeEventId === "string" ? req.body.stripeEventId : null;
    const stripeCheckoutSessionId =
      typeof req.body?.stripeCheckoutSessionId === "string"
        ? req.body.stripeCheckoutSessionId
        : null;
    const stripePaymentIntentId =
      typeof req.body?.stripePaymentIntentId === "string"
        ? req.body.stripePaymentIntentId
        : req.body?.stripePaymentIntentId === null
          ? null
          : null;
    const metadata =
      req.body?.metadata && typeof req.body.metadata === "object"
        ? req.body.metadata
        : null;

    if (!stripeEventId || !stripeCheckoutSessionId || !metadata) {
      res.status(400).json({
        error: "metadata, stripeEventId, and stripeCheckoutSessionId are required",
      });
      return;
    }

    let connection:
      | Awaited<ReturnType<typeof createRoleClient>>
      | null = null;
    try {
      connection = await createRoleClient({
        port: env.MCP_HTTP_PORT,
        role: "operations",
      });
      const result = await connection.client.callTool({
        name: "mark_checkout_order_paid",
        arguments: {
          metadata,
          stripeEventId,
          stripeCheckoutSessionId,
          stripePaymentIntentId,
        },
      });
      res.json(
        structuredContent<Record<string, unknown>>(
          result,
          "mark_checkout_order_paid",
        ),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Checkout payment reconciliation failed";
      res.status(500).json({ error: message });
    } finally {
      if (connection) {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }
    }
  });

  app.post("/dashboard/checkout/declined", async (req: Request, res: Response) => {
    let connection:
      | Awaited<ReturnType<typeof createRoleClient>>
      | null = null;
    try {
      connection = await createRoleClient({
        port: env.MCP_HTTP_PORT,
        role: "operations",
      });
      const result = await connection.client.callTool({
        name: "record_payment_declined_incident",
        arguments: {
          orderId:
            typeof req.body?.orderId === "string" ? req.body.orderId : null,
          checkoutSessionId:
            typeof req.body?.checkoutSessionId === "string"
              ? req.body.checkoutSessionId
              : req.body?.checkoutSessionId === null
                ? null
                : undefined,
          stripeEventId:
            typeof req.body?.stripeEventId === "string"
              ? req.body.stripeEventId
              : req.body?.stripeEventId === null
                ? null
                : undefined,
          stripePaymentIntentId:
            typeof req.body?.stripePaymentIntentId === "string"
              ? req.body.stripePaymentIntentId
              : req.body?.stripePaymentIntentId === null
                ? null
                : undefined,
          errorMessage:
            typeof req.body?.errorMessage === "string"
              ? req.body.errorMessage
              : req.body?.errorMessage === null
                ? null
                : undefined,
          declineCode:
            typeof req.body?.declineCode === "string"
              ? req.body.declineCode
              : req.body?.declineCode === null
                ? null
                : undefined,
        },
      });
      res.json(
        structuredContent<Record<string, unknown>>(
          result,
          "record_payment_declined_incident",
        ),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Payment decline incident recording failed";
      res.status(500).json({ error: message });
    } finally {
      if (connection) {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }
    }
  });

  app.post("/dashboard/provision", async (req: Request, res: Response) => {
    const infraType =
      req.body?.infraType === "observability" ? "observability" : "queue";
    const triggerReason =
      typeof req.body?.triggerReason === "string" &&
      req.body.triggerReason.trim()
        ? req.body.triggerReason.trim()
        : "Rising event volume requires additional queue capacity";

    let connection:
      | Awaited<ReturnType<typeof createRoleClient>>
      | null = null;
    try {
      connection = await createRoleClient({
        port: env.MCP_HTTP_PORT,
        role: "operations",
      });
      const result = await connection.client.callTool({
        name: "provision_infrastructure",
        arguments: {
          infraType,
          triggerReason,
        },
      });
      res.json(
        structuredContent<Record<string, unknown>>(
          result,
          "provision_infrastructure",
        ),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Infrastructure provisioning failed";
      res.status(500).json({ error: message });
    } finally {
      if (connection) {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }
    }
  });

  app.post("/dashboard/event", async (req: Request, res: Response) => {
    const eventType =
      typeof req.body?.eventType === "string" ? req.body.eventType : null;
    const payload =
      req.body?.payload && typeof req.body.payload === "object"
        ? req.body.payload
        : null;

    if (!eventType || !payload) {
      res.status(400).json({ error: "eventType and payload are required" });
      return;
    }

    let connection:
      | Awaited<ReturnType<typeof createRoleClient>>
      | null = null;
    try {
      connection = await createRoleClient({
        port: env.MCP_HTTP_PORT,
        role: "operations",
      });
      const result = await connection.client.callTool({
        name: "record_operational_event",
        arguments: {
          eventType,
          payload,
        },
      });
      res.json(
        structuredContent<Record<string, unknown>>(
          result,
          "record_operational_event",
        ),
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Operational event recording failed";
      res.status(500).json({ error: message });
    } finally {
      if (connection) {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }
    }
  });

  const httpServer = app.listen(env.MCP_HTTP_PORT, env.MCP_HTTP_HOST, () => {
    const address = httpServer.address() as AddressInfo | null;
    const host = address?.address ?? env.MCP_HTTP_HOST;
    const port = address?.port ?? env.MCP_HTTP_PORT;
    console.error(`Hermes Routiq MCP server running on Streamable HTTP at http://${host}:${port}${env.MCP_HTTP_PATH}`);
    console.error(`Hermes Routiq MCP server running on legacy SSE at http://${host}:${port}${env.MCP_SSE_PATH}`);
  });

  httpServer.on("error", (error: unknown) => {
    console.error("Failed to start HTTP MCP transport:", error);
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await Promise.all(Object.values(transportRegistry).map((transport) => closeTransport(transport)));
    httpServer.close();
  });
}

async function main(): Promise<void> {
  const env = getEnv();

  await Promise.all([
    startStdioTransport(),
    startHttpTransport(env),
  ]);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
