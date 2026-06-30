const { Client } = require('./node_modules/pg');
const conn = 'postgresql://postgres.stgqvbogsiakoimqutuq:%25%40Snehalx7%25@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres';
const ACTIVE = new Set(['paid','assigned','in_transit']);
(async () => {
  const client = new Client({ connectionString: conn });
  await client.connect();
  const vehiclesRes = await client.query(`select id, driver_id, route, routing_plan from vehicles order by id asc`);
  const ordersRes = await client.query(`select id, customer_id, status from orders order by created_at asc`);
  const customersRes = await client.query(`select id, lat, lng from customer_locations order by id asc`);
  await client.end();
  const customerById = new Map(customersRes.rows.map((row) => [row.id, row]));
  const drivers = vehiclesRes.rows.map((vehicle) => {
    const plannedStops = Array.isArray(vehicle.routing_plan?.orderedStops) ? vehicle.routing_plan.orderedStops : [];
    const start = plannedStops[0]?.location ?? { lat: vehicle.route?.[0]?.[1], lng: vehicle.route?.[0]?.[0] };
    return {
      id: vehicle.driver_id,
      name: vehicle.driver_id,
      vehicle_id: vehicle.id,
      start_location: start,
      end_location: start,
      capacity: 4,
      current_load: 0,
      time_window: { start: 0, end: 86400 },
    };
  });
  const orders = ordersRes.rows.flatMap((order, index) => {
    if (!ACTIVE.has(order.status)) return [];
    const customer = customerById.get(order.customer_id);
    if (!customer) return [];
    return [{ id: order.id, location: { lat: customer.lat, lng: customer.lng }, demand: 1, service_time_seconds: 0, assigned_driver_id: null, sequence: index }];
  });
  require('fs').writeFileSync('C:/tmp/checkout-route-body.json', JSON.stringify({ provider:'cuopt-osrm', drivers, orders }, null, 2));
  console.log(JSON.stringify({ drivers: drivers.length, orders: orders.length }, null, 2));
})().catch((error) => { console.error(error); process.exit(1); });
