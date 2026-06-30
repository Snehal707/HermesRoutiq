import type { DashboardStripeTransaction } from "@/lib/dashboard/types";

function formatMoney(transaction: DashboardStripeTransaction): string {
  const sign = transaction.direction === "incoming" ? "+" : "-";
  return `${sign}$${(transaction.amountCents / 100).toFixed(0)}`;
}

interface StripeTransactionPanelProps {
  transactions: DashboardStripeTransaction[];
}

export function StripeTransactionPanel({
  transactions,
}: StripeTransactionPanelProps) {
  return (
    <section className="stripe-panel">
      <div className="panel-heading-row">
        <h2 className="eyebrow-label">Payments</h2>
        <span className="stripe-mode">Test Mode</span>
      </div>

      <div className="stripe-transactions">
        {transactions.length > 0 ? (
          transactions.map((transaction) => (
            <article key={transaction.id}>
              <span
                className={`stripe-direction is-${transaction.direction}`}
                aria-hidden="true"
              >
                {transaction.direction === "incoming" ? "IN" : "OUT"}
              </span>
              <div>
                <strong>{transaction.label}</strong>
                {transaction.customerLabel || transaction.destinationLabel ? (
                  <p className="text-[11px] text-slate-400">
                    {transaction.customerLabel ?? "Unknown request"}
                    {transaction.pickupHubLabel
                      ? ` from ${transaction.pickupHubLabel}`
                      : ""}
                    {transaction.destinationLabel
                      ? ` -> ${transaction.destinationLabel}`
                      : ""}
                  </p>
                ) : null}
                <code title={transaction.stripeReference}>
                  {transaction.stripeReference}
                </code>
              </div>
              <b>{formatMoney(transaction)}</b>
            </article>
          ))
        ) : (
          <p className="stripe-empty">
            Waiting for checkout and payout records...
          </p>
        )}
      </div>
    </section>
  );
}
