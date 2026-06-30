"use client";

import { useSearchParams } from "next/navigation";
import { CityMap } from "@/components/CityMap";
import {
  CreateDeliveryButton,
  type CheckoutRequestDraft,
  type PickupHubOption,
} from "@/components/CreateDeliveryButton";
import { FinalRecoveryReport } from "@/components/FinalRecoveryReport";
import { HeadlineHud } from "@/components/HeadlineHud";
import { NemotronDecisionPanel } from "@/components/NemotronDecisionPanel";
import { SimControls } from "@/components/SimControls";
import { StripeTransactionPanel } from "@/components/StripeTransactionPanel";
import type { ReasoningResponse } from "@/lib/dashboard/decision";
import type { DashboardCurrentRequest } from "@/lib/dashboard/types";
import { useDashboardSnapshot } from "@/lib/dashboard/useDashboardSnapshot";
import { usePersistedSimClock } from "@/lib/sim/usePersistedSimClock";
import {
  isSimulatorOverlayEnabled,
  useSimulatorSnapshot,
} from "@/lib/sim/useSimulatorSnapshot";
import { useAnimatedSimulatorTime } from "@/lib/sim/useAnimatedSimulatorTime";
import { useSimulatorScheduledEvents } from "@/lib/sim/useSimulatorScheduledEvents";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type DashboardTab =
  | "operations"
  | "payments"
  | "recovery-report";

interface CheckoutReturnState {
  kind: "success" | "cancelled";
  scenario: "success" | "payment_declined" | null;
  orderId: string | null;
  paymentStatus: string | null;
  sessionStatus: string | null;
  detail: string;
}

const REASONING_RETRY_LIMIT = 2;
const REASONING_RETRY_DELAY_MS = 2_000;
const POST_CHECKOUT_BURST_MS = 10_000;
const POST_INCIDENT_BURST_MS = 12_000;
const DEFAULT_CHECKOUT_REQUEST_DRAFT: CheckoutRequestDraft = {
  pickupHubId: "",
  customerName: "Market Street Drop",
  destinationLat: "37.7862",
  destinationLng: "-122.4008",
};

function formatIncidentTypeLabel(
  incidentType: string | null | undefined,
): string {
  switch (incidentType) {
    case "payment_declined":
      return "Payment Declined";
    case "congestion":
      return "Traffic Congestion";
    case "vehicle_breakdown":
      return "Vehicle Breakdown";
    default:
      return "Incident";
  }
}

function requestFunnelBadgeClasses(
  status: "pending" | "declined" | "paid" | "recovered",
): string {
  switch (status) {
    case "declined":
      return "border-amber-400/20 bg-amber-500/10 text-amber-200";
    case "paid":
      return "border-sky-400/20 bg-sky-500/10 text-sky-200";
    case "recovered":
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200";
    default:
      return "border-white/10 bg-white/[0.06] text-slate-200";
  }
}

function dispatchStatusBadgeClasses(
  status: "idle" | "reasoning" | "released" | "held" | "failed",
): string {
  switch (status) {
    case "reasoning":
      return "border-amber-400/20 bg-amber-500/10 text-amber-200";
    case "released":
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200";
    case "held":
      return "border-sky-400/20 bg-sky-500/10 text-sky-200";
    case "failed":
      return "border-rose-400/20 bg-rose-500/10 text-rose-200";
    default:
      return "border-white/10 bg-white/[0.06] text-slate-200";
  }
}

function formatQuotedPrice(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "n/a";
}

function describeCurrentRequest(
  request: DashboardCurrentRequest,
): { label: string; detail: string } {
  if (request.status === "delivered") {
    return {
      label: "Delivery completed",
      detail:
        request.dispatchDecisionSummary ??
        request.decisionSummary ??
        "Hermes released the route, completed the run, and closed the order.",
    };
  }

  if (request.dispatchStatus === "released") {
    return {
      label: "Dispatch live",
      detail:
        request.dispatchDecisionSummary ??
        (request.dispatchAssignedVehicleId
          ? `Vehicle ${request.dispatchAssignedVehicleId} is assigned and the live route is syncing onto the map.`
          : "Hermes has released the route and is syncing the live vehicle state."),
    };
  }

  if (request.dispatchStatus === "reasoning") {
    return {
      label: "Dispatch reasoning",
      detail:
        request.dispatchDecisionSummary ??
        "Hermes is validating capacity, routing, and policy before releasing the driver.",
    };
  }

  if (request.funnelStatus === "declined") {
    return {
      label: "Payment recovery",
      detail:
        request.decisionSummary ??
        "Payment failed, so Hermes kept the order off the fleet and shifted it into recovery.",
    };
  }

  return {
    label: "Intake review",
    detail:
      request.decisionSummary ??
      "Hermes is reviewing the request, quoting it, and preparing the next allowed move.",
  };
}

async function requestReasoningDecision(
  incidentId: string,
): Promise<ReasoningResponse> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < REASONING_RETRY_LIMIT) {
    attempt += 1;
    try {
      const response = await fetch("/api/dashboard/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId }),
      });
      const payload = (await response.json()) as ReasoningResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Reasoning request failed");
      }
      return payload;
    } catch (error: unknown) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Reasoning request failed");
      if (attempt >= REASONING_RETRY_LIMIT) {
        break;
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, REASONING_RETRY_DELAY_MS),
      );
    }
  }

  throw lastError ?? new Error("Reasoning request failed");
}

