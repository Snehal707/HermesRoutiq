import type { DashboardRecoveryReport } from "@/lib/dashboard/types";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

interface FinalRecoveryReportProps {
  report: DashboardRecoveryReport | null;
}

export function FinalRecoveryReport({ report }: FinalRecoveryReportProps) {
  if (!report) {
    return null;
  }

  const deliveryCompleted =
    report.affectedDeliveries > 0 &&
    report.recoveredDeliveries >= report.affectedDeliveries;

  const metrics = [
    ["Affected deliveries", report.affectedDeliveries],
    ["Delivered after recovery", report.recoveredDeliveries],
    ["Customer revenue protected", money(report.customerRevenueProtectedCents)],
    ["Emergency spending", money(report.emergencySpendingCents)],
    ["Estimated refunds avoided", money(report.refundsAvoidedCents)],
    ["Estimated churn loss avoided", money(report.churnLossAvoidedCents)],
    ["Estimated net financial benefit", money(report.netFinancialBenefitCents)],
    ["Human intervention", report.humanInterventionCount],
    ["Policy violations", report.policyViolationCount],
    ["Recovery time", `${report.recoverySeconds}s`],
  ] as const;

  return (
    <section className="recovery-report">
      <div className="recovery-report-header">
        <div>
          <h2>{deliveryCompleted ? "Recovery complete" : "Recovery in progress"}</h2>
          <p>Incident {report.incidentId.slice(0, 8)}</p>
        </div>
        <span>{deliveryCompleted ? "Delivered" : "Route recovered"}</span>
      </div>

      <p className="mt-3 text-sm text-slate-400">
        {deliveryCompleted
          ? "Recorded recovery events and ledger entries are shown directly. Customer retention and refund-avoidance values are estimated when the backend did not persist explicit figures for this incident."
          : "Hermes has already executed the recovery plan, but the affected delivery is still live on the map. Revenue protection and refund-avoidance values are scenario estimates until the drop-off is complete."}
      </p>

      {report.affectedOrders.length > 0 ? (
        <div className="mt-3 px-1 text-xs text-slate-300">
          <p className="font-semibold uppercase tracking-[0.14em] text-slate-200">
            Affected Requests
          </p>
          <div className="mt-2 grid gap-2">
            {report.affectedOrders.map((order) => (
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

      <dl>
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="recovery-skill">
        <span>
          {report.reusedSkill?.reused
            ? "Recovery skill reused"
            : "New Hermes skill created"}
        </span>
        <code className="rounded-none border-0 bg-transparent px-0 py-0">
          {report.reusedSkill?.reused
            ? `${report.reusedSkill.skillName}${
                report.reusedSkill.learnedFromIncidentId
                  ? ` (learned from incident ${report.reusedSkill.learnedFromIncidentId.slice(0, 8)})`
                  : ""
              }`
            : report.skillName ?? "Pending audit record"}
        </code>
      </div>
    </section>
  );
}
