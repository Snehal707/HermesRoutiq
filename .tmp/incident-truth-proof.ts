import {
  ensureInitialized,
  loadPersistedSimulation,
  resetSimulation,
} from "../apps/web/lib/sim/persistence";
import {
  buildCheckoutOrderMetadata,
  ensurePendingCheckoutOrder,
  markCheckoutOrderPaid,
  dispatchPaidOrderWithHermes,
} from "../apps/web/lib/orders";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await ensureInitialized();
  await resetSimulation(42, "empty");

  const now = Date.now();
  const metadata = await buildCheckoutOrderMetadata({
    request: {
      pickupHubId: "hub-north",
      customerName: "Incident Truth Proof",
      destinationLat: 37.7862,
      destinationLng: -122.4008,
    },
    blockOnIntake: true,
  });

  const order = await ensurePendingCheckoutOrder({
    metadata,
    stripeSessionId: `proof-session-${now}`,
  });

  const paid = await markCheckoutOrderPaid({
    stripeEventId: `proof-event-${now}`,
    stripeCheckoutSessionId: `proof-session-${now}`,
    stripePaymentIntentId: `proof-paid-${now}`,
    metadata,
  });

  await dispatchPaidOrderWithHermes(paid.orderId);

  const controlRes = await fetch("http://127.0.0.1:3001/api/sim/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });

  let vehicleId: string | null = null;
  let incidentId: string | null = null;
  const timeline: Array<Record<string, unknown>> = [];

  for (let step = 0; step < 30; step += 1) {
    const { world: state, tick } = await loadPersistedSimulation();
    const currentOrder = state.orders.find((entry) => entry.id === order.id);
    const assignedVehicle = state.vehicles.find((vehicle) => vehicle.assignedOrderId === order.id);

    if (assignedVehicle && !vehicleId) {
      vehicleId = assignedVehicle.id;
    }

    timeline.push({
      step,
      elapsed: tick.elapsedSeconds,
      running: tick.status === "running",
      orderStatus: currentOrder?.status ?? null,
      vehicleId: assignedVehicle?.id ?? null,
      vehicleStatus: assignedVehicle?.status ?? null,
      routeLen: assignedVehicle?.route.length ?? 0,
      activeIncidents: state.incidents.filter((incident) => incident.status === "active").length,
    });

    if (assignedVehicle && currentOrder?.status === "in_transit" && !incidentId) {
      const congestionRes = await fetch("http://127.0.0.1:3001/api/sim/congestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vehicleId: assignedVehicle.id }),
      });
      const congestionJson = (await congestionRes.json()) as { incident?: { id?: string } };
      incidentId = congestionJson.incident?.id ?? null;

      await fetch("http://127.0.0.1:3001/api/dashboard/reason", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId }),
      });

      await fetch("http://127.0.0.1:3001/api/dashboard/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId }),
      });
    }

    if (incidentId && currentOrder?.status === "delivered") {
      break;
    }

    await sleep(1000);
  }

  const { world: finalState } = await loadPersistedSimulation();
  const finalOrder = finalState.orders.find((entry) => entry.id === order.id);
  const finalVehicle = finalState.vehicles.find((vehicle) => vehicle.id === vehicleId);

  console.log(
    JSON.stringify(
      {
        orderId: order.id,
        controlStatus: controlRes.status,
        vehicleId,
        incidentId,
        finalOrderStatus: finalOrder?.status ?? null,
        finalVehicleStatus: finalVehicle?.status ?? null,
        finalVehicleAssignedOrderId: finalVehicle?.assignedOrderId ?? null,
        finalVehicleRouteLen: finalVehicle?.route.length ?? 0,
        activeIncidents: finalState.incidents.filter((incident) => incident.status === "active").length,
        timeline,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