export default function SimDashboard() {
  const searchParams = useSearchParams();
  const simulatorOverlayEnabled = isSimulatorOverlayEnabled();
  const {
    world,
    tick,
    loading,
    error,
    planningMessage,
    refresh: refreshSimulationState,
    burstRefresh: burstSimulationRefresh,
    start,
    reset,
    simulateBreakdown,
    simulateCongestion,
    breakdownTriggered,
  } = usePersistedSimClock();

  const [reasoningStatus, setReasoningStatus] = useState<
    "idle" | "reasoning" | "complete" | "error"
  >("idle");
  const [selectedTab, setSelectedTab] = useState<DashboardTab>("operations");
  const [reasoningResult, setReasoningResult] =
    useState<ReasoningResponse | null>(null);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const [reasoningSeconds, setReasoningSeconds] = useState(0);
  const [mapHeightVh, setMapHeightVh] = useState(58);
  const [selectedIncidentVehicleId, setSelectedIncidentVehicleId] = useState<string | null>(null);
  const [checkoutReturn, setCheckoutReturn] = useState<CheckoutReturnState | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<
    "idle" | "executing" | "complete" | "error"
  >("idle");
  const [pickupHubOptions, setPickupHubOptions] = useState<PickupHubOption[]>([]);
  const [checkoutOptionsLoading, setCheckoutOptionsLoading] = useState(false);
  const [checkoutRequestDraft, setCheckoutRequestDraft] = useState<CheckoutRequestDraft>(
    DEFAULT_CHECKOUT_REQUEST_DRAFT,
  );
  const autoStartOrderRef = useRef<string | null>(null);
  const dispatchReasoningStartedAtRef = useRef<number | null>(null);
  const reasoningIncidentRef = useRef<string | null>(null);
  const recoveryIncidentRef = useRef<string | null>(null);
  const suppressAutoTabUntilRef = useRef(0);
  const incidentWorkflowEpochRef = useRef(0);
  const {
    snapshot: dashboardSnapshot,
    error: dashboardSnapshotError,
    refresh: refreshDashboardSnapshot,
    burstRefresh: burstDashboardRefresh,
    clear: clearDashboardSnapshot,
  } = useDashboardSnapshot();
  const {
    snapshot: simulatorSnapshot,
    error: simulatorSnapshotError,
    refresh: refreshSimulatorSnapshot,
  } = useSimulatorSnapshot(simulatorOverlayEnabled);
  const animatedSimulatorTimeSeconds = useAnimatedSimulatorTime(
    simulatorSnapshot,
    simulatorOverlayEnabled,
  );
  const planningInProgress = Boolean(planningMessage);
  const {
    appliedEventIds: appliedSimulatorEventIds,
    blockedEvents: blockedSimulatorEvents,
    lastError: simulatorEventError,
  } = useSimulatorScheduledEvents({
    enabled: simulatorOverlayEnabled,
    planningInProgress,
    snapshot: simulatorSnapshot,
    world,
    simElapsedSeconds: tick.elapsedSeconds,
  });
  const mapElapsedSeconds = tick.elapsedSeconds;
  const ambientElapsedSeconds =
    animatedSimulatorTimeSeconds ??
    simulatorSnapshot?.sim_time_seconds ??
    0;
  const worldLatestIncident = world?.incidents.at(-1) ?? null;
  const activeIncident = dashboardSnapshot?.activeIncident ?? null;
  const pendingWorldIncidentId =
    !activeIncident &&
    worldLatestIncident &&
    Math.abs(tick.elapsedSeconds - worldLatestIncident.createdAtSimSeconds) <= 15
      ? worldLatestIncident.id
      : null;

  const clearIncidentUiState = useCallback(() => {
    incidentWorkflowEpochRef.current += 1;
    dispatchReasoningStartedAtRef.current = null;
    reasoningIncidentRef.current = null;
    recoveryIncidentRef.current = null;
    setReasoningStatus("idle");
    setReasoningResult(null);
    setReasoningError(null);
    setReasoningSeconds(0);
    setRecoveryStatus("idle");
  }, []);

  const triggerFastUiRefresh = useCallback(
    (durationMs: number) => {
      void refreshDashboardSnapshot();
      burstDashboardRefresh({ durationMs });
      window.setTimeout(() => void refreshDashboardSnapshot(), 500);
      window.setTimeout(() => void refreshDashboardSnapshot(), 1_250);
      window.setTimeout(() => void refreshDashboardSnapshot(), 2_500);

      void refreshSimulationState();
      burstSimulationRefresh({ durationMs });
      window.setTimeout(() => void refreshSimulationState(), 500);
      window.setTimeout(() => void refreshSimulationState(), 1_250);
      window.setTimeout(() => void refreshSimulationState(), 2_500);

      void refreshSimulatorSnapshot();
      window.setTimeout(() => void refreshSimulatorSnapshot(), 500);
      window.setTimeout(() => void refreshSimulatorSnapshot(), 1_250);
      window.setTimeout(() => void refreshSimulatorSnapshot(), 2_500);
    },
    [
      burstDashboardRefresh,
      burstSimulationRefresh,
      refreshDashboardSnapshot,
      refreshSimulationState,
      refreshSimulatorSnapshot,
    ],
  );

  const handleReset = useCallback(async () => {
    suppressAutoTabUntilRef.current = Date.now() + 5_000;
    autoStartOrderRef.current = null;
    setCheckoutReturn(null);
    setCheckoutRequestDraft(DEFAULT_CHECKOUT_REQUEST_DRAFT);
    setSelectedTab("operations");
    clearIncidentUiState();
    clearDashboardSnapshot();
    await reset();
    await refreshSimulationState();
    await refreshDashboardSnapshot();
    refreshSimulatorSnapshot();
    triggerFastUiRefresh(4_000);
  }, [
    clearDashboardSnapshot,
    clearIncidentUiState,
    refreshDashboardSnapshot,
    refreshSimulationState,
    refreshSimulatorSnapshot,
    reset,
    triggerFastUiRefresh,
  ]);

  const activeIncidentId = activeIncident?.id ?? pendingWorldIncidentId;
  const latestIncidentType = activeIncident?.type ?? worldLatestIncident?.type ?? null;
  const latestIncidentLabel = formatIncidentTypeLabel(latestIncidentType);
  const latestIncidentOrderId =
    activeIncident?.orderIds[0] ??
    worldLatestIncident?.orderIds[0] ??
    null;
  const latestPaymentIncidentOrderId =
    latestIncidentType === "payment_declined" ? latestIncidentOrderId : null;
  const liveDeliveryVehicles = useMemo(
    () => {
      const orders = world?.orders ?? [];
      return (world?.vehicles ?? []).filter((vehicle) =>
        orders.some(
          (order) =>
            order.vehicleId === vehicle.id &&
            (order.status === "assigned" || order.status === "in_transit"),
        ),
      );
    },
    [world],
  );
  const liveActiveDeliveryCount = useMemo(
    () =>
      (world?.orders ?? []).filter(
        (order) => order.status === "assigned" || order.status === "in_transit",
      ).length,
    [world],
  );
  const incidentVehicleOptions = useMemo(
    () => {
      const orders = world?.orders ?? [];
      return liveDeliveryVehicles.map((vehicle) => {
        const orderCount = orders.filter(
          (order) =>
            order.vehicleId === vehicle.id &&
            (order.status === "assigned" || order.status === "in_transit"),
        ).length;
        return {
          id: vehicle.id,
          label: `${vehicle.id} / ${orderCount} live ${orderCount === 1 ? "delivery" : "deliveries"}`,
        };
      });
    },
    [liveDeliveryVehicles, world],
  );
  const selectedIncidentVehicle =
    liveDeliveryVehicles.find((vehicle) => vehicle.id === selectedIncidentVehicleId) ??
    null;
  const canSimulateBreakdown = Boolean(
    !planningInProgress &&
    selectedIncidentVehicle,
  );
  const canSimulateCongestion = Boolean(
    !planningInProgress && selectedIncidentVehicle,
  );
  const dispatchReadyForIncidents = Boolean(
    !planningInProgress && (canSimulateBreakdown || canSimulateCongestion),
  );
  const policyTimelineItems = dashboardSnapshot?.policyEvaluations ?? [];
  const stripeTransactions = dashboardSnapshot?.stripeTransactions ?? [];
  const currentRequest = dashboardSnapshot?.currentRequest ?? null;
  const requestHistory = dashboardSnapshot?.requestHistory ?? [];
  const recoveryReport = dashboardSnapshot?.finalRecoveryReport ?? null;
  const headlineMetrics = useMemo(() => {
    if (!dashboardSnapshot?.headline) {
      return null;
    }

    return {
      ...dashboardSnapshot.headline,
      activeDeliveries: Math.max(
        dashboardSnapshot.headline.activeDeliveries,
        liveActiveDeliveryCount,
      ),
      activeIncidents: Math.max(
        dashboardSnapshot.headline.activeIncidents,
        activeIncidentId ? 1 : 0,
      ),
    };
  }, [activeIncidentId, dashboardSnapshot?.headline, liveActiveDeliveryCount]);
  const hasRecoveredDashboardState = Boolean(
    headlineMetrics && (currentRequest || liveActiveDeliveryCount > 0),
  );
  const showDashboardSnapshotError = hasRecoveredDashboardState
    ? null
    : dashboardSnapshotError;
  const hasCheckoutPayments = stripeTransactions.some(
    (transaction) => transaction.kind === "checkout_payment",
  );
  const liveRouteCount = (world?.vehicles ?? []).filter(
    (vehicle) =>
      vehicle.route.length > 1 &&
      ((world?.orders ?? []).some(
        (order) =>
          order.vehicleId === vehicle.id &&
          (order.status === "assigned" || order.status === "in_transit"),
      ) ||
        vehicle.status === "en_route" ||
        vehicle.routeStatus === "incident" ||
        vehicle.routeStatus === "recovery" ||
        vehicle.routeStatus === "at_risk"),
  ).length;
  const awaitingVisibleRoute = Boolean(
    currentRequest?.dispatchStatus === "released" &&
      currentRequest.dispatchAssignedVehicleId &&
      liveRouteCount === 0,
  );
  const showSimulationSyncWarning = Boolean(
    error &&
      !planningMessage &&
      !awaitingVisibleRoute &&
      liveDeliveryVehicles.length === 0,
  );
  const currentRequestSummary = currentRequest
    ? describeCurrentRequest(currentRequest)
    : null;
  const dispatchReasoningActive =
    reasoningStatus === "idle" && currentRequest?.dispatchStatus === "reasoning";
  const latestRecoveryIncidentId = recoveryReport?.incidentId ?? null;
  const mapSizeLabel = useMemo(() => {
    if (mapHeightVh <= 50) {
      return "Compact";
    }
    if (mapHeightVh >= 66) {
      return "Expanded";
    }
    return "Balanced";
  }, [mapHeightVh]);
  const tabs = [
    { id: "operations", label: "Operations" },
    { id: "payments", label: "Payments" },
    { id: "recovery-report", label: "Recovery Report" },
  ] as const satisfies ReadonlyArray<{ id: DashboardTab; label: string }>;

  useEffect(() => {
    if (incidentVehicleOptions.length === 0) {
      setSelectedIncidentVehicleId(null);
      return;
    }

    if (
      selectedIncidentVehicleId &&
      incidentVehicleOptions.some((vehicle) => vehicle.id === selectedIncidentVehicleId)
    ) {
      return;
    }

    setSelectedIncidentVehicleId(incidentVehicleOptions[0]?.id ?? null);
  }, [incidentVehicleOptions, selectedIncidentVehicleId]);

  useEffect(() => {
    let cancelled = false;

    async function loadCheckoutOptions() {
      setCheckoutOptionsLoading(true);

      try {
        const response = await fetch("/api/checkout/options", {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          error?: string;
          pickupHubs?: PickupHubOption[];
          suggestedDestination?: {
            customerName?: string;
            destinationLat?: number;
            destinationLng?: number;
          };
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load checkout options.");
        }

        if (cancelled) {
          return;
        }

        const hubs = payload.pickupHubs ?? [];
        setPickupHubOptions(hubs);
        setCheckoutRequestDraft((current) => ({
          pickupHubId: current.pickupHubId || hubs[0]?.id || "",
          customerName:
            current.customerName || payload.suggestedDestination?.customerName || "Customer Request",
          destinationLat:
            current.destinationLat ||
            (typeof payload.suggestedDestination?.destinationLat === "number"
              ? String(payload.suggestedDestination.destinationLat)
              : ""),
          destinationLng:
            current.destinationLng ||
            (typeof payload.suggestedDestination?.destinationLng === "number"
              ? String(payload.suggestedDestination.destinationLng)
              : ""),
        }));
      } catch (optionsError: unknown) {
        if (!cancelled) {
          setReasoningError(
            optionsError instanceof Error
              ? optionsError.message
              : "Failed to load checkout options.",
          );
        }
      } finally {
        if (!cancelled) {
          setCheckoutOptionsLoading(false);
        }
      }
    }

    void loadCheckoutOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (Date.now() < suppressAutoTabUntilRef.current) {
      return;
    }

    if (recoveryStatus === "complete" && latestRecoveryIncidentId) {
      setSelectedTab("recovery-report");
    }
  }, [latestRecoveryIncidentId, recoveryStatus]);

  useEffect(() => {
    if (!dispatchReasoningActive) {
      dispatchReasoningStartedAtRef.current = null;
      if (reasoningStatus === "idle") {
        setReasoningSeconds(0);
      }
      return;
    }

    if (dispatchReasoningStartedAtRef.current === null) {
      dispatchReasoningStartedAtRef.current = performance.now();
    }

    const startedAt = dispatchReasoningStartedAtRef.current;
    const timer = window.setInterval(() => {
      setReasoningSeconds((performance.now() - startedAt) / 1_000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [dispatchReasoningActive, reasoningStatus]);

  useEffect(() => {
    const checkoutState = searchParams.get("checkout");
    if (checkoutState !== "success" && checkoutState !== "cancelled") {
      return;
    }

    let disposed = false;
    const sessionId = searchParams.get("session_id");
    const orderId = searchParams.get("order_id");
    const scenarioParam = searchParams.get("scenario");
    const scenario =
      scenarioParam === "success" || scenarioParam === "payment_declined"
        ? scenarioParam
        : null;

    async function processCheckoutReturn() {
      if (checkoutState === "cancelled") {
        if (disposed) {
          return;
        }

        setCheckoutReturn({
          kind: "cancelled",
          scenario,
          orderId,
          paymentStatus: null,
          sessionStatus: null,
          detail:
            scenario === "payment_declined"
              ? "The retry checkout was cancelled. Hermes is still keeping dispatch blocked until the customer pays."
              : "Checkout was cancelled before payment, so the request is still outside live dispatch.",
        });
        await refreshDashboardSnapshot();
        return;
      }

      let sessionPayload:
        | {
            orderId?: string | null;
            paymentStatus?: string | null;
            status?: string | null;
          }
        | null = null;

      if (sessionId) {
        let confirmPayload:
          | {
              error?: string;
              confirmed?: boolean;
              orderId?: string | null;
              paymentStatus?: string | null;
              sessionStatus?: string | null;
            }
          | null = null;

        try {
          const confirmResponse = await fetch("/api/checkout/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          confirmPayload = (await confirmResponse.json().catch(() => ({}))) as {
            error?: string;
            confirmed?: boolean;
            orderId?: string | null;
            paymentStatus?: string | null;
            sessionStatus?: string | null;
          };
        } catch {
          confirmPayload = null;
        }

        if (confirmPayload?.confirmed) {
          setCheckoutReturn({
            kind: "success",
            scenario,
            orderId: confirmPayload.orderId ?? orderId,
            paymentStatus: confirmPayload.paymentStatus ?? null,
            sessionStatus: confirmPayload.sessionStatus ?? null,
            detail:
              "Stripe payment was confirmed locally and Hermes has been asked to release dispatch now.",
          });
          autoStartOrderRef.current = confirmPayload.orderId ?? orderId ?? null;
          triggerFastUiRefresh(POST_CHECKOUT_BURST_MS);
          await refreshSimulationState();
          await refreshDashboardSnapshot();
          return;
        }

        const response = await fetch(
          `/api/checkout/session?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as {
          error?: string;
          orderId?: string | null;
          paymentStatus?: string | null;
          status?: string | null;
        };

        if (response.ok) {
          sessionPayload = payload;
        }
      }

      if (disposed) {
        return;
      }

      setCheckoutReturn({
        kind: "success",
        scenario,
        orderId: sessionPayload?.orderId ?? orderId,
        paymentStatus: sessionPayload?.paymentStatus ?? null,
        sessionStatus: sessionPayload?.status ?? null,
        detail:
          sessionPayload?.paymentStatus === "paid"
            ? "Stripe marked the checkout paid. Hermes is reconciling dispatch now; the dashboard will keep refreshing."
            : "Stripe returned a success page. The dashboard is refreshing to confirm payment and dispatch state.",
      });
      if (sessionPayload?.paymentStatus === "paid") {
        autoStartOrderRef.current = sessionPayload.orderId ?? orderId ?? null;
      }
      triggerFastUiRefresh(POST_CHECKOUT_BURST_MS);
      await refreshSimulationState();
      await refreshDashboardSnapshot();
    }

    void processCheckoutReturn().finally(() => {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("checkout");
      nextUrl.searchParams.delete("session_id");
      nextUrl.searchParams.delete("order_id");
      nextUrl.searchParams.delete("scenario");
      window.history.replaceState({}, "", nextUrl.toString());
    });

    return () => {
      disposed = true;
    };
  }, [
    refreshDashboardSnapshot,
    refreshSimulationState,
    refreshSimulatorSnapshot,
    searchParams,
    triggerFastUiRefresh,
  ]);

  useEffect(() => {
    const pendingAutoStartOrderId = autoStartOrderRef.current;
    if (!pendingAutoStartOrderId) {
      return;
    }

    const currentOrder = world?.orders.find(
      (order) => order.id === pendingAutoStartOrderId,
    );
    if (!currentOrder) {
      return;
    }

    const assignedAndVisible =
      (currentOrder.status === "assigned" || currentOrder.status === "in_transit") &&
      Boolean(
        world?.vehicles.some(
          (vehicle) =>
            vehicle.id === currentOrder.vehicleId &&
            vehicle.route.length > 1,
        ),
      );

    if (!assignedAndVisible) {
      return;
    }

    if (tick.status !== "running") {
      void start();
    }

    autoStartOrderRef.current = null;
  }, [start, tick.status, world]);

  useEffect(() => {
    if (!activeIncidentId || reasoningIncidentRef.current === activeIncidentId) {
      return;
    }

    const workflowEpoch = incidentWorkflowEpochRef.current;
    reasoningIncidentRef.current = activeIncidentId;
    setReasoningStatus("reasoning");
    setReasoningResult(null);
    setReasoningError(null);
    setReasoningSeconds(0);
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setReasoningSeconds((performance.now() - startedAt) / 1_000);
    }, 100);

    void requestReasoningDecision(activeIncidentId)
      .then(async (payload) => {
        if (incidentWorkflowEpochRef.current !== workflowEpoch) {
          return;
        }

        setReasoningResult(payload);
        setReasoningSeconds(payload.latencyMs / 1_000);
        setReasoningStatus("complete");

        if (recoveryIncidentRef.current !== activeIncidentId) {
          recoveryIncidentRef.current = activeIncidentId;
          setRecoveryStatus("executing");
          void fetch("/api/dashboard/recover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ incidentId: activeIncidentId }),
          })
            .then(async (recoveryResponse) => {
              if (incidentWorkflowEpochRef.current !== workflowEpoch) {
                return;
              }

              const recoveryPayload = (await recoveryResponse.json()) as {
                error?: string;
              };
              if (!recoveryResponse.ok) {
                throw new Error(
                  recoveryPayload.error ?? "Recovery execution failed",
                );
              }
              setRecoveryStatus("complete");
              void refreshDashboardSnapshot();
            })
            .catch((recoveryError: unknown) => {
              if (incidentWorkflowEpochRef.current !== workflowEpoch) {
                return;
              }

              setReasoningError(
                recoveryError instanceof Error
                  ? recoveryError.message
                  : "Recovery execution failed",
              );
              setRecoveryStatus("error");
            });
        }
        if (incidentWorkflowEpochRef.current !== workflowEpoch) {
          return;
        }
        void refreshDashboardSnapshot();
      })
      .catch((requestError: unknown) => {
        if (incidentWorkflowEpochRef.current !== workflowEpoch) {
          return;
        }

        setReasoningError(
          requestError instanceof Error
            ? requestError.message
            : "Reasoning request failed",
        );
        setReasoningStatus("error");
      })
      .finally(() => window.clearInterval(timer));

    return () => window.clearInterval(timer);
  }, [activeIncidentId, refreshDashboardSnapshot]);

  const handleStartMotion = useCallback(async () => {
    await start();
    triggerFastUiRefresh(4_000);
  }, [start, triggerFastUiRefresh]);

  const handleSimulateBreakdown = useCallback(async () => {
    if (!selectedIncidentVehicleId) {
      return;
    }

    setReasoningError(null);
    try {
      await simulateBreakdown(selectedIncidentVehicleId);
    } catch (incidentError: unknown) {
      setReasoningError(
        incidentError instanceof Error
          ? incidentError.message
          : "Could not trigger a vehicle breakdown.",
      );
      return;
    }
    triggerFastUiRefresh(POST_INCIDENT_BURST_MS);
  }, [
    selectedIncidentVehicleId,
    simulateBreakdown,
    triggerFastUiRefresh,
  ]);

  const handleSimulateCongestion = useCallback(async () => {
    if (!selectedIncidentVehicleId) {
      return;
    }

    setReasoningError(null);
    try {
      await simulateCongestion(selectedIncidentVehicleId);
    } catch (incidentError: unknown) {
      setReasoningError(
        incidentError instanceof Error
          ? incidentError.message
          : "Could not trigger traffic congestion.",
      );
      return;
    }
    triggerFastUiRefresh(POST_INCIDENT_BURST_MS);
  }, [
    selectedIncidentVehicleId,
    simulateCongestion,
    triggerFastUiRefresh,
  ]);

  const hasRecovery = Boolean(recoveryReport);

  const reasoningPanelContent =
    reasoningStatus !== "idle" || currentRequest ? (
      <NemotronDecisionPanel
        agentTimeline={dashboardSnapshot?.agentTimeline ?? []}
        currentRequest={currentRequest}
        policyItems={policyTimelineItems}
        result={reasoningResult}
        reasoningSeconds={reasoningSeconds}
        status={reasoningStatus}
        error={reasoningError}
      />
    ) : checkoutReturn?.kind === "success" &&
      checkoutReturn.paymentStatus === "paid" ? (
      <section className="flex h-full items-center justify-center rounded-2xl border border-emerald-400/15 bg-emerald-500/[0.04] p-6 text-center text-emerald-100">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-200">
            Hermes Dispatch Is Waking Up
          </h3>
          <p className="mt-2 text-sm text-emerald-100/80">
            Stripe cleared the payment. Hermes is releasing dispatch now and the dashboard is fast-refreshing while the route lands on the map.
          </p>
        </div>
      </section>
    ) : (
      <section className="flex h-full items-center justify-center rounded-2xl border border-white/6 bg-white/[0.03] p-6 text-center text-slate-400">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-200">
            Hermes Standing By
          </h3>
          <p className="mt-2 text-sm text-slate-500">
            Create a paid delivery or trigger a live incident to watch Hermes work in real time.
          </p>
        </div>
      </section>
    );

  if (loading || (planningMessage && !world) || (!world && !error)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0e14]">
        <div className="flex flex-col items-center gap-3 text-slate-300">
          <p className="text-lg font-medium">
            {planningMessage ?? "Loading operations dashboard..."}
          </p>
          {planningMessage ? (
            <p className="text-sm text-slate-400">
              cuOpt is optimizing assignments and OSRM is rebuilding road geometry.
            </p>
          ) : !world ? (
            <p className="text-sm text-slate-400">
              Reconnecting live fleet state after reload.
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (!world) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0e14] p-6">
        <div className="max-w-lg rounded-2xl border border-red-500/20 bg-[#111924] p-6 text-red-100 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
          <h2 className="text-lg font-semibold">Simulation unavailable</h2>
          <p className="mt-2 text-sm">{error ?? "World state missing"}</p>
          <p className="mt-3 text-sm text-red-200/80">
            Ensure Supabase tables exist (`npm run db:migrate`) and Redis/Supabase
            env vars are set in `apps/web/.env.local`.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#071018] text-white">
      <section
        className="relative z-0 min-h-0 shrink-0 overflow-hidden bg-[#08111c]"
        style={{ height: `${mapHeightVh}vh` }}
      >
        <div className="grid h-full xl:grid-cols-[minmax(0,1fr)_430px] xl:gap-4 xl:p-4">
          <div className="relative min-h-0 overflow-hidden bg-[#08111c] xl:rounded-[28px] xl:border xl:border-white/10 xl:shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
            <main className="absolute inset-0 z-0">
              <CityMap
                world={world}
                elapsedSeconds={mapElapsedSeconds}
                ambientElapsedSeconds={ambientElapsedSeconds}
                ambientSnapshotTimeSeconds={
                  simulatorSnapshot?.sim_time_seconds ?? null
                }
                ambientVehicles={simulatorSnapshot?.ambient_vehicles}
                ambientRouteSegments={simulatorSnapshot?.ambient_route_segments}
                trafficZones={simulatorSnapshot?.traffic_zones}
                signalLights={simulatorSnapshot?.signal_lights}
                mapView={simulatorSnapshot?.map_view ?? null}
              />
            </main>

            <div className="pointer-events-none absolute bottom-4 left-4 z-20 max-w-[28rem]">
          <div className="rounded-3xl border border-white/10 bg-[#09131f]/88 px-5 py-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#57b0ff]">
                  Demo Fleet Control
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-white">
                  Hermes<span className="text-[#57b0ff]">Routiq</span>
                </h1>
              </div>
              <div className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
                <div>Seed {world.seed}</div>
                <div className="mt-1 flex items-center justify-end gap-1.5 text-[9px] text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Running
                </div>
              </div>
            </div>

            {recoveryStatus !== "idle" ? (
              <div className={`recovery-banner is-${recoveryStatus} mt-4`}>
                <span />
                <div>
                  <div>
                    {recoveryStatus === "executing"
                      ? latestIncidentType === "payment_declined"
                        ? "Executing payment recovery plan"
                        : "Executing recovery plan / routes active"
                      : recoveryStatus === "complete"
                        ? latestIncidentType === "payment_declined"
                          ? "Payment recovery complete / dispatch held"
                          : "Recovery complete / deliveries updated"
                        : "Recovery execution needs attention"}
                  </div>
                  {recoveryStatus === "error" && reasoningError ? (
                    <div className="mt-1 text-[11px] font-normal normal-case tracking-normal text-rose-100/90">
                      {reasoningError}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {simulatorOverlayEnabled ? (
              <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-[11px] text-slate-300">
                <p className="font-semibold uppercase tracking-[0.16em] text-slate-100">
                  Ambient City Simulation
                </p>
                <p className="mt-1 text-slate-400">
                  {simulatorSnapshotError
                    ? simulatorSnapshotError
                    : simulatorSnapshot
                      ? `${simulatorSnapshot.scenario_name} · ${simulatorSnapshot.ambient_vehicles.length} vehicles · ${simulatorSnapshot.signal_lights.length} signals · t=${simulatorSnapshot.sim_time_seconds.toFixed(0)}s`
                      : "Connecting to simulator backend..."}
                </p>
                {simulatorSnapshot?.scheduled_events.length ? (
                  <p className="mt-2 text-slate-500">
                    Events: {appliedSimulatorEventIds.length} applied,{" "}
                    {blockedSimulatorEvents.length} blocked,{" "}
                    {simulatorSnapshot.scheduled_events.length} scheduled.
                  </p>
                ) : null}
                {blockedSimulatorEvents[0] ? (
                  <p className="mt-2 text-amber-200/80">
                    Waiting on {blockedSimulatorEvents[0].eventId}:{" "}
                    {blockedSimulatorEvents[0].reason}
                  </p>
                ) : null}
                {simulatorEventError ? (
                  <p className="mt-2 text-amber-300">
                    Scheduler: {simulatorEventError}
                  </p>
                ) : null}
              </div>
            ) : null}
              </div>
            </div>
          </div>

          <aside className="hidden h-full min-h-0 flex-col overflow-hidden border-l border-white/10 bg-[#06111b] xl:flex xl:rounded-[28px] xl:border xl:border-white/10 xl:shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
            <div className="border-b border-white/8 px-4 py-4">
              <div className="flex items-center gap-3">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    activeIncidentId || currentRequest?.dispatchStatus === "reasoning"
                      ? "animate-pulse bg-emerald-400"
                      : "bg-slate-500"
                  }`}
                />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#57b0ff]">
                    Hermes Live Reasoning
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Dispatch, policy, tools, and recovery in one live feed.
                  </p>
                </div>
              </div>
            </div>
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
              {reasoningPanelContent}
            </div>
          </aside>
        </div>
      </section>

      <section
        className="relative z-40 shrink-0 overflow-hidden border-t border-white/10 bg-[#0f1117] shadow-[0_-18px_48px_rgba(0,0,0,0.45)]"
        style={{ height: `${100 - mapHeightVh}vh` }}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="border-b border-white/10 px-4 pt-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pr-3">
                {tabs.map((tab) => {
                  const isActive = selectedTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setSelectedTab(tab.id)}
                      className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition ${
                        isActive
                          ? "bg-[#57b0ff] text-[#071018] shadow-[0_10px_30px_rgba(87,176,255,0.35)]"
                          : "bg-white/5 text-slate-400"
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <HeadlineHud
                  metrics={headlineMetrics}
                  error={showDashboardSnapshotError}
                  hideWallet
                  compact
                  className="w-[520px]"
                />

                <div className="rounded-2xl border border-white/10 bg-[#09131f] px-3 py-2 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        Map Size
                      </p>
                      <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-[#7fc4ff]">
                        {mapSizeLabel}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setMapHeightVh((current) => Math.max(46, current - 6))
                        }
                        className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-lg font-semibold text-white transition hover:bg-white/10"
                        aria-label="Reduce map height"
                      >
                        -
                      </button>
                      <button
                        type="button"
                        onClick={() => setMapHeightVh(58)}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300 transition hover:bg-white/10"
                        aria-label="Reset map size"
                      >
                        Size Reset
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setMapHeightVh((current) => Math.min(74, current + 6))
                        }
                        className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-lg font-semibold text-white transition hover:bg-white/10"
                        aria-label="Increase map height"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 pb-3 xl:hidden">
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#06111b] p-3 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      activeIncidentId || currentRequest?.dispatchStatus === "reasoning"
                        ? "animate-pulse bg-emerald-400"
                        : "bg-slate-500"
                    }`}
                  />
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#57b0ff]">
                      Hermes Live Reasoning
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Dispatch, policy, tools, and recovery in one live feed.
                    </p>
                  </div>
                </div>
                <div className="no-scrollbar h-[440px] overflow-y-auto overflow-x-hidden pr-1">
                  {reasoningPanelContent}
                </div>
              </div>
            </div>
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
            {selectedTab === "operations" ? (
              <div className="grid h-full gap-3">
                <div className="grid min-h-0 gap-3 content-start">
                  {planningMessage ? (
                    <section className="mt-4 rounded-2xl border border-[#45a3ff]/30 bg-[#10243a] px-4 py-3 text-[#d8ecff]">
                      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#7fc4ff]">
                        <span className="h-2 w-2 rounded-full bg-[#45a3ff] animate-pulse" />
                        Route Planning
                      </div>
                      <p className="mt-2 text-sm font-medium">{planningMessage}</p>
                      <p className="mt-1 text-xs text-[#9cc8ed]">
                        The dashboard will refresh automatically when the optimized plan is ready.
                      </p>
                    </section>
                  ) : null}

                  {showSimulationSyncWarning ? (
                    <section className="rounded-2xl border border-amber-400/20 bg-amber-500/5 px-4 py-3 text-amber-100">
                      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
                        <span className="h-2 w-2 rounded-full bg-amber-300" />
                        Live Sync Warning
                      </div>
                      <p className="mt-2 text-sm font-medium">{error}</p>
                      <p className="mt-1 text-xs text-amber-100/75">
                        Hermes and the simulator are still running. The dashboard will keep retrying in the background.
                      </p>
                    </section>
                  ) : null}

                  {awaitingVisibleRoute ? (
                    <section className="rounded-2xl border border-sky-400/20 bg-sky-500/5 px-4 py-3 text-sky-100">
                      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-sky-300">
                        <span className="h-2 w-2 rounded-full bg-sky-300 animate-pulse" />
                        Dispatch Released
                      </div>
                      <p className="mt-2 text-sm font-medium">
                        Hermes already assigned the delivery and published the route.
                      </p>
                      <p className="mt-1 text-xs text-sky-100/75">
                        The map is still catching up to the fresh live vehicle state, so keep the Hermes panel in view while the route appears.
                      </p>
                    </section>
                  ) : null}

                  <div className="grid gap-3 xl:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.45fr)]">
                    <SimControls
                      status={tick.status}
                      breakdownTriggered={breakdownTriggered}
                      planningInProgress={planningInProgress}
                      canSimulateBreakdown={canSimulateBreakdown}
                      canSimulateCongestion={canSimulateCongestion}
                      incidentVehicleId={selectedIncidentVehicleId}
                      incidentVehicleOptions={incidentVehicleOptions}
                      onIncidentVehicleChange={(vehicleId) =>
                        setSelectedIncidentVehicleId(vehicleId || null)
                      }
                      onStart={() => void handleStartMotion()}
                      onReset={() => void handleReset()}
                      onBreakdown={() => void handleSimulateBreakdown()}
                      onCongestion={() => void handleSimulateCongestion()}
                    />

                    <section className="control-section">
                      <h2 className="eyebrow-label">Revenue Intake</h2>
                      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(360px,0.94fr)_minmax(0,1.1fr)]">
                        <div className="grid content-start gap-3">
                          {checkoutReturn ? (
                            <div
                              className={`rounded-2xl border px-3 py-3 text-xs ${
                                checkoutReturn.kind === "success"
                                  ? "border-emerald-400/15 bg-emerald-500/5 text-emerald-100"
                                  : "border-amber-400/15 bg-amber-500/5 text-amber-100"
                              }`}
                            >
                              <p
                                className={`font-semibold uppercase tracking-[0.14em] ${
                                  checkoutReturn.kind === "success"
                                    ? "text-emerald-300"
                                    : "text-amber-300"
                                }`}
                              >
                                {checkoutReturn.kind === "success"
                                  ? "Stripe Checkout Returned"
                                  : "Checkout Cancelled"}
                              </p>
                              <p className="mt-1 opacity-80">
                                {checkoutReturn.detail}
                              </p>
                              <p className="mt-2 font-mono text-[11px] opacity-70">
                                {checkoutReturn.orderId
                                  ? `order ${checkoutReturn.orderId}`
                                  : "order unknown"}
                                {checkoutReturn.paymentStatus
                                  ? ` | payment ${checkoutReturn.paymentStatus}`
                                  : ""}
                                {checkoutReturn.sessionStatus
                                  ? ` | session ${checkoutReturn.sessionStatus}`
                                  : ""}
                              </p>
                            </div>
                          ) : null}
                          <div className="grid gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                            <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                              Pickup Hub
                              <select
                                value={checkoutRequestDraft.pickupHubId}
                                onChange={(event) =>
                                  setCheckoutRequestDraft((current) => ({
                                    ...current,
                                    pickupHubId: event.target.value,
                                  }))
                                }
                                disabled={checkoutOptionsLoading}
                                className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                              >
                                <option value="">Select a hub</option>
                                {pickupHubOptions.map((hub) => (
                                  <option key={hub.id} value={hub.id}>
                                    {hub.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                              Customer Label
                              <input
                                value={checkoutRequestDraft.customerName}
                                onChange={(event) =>
                                  setCheckoutRequestDraft((current) => ({
                                    ...current,
                                    customerName: event.target.value,
                                  }))
                                }
                                className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                                placeholder="Market Street Drop"
                              />
                            </label>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                Destination Lat
                                <input
                                  value={checkoutRequestDraft.destinationLat}
                                  onChange={(event) =>
                                    setCheckoutRequestDraft((current) => ({
                                      ...current,
                                      destinationLat: event.target.value,
                                    }))
                                  }
                                  className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                                  inputMode="decimal"
                                />
                              </label>
                              <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                Destination Lng
                                <input
                                  value={checkoutRequestDraft.destinationLng}
                                  onChange={(event) =>
                                    setCheckoutRequestDraft((current) => ({
                                      ...current,
                                      destinationLng: event.target.value,
                                    }))
                                  }
                                  className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                                  inputMode="decimal"
                                />
                              </label>
                            </div>
                            <p className="text-[11px] text-slate-500">
                              Hermes reviews the request first, then opens the paid
                              or decline path.
                            </p>
                            <CreateDeliveryButton
                              label="Create Paid Delivery"
                              requestDraft={checkoutRequestDraft}
                              requestDisabled={checkoutOptionsLoading}
                            />
                            <CreateDeliveryButton
                              scenario="payment_declined"
                              tone="warning"
                              label="Run Stripe Test Decline"
                              loadingLabel="Running Stripe test decline..."
                              redirectingLabel="Running a Stripe test decline and waiting for Hermes to react..."
                              requestDraft={checkoutRequestDraft}
                              requestDisabled={checkoutOptionsLoading}
                              onComplete={() => refreshDashboardSnapshot()}
                            />
                            {latestPaymentIncidentOrderId ? (
                              <CreateDeliveryButton
                                orderId={latestPaymentIncidentOrderId}
                                label="Recover Payment"
                                loadingLabel="Opening retry checkout..."
                                redirectingLabel="Redirecting to Stripe Checkout so the customer can complete payment..."
                              />
                            ) : null}
                          </div>
                        </div>

                        <div className="grid content-start gap-3">
                          {latestIncidentType === "payment_declined" ? (
                            <div className="rounded-2xl border border-amber-400/15 bg-amber-500/5 px-3 py-3 text-xs text-amber-100">
                              <p className="font-semibold uppercase tracking-[0.14em] text-amber-300">
                                Payment Declined
                              </p>
                              <p className="mt-1 text-amber-100/80">
                                Hermes kept the request off the fleet, blocked dispatch,
                                and opened a customer recovery path instead of burning
                                driver capacity on unpaid work.
                              </p>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-sky-400/15 bg-sky-500/5 px-3 py-3 text-xs text-sky-100">
                              <p className="font-semibold uppercase tracking-[0.14em] text-sky-300">
                                Stripe Test Flow
                              </p>
                              <p className="mt-1 text-sky-100/80">
                                Both payment outcomes now start from the same explicit
                                delivery request. Paid orders release through Stripe
                                Checkout in test mode; declined payments stay off the
                                fleet and are handled as commerce incidents.
                              </p>
                            </div>
                          )}

                          {currentRequest ? (
                            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 text-xs text-slate-200">
                              <p className="font-semibold uppercase tracking-[0.14em] text-slate-300">
                                Current Request
                              </p>
                              <div className="mt-2 grid gap-1">
                                <div className="flex items-center gap-2">
                                  <strong>{currentRequest.customerLabel ?? currentRequest.orderId}</strong>
                                  <span
                                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${requestFunnelBadgeClasses(currentRequest.funnelStatus)}`}
                                  >
                                    {currentRequest.funnelStatus}
                                  </span>
                                  {currentRequest.dispatchStatus !== "idle" ? (
                                    <span
                                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${dispatchStatusBadgeClasses(currentRequest.dispatchStatus)}`}
                                    >
                                      {currentRequest.dispatchStatus}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-slate-400">
                                  {currentRequest.pickupHubLabel ?? "Unknown hub"}
                                  {currentRequest.destinationLabel
                                    ? ` -> ${currentRequest.destinationLabel}`
                                    : ""}
                                </p>
                                <p className="text-slate-400">
                                  Quote {formatQuotedPrice(currentRequest.quotedPriceCents)}
                                  {typeof currentRequest.baselineQuoteCents === "number"
                                    ? ` / baseline $${(currentRequest.baselineQuoteCents / 100).toFixed(2)}`
                                    : ""}
                                  {typeof currentRequest.estimatedDistanceKm === "number"
                                    ? ` / ${currentRequest.estimatedDistanceKm.toFixed(2)} km`
                                    : ""}
                                </p>
                                <p className="text-slate-400">
                                  {currentRequestSummary?.label ?? "Request update"}:{" "}
                                  {currentRequestSummary?.detail ?? "Waiting for Hermes to update the request."}
                                </p>
                                {currentRequest.dispatchAssignedVehicleId ? (
                                  <p className="text-slate-400">
                                    Assigned vehicle {currentRequest.dispatchAssignedVehicleId}
                                    {currentRequest.status ? ` / order ${currentRequest.status}` : ""}
                                  </p>
                                ) : null}
                                {awaitingVisibleRoute ? (
                                  <p className="pt-1 text-amber-200/85">
                                    Hermes already released the route. The browser is still syncing the vehicle path into the live map.
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          ) : null}

                          {requestHistory.length > 1 ? (
                            <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3 text-xs text-slate-200">
                              <p className="font-semibold uppercase tracking-[0.14em] text-slate-300">
                                Request History
                              </p>
                              <div className="mt-2 grid gap-2">
                                {requestHistory.slice(1).map((request) => (
                                  <div
                                    key={request.orderId}
                                    className="rounded-xl border border-white/6 bg-black/10 px-2 py-2"
                                  >
                                    <div className="flex items-center gap-2">
                                      <strong>{request.customerLabel ?? request.orderId}</strong>
                                      <span
                                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${requestFunnelBadgeClasses(request.funnelStatus)}`}
                                      >
                                        {request.funnelStatus}
                                      </span>
                                    </div>
                                    <p className="text-slate-400">
                                      {request.pickupHubLabel ?? "Unknown hub"}
                                      {request.destinationLabel
                                        ? ` -> ${request.destinationLabel}`
                                        : ""}
                                    </p>
                                    <p className="text-slate-500">
                                      {typeof request.quotedPriceCents === "number"
                                        ? `$${(request.quotedPriceCents / 100).toFixed(2)}`
                                        : "n/a"}
                                      {request.strategy ? ` | ${request.strategy}` : ""}
                                      {request.status ? ` | ${request.status}` : ""}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </section>
                  </div>
                </div>

              </div>
            ) : null}

            {selectedTab === "payments" ? (
              <div className="no-scrollbar h-full overflow-y-auto overflow-x-hidden">
                <StripeTransactionPanel transactions={stripeTransactions} />
              </div>
            ) : null}

            {selectedTab === "recovery-report" ? (
              <div className="grid h-full gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
                <section className="px-1 py-1">
                  {recoveryReport ? (
                    <FinalRecoveryReport report={recoveryReport} />
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 text-center text-sm text-slate-400">
                      <div>
                        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-100">
                          Recovery Report Pending
                        </h3>
                        <p className="mt-2 text-sm text-emerald-100/60">
                          Recovery metrics will appear here once the fulfillment
                          recovery flow completes.
                        </p>
                      </div>
                    </div>
                  )}
                </section>

                <section className="grid gap-3 content-start">
                  <article className="overflow-hidden rounded-3xl border border-sky-400/15 bg-gradient-to-br from-sky-500/[0.06] to-white/[0.015] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-sky-400/30 bg-sky-500/10 text-sky-300">
                          <svg
                            className="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                            <path d="M21 3v5h-5" />
                            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                            <path d="M3 21v-5h5" />
                          </svg>
                        </span>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-300">
                          Hermes Learning Loop
                        </p>
                      </div>
                      {recoveryReport?.reusedSkill?.reused ? (
                        <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-emerald-300">
                          Reused
                        </span>
                      ) : recoveryReport?.skillName ? (
                        <span className="rounded-full border border-sky-400/25 bg-sky-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-sky-300">
                          New skill
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-3 text-sm leading-relaxed text-slate-300">
                      {recoveryReport?.reusedSkill?.reused
                        ? "Hermes reused an existing recovery skill and adapted it to this incident's current numbers."
                        : recoveryReport?.skillName
                          ? "Hermes created a new recovery skill from this run so the next incident can start faster."
                          : "The learned skill record will appear here after recovery completes."}
                    </p>

                    {recoveryReport?.reusedSkill?.reused || recoveryReport?.skillName ? (
                      <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5">
                        <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-slate-500">
                          Skill
                        </p>
                        <code className="mt-1 block font-mono text-[13px] font-medium text-emerald-200">
                          {recoveryReport?.reusedSkill?.reused
                            ? recoveryReport.reusedSkill.skillName
                            : recoveryReport?.skillName}
                        </code>
                        {recoveryReport?.reusedSkill?.reused &&
                        recoveryReport.reusedSkill.learnedFromIncidentId ? (
                          <p className="mt-1.5 text-[11px] text-slate-500">
                            Learned from incident{" "}
                            <span className="font-mono text-slate-400">
                              {recoveryReport.reusedSkill.learnedFromIncidentId.slice(0, 8)}
                            </span>
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-3 font-mono text-sm text-slate-400">
                        Pending audit record
                      </p>
                    )}
                  </article>
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
