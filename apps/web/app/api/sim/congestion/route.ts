import { NextResponse } from "next/server";
import {
  loadPersistedSimulation,
  persistBreakdown,
  persistTickAndVehicles,
} from "@/lib/sim/persistence";
import {
  findCongestionVehicleId,
  hasActiveCongestion,
  hasActiveCongestionForOrders,
  triggerCongestion,
} from "@/lib/sim/world";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      vehicleId?: unknown;
    };
    const { world, tick } = await loadPersistedSimulation();
    const previousIncidentCount = world.incidents.length;
    const previousLastIncidentId =
      world.incidents[world.incidents.length - 1]?.id ?? null;
    const congestionVehicleId =
      typeof body.vehicleId === "string" && body.vehicleId.trim().length > 0
        ? body.vehicleId.trim()
        : findCongestionVehicleId(world, tick.elapsedSeconds);

    if (!congestionVehicleId) {
      return NextResponse.json(
        { error: "No active delivery vehicle is available for a congestion incident." },
        { status: 409 },
      );
    }

    if (hasActiveCongestion(world, congestionVehicleId)) {
      return NextResponse.json(
        { error: "Congestion already active for the affected vehicle" },
        { status: 409 },
      );
    }
    const targetOrderIds = world.orders
      .filter((order) => order.vehicleId === congestionVehicleId)
      .filter((order) => order.status === "assigned" || order.status === "in_transit")
      .map((order) => order.id);
    if (hasActiveCongestionForOrders(world, targetOrderIds)) {
      return NextResponse.json(
        { error: "Congestion already active for the selected delivery" },
        { status: 409 },
      );
    }

    const updatedWorld = triggerCongestion(
      world,
      tick.elapsedSeconds,
      congestionVehicleId,
      // The user explicitly selected this vehicle, so honor the click even if its
      // route doesn't cross the fixed congestion zone.
      { bypassExposureGate: true },
    );
    const incident = updatedWorld.incidents[updatedWorld.incidents.length - 1];
    const createdNewIncident =
      updatedWorld.incidents.length > previousIncidentCount &&
      incident?.id !== previousLastIncidentId;

    if (!incident || !createdNewIncident || incident.type !== "congestion") {
      return NextResponse.json(
        { error: "Congestion could not be created for the selected vehicle." },
        { status: 409 },
      );
    }

    await persistBreakdown(updatedWorld, incident);
    await persistTickAndVehicles(tick, updatedWorld);

    return NextResponse.json({ world: updatedWorld, tick });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to simulate congestion";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
