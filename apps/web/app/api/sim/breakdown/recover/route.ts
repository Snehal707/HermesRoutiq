import { NextResponse } from "next/server";

import { executeBreakdownRecoveryReroute } from "@/lib/routing/breakdown";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      incidentId?: unknown;
      plannedAssignments?: unknown;
      simulatePersistFailure?: unknown;
    };

    if (typeof body.incidentId !== "string" || !body.incidentId) {
      return NextResponse.json(
        { error: "incidentId is required" },
        { status: 400 },
      );
    }
    if (
      !Array.isArray(body.plannedAssignments) ||
      body.plannedAssignments.some(
        (assignment) =>
          !assignment ||
          typeof assignment !== "object" ||
          typeof (assignment as { vehicleId?: unknown }).vehicleId !== "string" ||
          !(assignment as { vehicleId?: string }).vehicleId ||
          !Array.isArray((assignment as { orderIds?: unknown }).orderIds) ||
          ((assignment as { orderIds: unknown[] }).orderIds).some(
            (orderId) => typeof orderId !== "string" || !orderId,
          ),
      )
    ) {
      return NextResponse.json(
        {
          error:
            "plannedAssignments must be an array of { vehicleId, orderIds[] }",
        },
        { status: 400 },
      );
    }

    const result = await executeBreakdownRecoveryReroute({
      incidentId: body.incidentId,
      plannedAssignments: body.plannedAssignments as Array<{
        vehicleId: string;
        orderIds: string[];
      }>,
      simulatePersistFailure: body.simulatePersistFailure === true,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to execute breakdown recovery reroute";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
