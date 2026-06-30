const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const row = (await c.query("select id,status,stripe_checkout_session_id,vehicle_id from orders where stripe_checkout_session_id is not null order by created_at desc limit 1")).rows[0];
  console.log(JSON.stringify(row, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
