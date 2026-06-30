import { NextResponse } from "next/server";
import type { ScheduledSimulatorEvent } from "@hermes-routiq/shared";
import { reconcileScheduledSimulatorEvents } from "@/lib/sim/scheduler";

export const dynamic = "force-dynamic";

interface ReconcileBody {
  simTimeSeconds: number;
  scheduledEvents: ScheduledSimulatorEvent[];
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as ReconcileBody;

    if (
      typeof body.simTimeSeconds !== "number" ||
      !Number.isFinite(body.simTimeSeconds) ||
      !Array.isArray(body.scheduledEvents)
    ) {
      return NextResponse.json(
        { error: "Invalid reconcile payload" },
        { status: 400 },
      );
    }

    const result = await reconcileScheduledSimulatorEvents({
      simTimeSeconds: body.simTimeSeconds,
      scheduledEvents: body.scheduledEvents,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to reconcile scheduled simulator events";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
