"use client";

import { useState } from "react";

interface CreateDeliveryButtonProps {
  label?: string;
  loadingLabel?: string;
  redirectingLabel?: string;
  scenario?: "success" | "payment_declined";
  tone?: "primary" | "warning";
  orderId?: string;
  openInNewTab?: boolean;
  requestDraft?: CheckoutRequestDraft;
  requestDisabled?: boolean;
  onComplete?: (payload: {
    orderId?: string;
    incidentId?: string;
    created?: boolean;
    scenario?: "success" | "payment_declined";
  }) => void | Promise<void>;
}

export interface PickupHubOption {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface CheckoutRequestDraft {
  pickupHubId: string;
  customerName: string;
  destinationLat: string;
  destinationLng: string;
}

export function CreateDeliveryButton({
  label = "Create Paid Delivery",
  loadingLabel = "Opening checkout...",
  redirectingLabel = "Redirecting to Stripe Checkout...",
  scenario = "success",
  tone = "primary",
  orderId,
  openInNewTab = false,
  onComplete,
  requestDraft,
  requestDisabled = false,
}: CreateDeliveryButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresExplicitRequest = !orderId;

  async function handleClick() {
    setLoading(true);
    setError(null);
    const popup = openInNewTab ? window.open("", "_blank") : null;

    try {
      const body: {
        scenario: "success" | "payment_declined";
        orderId?: string;
        request?: {
          pickupHubId: string;
          customerName: string;
          destinationLat: number;
          destinationLng: number;
        };
      } = {
        scenario,
        orderId,
      };

      if (requiresExplicitRequest) {
        if (!requestDraft) {
          throw new Error("Delivery request form is not ready yet.");
        }
        if (!requestDraft.pickupHubId) {
          throw new Error("Select a pickup hub before creating the delivery.");
        }

        const destinationLat = Number.parseFloat(requestDraft.destinationLat);
        const destinationLng = Number.parseFloat(requestDraft.destinationLng);
        if (!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)) {
          throw new Error("Destination latitude and longitude must be valid numbers.");
        }

        body.request = {
          pickupHubId: requestDraft.pickupHubId,
          customerName: requestDraft.customerName.trim() || "Customer Request",
          destinationLat,
          destinationLng,
        };
      }

      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: string;
        sessionUrl?: string;
        orderId?: string;
        incidentId?: string;
        created?: boolean;
        scenario?: "success" | "payment_declined";
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Checkout session was not created.");
      }

      if (!payload.sessionUrl) {
        await onComplete?.({
          orderId: payload.orderId,
          incidentId: payload.incidentId,
          created: payload.created,
          scenario: payload.scenario,
        });
        setLoading(false);
        return;
      }

      if (popup && !popup.closed) {
        popup.location.href = payload.sessionUrl;
        popup.focus();
        setLoading(false);
        return;
      }

      window.location.href = payload.sessionUrl;
    } catch (checkoutError: unknown) {
      if (popup && !popup.closed) {
        popup.close();
      }
      const message =
        checkoutError instanceof Error
          ? checkoutError.message
          : "Failed to create delivery checkout.";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={loading || requestDisabled}
        aria-busy={loading}
        className={`control-button relative flex w-full items-center justify-center gap-2 overflow-hidden font-semibold ${
          tone === "warning"
            ? "control-button-warning"
            : "control-button-primary"
        }`}
      >
        {loading ? (
          <>
            <svg className="h-3.5 w-3.5 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>{loadingLabel}</span>
          </>
        ) : (
          <>
            <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
            </svg>
            <span>{label}</span>
          </>
        )}
      </button>
      {loading ? (
        <p className="rounded border border-emerald-500/10 bg-emerald-500/5 p-2 text-center font-mono text-[11px] text-emerald-200/75">
          {redirectingLabel}
        </p>
      ) : null}
      {error ? (
        <p className="rounded border border-red-500/10 bg-red-500/5 p-2 text-center font-mono text-[11px] text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
