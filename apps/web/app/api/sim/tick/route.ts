import { NextResponse } from "next/server";
import type { PersistedTickState, RedisVehicleState } from "@/lib/sim/persistence";
import {
  isSimClockStatus,
  persistTickAndVehicles,
  reconcileSimulationProgress,
} from "@/lib/sim/persistence";
import type { SimulationWorld } from "@/lib/sim/types";

interface TickPatchBody {
  tick: PersistedTickState;
  vehicleStates: Record<string, RedisVehicleState>;
  world?: SimulationWorld;
}

let lastReconciledTickKey: string | null = null;
let scheduledReconciliationTick: PersistedTickState | null = null;
let reconciliationWorker: Promise<void> | null = null;

function reconciliationKey(tick: PersistedTickState): string {
  return `${tick.seed}:${tick.status}:${Math.floor(tick.elapsedSeconds)}`;
}

function scheduleReconciliation(tick: PersistedTickState): void {
  if (tick.status !== "running") {
    return;
  }

  const nextKey = reconciliationKey(tick);
  if (
    nextKey === lastReconciledTickKey ||
    nextKey ===
      (scheduledReconciliationTick
        ? reconciliationKey(scheduledReconciliationTick)
        : null)
  ) {
    return;
  }

  scheduledReconciliationTick = tick;
  if (reconciliationWorker) {
    return;
  }

  reconciliationWorker = (async () => {
    while (scheduledReconciliationTick) {
      const nextTick = scheduledReconciliationTick;
      scheduledReconciliationTick = null;
      const nextReconcileKey = reconciliationKey(nextTick);

      try {
        await reconcileSimulationProgress(nextTick);
        lastReconciledTickKey = nextReconcileKey;
      } catch (error) {
        console.error("Background sim reconciliation failed", {
          tick: nextTick,
          error,
        });
      }
    }
  })().finally(() => {
    reconciliationWorker = null;
  });
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as TickPatchBody;

    if (
      !body.tick ||
      typeof body.tick.elapsedSeconds !== "number" ||
      !isSimClockStatus(body.tick.status)
    ) {
      return NextResponse.json({ error: "Invalid tick payload" }, { status: 400 });
    }

    if (body.world) {
      await persistTickAndVehicles(body.tick, body.world);
    } else if (body.vehicleStates) {
      const { saveTickToRedis, saveVehicleStatesToRedis } = await import(
        "@/lib/sim/persistence"
      );
      await saveTickToRedis(body.tick);
      await saveVehicleStatesToRedis(body.vehicleStates);
    } else {
      const { saveTickToRedis } = await import("@/lib/sim/persistence");
      await saveTickToRedis(body.tick);
    }

    scheduleReconciliation(body.tick);

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to persist tick";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
