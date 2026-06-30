import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  ensureHermesDispatchForPaidOrder,
  markCheckoutOrderPaid,
  parseCheckoutMetadata,
  recordStripeCheckoutPaymentFailure,
} from "@/lib/orders";
import { getStripeServer } from "@/lib/stripe/server";
import { requireServerEnv } from "@/lib/env/server";

export const dynamic = "force-dynamic";

function paymentIntentIdFromSession(
  session: Stripe.Checkout.Session,
): string | null {
  return typeof session.payment_intent === "string" ? session.payment_intent : null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const stripe = getStripeServer();
  const env = requireServerEnv();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Webhook signature verification failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = parseCheckoutMetadata(session.metadata);

      const result = await markCheckoutOrderPaid({
        stripeEventId: event.id,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: paymentIntentIdFromSession(session),
        metadata,
      });

      void ensureHermesDispatchForPaidOrder(result.orderId).catch((error) => {
        console.error("Asynchronous Hermes dispatch failed", {
          orderId: result.orderId,
          error,
        });
      });

      return NextResponse.json({
        received: true,
        orderId: result.orderId,
        created: result.created,
        dispatchRequested: true,
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId = intent.metadata?.orderId?.trim();

      if (!orderId) {
        return NextResponse.json({
          received: true,
          ignored: true,
          reason: "missing_order_id_metadata",
        });
      }

      const result = await recordStripeCheckoutPaymentFailure({
        stripeEventId: event.id,
        stripePaymentIntentId: intent.id,
        orderId,
        errorMessage: intent.last_payment_error?.message ?? null,
        declineCode: intent.last_payment_error?.decline_code ?? null,
      });

      return NextResponse.json({
        received: true,
        orderId,
        incidentId: result.incidentId,
        created: result.created,
      });
    }

    return NextResponse.json({ received: true, ignored: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to process Stripe webhook";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
