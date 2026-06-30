/**
 * Quick determinism sanity check — run with: npx tsx apps/web/scripts/verify-determinism.ts
 */
import { createWorld } from "../lib/sim/world";
import { getVehiclePositionAtTime } from "../lib/sim/movement";

const seed = 42;
const worldA = createWorld(seed);
const worldB = createWorld(seed);

const serialize = (world: ReturnType<typeof createWorld>) =>
  JSON.stringify({
    hubs: world.pickupHubs,
    customers: world.customers,
    routes: world.vehicles.map((v) => v.route),
    orders: world.orders,
    positions: world.vehicles.map((v) =>
      getVehiclePositionAtTime(v.route, 5, v.speedMps, null),
    ),
  });

const a = serialize(worldA);
const b = serialize(worldB);

if (a !== b) {
  console.error("FAIL: createWorld(42) is not deterministic");
  process.exit(1);
}

console.log("PASS: createWorld(42) produces identical state");
console.log(`Orders on ${worldA.breakdownVehicleId}:`, worldA.orders.filter((o) => o.vehicleId === worldA.breakdownVehicleId).length);
