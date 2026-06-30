import { loadPersistedSimulation } from "../apps/web/lib/sim/persistence";
import { findCongestionVehicleId } from "../apps/web/lib/sim/world";

async function main() {
  const { world } = await loadPersistedSimulation();
  console.log(JSON.stringify({
    vehicleCount: world.vehicles.length,
    orderCount: world.orders.length,
    incidentCount: world.incidents.length,
    congestionVehicleId: findCongestionVehicleId(world),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
