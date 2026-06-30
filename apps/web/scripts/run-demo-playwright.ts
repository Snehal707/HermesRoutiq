import { config } from "dotenv";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

config({ path: resolve(__dirname, "../.env.local") });

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3001";

interface DemoSnapshot {
  headline: {
    activeDeliveries: number;
    activeIncidents: number;
  };
  stripeTransactions: Array<{
    kind: string;
    stripeReference: string;
  }>;
  finalRecoveryReport: {
    affectedDeliveries: number;
    recoveredDeliveries: number;
    customerRevenueProtectedCents: number;
    emergencySpendingCents: number;
    refundsAvoidedCents: number;
    churnLossAvoidedCents: number;
    netFinancialBenefitCents: number;
    humanInterventionCount: number;
    policyViolationCount: number;
    recoverySeconds: number;
    skillName: string | null;
  } | null;
}

interface DemoState {
  world: {
    orders: Array<{ id: string; status: string; vehicleId: string }>;
    incidents: Array<{ id: string; vehicleId?: string }>;
  };
  tick: {
    status: string;
  };
}

interface CheckoutPayload {
  sessionUrl: string;
  orderId: string;
}

async function waitForCondition(
  page: Page,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function fetchSnapshot(page: Page): Promise<DemoSnapshot> {
  const snapshotResponse = await page.request.get(
    `${BASE_URL}/api/dashboard/snapshot`,
  );
  return snapshotResponse.json() as Promise<DemoSnapshot>;
}

async function fetchState(page: Page): Promise<DemoState> {
  const stateResponse = await page.request.get(`${BASE_URL}/api/sim/state`);
  return stateResponse.json() as Promise<DemoState>;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  const failedResponseBodies: Array<{ url: string; status: number; body: string }> = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (
      response.url().startsWith(BASE_URL) &&
      response.status() >= 400
    ) {
      failedResponses.push(`${response.status()} ${response.url()}`);
      void response.text()
        .then((body) => {
          failedResponseBodies.push({
            url: response.url(),
            status: response.status(),
            body: body.slice(0, 800),
          });
        })
        .catch(() => undefined);
    }
  });

  try {
    console.log("[demo] resetting simulation");
    const reset = await page.request.post(`${BASE_URL}/api/sim/control`, {
      data: { action: "reset" },
      timeout: 120_000,
    });
    if (!reset.ok()) {
      throw new Error(`Reset failed: ${reset.status()} ${await reset.text()}`);
    }
    const resetPayload = await reset.json() as {
      world: {
        seed: number;
        incidents: unknown[];
        orders: Array<{ vehicleId: string }>;
      };
    };

    console.log("[demo] opening dashboard");
    await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.locator(".headline-hud").waitFor({ timeout: 120_000 });
    console.log("[demo] dashboard ready");

    let checkoutPayload: CheckoutPayload | null = null;
    await page.route(`${BASE_URL}/api/checkout`, async (route) => {
      const apiResponse = await page.request.post(
        `${BASE_URL}/api/checkout`,
        { timeout: 120_000 },
      );
      const body = await apiResponse.text();
      checkoutPayload = JSON.parse(body) as CheckoutPayload;
      await route.fulfill({
        status: apiResponse.status(),
        contentType: "application/json",
        body,
      });
    });
    console.log("[demo] opening checkout");
    await page.getByRole("button", {
      name: /Create Paid Delivery/i,
    }).click();
    await page.waitForURL(/checkout\.stripe\.com/, {
      timeout: 120_000,
      waitUntil: "domcontentloaded",
    });
    console.log("[demo] stripe checkout opened");
    if (!checkoutPayload) {
      throw new Error("Checkout response did not include a session URL.");
    }
    const checkoutOrderId = (checkoutPayload as CheckoutPayload).orderId;
    await page.locator("input[name=email]").fill("demo@hermesroutiq.test");
    await page.locator("input[name=cardNumber]").fill("4242424242424242");
    await page.locator("input[name=cardExpiry]").fill("1230");
    await page.locator("input[name=cardCvc]").fill("123");
    await page.locator("input[name=billingName]").fill("Hermes Routiq Demo");
    await page.locator("select[name=billingCountry]").selectOption("US");
    await page.locator("input[name=billingPostalCode]").fill("94107");
    await page
      .locator('[data-testid="hosted-payment-submit-button"]')
      .click();
    console.log("[demo] submitted stripe payment");
    try {
      await page.waitForURL(
        new RegExp(
          `${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\?checkout=success`,
        ),
        {
          timeout: 120_000,
          waitUntil: "domcontentloaded",
        },
      );
    } catch {
      throw new Error(
        `Stripe Checkout did not complete. URL: ${page.url()}. Page: ${(await page.locator("body").innerText()).slice(0, 800)}`,
      );
    }
    const successUrl = new URL(page.url());
    const sessionId = successUrl.searchParams.get("session_id");
    if (!sessionId) {
      throw new Error(`Checkout success URL did not include session_id. URL: ${page.url()}`);
    }
    await page.locator(".headline-hud").waitFor({ timeout: 120_000 });
    console.log("[demo] returned from stripe", { sessionId, checkoutOrderId });

    console.log("[demo] waiting for Hermes dispatch assignment");
    await waitForCondition(
      page,
      async () => {
        const state = await fetchState(page);
        return state.world.orders.some(
          (order) =>
            order.id === checkoutOrderId &&
            ["assigned", "in_transit"].includes(order.status) &&
            Boolean(order.vehicleId),
        );
      },
      120_000,
      "checkout order to be assigned by Hermes",
    );
    console.log("[demo] Hermes assigned paid order");

    console.log("[demo] waiting for sim auto-start");
    let stateAfterAssignment = await fetchState(page);
    if (stateAfterAssignment.tick.status !== "running") {
      await waitForCondition(
        page,
        async () => {
          stateAfterAssignment = await fetchState(page);
          return stateAfterAssignment.tick.status === "running";
        },
        20_000,
        "auto-start after paid-order assignment",
      ).catch(async () => {
        console.log("[demo] auto-start did not happen in time, starting manually");
        const startResponse = await page.request.post(`${BASE_URL}/api/sim/control`, {
          data: { action: "start" },
          timeout: 120_000,
        });
        if (!startResponse.ok()) {
          throw new Error(`Start simulation failed: ${startResponse.status()} ${await startResponse.text()}`);
        }
      });
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.locator(".headline-hud").waitFor({ timeout: 120_000 });
    console.log("[demo] dashboard ready for incident trigger");

    let assignedVehicleId: string | null = null;
    console.log("[demo] waiting for assigned vehicle id");
    await waitForCondition(
      page,
      async () => {
        const state = await fetchState(page);
        const checkoutOrder = state.world.orders.find(
          (order) => order.id === checkoutOrderId,
        );
        assignedVehicleId = checkoutOrder?.vehicleId ?? null;
        return Boolean(assignedVehicleId);
      },
      120_000,
      "assigned vehicle for checkout order",
    );
    console.log("[demo] assigned vehicle located", { assignedVehicleId });

    console.log("[demo] waiting for active assigned order before incident");
    await waitForCondition(
      page,
      async () => {
        const state = await fetchState(page);
        return state.world.orders.some(
          (order) =>
            order.id === checkoutOrderId &&
            order.vehicleId === assignedVehicleId &&
            (order.status === "assigned" || order.status === "in_transit") &&
            state.tick.status === "running",
        );
      },
      30_000,
      "active assigned order before breakdown",
    );

    console.log("[demo] triggering breakdown");
    const breakdown = await page.request.post(`${BASE_URL}/api/sim/breakdown`, {
      data: assignedVehicleId ? { vehicleId: assignedVehicleId } : {},
      timeout: 120_000,
    });
    if (!breakdown.ok()) {
      throw new Error(
        `Breakdown trigger failed: ${breakdown.status()} ${await breakdown.text()}`,
      );
    }
    console.log("[demo] breakdown accepted");

    console.log("[demo] waiting for reasoning");
    await page.locator(".decision-status.is-reasoning").waitFor({
      timeout: 60_000,
    });
    console.log("[demo] waiting for reasoning completion");
    await page.locator(".decision-status.is-complete").waitFor({
      timeout: 120_000,
    });

    const recoveryBanner = page.locator(".recovery-banner.is-executing");
    console.log("[demo] waiting for recovery banner");
    await recoveryBanner.waitFor({ timeout: 120_000 });
    const recoveryBannerText = await recoveryBanner.innerText();
    await page.waitForTimeout(2_000);
    await page.screenshot({
      path: `${process.env.TEMP}\\hermes-demo-recovery-blue.png`,
    });

    console.log("[demo] waiting for final recovery report");
    await page.locator(".recovery-report").waitFor({ timeout: 150_000 });
    await page.locator(".recovery-report").scrollIntoViewIfNeeded();

    const snapshot = await fetchSnapshot(page);
    await page.locator(".recovery-report").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.TEMP}\\hermes-demo-final.png`,
    });

    const report = snapshot.finalRecoveryReport;
    if (!report) {
      throw new Error("Final recovery report was not produced.");
    }

    console.log(JSON.stringify({
      reset: {
        seed: resetPayload.world.seed,
        incidentCount: resetPayload.world.incidents.length,
        orderCount: resetPayload.world.orders.length,
      },
      checkoutOrderId,
      assignedVehicleId,
      recoveryBannerText,
      stripeTransactions: snapshot.stripeTransactions,
      report,
      headline: snapshot.headline,
      consoleErrors,
      failedResponses,
      failedResponseBodies,
    }, null, 2));

    if (consoleErrors.length > 0 || failedResponses.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

void main();
