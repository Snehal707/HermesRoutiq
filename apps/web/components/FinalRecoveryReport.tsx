import type { DashboardRecoveryReport } from "@/lib/dashboard/types";

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(cents / 100))}`;
}

type Accent = "positive" | "cost" | "warn" | "bad" | "neutral";

const ACCENT_VALUE_CLASS: Record<Accent, string> = {
  positive: "text-emerald-300",
  cost: "text-amber-300",
  warn: "text-amber-300",
  bad: "text-rose-300",
  neutral: "text-slate-100",
};

interface StatCardProps {
  label: string;
  value: string | number;
  accent?: Accent;
}

function StatCard({ label, value, accent = "neutral" }: StatCardProps) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
      <dt className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-slate-400">
        {label}
      </dt>
      <dd
        className={`mt-1 font-mono text-base font-semibold tabular-nums ${ACCENT_VALUE_CLASS[accent]}`}
      >
        {value}
      </dd>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
      {children}
    </p>
  );
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

  const netBenefitCents = report.netFinancialBenefitCents;
  const netPositive = netBenefitCents >= 0;

  const financialMetrics: StatCardProps[] = [
    {
      label: "Customer revenue protected",
      value: money(report.customerRevenueProtectedCents),
      accent: "positive",
    },
    {
      label: "Emergency spending",
      value: money(report.emergencySpendingCents),
      accent: "cost",
    },
    {
      label: "Estimated refunds avoided",
      value: money(report.refundsAvoidedCents),
      accent: "positive",
    },
    {
      label: "Estimated churn loss avoided",
      value: money(report.churnLossAvoidedCents),
      accent: "positive",
    },
  ];

  const operationsMetrics: StatCardProps[] = [
    {
      label: "Human intervention",
      value: report.humanInterventionCount,
      accent: report.humanInterventionCount > 0 ? "warn" : "neutral",
    },
    {
      label: "Policy violations",
      value: report.policyViolationCount,
      accent: report.policyViolationCount > 0 ? "bad" : "neutral",
    },
  ];

  return (
    <section className="recovery-report">
      <div className="recovery-report-header">
        <div>
          <h2>{deliveryCompleted ? "Recovery complete" : "Recovery in progress"}</h2>
          <p>Incident {report.incidentId.slice(0, 8)}</p>
        </div>
        <span>{deliveryCompleted ? "Delivered" : "Route recovered"}</span>
      </div>

      {/* Hero summary strip */}
      <div className="grid grid-cols-3 divide-x divide-white/[0.06] border-b border-white/[0.06]">
        <div className="px-4 py-3.5">
          <p className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-slate-400">
            Deliveries recovered
          </p>
          <p className="mt-1 font-mono text-2xl font-bold leading-none tabular-nums text-emerald-300">
            {report.recoveredDeliveries}
            <span className="text-base font-semibold text-slate-500">
              /{report.affectedDeliveries}
            </span>
          </p>
        </div>
        <div className="px-4 py-3.5">
          <p className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-slate-400">
            Net financial benefit
          </p>
          <p
            className={`mt-1 font-mono text-2xl font-bold leading-none tabular-nums ${
              netPositive ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {money(netBenefitCents)}
          </p>
        </div>
        <div className="px-4 py-3.5">
          <p className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-slate-400">
            Recovery time
          </p>
          <p className="mt-1 font-mono text-2xl font-bold leading-none tabular-nums text-slate-100">
            {report.recoverySeconds}
            <span className="text-base font-semibold text-slate-500">s</span>
          </p>
        </div>
      </div>

      <div className="px-4 pt-3.5">
        <p className="text-xs leading-relaxed text-slate-400">
          {deliveryCompleted
            ? "Recorded recovery events and ledger entries are shown directly. Customer retention and refund-avoidance values are estimated when the backend did not persist explicit figures for this incident."
            : "Hermes has already executed the recovery plan, but the affected delivery is still live on the map. Revenue protection and refund-avoidance values are scenario estimates until the drop-off is complete."}
        </p>
      </div>

      {report.affectedOrders.length > 0 ? (
        <div className="px-4 pt-4">
          <SectionLabel>Affected requests</SectionLabel>
          <div className="grid gap-2">
            {report.affectedOrders.map((order) => (
              <div
                key={order.id}
                className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"
              >
                <p className="text-sm font-semibold text-slate-100">
                  {order.customerLabel ?? order.id}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                  <span>{order.pickupHubLabel ?? "Unknown hub"}</span>
                  {order.destinationLabel ? (
                    <>
                      <span className="text-slate-600">→</span>
                      <span>{order.destinationLabel}</span>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="px-4 pt-4">
        <SectionLabel>Financial impact</SectionLabel>
        <dl className="grid grid-cols-2 gap-2">
          {financialMetrics.map((metric) => (
            <StatCard key={metric.label} {...metric} />
          ))}
        </dl>
      </div>

      <div className="px-4 pt-4">
        <SectionLabel>Operations</SectionLabel>
        <dl className="grid grid-cols-2 gap-2">
          {operationsMetrics.map((metric) => (
            <StatCard key={metric.label} {...metric} />
          ))}
        </dl>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          {report.reusedSkill?.reused
            ? "Recovery skill reused"
            : "New Hermes skill created"}
        </span>
        <code className="rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 font-mono text-[11px] text-emerald-200">
          {report.reusedSkill?.reused
            ? `${report.reusedSkill.skillName}${
                report.reusedSkill.learnedFromIncidentId
                  ? ` (learned from ${report.reusedSkill.learnedFromIncidentId.slice(0, 8)})`
                  : ""
              }`
            : report.skillName ?? "Pending audit record"}
        </code>
      </div>
    </section>
  );
}
