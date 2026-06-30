import dotenv from "dotenv";
import Stripe from "stripe";
import { chromium } from "playwright";

dotenv.config({ path: "apps/web/.env.local" });

const DEFAULT_TOTAL_AMOUNT_USD = 50;
const MAX_CHUNK_AMOUNT_CENTS = 500_000;

function parseTotalAmountCents(): number {
  const usdArgIndex = process.argv.findIndex((arg) => arg === "--amount-usd");
  const centsArgIndex = process.argv.findIndex((arg) => arg === "--amount-cents");

  if (centsArgIndex >= 0) {
    const raw = process.argv[centsArgIndex + 1];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("Invalid --amount-cents value.");
    }
    return parsed;
  }

  if (usdArgIndex >= 0) {
    const raw = process.argv[usdArgIndex + 1];
    const parsed = Number.parseFloat(raw ?? "");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("Invalid --amount-usd value.");
    }
    return Math.round(parsed * 100);
  }

  return DEFAULT_TOTAL_AMOUNT_USD * 100;
}

function buildFundingChunks(totalAmountCents: number): number[] {
  const chunks: number[] = [];
  let remaining = totalAmountCents;

  while (remaining > 0) {
    const next = Math.min(MAX_CHUNK_AMOUNT_CENTS, remaining);
    chunks.push(next);
    remaining -= next;
  }

  return chunks;
}

async function main(): Promise<void> {
  const secretKey = process.env.STRIPE_CONNECT_SECRET_KEY;

  if (!secretKey) {
    throw new Error("Missing STRIPE_CONNECT_SECRET_KEY in apps/web/.env.local");
  }

  const stripe = new Stripe(secretKey);
  const totalAmountCents = parseTotalAmountCents();
  const chunks = buildFundingChunks(totalAmountCents);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const completedSessions: Array<{
      sessionId: string;
      paymentStatus: string | null;
      paymentIntentId: string | null;
      amountCents: number;
    }> = [];

    for (const [index, amountCents] of chunks.entries()) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        success_url: "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://example.com/cancel",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              product_data: {
                name: "HermesRoutiq Connect balance funding",
              },
              unit_amount: amountCents,
            },
          },
        ],
      });

      if (!session.url) {
        throw new Error("Stripe Checkout session did not return a URL.");
      }

      await page.goto(session.url, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await page.locator("input[name=email]").fill("funding@hermesroutiq.test");
      await page.locator("input[name=cardNumber]").fill("4000000000000077");
      await page.locator("input[name=cardExpiry]").fill("1230");
      await page.locator("input[name=cardCvc]").fill("123");
      await page.locator("input[name=billingName]").fill("Hermes Routiq Funding");
      await page.locator("select[name=billingCountry]").selectOption("US");
      await page.locator("input[name=billingPostalCode]").fill("94107");
      await page
        .locator('[data-testid="hosted-payment-submit-button"]')
        .click();
      await page.waitForURL(/example\.com\/success/, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });

      const completedSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["payment_intent"],
      });
      completedSessions.push({
        sessionId: completedSession.id,
        paymentStatus: completedSession.payment_status ?? null,
        paymentIntentId:
          typeof completedSession.payment_intent === "string"
            ? completedSession.payment_intent
            : completedSession.payment_intent?.id ?? null,
        amountCents,
      });

      console.log(
        JSON.stringify(
          {
            progress: `${index + 1}/${chunks.length}`,
            amountCents,
            sessionId: completedSession.id,
            paymentStatus: completedSession.payment_status,
          },
          null,
          2,
        ),
      );
    }

    const balance = await stripe.balance.retrieve();

    console.log(
      JSON.stringify(
        {
          fundedTotalCents: totalAmountCents,
          chunks,
          completedSessions,
          available: balance.available,
          pending: balance.pending,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

void main();
