import { NextResponse } from "next/server";
import {
  loadPersistedSimulation,
  readRoutingPlanningState,
  resetSimulation,
  RoutingPlanningError,
  updateTickControl,
} from "@/lib/sim/persistence";
import { getSimulationSeed } from "@/lib/sim/world";
import { isSimClockStatus } from "@/lib/sim/persistence";

interface ControlBody {
  action: "start" | "pause" | "reset" | "speed";
  multiplier?: number;
}

async function planningResponse(): Promise<NextResponse> {
  const planning = await readRoutingPlanningState();
  if (!planning) {
    return NextResponse.json({ status: "planning" }, { status: 202 });
  }

  if (planning.phase === "resetting") {
    return NextResponse.json({ status: "planning", planning }, { status: 202 });
  }

  try {
    const { world, tick } = await loadPersistedSimulation();
    return NextResponse.json({ status: "planning", planning, world, tick }, { status: 202 });
  } catch {
    return NextResponse.json({ status: "planning", planning }, { status: 202 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as ControlBody;

    if (body.action !== "reset" && (await readRoutingPlanningState())) {
      return planningResponse();
    }

    if (body.action === "reset") {
      const seed = getSimulationSeed();
      const { world, tick } = await resetSimulation(seed, "empty");
      return NextResponse.json({ world, tick });
    }

    const { tick } = await loadPersistedSimulation();
    let nextTick = { ...tick };

    switch (body.action) {
      case "start":
        nextTick = { ...nextTick, status: "running" };
        break;
      case "pause":
        nextTick = { ...nextTick, status: "paused" };
        break;
      case "speed":
        if (typeof body.multiplier !== "number" || body.multiplier <= 0) {
          return NextResponse.json(
            { error: "Invalid speed multiplier" },
            { status: 400 },
          );
        }
        nextTick = { ...nextTick, speedMultiplier: body.multiplier };
        break;
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    if (!isSimClockStatus(nextTick.status)) {
      return NextResponse.json({ error: "Invalid tick status" }, { status: 400 });
    }

    await updateTickControl(nextTick);
    const { world } = await loadPersistedSimulation();

    return NextResponse.json({ world, tick: nextTick });
  } catch (error: unknown) {
    if (error instanceof RoutingPlanningError) {
      return planningResponse();
    }

    const message =
      error instanceof Error ? error.message : "Failed to update simulation control";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
