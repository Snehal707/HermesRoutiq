import { NextResponse } from "next/server";
import { recordPaymentDeclinedIncident } from "@/lib/orders";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      orderId?: string;
      checkoutSessionId?: string | null;
    };

    if (!body.orderId) {
      return NextResponse.json({ error: "orderId is required" }, { status: 400 });
    }

    const result = await recordPaymentDeclinedIncident({
      orderId: body.orderId,
      checkoutSessionId:
        typeof body.checkoutSessionId === "string" ? body.checkoutSessionId : null,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to record payment declined incident";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
