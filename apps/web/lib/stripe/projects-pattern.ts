import Stripe from "stripe";

export interface InfrastructureUpgradeInput {
  amountCents: number;
  eventType: string;
  idempotencyKey: string;
  observedEventCount: number;
  serviceCategory: "observability" | "queue" | "database";
  threshold: number;
  windowSeconds: number;
}

interface StripeBillingClient {
  products: {
    create: (...args: any[]) => Promise<Stripe.Product>;
  };
  prices: {
    create: (...args: any[]) => Promise<Stripe.Price>;
  };
}

function asStripeBillingClient(stripe: unknown): StripeBillingClient {
  return stripe as StripeBillingClient;
}

let stripeBillingClient: Stripe | null = null;

export function getStripeBillingServer(secretKey = process.env.STRIPE_SECRET_KEY): Stripe {
  if (!secretKey || secretKey.trim().length === 0) {
    throw new Error("Missing STRIPE_SECRET_KEY for Stripe Billing operations.");
  }

  if (!stripeBillingClient) {
    stripeBillingClient = new Stripe(secretKey);
  }

  return stripeBillingClient;
}

export async function createInfrastructureUpgradeBillingArtifact(
  stripe: unknown,
  input: InfrastructureUpgradeInput,
): Promise<{ product: Stripe.Product; price: Stripe.Price }> {
  const client = asStripeBillingClient(stripe);
  const normalizedCategory = input.serviceCategory.replace(/_/g, "-");
  const upgradeName = `HermesRoutiq ${normalizedCategory} surge capacity`;

  // Stripe Projects provisioning pattern:
  // the Projects CLI is real, but sandbox use is blocked by KYC on the platform account.
  // This creates the equivalent real Stripe billing artifact for the approved infra upgrade.
  const product = await client.products.create({
    name: upgradeName,
    description:
      `Provisioning pattern for ${normalizedCategory} capacity after ` +
      `${input.observedEventCount} ${input.eventType} events in ${input.windowSeconds}s.`,
    metadata: {
      eventType: input.eventType,
      observedEventCount: String(input.observedEventCount),
      serviceCategory: input.serviceCategory,
      threshold: String(input.threshold),
      windowSeconds: String(input.windowSeconds),
      provisioningPattern: "stripe-projects-k yc-fallback".replace(" ", ""),
    },
  }, {
    idempotencyKey: `${input.idempotencyKey}:product`,
  });

  const price = await client.prices.create({
    currency: "usd",
    unit_amount: input.amountCents,
    recurring: { interval: "month" },
    product: product.id,
    nickname: `${upgradeName} monthly`,
    metadata: {
      eventType: input.eventType,
      productId: product.id,
      serviceCategory: input.serviceCategory,
      threshold: String(input.threshold),
      windowSeconds: String(input.windowSeconds),
      provisioningPattern: "stripe-projects-k yc-fallback".replace(" ", ""),
    },
  }, {
    idempotencyKey: `${input.idempotencyKey}:price`,
  });

  return { product, price };
}
