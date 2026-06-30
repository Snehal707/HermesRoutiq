import { NextResponse } from "next/server";

import { executeCongestionReroute } from "@/lib/routing/congestion";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { incidentId?: string };
    if (!body.incidentId) {
      return NextResponse.json(
        { error: "incidentId is required" },
        { status: 400 },
      );
    }

    const result = await executeCongestionReroute({
      incidentId: body.incidentId,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to execute congestion reroute";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
