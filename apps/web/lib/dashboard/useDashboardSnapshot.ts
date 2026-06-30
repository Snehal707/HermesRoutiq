"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "./types";

const REFRESH_INTERVAL_MS = 2_500;
const BURST_REFRESH_INTERVAL_MS = 350;
const BURST_REFRESH_DURATION_MS = 8_000;
// Matches the sim clock: the dev server can queue requests for several seconds
// during polling bursts, so allow generous headroom before aborting.
const REQUEST_TIMEOUT_MS = 20_000;
const SNAPSHOT_CACHE_KEY = "hermes-routiq:dashboard-snapshot";

interface BurstWindow {
  startedAt: number;
  durationMs: number;
  intervalMs: number;
}

// Last-known snapshot, kept in memory and mirrored to sessionStorage so a single
// slow/aborted request (or a page reload) keeps the dashboard populated instead
// of flashing empty.
let lastSnapshotCache: DashboardSnapshot | null = null;

function loadCachedSnapshot(): DashboardSnapshot | null {
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
    const parsed = JSON.parse(raw) as DashboardSnapshot;
    lastSnapshotCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function cacheSnapshot(snapshot: DashboardSnapshot): void {
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

export function useDashboardSnapshot() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(() =>
    loadCachedSnapshot(),
  );
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const requestIdRef = useRef(0);
  const burstWindowRef = useRef<BurstWindow | null>(null);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let payload: (DashboardSnapshot & { error?: string }) | null = null;
    let response: Response;
    try {
      response = await fetch("/api/dashboard/snapshot", {
        cache: "no-store",
        signal: controller.signal,
      });
      payload = (await response.json()) as DashboardSnapshot & {
        error?: string;
      };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Timed out loading dashboard data");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to load dashboard data");
    }

    if (
      generationRef.current !== generation ||
      requestIdRef.current !== requestId
    ) {
      return;
    }

    cacheSnapshot(payload);
    setSnapshot(payload);
    setError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    let timeout: number | null = null;

    const poll = async () => {
      try {
        await refresh();
      } catch (refreshError: unknown) {
        if (disposed) {
          return;
        }
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Failed to refresh dashboard data",
        );
      } finally {
        if (!disposed) {
          const burstWindow = burstWindowRef.current;
          const burstActive =
            burstWindow !== null &&
            Date.now() - burstWindow.startedAt < burstWindow.durationMs;
          if (!burstActive && burstWindow !== null) {
            burstWindowRef.current = null;
          }
          timeout = window.setTimeout(
            () => void poll(),
            burstActive
              ? burstWindow?.intervalMs ?? BURST_REFRESH_INTERVAL_MS
              : REFRESH_INTERVAL_MS,
          );
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
  }, [refresh]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    requestIdRef.current += 1;
    burstWindowRef.current = null;
    lastSnapshotCache = null;
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(SNAPSHOT_CACHE_KEY);
      } catch {
        // Ignore storage failures.
      }
    }
    setSnapshot(null);
    setError(null);
  }, []);

  const burstRefresh = useCallback(
    (options?: { durationMs?: number; intervalMs?: number }) => {
      burstWindowRef.current = {
        startedAt: Date.now(),
        durationMs: options?.durationMs ?? BURST_REFRESH_DURATION_MS,
        intervalMs: options?.intervalMs ?? BURST_REFRESH_INTERVAL_MS,
      };
      void refresh().catch(() => undefined);
    },
    [refresh],
  );

  return { snapshot, error, refresh, burstRefresh, clear };
}
