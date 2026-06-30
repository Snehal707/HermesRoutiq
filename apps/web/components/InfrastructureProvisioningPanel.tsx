"use client";

import { useState } from "react";

interface ProvisioningResult {
  created: boolean;
  triggered: boolean;
  ledgerRowId: string | null;
  stripeReference: string | null;
  triggerMetric: {
    source: string;
    observedCount: number;
    threshold: number;
  };
  policy: {
    allowed: boolean;
    reason: string;
  };
}

export function InfrastructureProvisioningPanel() {
  const [status, setStatus] = useState<
    "idle" | "provisioning" | "complete" | "error"
  >("idle");
  const [result, setResult] = useState<ProvisioningResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function provision() {
    setStatus("provisioning");
    setError(null);

    try {
      const response = await fetch("/api/dashboard/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          infraType: "queue",
          triggerReason:
            "Rising simulation event volume requires queue capacity",
        }),
      });
      const payload = (await response.json()) as ProvisioningResult & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error ?? "Infrastructure provisioning failed",
        );
      }
      setResult(payload);
      setStatus("complete");
    } catch (provisionError: unknown) {
      setError(
        provisionError instanceof Error
          ? provisionError.message
          : "Infrastructure provisioning failed",
      );
      setStatus("error");
    }
  }

  return (
    <section className="infrastructure-panel">
      <div className="panel-heading-row">
        <h2 className="eyebrow-label">Infrastructure Capacity</h2>
        <span>Stripe Projects</span>
      </div>
      <p>
        Evaluate live event volume and confirm the provisioned Inngest queue
        project through the Operations policy gate.
      </p>
      <button
        type="button"
        className="control-button infrastructure-button"
        disabled={status === "provisioning"}
        aria-busy={status === "provisioning"}
        onClick={() => void provision()}
      >
        {status === "provisioning" ? (
          <>
            <svg
              className="h-3.5 w-3.5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>Provisioning...</span>
          </>
        ) : (
          "Provision queue capacity"
        )}
      </button>

      {status === "provisioning" ? (
        <p className="mt-2 text-[11px] text-sky-200/75">
          Checking trigger volume, policy approval, and project status...
        </p>
      ) : null}

      {result ? (
        <div className="infrastructure-result">
          <strong>Provisioned · policy approved</strong>
          <span>
            {result.triggerMetric.observedCount} events observed · threshold{" "}
            {result.triggerMetric.threshold}
          </span>
          <code>{result.stripeReference}</code>
          <code>ledger {result.ledgerRowId}</code>
        </div>
      ) : null}
      {error ? <p className="panel-error">{error}</p> : null}
    </section>
  );
}
