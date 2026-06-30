import type { ReasoningResponse } from "@/lib/dashboard/decision";
import type {
  DashboardAgentTimelineItem,
  DashboardCurrentRequest,
  DashboardPolicyEvaluation,
} from "@/lib/dashboard/types";

function formatMoney(cents: number): string {
  const sign = cents > 0 ? "+" : "";
  return `${sign}$${Math.abs(cents / 100).toFixed(0)}`;
}

function formatQuote(cents: number | null | undefined): string {
  if (typeof cents !== "number") {
    return "n/a";
  }

  return `$${(cents / 100).toFixed(2)}`;
}

function formatFeedTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function normalizeActionType(actionType: string): string {
  return actionType.includes(":")
    ? actionType.split(":").at(-1) ?? actionType
    : actionType;
}

function activityIcon(toolName: string, rawActionType: string): string {
  if (
    toolName === "check_spending_policy" ||
    rawActionType.startsWith("role_tool_authorization:")
  ) {
    return "[L]";
  }

  if (toolName === "record_agent_decision" || toolName === "create_recovery_skill") {
    return "[A]";
  }

  if (toolName === "create_driver_payout" || toolName === "issue_customer_refund") {
    return "[$]";
  }

  return "[T]";
}

function formatPlannedArgument(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatPlannedArgument(entry)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    return "{...}";
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function formatProviderLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "hermes_local":
      return "Hermes sandbox bridge";
    case "openrouter":
      return "OpenRouter";
    case "nous":
      return "Nous inference";
    case "cuopt-osrm":
      return "cuOpt + OSRM";
    default:
      return provider ?? "Unknown provider";
  }
}

function formatRuntimeLabel(model: string | null | undefined): string {
  if (!model) {
    return "Unknown runtime";
  }

  return model === "hermes-agent" ? "Hermes agent runtime" : model;
}

