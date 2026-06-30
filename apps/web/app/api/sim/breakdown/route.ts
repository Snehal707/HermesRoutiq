import { NextResponse } from "next/server";
import {
  loadPersistedSimulation,
  persistBreakdown,
  persistTickAndVehicles,
} from "@/lib/sim/persistence";
import { triggerBreakdown } from "@/lib/sim/world";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      vehicleId?: unknown;
    };
    const { world, tick } = await loadPersistedSimulation();
    const previousIncidentCount = world.incidents.length;
    const previousLastIncidentId =
      world.incidents[world.incidents.length - 1]?.id ?? null;
    const vehicleId =
      typeof body.vehicleId === "string" && body.vehicleId.trim().length > 0
        ? body.vehicleId.trim()
        : world.breakdownVehicleId;

    if (
      world.incidents.some(
        (incident) =>
          incident.type === "vehicle_breakdown" &&
          incident.vehicleId === vehicleId,
      )
    ) {
      return NextResponse.json(
        { error: "Breakdown already active" },
        { status: 409 },
      );
    }

    // Incident ID is assigned inside triggerBreakdown via createIncidentId() (UUID).
    const updatedWorld = triggerBreakdown(world, tick.elapsedSeconds, vehicleId);
    const incident = updatedWorld.incidents[updatedWorld.incidents.length - 1];

    const createdNewIncident =
      updatedWorld.incidents.length > previousIncidentCount &&
      incident?.id !== previousLastIncidentId;

    if (!incident || !createdNewIncident || incident.type !== "vehicle_breakdown") {
      return NextResponse.json(
        { error: "Breakdown could not be created for the selected vehicle." },
        { status: 409 },
      );
    }

    await persistBreakdown(updatedWorld, incident);
    await persistTickAndVehicles(tick, updatedWorld);

    return NextResponse.json({ world: updatedWorld, tick });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to simulate breakdown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
