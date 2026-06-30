"use client";

import { useEffect, useRef, useState } from "react";
import type { SimulatorSnapshot } from "@hermes-routiq/shared";
import type { SimulationWorld } from "@/lib/sim/types";

interface UseSimulatorScheduledEventsParams {
  enabled: boolean;
  planningInProgress: boolean;
  snapshot: SimulatorSnapshot | null;
  world: SimulationWorld | null;
  simElapsedSeconds: number;
}

export interface SimulatorEventStatus {
  appliedEventIds: string[];
  blockedEvents: Array<{
    eventId: string;
    reason: string;
  }>;
  lastError: string | null;
}

export function useSimulatorScheduledEvents({
  enabled,
  planningInProgress,
  snapshot,
  world,
  simElapsedSeconds,
}: UseSimulatorScheduledEventsParams): SimulatorEventStatus {
  const [appliedEventIds, setAppliedEventIds] = useState<string[]>([]);
  const [blockedEvents, setBlockedEvents] = useState<
    Array<{ eventId: string; reason: string }>
  >([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const lastAttemptedSimSecondRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !snapshot || !world || planningInProgress) {
      return;
    }

    const activeOrders = world.orders.some(
      (order) => order.status === "assigned" || order.status === "in_transit",
    );
    if (!activeOrders) {
      return;
    }

    const hasDueEvents = snapshot.scheduled_events.some(
      (event) => event.due_at_sim_seconds <= simElapsedSeconds,
    );

    if (!hasDueEvents || inFlightRef.current) {
      return;
    }

    if (lastAttemptedSimSecondRef.current === simElapsedSeconds) {
      return;
    }

    inFlightRef.current = true;
    lastAttemptedSimSecondRef.current = simElapsedSeconds;

    void fetch("/api/simulator/events/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simTimeSeconds: simElapsedSeconds,
          scheduledEvents: snapshot.scheduled_events,
        }),
      })
      .then(async (response) => {
        const payload = (await response.json()) as {
          appliedEventIds?: string[];
          blockedEvents?: Array<{ eventId: string; reason: string }>;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to reconcile simulator events");
        }
        setAppliedEventIds(payload.appliedEventIds ?? []);
        setBlockedEvents(payload.blockedEvents ?? []);
        setLastError(null);
      })
      .catch((error: unknown) => {
        setLastError(
          error instanceof Error
            ? error.message
            : "Failed to reconcile simulator events",
        );
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [enabled, planningInProgress, simElapsedSeconds, snapshot, world]);

  return { appliedEventIds, blockedEvents, lastError };
}
