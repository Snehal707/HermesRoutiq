import { config } from "dotenv";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

config({ path: resolve(process.cwd(), "apps/web/.env.local") });

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3001";

interface CheckoutPayload {
  sessionUrl: string;
  orderId: string;
}

interface SimState {
  world: {
    orders: Array<{ id: string; status: string; vehicleId: string }>;
    vehicles: Array<{
      id: string;
      status: string;
      routeStatus: string;
      routingProvider: string;
      route: Array<[number, number]>;
      routingPlan?: {
        routeStartAtSeconds?: number;
        assignedOrderIds?: string[];
      } | null;
    }>;
    incidents: Array<{ id: string; type: string; vehicleId?: string }>;
  };
  tick: {
    status: string;
    elapsedSeconds: number;
  };
}

interface DashboardSnapshot {
  headline: {
    activeDeliveries: number;
    activeIncidents: number;
    expectedProfitCents: number;
  };
  activeIncident: {
    id: string;
    type: string;
  } | null;
  finalRecoveryReport: {
    incidentId: string;
    affectedDeliveries: number;
    recoveredDeliveries: number;
    recoverySeconds: number;
  } | null;
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

async function fetchState(page: Page): Promise<SimState> {
  const response = await page.request.get(`${BASE_URL}/api/sim/state`);
  return response.json() as Promise<SimState>;
}

async function fetchSnapshot(page: Page): Promise<DashboardSnapshot> {
  const response = await page.request.get(`${BASE_URL}/api/dashboard/snapshot`);
  return response.json() as Promise<DashboardSnapshot>;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    const reset = await page.request.post(`${BASE_URL}/api/sim/control`, {
      data: { action: "reset" },
      timeout: 120_000,
    });
    if (!reset.ok()) {
      throw new Error(`Reset failed: ${reset.status()} ${await reset.text()}`);
    }

    await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.locator(".headline-hud").waitFor({ timeout: 120_000 });

    let checkoutPayload: CheckoutPayload | null = null;
    await page.route(`${BASE_URL}/api/checkout`, async (route) => {
      const apiResponse = await page.request.post(`${BASE_URL}/api/checkout`, {
        timeout: 120_000,
      });
      const body = await apiResponse.text();
      checkoutPayload = JSON.parse(body) as CheckoutPayload;
      await route.fulfill({
        status: apiResponse.status(),
        contentType: "application/json",
        body,
      });
    });

    await page.getByRole("button", { name: /Create Paid Delivery/i }).click();
    await page.waitForURL(/checkout\.stripe\.com/, {
      timeout: 120_000,
      waitUntil: "domcontentloaded",
    });

    if (!checkoutPayload) {
      throw new Error("Checkout response did not include order metadata.");
    }

    const checkoutOrderId = checkoutPayload.orderId;
    await page.locator("input[name=email]").fill("demo@hermesroutiq.test");
    await page.locator("input[name=cardNumber]").fill("4242424242424242");
    await page.locator("input[name=cardExpiry]").fill("1230");
    await page.locator("input[name=cardCvc]").fill("123");
    await page.locator("input[name=billingName]").fill("Hermes Routiq Demo");
    await page.locator("select[name=billingCountry]").selectOption("US");
    await page.locator("input[name=billingPostalCode]").fill("94107");
    await page.locator('[data-testid="hosted-payment-submit-button"]').click();

    await page.waitForURL(
      new RegExp(
        `${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\?checkout=success`,
      ),
      {
        timeout: 120_000,
        waitUntil: "domcontentloaded",
      },
    );
    await page.locator(".headline-hud").waitFor({ timeout: 120_000 });

    await waitForCondition(
      page,
      async () => {
        const state = await fetchState(page);
        return state.world.orders.some(
          (order) =>
            order.id === checkoutOrderId &&
            (order.status === "assigned" || order.status === "in_transit") &&
            Boolean(order.vehicleId),
        );
      },
      120_000,
      "paid order to be dispatched by Hermes",
    );

    let assignedVehicleId: string | null = null;
    await waitForCondition(
      page,
      async () => {
        const state = await fetchState(page);
        const order = state.world.orders.find((entry) => entry.id === checkoutOrderId);
        assignedVehicleId = order?.vehicleId ?? null;
        return state.tick.status === "running" && Boolean(assignedVehicleId);
      },
      60_000,
      "running simulation with assigned vehicle",
    );

    const congestionResponse = await page.request.post(`${BASE_URL}/api/sim/congestion`, {
      data: { vehicleId: assignedVehicleId },
      timeout: 120_000,
    });
    if (!congestionResponse.ok()) {
      throw new Error(
        `Congestion trigger failed: ${congestionResponse.status()} ${await congestionResponse.text()}`,
      );
    }

    const congestionPayload = (await congestionResponse.json()) as {
      world: { incidents: Array<{ id: string; type: string }> };
    };
    const incidentId = congestionPayload.world.incidents.at(-1)?.id;
    if (!incidentId) {
      throw new Error("Congestion trigger did not return an incident id.");
    }

    await page.waitForTimeout(500);

    const reasoningStartedAt = Date.now();
    const reasonResponse = await page.request.post(`${BASE_URL}/api/dashboard/reason`, {
      data: { incidentId },
      timeout: 180_000,
    });
    const reasoningDurationMs = Date.now() - reasoningStartedAt;
    const reasonBody = await reasonResponse.json() as {
      error?: string;
      attempts?: number;
      latencyMs?: number;
      provider?: string;
      model?: string;
      decision?: {
        selectedStrategy: string;
      };
    };
    if (!reasonResponse.ok()) {
      throw new Error(
        `Reasoning request failed: ${reasonResponse.status()} ${JSON.stringify(reasonBody)}`,
      );
    }

    const recoveryStartedAt = Date.now();
    const recoverResponse = await page.request.post(`${BASE_URL}/api/dashboard/recover`, {
      data: { incidentId },
      timeout: 180_000,
    });
    const recoveryDurationMs = Date.now() - recoveryStartedAt;
    const recoverBody = await recoverResponse.json() as {
      error?: string;
      execution?: {
        status?: string;
        vehicleId?: string;
        provider?: string;
        routeChanged?: boolean;
        afterIntersectsCongestion?: boolean;
      };
      provider?: string;
      model?: string;
    };
    if (!recoverResponse.ok()) {
      throw new Error(
        `Recovery request failed: ${recoverResponse.status()} ${JSON.stringify(recoverBody)}`,
      );
    }

    await page.waitForTimeout(2_000);
    const finalState = await fetchState(page);
    const finalSnapshot = await fetchSnapshot(page);
    const vehicle = finalState.world.vehicles.find(
      (entry) => entry.id === assignedVehicleId,
    );

    console.log(
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          checkoutOrderId,
          assignedVehicleId,
          incidentId,
          reasoning: {
            httpDurationMs: reasoningDurationMs,
            hermesReportedLatencyMs: reasonBody.latencyMs ?? null,
            attempts: reasonBody.attempts ?? null,
            provider: reasonBody.provider ?? null,
            model: reasonBody.model ?? null,
            selectedStrategy: reasonBody.decision?.selectedStrategy ?? null,
          },
          recovery: {
            httpDurationMs: recoveryDurationMs,
            provider: recoverBody.provider ?? null,
            model: recoverBody.model ?? null,
            execution: recoverBody.execution ?? null,
          },
          finalState: {
            tick: finalState.tick,
            incidents: finalState.world.incidents,
            order: finalState.world.orders.find((entry) => entry.id === checkoutOrderId) ?? null,
            vehicle: vehicle ?? null,
          },
          finalSnapshot,
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
