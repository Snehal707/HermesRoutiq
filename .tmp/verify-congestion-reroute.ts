import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = "http://127.0.0.1:3001";

type SimState = {
  world: {
    orders: Array<{
      id: string;
      status: string;
      vehicleId: string;
    }>;
    vehicles: Array<{
      id: string;
      status: string;
      routeStatus: string;
      route: Array<[number, number]>;
      frozenAtSeconds: number | null;
    }>;
    incidents: Array<{
      id: string;
      type: string;
      vehicleId: string;
      orderIds: string[];
    }>;
  };
  tick: {
    elapsedSeconds: number;
    status: string;
    speedMultiplier: number;
  };
};

type DashboardSnapshot = {
  headline: {
    activeDeliveries: number;
    activeIncidents: number;
  };
  currentRequest: null | {
    orderId: string;
    dispatchAssignedVehicleId: string | null;
    dispatchStatus: string;
  };
  activeIncident: null | {
    id: string;
    type: string;
  };
  finalRecoveryReport: null | {
    incidentId: string;
    affectedDeliveries: number;
    recoveredDeliveries: number;
  };
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `POST ${url} failed with ${response.status}`);
  }
  return payload;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `GET ${url} failed with ${response.status}`);
  }
  return payload;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  console.log("[verify] resetting simulation");
  await postJson(`${BASE_URL}/api/sim/control`, { action: "reset" });
  await waitFor(
    "clean reset snapshot",
    async () => {
      const snapshot = await getJson<DashboardSnapshot>(`${BASE_URL}/api/dashboard/snapshot`);
      if (snapshot.currentRequest === null && snapshot.activeIncident === null) {
        return snapshot;
      }
      return null;
    },
    30_000,
    2_000,
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log("[verify] opening dashboard");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.getByText(/demo fleet control/i).waitFor({ timeout: 30_000 });

    console.log("[verify] creating checkout session");
    const checkout = await postJson<{
      sessionUrl: string;
      sessionId: string;
      orderId: string;
    }>(`${BASE_URL}/api/checkout`, {
      request: {
        pickupHubId: "hub-north",
        customerName: "Market Street Drop",
        destinationLat: 37.7862,
        destinationLng: -122.4016,
      },
    });

    console.log("[verify] opening stripe checkout", {
      orderId: checkout.orderId,
      sessionId: checkout.sessionId,
    });
    await page.goto(checkout.sessionUrl, { waitUntil: "domcontentloaded" });
    await page.locator("input[name=email]").fill("demo@hermesroutiq.test");
    await page.locator("input[name=cardNumber]").fill("4242424242424242");
    await page.locator("input[name=cardExpiry]").fill("1230");
    await page.locator("input[name=cardCvc]").fill("123");
    await page.locator("input[name=billingName]").fill("Hermes Routiq Demo");
    await page.locator("select[name=billingCountry]").selectOption("US");
    await page.locator("input[name=billingPostalCode]").fill("94107");
    await page.locator('[data-testid="hosted-payment-submit-button"]').click();

    console.log("[verify] waiting for Stripe return");
    await page.waitForURL(/http:\/\/(127\.0\.0\.1|localhost):3001\/\?checkout=success/, {
      timeout: 90_000,
    });
    await page.waitForLoadState("domcontentloaded");

    console.log("[verify] waiting for Hermes dispatch");
    const dispatchState = await waitFor(
      "paid order dispatch",
      async () => {
        const snapshot = await getJson<DashboardSnapshot>(`${BASE_URL}/api/dashboard/snapshot`);
        const currentRequest = snapshot.currentRequest;
        if (
          currentRequest?.orderId === checkout.orderId &&
          currentRequest.dispatchStatus === "released" &&
          currentRequest.dispatchAssignedVehicleId
        ) {
          return currentRequest;
        }
        return null;
      },
      90_000,
      2_000,
    );

    const screenshotBeforeIncident = join(
      tmpdir(),
      `hermesroutiq-before-congestion-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotBeforeIncident, fullPage: false });

    const stateBeforeIncident = await getJson<SimState>(`${BASE_URL}/api/sim/state`);
    const vehicleBeforeIncident = stateBeforeIncident.world.vehicles.find(
      (vehicle) => vehicle.id === dispatchState.dispatchAssignedVehicleId,
    );

    console.log("[verify] triggering congestion", {
      assignedVehicleId: dispatchState.dispatchAssignedVehicleId,
    });
    const congestion = await postJson<{ world: SimState["world"]; tick: SimState["tick"] }>(
      `${BASE_URL}/api/sim/congestion`,
      { vehicleId: dispatchState.dispatchAssignedVehicleId },
    );
    const incidentId = congestion.world.incidents.at(-1)?.id ?? null;
    if (!incidentId) {
      throw new Error("Congestion incident was not created.");
    }

    const incidentSettledState = await waitFor(
      "congestion freeze",
      async () => {
        const state = await getJson<SimState>(`${BASE_URL}/api/sim/state`);
        const vehicle = state.world.vehicles.find(
          (candidate) => candidate.id === dispatchState.dispatchAssignedVehicleId,
        );
        if (vehicle?.routeStatus === "at_risk" || vehicle?.routeStatus === "incident") {
          return state;
        }
        return null;
      },
      20_000,
      1_000,
    );

    const screenshotDuringIncident = join(
      tmpdir(),
      `hermesroutiq-during-congestion-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotDuringIncident, fullPage: false });

    console.log("[verify] waiting for same-vehicle recovery");
    const recoveredState = await waitFor(
      "same-vehicle reroute recovery",
      async () => {
        const state = await getJson<SimState>(`${BASE_URL}/api/sim/state`);
        const vehicle = state.world.vehicles.find(
          (candidate) => candidate.id === dispatchState.dispatchAssignedVehicleId,
        );
        const incidentVehicles = state.world.incidents
          .filter((incident) => incident.orderIds.includes(checkout.orderId))
          .map((incident) => incident.vehicleId);
        if (
          vehicle &&
          vehicle.status === "en_route" &&
          vehicle.routeStatus === "recovery" &&
          incidentVehicles.every((vehicleId) => vehicleId === dispatchState.dispatchAssignedVehicleId)
        ) {
          return {
            state,
            vehicle,
            incidentVehicles,
          };
        }
        return null;
      },
      60_000,
      2_000,
    );

    const screenshotAfterRecovery = join(
      tmpdir(),
      `hermesroutiq-after-congestion-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotAfterRecovery, fullPage: false });

    const snapshotAfterRecovery = await getJson<DashboardSnapshot>(`${BASE_URL}/api/dashboard/snapshot`);

    console.log(JSON.stringify({
      orderId: checkout.orderId,
      assignedVehicleId: dispatchState.dispatchAssignedVehicleId,
      incidentId,
      beforeIncident: {
        tickStatus: stateBeforeIncident.tick.status,
        activeDeliveries: (await getJson<DashboardSnapshot>(`${BASE_URL}/api/dashboard/snapshot`)).headline.activeDeliveries,
        vehicleStatus: vehicleBeforeIncident?.status ?? null,
        routeStatus: vehicleBeforeIncident?.routeStatus ?? null,
        routePointCount: vehicleBeforeIncident?.route.length ?? 0,
      },
      frozenState: {
        tickStatus: incidentSettledState.tick.status,
        incidentCount: incidentSettledState.world.incidents.length,
        vehicleStatus: incidentSettledState.world.vehicles.find(
          (vehicle) => vehicle.id === dispatchState.dispatchAssignedVehicleId,
        )?.status ?? null,
        routeStatus: incidentSettledState.world.vehicles.find(
          (vehicle) => vehicle.id === dispatchState.dispatchAssignedVehicleId,
        )?.routeStatus ?? null,
      },
      recoveryState: {
        tickStatus: recoveredState.state.tick.status,
        vehicleStatus: recoveredState.vehicle.status,
        routeStatus: recoveredState.vehicle.routeStatus,
        routePointCount: recoveredState.vehicle.route.length,
        incidentVehicles: recoveredState.incidentVehicles,
        activeIncidents: snapshotAfterRecovery.headline.activeIncidents,
        currentRequestStatus: snapshotAfterRecovery.currentRequest?.dispatchStatus ?? null,
        finalRecoveryReport: snapshotAfterRecovery.finalRecoveryReport,
      },
      screenshots: {
        beforeIncident: screenshotBeforeIncident,
        duringIncident: screenshotDuringIncident,
        afterRecovery: screenshotAfterRecovery,
      },
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
