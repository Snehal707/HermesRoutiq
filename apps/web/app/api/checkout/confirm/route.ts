import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  ensureHermesDispatchForPaidOrder,
  markCheckoutOrderPaid,
  parseCheckoutMetadata,
} from "@/lib/orders";
import { getStripeServer } from "@/lib/stripe/server";

export const dynamic = "force-dynamic";
const DISPATCH_KICKOFF_WAIT_MS = 1_200;

function paymentIntentIdFromSession(
  session: Stripe.Checkout.Session,
): string | null {
  return typeof session.payment_intent === "string" ? session.payment_intent : null;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
    };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const stripe = getStripeServer();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return NextResponse.json({
        confirmed: false,
        orderId: session.client_reference_id ?? session.metadata?.orderId ?? null,
        paymentStatus: session.payment_status ?? null,
        sessionStatus: session.status ?? null,
      });
    }

    const metadata = parseCheckoutMetadata(session.metadata);
    const result = await markCheckoutOrderPaid({
      stripeEventId: `stripe-confirm:${session.id}`,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentIdFromSession(session),
      metadata,
    });

    const dispatchKickoff = ensureHermesDispatchForPaidOrder(result.orderId).catch(
      (dispatchError: unknown) => {
        console.error("Async paid-order dispatch failed after checkout confirm", {
          orderId: result.orderId,
          dispatchError,
        });
      },
    );
    await Promise.race([
      dispatchKickoff,
      new Promise((resolve) => setTimeout(resolve, DISPATCH_KICKOFF_WAIT_MS)),
    ]);

    return NextResponse.json({
      confirmed: true,
      orderId: result.orderId,
      created: result.created,
      dispatchRequested: true,
      paymentStatus: session.payment_status ?? null,
      sessionStatus: session.status ?? null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to confirm checkout session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
