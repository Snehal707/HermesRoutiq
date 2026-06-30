import "server-only";

import Stripe from "stripe";
import { requireServerEnv } from "@/lib/env/server";

let stripeClient: Stripe | null = null;

export function getStripeServer(): Stripe {
  if (!stripeClient) {
    const env = requireServerEnv();
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
}
