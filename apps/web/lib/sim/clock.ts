"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulationWorld } from "./types";
import { createWorld, resetWorld, triggerBreakdown } from "./world";

export type SimClockStatus = "idle" | "running" | "paused";

export interface SimTickState {
  elapsedSeconds: number;
  speedMultiplier: number;
  status: SimClockStatus;
}

type SimListener = (state: SimTickState) => void;

export class SimClock {
  private elapsedSeconds = 0;
  private speedMultiplier = 1;
  private status: SimClockStatus = "idle";
  private rafId: number | null = null;
  private lastFrameMs: number | null = null;
  private listeners = new Set<SimListener>();

  subscribe(listener: SimListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): SimTickState {
    return {
      elapsedSeconds: this.elapsedSeconds,
      speedMultiplier: this.speedMultiplier,
      status: this.status,
    };
  }

  getElapsedSeconds(): number {
    return this.elapsedSeconds;
  }

  start(): void {
    if (this.status === "running") {
      return;
    }
    this.status = "running";
    this.lastFrameMs = null;
    this.scheduleFrame();
    this.emit();
  }

  pause(): void {
    if (this.status !== "running") {
      return;
    }
    this.status = "paused";
    this.cancelFrame();
    this.emit();
  }

  reset(): void {
    this.cancelFrame();
    this.elapsedSeconds = 0;
    this.speedMultiplier = 1;
    this.status = "idle";
    this.lastFrameMs = null;
    this.emit();
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
    this.emit();
  }

  /** Restore tick state from Redis without starting the animation loop. */
  hydrate(state: SimTickState): void {
    this.cancelFrame();
    this.elapsedSeconds = state.elapsedSeconds;
    this.speedMultiplier = state.speedMultiplier;
    this.status = state.status;
    this.lastFrameMs = null;
    this.emit();
  }

  /** Resume the RAF loop after hydrate when status is running. */
  resumeIfRunning(): void {
    if (this.status === "running") {
      this.lastFrameMs = null;
      this.scheduleFrame();
    }
  }

  private scheduleFrame(): void {
    this.cancelFrame();
    this.rafId = window.requestAnimationFrame(this.onFrame);
  }

  private cancelFrame(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private onFrame = (frameMs: number): void => {
    if (this.status !== "running") {
      return;
    }

    if (this.lastFrameMs !== null) {
      const deltaSeconds = (frameMs - this.lastFrameMs) / 1000;
      this.elapsedSeconds += deltaSeconds * this.speedMultiplier;
      this.emit();
    }

    this.lastFrameMs = frameMs;
    this.scheduleFrame();
  };

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  destroy(): void {
    this.cancelFrame();
    this.listeners.clear();
  }
}

export interface UseSimClockResult {
  world: SimulationWorld;
  tick: SimTickState;
  start: () => void;
  pause: () => void;
  reset: () => void;
  setSpeed: (multiplier: number) => void;
  simulateBreakdown: () => void;
  breakdownTriggered: boolean;
}

export function useSimClock(initialSeed?: number): UseSimClockResult {
  const clockRef = useRef<SimClock | null>(null);
  if (clockRef.current === null) {
    clockRef.current = new SimClock();
  }

  const [world, setWorld] = useState<SimulationWorld>(() =>
    createWorld(initialSeed),
  );
  const [tick, setTick] = useState<SimTickState>(() =>
    clockRef.current!.getState(),
  );

  useEffect(() => {
    const clock = clockRef.current!;
    return clock.subscribe(setTick);
  }, []);

  useEffect(() => {
    return () => {
      clockRef.current?.destroy();
    };
  }, []);

  const start = useCallback(() => {
    clockRef.current?.start();
  }, []);

  const pause = useCallback(() => {
    clockRef.current?.pause();
  }, []);

  const reset = useCallback(() => {
    clockRef.current?.reset();
    setWorld(createWorld(initialSeed));
  }, [initialSeed]);

  const setSpeed = useCallback((multiplier: number) => {
    clockRef.current?.setSpeed(multiplier);
  }, []);

  const simulateBreakdown = useCallback(() => {
    const elapsed = clockRef.current?.getElapsedSeconds() ?? 0;
    setWorld((current) => triggerBreakdown(current, elapsed));
  }, []);

  const breakdownTriggered = world.incidents.length > 0;

  return {
    world,
    tick,
    start,
    pause,
    reset,
    setSpeed,
    simulateBreakdown,
    breakdownTriggered,
  };
}

export { resetWorld };
