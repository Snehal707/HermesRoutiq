import type { DashboardHeadlineMetrics } from "@/lib/dashboard/types";

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

interface HeadlineHudProps {
  metrics: DashboardHeadlineMetrics | null;
  error: string | null;
  hideWallet?: boolean;
  className?: string;
  compact?: boolean;
}

export function HeadlineHud({
  metrics,
  error,
  hideWallet = false,
  className,
  compact = false,
}: HeadlineHudProps) {
  const items = [
    {
      label: "Stripe Ledger Net",
      value: metrics ? formatMoney(metrics.walletBalanceCents) : "--",
      key: "wallet",
    },
    {
      label: "Active Fleet Deliveries",
      value: metrics ? String(metrics.activeDeliveries) : "--",
      key: "deliveries",
    },
    {
      label: "Active Incidents",
      value: metrics ? String(metrics.activeIncidents) : "--",
      alert: (metrics?.activeIncidents ?? 0) > 0,
      key: "incidents",
    },
    {
      label: "Estimated Net Margin",
      value: metrics ? formatMoney(metrics.expectedProfitCents) : "--",
      key: "profit",
    },
  ].filter((item) => !(hideWallet && item.key === "wallet"));

  return (
    <section
      className={`headline-hud ${compact ? "headline-hud--compact" : "max-w-[860px]"} ${className ?? ""}`}
      aria-label="Business overview"
    >
      {items.map((item) => (
        <div className="headline-hud-item" key={item.label}>
          <span>{item.label}</span>
          <strong className={item.alert ? "is-alert" : undefined}>
            {item.value}
          </strong>
        </div>
      ))}
      {error ? <p className="headline-hud-error">{error}</p> : null}
    </section>
  );
}
