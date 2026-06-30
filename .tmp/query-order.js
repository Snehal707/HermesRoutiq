require("dotenv").config({ path: "apps/web/.env.local" });
const pg = require("pg");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const orderId = "order-checkout-b8491d8e-da1e-4279-a101-ad06dbbbaf45";
  await client.connect();
  const order = await client.query("select id,status,vehicle_id,stripe_checkout_session_id,stripe_payment_intent_id,created_at from orders where id = $1", [orderId]);
  const events = await client.query("select event_type, created_at, payload from simulation_events where (payload->>'orderId') = $1 order by created_at desc limit 20", [orderId]);
  console.log(JSON.stringify({ order: order.rows, events: events.rows }, null, 2));
  await client.end();
})().catch(async (error) => {
  console.error(error);
  try { await client.end(); } catch {}
  process.exit(1);
});
