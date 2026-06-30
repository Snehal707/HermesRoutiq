"use client";

import type { SimulatorSnapshot } from "@hermes-routiq/shared";
import { useEffect, useState } from "react";

export function useAnimatedSimulatorTime(
  snapshot: SimulatorSnapshot | null,
  enabled: boolean,
): number | null {
  const [animatedTimeSeconds, setAnimatedTimeSeconds] = useState<number | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || !snapshot) {
      setAnimatedTimeSeconds(null);
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();
    const baseSimTimeSeconds = snapshot.sim_time_seconds;
    const simulationSpeed = snapshot.simulation_speed;

    const animate = () => {
      const elapsedWallSeconds = (performance.now() - startedAt) / 1_000;
      setAnimatedTimeSeconds(
        baseSimTimeSeconds + elapsedWallSeconds * simulationSpeed,
      );
      frameId = window.requestAnimationFrame(animate);
    };

    setAnimatedTimeSeconds(baseSimTimeSeconds);
    frameId = window.requestAnimationFrame(animate);

    return () => window.cancelAnimationFrame(frameId);
  }, [
    enabled,
    snapshot?.generated_at,
    snapshot?.sim_time_seconds,
    snapshot?.simulation_speed,
  ]);

  return animatedTimeSeconds;
}
