import { NextResponse } from "next/server";
import {
  buildCheckoutOrderMetadata,
  ensurePendingCheckoutOrder,
  runStripePaymentDeclineDemo,
  type CheckoutOrderRequestInput,
  type CheckoutScenario,
} from "@/lib/orders";
import { ensureInitialized } from "@/lib/sim/persistence";
import { getStripeServer } from "@/lib/stripe/server";

export const dynamic = "force-dynamic";

function parseCheckoutRequestInput(
  value: unknown,
): CheckoutOrderRequestInput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.pickupHubId !== "string" ||
    typeof candidate.customerName !== "string" ||
    typeof candidate.destinationLat !== "number" ||
    typeof candidate.destinationLng !== "number"
  ) {
    return undefined;
  }

  return {
    pickupHubId: candidate.pickupHubId,
    customerName: candidate.customerName,
    destinationLat: candidate.destinationLat,
    destinationLng: candidate.destinationLng,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await ensureInitialized();

    const stripe = getStripeServer();
    const body = (await request.json().catch(() => ({}))) as {
      orderId?: string;
      scenario?: CheckoutScenario;
      request?: CheckoutOrderRequestInput;
    };
    const orderRequest = parseCheckoutRequestInput(body.request);
    const scenario = body.scenario === "payment_declined"
      ? "payment_declined"
      : "success";

    if (scenario === "payment_declined") {
      const result = await runStripePaymentDeclineDemo({
        orderId: typeof body.orderId === "string" ? body.orderId : undefined,
        request: orderRequest,
      });

      return NextResponse.json({
        orderId: result.orderId,
        incidentId: result.incidentId,
        created: result.created,
        scenario,
        declineCode: result.declineCode,
        errorMessage: result.errorMessage,
        paymentIntentId: result.paymentIntentId,
      });
    }

    const metadata = await buildCheckoutOrderMetadata({
      orderId: typeof body.orderId === "string" ? body.orderId : undefined,
      request: orderRequest,
      blockOnIntake: false,
    });
    const sessionMetadata: Record<string, string> = {
      orderId: metadata.orderId,
      customerId: metadata.customerId,
      pickupHubId: metadata.pickupHubId,
      quotedPriceCents: String(metadata.quotedPriceCents),
      checkoutScenario: scenario,
    };
    const origin = new URL(request.url).origin;
    const idempotencyKey = `checkout-session:${metadata.orderId}`;
    const cancelParams = new URLSearchParams({
      checkout: "cancelled",
      scenario,
      order_id: metadata.orderId,
    });
    const successParams = new URLSearchParams({
      checkout: "success",
      order_id: metadata.orderId,
      scenario,
    });
    const successUrl =
      `${origin}/?${successParams.toString()}&session_id={CHECKOUT_SESSION_ID}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        success_url: successUrl,
        cancel_url: `${origin}/?${cancelParams.toString()}`,
        client_reference_id: metadata.orderId,
        payment_intent_data: {
          metadata: {
            orderId: metadata.orderId,
            checkoutScenario: scenario,
          },
        },
        metadata: sessionMetadata,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "HermesRoutiq delivery order",
                description: "Stripe test-mode delivery payment",
              },
              unit_amount: metadata.quotedPriceCents,
            },
            quantity: 1,
          },
        ],
      },
      {
        idempotencyKey,
      },
    );

    if (!session.url) {
      throw new Error("Stripe Checkout session URL was not returned.");
    }

    await ensurePendingCheckoutOrder({
      metadata,
      stripeCheckoutSessionId: session.id,
    });

    return NextResponse.json({
      sessionId: session.id,
      sessionUrl: session.url,
      orderId: metadata.orderId,
      quotedPriceCents: metadata.quotedPriceCents,
      scenario,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to create checkout session";
    const status =
      message.toLowerCase().includes("declined the delivery") ||
      message.toLowerCase().includes("capacity")
        ? 409
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
