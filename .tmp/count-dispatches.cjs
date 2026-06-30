const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = await c.query("select count(*)::int as count from simulation_events where event_type = 'checkout_order_dispatched' and payload->>'orderId' = $1", [process.argv[2]]);
  console.log(q.rows[0].count);
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
