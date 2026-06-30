require("dotenv").config({ path: "apps/web/.env.local" });
const pg = require("pg");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const orderId = "order-checkout-b8491d8e-da1e-4279-a101-ad06dbbbaf45";
  await client.connect();
  const order = await client.query("select id,status,vehicle_id from orders where id = $1", [orderId]);
  const vehicle = await client.query("select id,status,route_status,route,routing_plan,frozen_at_seconds from vehicles where id = $1", [order.rows[0]?.vehicle_id]);
  const incidents = await client.query("select id,type,vehicle_id,order_ids,created_at_sim_seconds,created_at from incidents order by created_at desc limit 10");
  console.log(JSON.stringify({ order: order.rows[0] ?? null, vehicle: vehicle.rows[0] ?? null, incidents: incidents.rows }, null, 2));
  await client.end();
})().catch(async (error) => { console.error(error); try { await client.end(); } catch {} process.exit(1); });