function humanizeIdentifier(value: string | null | undefined): string {
  if (!value) {
    return "unknown";
  }

  return value
    .replace(/[_:]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatStrategyLabel(value: string | null | undefined): string {
  switch (value) {
    case "reroute_affected_vehicle":
      return "reroute the active vehicle";
    case "dispatch_available_driver":
      return "dispatch the best available driver";
    case "hold_for_capacity":
      return "hold dispatch for capacity";
    case "reassign_delivery":
      return "reassign the delivery";
    case "wait_and_monitor":
      return "wait and monitor";
    case "payment_recovery":
      return "run payment recovery";
    default:
      return humanizeIdentifier(value).toLowerCase();
  }
}

interface HumanSummary {
  label: string;
  headline: string;
  body: string;
  highlights: string[];
}

function buildHumanSummary(params: {
  currentRequest: DashboardCurrentRequest | null;
  result: ReasoningResponse | null;
  runtimeLabel: string;
  providerLabel: string;
}): HumanSummary | null {
  const { currentRequest, result, runtimeLabel, providerLabel } = params;

  if (result) {
    const selectedOption =
      result.candidateStrategies.find(
        (option) => option.optionId === result.decision.selectedStrategy,
      ) ?? null;
    const customer = currentRequest?.customerLabel ?? "the affected delivery";

    return {
      label: "Incident decision",
      headline: `Hermes chose to ${formatStrategyLabel(result.decision.selectedStrategy)} for ${customer}.`,
      body:
        selectedOption?.label ??
        `The agent evaluated recovery options, selected the best operational move, and is now executing it through the live tool chain.`,
      highlights: [
        `approved budget ${formatMoney(result.decision.approvedBudget)}`,
        `expected net ${formatMoney(result.decision.expectedNetBenefit)}`,
        `${result.decision.actions.length} planned calls`,
        `${runtimeLabel} via ${providerLabel}`,
      ],
    };
  }

  if (!currentRequest) {
    return null;
  }

  const customer = currentRequest.customerLabel ?? currentRequest.orderId;
  const routeLabel = [
    currentRequest.pickupHubLabel ?? "unknown hub",
    currentRequest.destinationLabel ?? "destination pending",
  ].join(" -> ");

  if (currentRequest.status === "delivered") {
    return {
      label: "Delivery complete",
      headline: `Hermes completed ${customer} from ${routeLabel}.`,
      body:
        currentRequest.dispatchDecisionSummary ??
        currentRequest.decisionSummary ??
        "Hermes accepted the paid order, released dispatch, routed the vehicle, and closed the delivery successfully.",
      highlights: [
        `quoted ${formatQuote(currentRequest.quotedPriceCents)}`,
        currentRequest.dispatchAssignedVehicleId
          ? `vehicle ${currentRequest.dispatchAssignedVehicleId}`
          : "vehicle assigned",
        `${runtimeLabel} via ${providerLabel}`,
      ],
    };
  }

  if (currentRequest.dispatchStatus === "reasoning") {
    return {
      label: "Dispatch in progress",
      headline: `Hermes is deciding how to release ${customer}.`,
      body:
        currentRequest.dispatchDecisionSummary ??
        currentRequest.decisionSummary ??
        "The paid order is live. Hermes is validating capacity, tools, and dispatch timing before publishing the route.",
      highlights: [
        `quote ${formatQuote(currentRequest.quotedPriceCents)}`,
        `${routeLabel}`,
        `${runtimeLabel} via ${providerLabel}`,
      ],
    };
  }

  if (currentRequest.dispatchStatus === "released") {
    return {
      label: "Dispatch live",
      headline: `Hermes released ${customer} onto the map.`,
      body:
        currentRequest.dispatchDecisionSummary ??
        "The route is assigned and the vehicle should now be visible in motion or ready to move.",
      highlights: [
        currentRequest.dispatchAssignedVehicleId
          ? `vehicle ${currentRequest.dispatchAssignedVehicleId}`
          : "vehicle pending",
        `quote ${formatQuote(currentRequest.quotedPriceCents)}`,
        `${runtimeLabel} via ${providerLabel}`,
      ],
    };
  }

  if (currentRequest.funnelStatus === "declined") {
    return {
      label: "Payment recovery",
      headline: `Hermes kept ${customer} off the fleet because payment failed.`,
      body:
        currentRequest.decisionSummary ??
        "Dispatch stayed blocked while Hermes shifted the request into recovery instead of spending driver time on unpaid work.",
      highlights: [
        `${routeLabel}`,
        currentRequest.strategy ? humanizeIdentifier(currentRequest.strategy) : "commerce guardrails",
        `${runtimeLabel} via ${providerLabel}`,
      ],
    };
  }

  return {
    label: "Intake review",
    headline: `Hermes is reviewing ${customer}.`,
    body:
      currentRequest.decisionSummary ??
      "The agent is evaluating the request, quoting it, and preparing the next allowed actions.",
    highlights: [
      `quote ${formatQuote(currentRequest.quotedPriceCents)}`,
      `${routeLabel}`,
      `${runtimeLabel} via ${providerLabel}`,
    ],
  };
}

interface NemotronDecisionPanelProps {
  agentTimeline: DashboardAgentTimelineItem[];
  currentRequest: DashboardCurrentRequest | null;
  result: ReasoningResponse | null;
  reasoningSeconds: number;
  status: "idle" | "reasoning" | "complete" | "error";
  error: string | null;
  policyItems: DashboardPolicyEvaluation[];
}

export function NemotronDecisionPanel({
  agentTimeline,
  currentRequest,
  result,
  reasoningSeconds,
  status,
  error,
  policyItems,
}: NemotronDecisionPanelProps) {
  const hasOperationalReasoning = Boolean(
    currentRequest &&
      (currentRequest.decisionSource ||
        currentRequest.dispatchStatus !== "idle" ||
        currentRequest.contextRefs.length > 0 ||
        currentRequest.dispatchContextRefs.length > 0),
  );

  if (status === "idle" && !hasOperationalReasoning) {
    return null;
  }

  const incidentId = result?.decision.incidentId ?? null;
  const visiblePolicyItems = [...policyItems]
    .filter((item) => (incidentId ? item.incidentId === incidentId : item.incidentId === null))
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
  const visibleAgentTimeline = [...agentTimeline]
    .filter((item) =>
      incidentId
        ? item.incidentId === incidentId || item.incidentId === null
        : item.incidentId === null,
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
  const executedActionCursor = new Map<string, number>();
  const plannedToolCount = result?.decision.actions.length ?? 0;
  const executedToolCount = visibleAgentTimeline.length;
  const runtimeModel =
    result?.model ??
    currentRequest?.dispatchModel ??
    currentRequest?.model ??
    null;
  const runtimeProvider =
    result?.provider ??
    currentRequest?.dispatchProvider ??
    currentRequest?.provider ??
    null;
  const runtimeLabel = formatRuntimeLabel(runtimeModel);
  const providerLabel = formatProviderLabel(runtimeProvider);
  const operationalStatus =
    status !== "idle"
      ? status
      : currentRequest?.dispatchStatus === "reasoning"
        ? "reasoning"
        : "complete";
  const operationalPlannedTools = [
    ...(currentRequest?.plannedTools ?? []),
    ...(currentRequest?.dispatchPlannedTools ?? []),
  ];
  const humanSummary = buildHumanSummary({
    currentRequest,
    result,
    runtimeLabel,
    providerLabel,
  });

  return (
    <section className="no-scrollbar flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden pr-1 text-slate-100">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Hermes summary
          </p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[#57b0ff]">
            Hermes agent | {runtimeLabel} | {providerLabel}
          </p>
        </div>
        <span className={`decision-status is-${operationalStatus}`}>
          {operationalStatus === "reasoning" ? "Reasoning..." : "Complete"}
        </span>
      </div>

      {humanSummary ? (
        <div className="mt-3 rounded-2xl border border-white/8 bg-[#08111a] px-4 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            {humanSummary.label}
          </p>
          <p className="mt-2 text-sm font-medium text-white">
            {humanSummary.headline}
          </p>
          <p className="mt-2 text-sm text-slate-400">{humanSummary.body}</p>
          {humanSummary.highlights.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {humanSummary.highlights.map((highlight) => (
                <span
                  key={highlight}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-slate-300"
                >
                  {highlight}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {result?.reusedSkill?.loaded ? (
        <div className="mt-3 rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.05] px-4 py-3 text-sm text-emerald-100">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300">
            Hermes learning loop
          </p>
          <p className="mt-2">
            Reused skill <strong>{result.reusedSkill.skillName}</strong>
            {result.reusedSkill.learnedFromIncidentId
              ? ` from incident ${result.reusedSkill.learnedFromIncidentId.slice(0, 8)}`
              : ""}.
          </p>
        </div>
      ) : null}

      <div className="mt-3 rounded-2xl border border-white/8 bg-[#08111a] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Observed tool and policy activity
          </p>
          <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {executedToolCount} observed
          </p>
        </div>

        <div className="mt-3 grid gap-1 font-mono text-[11px]">
          {visiblePolicyItems.map((item) => {
            const toolName = normalizeActionType(item.actionType);
            const icon = activityIcon(toolName, item.actionType);
            const statusColor = item.allowed ? "#00ff80" : "#ff6b6b";

            return (
              <div
                key={item.id}
                className="grid grid-cols-[32px_minmax(0,1fr)_76px_64px] items-center gap-2 rounded-md bg-white/[0.02] px-2 py-1.5"
              >
                <span aria-hidden="true">{icon}</span>
                <span className="truncate text-slate-200">
                  {humanizeIdentifier(toolName)}
                </span>
                <span
                  className="text-right text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: statusColor }}
                >
                  {item.allowed ? "allow" : "deny"}
                </span>
                <span className="text-right text-[10px] text-slate-500">
                  {formatFeedTime(item.createdAt)}
                </span>
              </div>
            );
          })}

          {visibleAgentTimeline.map((item) => (
            <div
              key={item.id}
              className="grid grid-cols-[32px_minmax(0,1fr)_76px_64px] items-center gap-2 rounded-md bg-white/[0.02] px-2 py-1.5"
            >
              <span aria-hidden="true">
                {activityIcon(item.toolName, item.toolName)}
              </span>
              <span className="truncate text-slate-200">
                {humanizeIdentifier(item.toolName)}
              </span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-300">
                observed
              </span>
              <span className="text-right text-[10px] text-slate-500">
                {formatFeedTime(item.createdAt)}
              </span>
            </div>
          ))}

          {operationalStatus === "reasoning" ? (
            <div className="grid grid-cols-[32px_minmax(0,1fr)_76px_64px] items-center gap-2 rounded-md border border-[#ffb400]/20 bg-[#ffb400]/[0.06] px-2 py-1.5 font-mono text-[11px]">
              <span aria-hidden="true">[A]</span>
              <span className="truncate text-[#ffd48a]">
                Hermes reasoning... {reasoningSeconds.toFixed(1)}s elapsed
              </span>
              <span className="text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[#ffb400]">
                live
              </span>
              <span className="text-right text-[10px] text-slate-500">...</span>
            </div>
          ) : null}

          {visiblePolicyItems.length === 0 &&
          visibleAgentTimeline.length === 0 &&
          operationalStatus !== "reasoning" ? (
            <div className="rounded-md bg-white/[0.02] px-2 py-2 text-[10px] text-slate-500">
              Waiting for Hermes activity.
            </div>
          ) : null}
        </div>
      </div>

      {result?.decision.actions.length ? (
        <div className="mt-3 rounded-2xl border border-white/8 bg-[#08111a] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Planned and executed calls
            </p>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              {plannedToolCount} planned / {executedToolCount} observed
            </p>
          </div>
          <div className="mt-3 grid gap-2">
            {result.decision.actions.map((action, index) => {
              const priorCount = executedActionCursor.get(action.tool) ?? 0;
              const matchingExecution = visibleAgentTimeline
                .filter((item) => item.toolName === action.tool)
                .at(priorCount) ?? null;
              executedActionCursor.set(action.tool, priorCount + 1);

              return (
                <div
                  key={`${action.tool}-${index}`}
                  className="border-b border-white/6 px-1 py-3 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-200">
                      {String(index + 1).padStart(2, "0")} / {humanizeIdentifier(action.tool)}
                    </span>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        matchingExecution ? "text-emerald-300" : "text-slate-500"
                      }`}
                    >
                      {matchingExecution ? "executed" : "planned"}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1 font-mono text-[10px] text-slate-400">
                    {Object.entries(action.arguments).map(([key, value]) => (
                      <div key={key} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                        <span className="text-slate-500">{key}</span>
                        <span className="truncate">{formatPlannedArgument(value)}</span>
                      </div>
                    ))}
                  </div>
                  {matchingExecution?.output ? (
                    <div className="mt-3 border-l border-emerald-400/20 pl-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-200">
                        Result / {formatFeedTime(matchingExecution.createdAt)}
                      </p>
                      <div className="mt-1 grid gap-1 font-mono text-[10px] text-emerald-100/80">
                        {Object.entries(matchingExecution.output)
                          .slice(0, 4)
                          .map(([key, value]) => (
                            <div
                              key={key}
                              className="grid grid-cols-[120px_minmax(0,1fr)] gap-2"
                            >
                              <span className="text-emerald-200/50">{key}</span>
                              <span className="truncate">{formatPlannedArgument(value)}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {!result && operationalPlannedTools.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-white/8 bg-[#08111a] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Current plan
            </p>
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              {operationalPlannedTools.length} planned
            </p>
          </div>
          <div className="mt-3 grid gap-2">
            {operationalPlannedTools.map((tool, index) => {
              const matchingExecution =
                visibleAgentTimeline.find((item) => item.toolName === tool.tool) ?? null;
              return (
                <div
                  key={`operational-${tool.tool}-${index}`}
                  className="border-b border-white/6 px-1 py-3 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-200">
                      {String(index + 1).padStart(2, "0")} / {humanizeIdentifier(tool.tool)}
                    </span>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        matchingExecution ? "text-sky-300" : "text-slate-500"
                      }`}
                    >
                      {matchingExecution ? "observed" : "planned"}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400">{tool.purpose}</p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {result ? (
        <>
          <div className="mt-3 rounded-2xl border border-white/8 bg-[#08111a] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                Recovery options compared
              </p>
              <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                attempt {result.attempts} / {result.latencyMs}ms
              </p>
            </div>
            <div className="mt-3 grid gap-2">
              {result.candidateStrategies.map((option) => {
                const selected =
                  option.optionId === result.decision.selectedStrategy;

                return (
                  <article
                    className={`decision-option ${selected ? "is-selected" : ""}`}
                    key={option.optionId}
                  >
                    <div>
                      <strong>{option.label}</strong>
                      <span>
                        {option.expectedLateDeliveries} late{" "}
                        {option.expectedLateDeliveries === 1
                          ? "delivery"
                          : "deliveries"}
                      </span>
                    </div>
                    <b>{formatMoney(option.expectedNetBenefit)}</b>
                    {selected ? <em>Selected</em> : null}
                  </article>
                );
              })}
            </div>
          </div>
          <div className="decision-footer">
            <span>
              Approved budget{" "}
              <strong>{formatMoney(result.decision.approvedBudget)}</strong>
            </span>
            <span>
              {runtimeLabel} | {providerLabel}
            </span>
          </div>
        </>
      ) : null}

      {operationalStatus === "reasoning" ? (
        <div className="mt-4 shrink-0 reasoning-state">
          <span className="reasoning-orbit" aria-hidden="true" />
          <div>
            <strong>
              {result
                ? "Reasoning with current incident data"
                : "Reasoning with current order and dispatch data"}
            </strong>
            <p>{reasoningSeconds.toFixed(1)}s elapsed</p>
          </div>
        </div>
      ) : null}

      {error ? <p className="panel-error">{error}</p> : null}
    </section>
  );
}
