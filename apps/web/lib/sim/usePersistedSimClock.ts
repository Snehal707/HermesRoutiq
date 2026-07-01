"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SimClock, type SimTickState } from "./clock";
import type { SimulationWorld } from "./types";
import type { PersistedTickState } from "./persistence";
import { createWorld, getSimulationSeed } from "./world";

export interface UsePersistedSimClockResult {
  world: SimulationWorld | null;
  tick: SimTickState;
  loading: boolean;
  error: string | null;
  planningMessage: string | null;
  refresh: () => Promise<void>;
  burstRefresh: (options?: { durationMs?: number; intervalMs?: number }) => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  reset: () => Promise<void>;
  setSpeed: (multiplier: number) => Promise<void>;
  simulateBreakdown: (vehicleId?: string) => Promise<void>;
  simulateCongestion: (vehicleId?: string) => Promise<void>;
  breakdownTriggered: boolean;
}

const TICK_SYNC_MS = 1_500;
const WORLD_REFRESH_MS = 2_500;
const BURST_REFRESH_MS = 350;
const BURST_REFRESH_DURATION_MS = 8_000;
// When a vehicle is within this many sim-seconds of an undelivered stop's ETA,
// poll the world fast so the "delivered" marker flips right as the truck arrives
// instead of a few seconds later.
const DELIVERY_APPROACH_LEAD_SECONDS = 6;
const DELIVERY_APPROACH_TRAIL_SECONDS = 5;
const DELIVERY_APPROACH_BURST_MS = 1_500;
// The dev server can queue requests for several seconds during polling bursts
// (HMR recompiles + concurrent pollers blocking the event loop), so allow more
// headroom than the worst-case observed latency before aborting.
const REQUEST_TIMEOUT_MS = 20_000;
const RESET_READY_TIMEOUT_MS = 20_000;
const RESET_READY_POLL_MS = 500;
const WORLD_CACHE_KEY = "hermes-routiq:sim-world";

// Last-known world, kept in memory and mirrored to sessionStorage so a single
// slow/aborted /api/sim/state request (or a page reload) degrades to the soft
// "Live Sync Warning" banner instead of the full-screen "Simulation
// unavailable" failure.
let lastWorldCache: SimulationWorld | null = null;

