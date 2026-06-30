const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const orders = (await c.query("select id,status,vehicle_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_event_id,created_at from orders order by created_at desc limit 3")).rows;
  const events = (await c.query("select event_type, created_at, left(payload::text, 500) as payload from simulation_events order by created_at desc limit 15")).rows;
  console.log(JSON.stringify({ orders, events }, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
