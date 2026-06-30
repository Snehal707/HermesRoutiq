"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulatorSnapshot } from "@hermes-routiq/shared";

const REFRESH_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SNAPSHOT_CACHE_KEY = "hermes-routiq:simulator-snapshot";

let lastSnapshotCache: SimulatorSnapshot | null = null;

function loadCachedSnapshot(): SimulatorSnapshot | null {
  if (lastSnapshotCache) {
    return lastSnapshotCache;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as SimulatorSnapshot;
    lastSnapshotCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function persistSnapshot(snapshot: SimulatorSnapshot) {
  lastSnapshotCache = snapshot;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures and keep the in-memory cache.
  }
}

export function isSimulatorOverlayEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SIMULATION_BACKEND_ENABLED === "true";
}

export function useSimulatorSnapshot(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<SimulatorSnapshot | null>(() =>
    loadCachedSnapshot(),
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const snapshotRef = useRef<SimulatorSnapshot | null>(snapshot);

  const refresh = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setError(null);
      return;
    }

    let disposed = false;
    let timeout: number | null = null;

    const poll = async () => {
      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let payload: (SimulatorSnapshot & { error?: string }) | null = null;
        let response: Response;
        try {
          response = await fetch("/api/simulator/snapshot", {
            cache: "no-store",
            signal: controller.signal,
          });
          payload = (await response.json()) as SimulatorSnapshot & {
            error?: string;
          };
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error("Timed out loading simulator snapshot");
          }
          throw error;
        } finally {
          window.clearTimeout(timeout);
        }

        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to load simulator snapshot");
        }

        if (!disposed) {
          persistSnapshot(payload);
          setSnapshot(payload);
          setError(null);
        }
      } catch (refreshError: unknown) {
        if (!disposed) {
          const message =
            refreshError instanceof Error
              ? refreshError.message
              : "Failed to load simulator snapshot";
          setError(snapshotRef.current ? null : message);
        }
      } finally {
        if (!disposed) {
          timeout = window.setTimeout(() => void poll(), REFRESH_INTERVAL_MS);
        }
      }
    };

    void poll();

    return () => {
      disposed = true;
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
    };
  }, [enabled, refreshNonce]);

  return { snapshot, error, refresh };
}
