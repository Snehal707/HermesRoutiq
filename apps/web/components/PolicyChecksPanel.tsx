import type { DashboardPolicyEvaluation } from "@/lib/dashboard/types";
import type { DashboardActiveIncident } from "@/lib/dashboard/types";

function formatAction(actionType: string): string {
  return actionType
    .replace("role_tool_authorization:", "")
    .replaceAll("_", " ");
}

function getLayer(actionType: string): string {
  return actionType.startsWith("role_tool_authorization:")
    ? "App role gate"
    : "Spend policy";
}

interface PolicyChecksPanelProps {
  evaluations: DashboardPolicyEvaluation[];
  activeIncident: DashboardActiveIncident | null;
}

export function PolicyChecksPanel({
  evaluations,
  activeIncident,
}: PolicyChecksPanelProps) {
  const activeIncidentId = activeIncident?.id ?? null;
  const visibleEvaluations = evaluations
    .filter(
      (evaluation) =>
        !activeIncidentId || evaluation.incidentId === activeIncidentId,
    )
    .slice(0, 12);

  if (!activeIncidentId && visibleEvaluations.length === 0) {
    return null;
  }

  return (
    <section className="policy-panel">
      <div className="panel-heading-row">
        <h2 className="eyebrow-label">Policy Log</h2>
      </div>
      {activeIncident?.orders.length ? (
        <div className="mb-3 rounded-xl border border-white/8 bg-white/[0.03] p-3 text-xs text-slate-300">
          <p className="font-semibold uppercase tracking-[0.14em] text-slate-200">
            Incident Requests
          </p>
          <div className="mt-2 grid gap-2">
            {activeIncident.orders.map((order) => (
              <div key={order.id}>
                <strong>{order.customerLabel ?? order.id}</strong>
                <p className="text-slate-400">
                  {order.pickupHubLabel ?? "Unknown hub"}
                  {order.destinationLabel ? ` -> ${order.destinationLabel}` : ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ol className="policy-timeline">
        {visibleEvaluations.length > 0 ? (
          visibleEvaluations.map((evaluation) => (
            <li key={evaluation.id}>
              <span
                className={`policy-result ${evaluation.allowed ? "is-allowed" : "is-denied"}`}
                aria-label={evaluation.allowed ? "Allowed" : "Denied"}
              />
              <div>
                <strong>{formatAction(evaluation.actionType)}</strong>
                <span>{getLayer(evaluation.actionType)}</span>
                <p>{evaluation.reason}</p>
              </div>
              <time dateTime={evaluation.createdAt}>
                {new Date(evaluation.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
            </li>
          ))
        ) : (
          <li className="policy-empty">Waiting for Hermes policy checks...</li>
        )}
      </ol>
    </section>
  );
}
