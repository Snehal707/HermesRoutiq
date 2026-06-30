import { NextResponse } from "next/server";
import {
  ensureInitialized,
  loadPersistedSimulation,
  readRoutingPlanningState,
  RoutingPlanningError,
} from "@/lib/sim/persistence";

export const dynamic = "force-dynamic";

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

export async function GET(): Promise<NextResponse> {
  try {
    if (await readRoutingPlanningState()) {
      return planningResponse();
    }

    await ensureInitialized();
    const { world, tick } = await loadPersistedSimulation();
    return NextResponse.json({ world, tick });
  } catch (error: unknown) {
    if (error instanceof RoutingPlanningError) {
      return planningResponse();
    }

    const message =
      error instanceof Error ? error.message : "Failed to load simulation state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
