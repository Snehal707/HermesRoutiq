import { NextResponse } from "next/server";
import { getStripeServer } from "@/lib/stripe/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("session_id")?.trim();

    if (!sessionId) {
      return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
    }

    const stripe = getStripeServer();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return NextResponse.json({
      sessionId: session.id,
      orderId:
        session.client_reference_id ??
        session.metadata?.orderId ??
        null,
      paymentStatus: session.payment_status ?? null,
      status: session.status ?? null,
      customerEmail: session.customer_details?.email ?? null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Stripe Checkout session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