function loadCachedWorld(): SimulationWorld | null {
  if (lastWorldCache) {
    return lastWorldCache;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(WORLD_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as SimulationWorld;
    lastWorldCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function cacheWorld(world: SimulationWorld): void {
  lastWorldCache = world;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WORLD_CACHE_KEY, JSON.stringify(world));
  } catch {
    // Ignore storage failures and keep the in-memory cache.
  }
}

interface BurstRefreshWindow {
  startedAt: number;
  durationMs: number;
  intervalMs: number;
}

interface PlanningPayload {
  status: "planning";
  planning?: {
    phase?: "initializing" | "resetting";
    provider?: string;
  };
  world?: SimulationWorld;
  tick?: PersistedTickState;
}

type FetchResult<T> =
  | { kind: "success"; data: T }
  | { kind: "planning"; data: PlanningPayload };

// True when any vehicle is within the approach window of a stop whose order is
// still undelivered — i.e. the "delivered" flip is imminent and we want fast polls.
function isApproachingDelivery(
  world: SimulationWorld,
  elapsedSeconds: number,
): boolean {
  for (const vehicle of world.vehicles) {
    const stops = vehicle.routingPlan?.orderedStops;
    if (!stops) {
      continue;
    }
    for (const stop of stops) {
      if (!stop.orderId) {
        continue;
      }
      const order = world.orders.find((candidate) => candidate.id === stop.orderId);
      if (!order || order.status === "delivered" || order.status === "cancelled") {
        continue;
      }
      if (
        elapsedSeconds >= stop.etaSeconds - DELIVERY_APPROACH_LEAD_SECONDS &&
        elapsedSeconds <= stop.etaSeconds + DELIVERY_APPROACH_TRAIL_SECONDS
      ) {
        return true;
      }
    }
  }
  return false;
}

function toPlanningMessage(payload?: PlanningPayload): string {
  const phase = payload?.planning?.phase;
  if (phase === "resetting") {
    return "Optimizing routes after reset...";
  }

  return "Optimizing routes...";
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  let response: Response;
  let payload: ((T & { error?: string }) | PlanningPayload) | null = null;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });

    payload = (await response.json()) as
      | (T & { error?: string })
      | PlanningPayload;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Timed out loading ${url}`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  if (response.status === 202) {
    return { kind: "planning", data: payload as PlanningPayload };
  }

  if (!response.ok) {
    throw new Error(
      payload && "error" in payload
        ? payload.error ?? `Request failed: ${response.status}`
        : `Request failed: ${response.status}`,
    );
  }

  return { kind: "success", data: payload as T };
}

export function usePersistedSimClock(): UsePersistedSimClockResult {
  const clockRef = useRef<SimClock | null>(null);
  if (clockRef.current === null) {
    clockRef.current = new SimClock();
  }

  const [world, setWorld] = useState<SimulationWorld | null>(() =>
    loadCachedWorld(),
  );
  const [tick, setTick] = useState<SimTickState>(() =>
    clockRef.current!.getState(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planningMessage, setPlanningMessage] = useState<string | null>(null);
  const lastSyncRef = useRef(0);
  const tickSyncInFlightRef = useRef(false);
  const worldRef = useRef<SimulationWorld | null>(null);
  const burstRefreshWindowRef = useRef<BurstRefreshWindow | null>(null);
  const worldRequestIdRef = useRef(0);

  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  const syncTickToServer = useCallback(
    async (
      nextTick: PersistedTickState,
      currentWorld?: SimulationWorld,
      options?: { includeWorld?: boolean },
    ) => {
      const result = await fetchJson("/api/sim/tick", {
        method: "PATCH",
        body: JSON.stringify({
          tick: nextTick,
          ...(options?.includeWorld && currentWorld ? { world: currentWorld } : {}),
        }),
      });

      if (result.kind === "planning") {
        setPlanningMessage(toPlanningMessage(result.data));
      }
    },
    [],
  );

  const applyPersistedTick = useCallback((serverTick: PersistedTickState) => {
    const clock = clockRef.current!;
    clock.hydrate(serverTick);
    setTick(clock.getState());
    clock.resumeIfRunning();
  }, []);

  const refreshWorldState = useCallback(async () => {
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;
    const result = await fetchJson<{
      world: SimulationWorld;
      tick: PersistedTickState;
    }>("/api/sim/state");

    if (worldRequestIdRef.current !== requestId) {
      return;
    }

    if (result.kind === "planning") {
      setPlanningMessage(toPlanningMessage(result.data));
      if (result.data.planning?.phase === "resetting") {
        return;
      }
      if (result.data.world) {
        setWorld(result.data.world);
        worldRef.current = result.data.world;
        cacheWorld(result.data.world);
      }
      if (result.data.tick && clockRef.current?.getState().status !== "running") {
        applyPersistedTick(result.data.tick);
      }
      return;
    }

    const data = result.data;
    setPlanningMessage(null);
    setWorld(data.world);
    worldRef.current = data.world;
    cacheWorld(data.world);

    if (clockRef.current?.getState().status !== "running") {
      applyPersistedTick(data.tick);
    }
  }, [applyPersistedTick]);

  useEffect(() => {
    const clock = clockRef.current!;

    const unsubscribe = clock.subscribe((nextTick) => {
      setTick(nextTick);

      const currentWorld = worldRef.current;
      if (nextTick.status !== "running" || !currentWorld) {
        return;
      }

      // Speed up world polling as a truck nears a drop-off so the delivered
      // marker lands right as it arrives (cleared automatically once past).
      if (isApproachingDelivery(currentWorld, nextTick.elapsedSeconds)) {
        burstRefreshWindowRef.current = {
          startedAt: Date.now(),
          durationMs: DELIVERY_APPROACH_BURST_MS,
          intervalMs: BURST_REFRESH_MS,
        };
      }

      const now = Date.now();
      if (now - lastSyncRef.current < TICK_SYNC_MS) {
        return;
      }

      lastSyncRef.current = now;
      const persistedTick: PersistedTickState = {
        ...nextTick,
        seed: currentWorld.seed,
      };
      if (tickSyncInFlightRef.current) {
        return;
      }
      tickSyncInFlightRef.current = true;
      void syncTickToServer(persistedTick)
        .catch((syncError: unknown) => {
          const message =
            syncError instanceof Error ? syncError.message : "Tick sync failed";
          setError(message);
        })
        .finally(() => {
          tickSyncInFlightRef.current = false;
        });
    });

    void (async () => {
      try {
        await refreshWorldState();
      } catch (loadError: unknown) {
        const message =
          loadError instanceof Error
            ? loadError.message
            : "Failed to load simulation";
        setError(message);
      } finally {
        setLoading(false);
      }
    })();

    let disposed = false;
    let refreshTimeout: number | null = null;
    const pollWorld = async () => {
      try {
        await refreshWorldState();
      } catch (refreshError: unknown) {
        const message =
          refreshError instanceof Error
            ? refreshError.message
            : "Failed to refresh simulation";
        setError(message);
      } finally {
        if (!disposed) {
          const burstWindow = burstRefreshWindowRef.current;
          const burstActive =
            burstWindow !== null &&
            Date.now() - burstWindow.startedAt < burstWindow.durationMs;
          if (!burstActive && burstWindow !== null) {
            burstRefreshWindowRef.current = null;
          }
          refreshTimeout = window.setTimeout(
            () => void pollWorld(),
            burstActive
              ? burstWindow?.intervalMs ?? BURST_REFRESH_MS
              : WORLD_REFRESH_MS,
          );
        }
      }
    };
    refreshTimeout = window.setTimeout(() => void pollWorld(), WORLD_REFRESH_MS);

    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      clock.destroy();
    };
  }, [refreshWorldState, syncTickToServer]);

  const start = useCallback(async () => {
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;
    const result = await fetchJson<{ world: SimulationWorld; tick: PersistedTickState }>(
      "/api/sim/control",
      {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
      },
    );
    if (worldRequestIdRef.current !== requestId) {
      return;
    }
    if (result.kind === "planning") {
      setPlanningMessage(toPlanningMessage(result.data));
      return;
    }
    const data = result.data;
    setWorld(data.world);
    worldRef.current = data.world;
    applyPersistedTick(data.tick);
    setPlanningMessage(null);
    clockRef.current!.resumeIfRunning();
  }, [applyPersistedTick]);

  const refresh = useCallback(async () => {
    try {
      await refreshWorldState();
      setError(null);
    } catch (refreshError: unknown) {
      const message =
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh simulation";
      setError(message);
      throw refreshError;
    }
  }, [refreshWorldState]);

  const burstRefresh = useCallback(
    (options?: { durationMs?: number; intervalMs?: number }) => {
      burstRefreshWindowRef.current = {
        startedAt: Date.now(),
        durationMs: options?.durationMs ?? BURST_REFRESH_DURATION_MS,
        intervalMs: options?.intervalMs ?? BURST_REFRESH_MS,
      };
      void refreshWorldState().catch(() => undefined);
    },
    [refreshWorldState],
  );

  const pause = useCallback(async () => {
    const currentTick = clockRef.current!.getState();
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;
    const result = await fetchJson<{ world: SimulationWorld; tick: PersistedTickState }>(
      "/api/sim/control",
      {
        method: "POST",
        body: JSON.stringify({ action: "pause" }),
      },
    );
    if (worldRequestIdRef.current !== requestId) {
      return;
    }
    if (result.kind === "planning") {
      setPlanningMessage(toPlanningMessage(result.data));
      return;
    }
    const data = result.data;
    setWorld(data.world);
    worldRef.current = data.world;
    const mergedTick = { ...data.tick, elapsedSeconds: currentTick.elapsedSeconds };
    applyPersistedTick(mergedTick);
    setPlanningMessage(null);
    if (worldRef.current) {
      const persistedTick: PersistedTickState = {
        ...mergedTick,
        seed: worldRef.current.seed,
      };
      await syncTickToServer(persistedTick);
    }
  }, [applyPersistedTick, syncTickToServer]);

  const reset = useCallback(async () => {
    // Stop tick sync immediately so a running sim cannot re-write stale Redis state
    // while the server reset is in flight.
    clockRef.current!.reset();
    lastSyncRef.current = Date.now();
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;

    setPlanningMessage("Resetting to an empty fleet...");
    setError(null);
    const localResetWorld = createWorld(getSimulationSeed());
    setWorld(localResetWorld);
    worldRef.current = localResetWorld;

    const result = await fetchJson<{ world: SimulationWorld; tick: PersistedTickState }>(
      "/api/sim/control",
      {
        method: "POST",
        body: JSON.stringify({ action: "reset" }),
      },
      { timeoutMs: 30_000 },
    );
    if (worldRequestIdRef.current !== requestId) {
      return;
    }
    if (result.kind === "planning") {
      if (result.data.world) {
        setWorld(result.data.world);
        worldRef.current = result.data.world;
      }
      if (result.data.tick) {
        applyPersistedTick(result.data.tick);
      }
      const deadline = Date.now() + RESET_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, RESET_READY_POLL_MS));
        const followUp = await fetchJson<{
          world: SimulationWorld;
          tick: PersistedTickState;
        }>("/api/sim/state");
        if (worldRequestIdRef.current !== requestId) {
          return;
        }
        if (followUp.kind === "planning") {
          if (followUp.data.planning?.phase === "resetting") {
            continue;
          }
          if (followUp.data.world) {
            setWorld(followUp.data.world);
            worldRef.current = followUp.data.world;
          }
          if (followUp.data.tick) {
            applyPersistedTick(followUp.data.tick);
          }
          continue;
        }

        const settled = followUp.data;
        setWorld(settled.world);
        worldRef.current = settled.world;
        applyPersistedTick(settled.tick);
        setPlanningMessage(null);
        setError(null);
        return;
      }
      throw new Error("Timed out waiting for reset to finish");
    }
    const data = result.data;
    setWorld(data.world);
    worldRef.current = data.world;
    applyPersistedTick(data.tick);
    setPlanningMessage(null);
    setError(null);
  }, [applyPersistedTick]);

  const setSpeed = useCallback(
    async (multiplier: number) => {
      const requestId = worldRequestIdRef.current + 1;
      worldRequestIdRef.current = requestId;
      const result = await fetchJson<{
        world: SimulationWorld;
        tick: PersistedTickState;
      }>("/api/sim/control", {
        method: "POST",
        body: JSON.stringify({ action: "speed", multiplier }),
      });
      if (worldRequestIdRef.current !== requestId) {
        return;
      }
      if (result.kind === "planning") {
        setPlanningMessage(toPlanningMessage(result.data));
        return;
      }
      const data = result.data;
      setWorld(data.world);
      worldRef.current = data.world;
      const currentTick = clockRef.current!.getState();
      const mergedTick = {
        ...data.tick,
        elapsedSeconds: currentTick.elapsedSeconds,
        speedMultiplier: multiplier,
      };
      clockRef.current!.setSpeed(multiplier);
      setTick(clockRef.current!.getState());
      setPlanningMessage(null);
      if (worldRef.current) {
        const persistedTick: PersistedTickState = {
          ...mergedTick,
          seed: worldRef.current.seed,
        };
        await syncTickToServer(persistedTick);
      }
    },
    [syncTickToServer],
  );

  const simulateBreakdown = useCallback(async (vehicleId?: string) => {
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;
    const result = await fetchJson<{ world: SimulationWorld; tick: PersistedTickState }>(
      "/api/sim/breakdown",
      {
        method: "POST",
        body: JSON.stringify(
          vehicleId ? { vehicleId } : {},
        ),
      },
    );
    if (worldRequestIdRef.current !== requestId) {
      return;
    }
    if (result.kind === "planning") {
      setPlanningMessage(toPlanningMessage(result.data));
      return;
    }
    const data = result.data;
    setWorld(data.world);
    worldRef.current = data.world;
    const currentTick = clockRef.current!.getState();
    applyPersistedTick({ ...data.tick, elapsedSeconds: currentTick.elapsedSeconds });
    setPlanningMessage(null);
    if (worldRef.current) {
      const persistedTick: PersistedTickState = {
        ...currentTick,
        seed: worldRef.current.seed,
      };
      await syncTickToServer(persistedTick);
    }
  }, [applyPersistedTick, syncTickToServer]);

  const simulateCongestion = useCallback(async (vehicleId?: string) => {
    const requestId = worldRequestIdRef.current + 1;
    worldRequestIdRef.current = requestId;
    const result = await fetchJson<{ world: SimulationWorld; tick: PersistedTickState }>(
      "/api/sim/congestion",
      {
        method: "POST",
        body: JSON.stringify(
          vehicleId ? { vehicleId } : {},
        ),
      },
    );
    if (worldRequestIdRef.current !== requestId) {
      return;
    }
    if (result.kind === "planning") {
      setPlanningMessage(toPlanningMessage(result.data));
      return;
    }
    const data = result.data;
    setWorld(data.world);
    worldRef.current = data.world;
    const currentTick = clockRef.current!.getState();
    applyPersistedTick({ ...data.tick, elapsedSeconds: currentTick.elapsedSeconds });
    setPlanningMessage(null);
    if (worldRef.current) {
      const persistedTick: PersistedTickState = {
        ...currentTick,
        seed: worldRef.current.seed,
      };
      await syncTickToServer(persistedTick);
    }
  }, [applyPersistedTick, syncTickToServer]);

  return {
    world,
    tick,
    loading,
    error,
    planningMessage,
    refresh,
    burstRefresh,
    start,
    pause,
    reset,
    setSpeed,
    simulateBreakdown,
    simulateCongestion,
    breakdownTriggered: (world?.incidents.length ?? 0) > 0,
  };
}
