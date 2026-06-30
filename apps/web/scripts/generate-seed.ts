import { createWorld, BREAKDOWN_VEHICLE_ID } from "../lib/sim/world";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

const world = createWorld(42);

console.log("-- Generated from createWorld(42). Do not edit by hand.");
console.log("BEGIN;");
console.log(
  "CREATE TEMP TABLE _driver_connect_snapshot AS SELECT id, stripe_payout_account_id FROM drivers;",
);

console.log("TRUNCATE policy_evaluations, customer_notifications, simulation_events, ledger, agent_decisions, incidents, orders, vehicles, drivers, customer_locations, pickup_hubs CASCADE;");

for (const hub of world.pickupHubs) {
  console.log(
    `INSERT INTO pickup_hubs (id, name, lat, lng) VALUES (${sqlString(hub.id)}, ${sqlString(hub.name)}, ${hub.location.lat}, ${hub.location.lng});`,
  );
}

for (const customer of world.customers) {
  console.log(
    `INSERT INTO customer_locations (id, name, lat, lng) VALUES (${sqlString(customer.id)}, ${sqlString(customer.name)}, ${customer.location.lat}, ${customer.location.lng});`,
  );
}

for (const driver of world.drivers) {
  console.log(
    `INSERT INTO drivers (id, name, vehicle_id, stripe_payout_account_id) VALUES (${sqlString(driver.id)}, ${sqlString(driver.name)}, ${sqlString(driver.vehicleId)}, (SELECT stripe_payout_account_id FROM _driver_connect_snapshot WHERE id = ${sqlString(driver.id)}));`,
  );
}

for (const vehicle of world.vehicles) {
  const frozen =
    vehicle.frozenAtSeconds === null ? "NULL" : String(vehicle.frozenAtSeconds);
  console.log(
    `INSERT INTO vehicles (id, driver_id, route, routing_provider, routing_plan, route_status, status, speed_mps, frozen_at_seconds) VALUES (${sqlString(vehicle.id)}, ${sqlString(vehicle.driverId)}, ${sqlJson(vehicle.route)}, ${sqlString(vehicle.routingProvider)}, ${sqlJson(vehicle.routingPlan)}, ${sqlString(vehicle.routeStatus)}, ${sqlString(vehicle.status)}, ${vehicle.speedMps}, ${frozen});`,
  );
}

for (const order of world.orders) {
  console.log(
    `INSERT INTO orders (id, customer_id, pickup_hub_id, vehicle_id, status, revenue_cents) VALUES (${sqlString(order.id)}, ${sqlString(order.customerId)}, ${sqlString(order.pickupHubId)}, ${sqlString(order.vehicleId)}, ${sqlString(order.status)}, ${order.revenueCents});`,
  );
}

console.log(`-- breakdown target vehicle: ${BREAKDOWN_VEHICLE_ID}`);
console.log("COMMIT;");
