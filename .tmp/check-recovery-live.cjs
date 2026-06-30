const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const incidents = (await c.query("select id,type,vehicle_id,order_ids,created_at from incidents order by created_at desc limit 5")).rows;
  const events = (await c.query("select event_type, created_at, left(payload::text, 350) as payload from simulation_events order by created_at desc limit 12")).rows;
  console.log(JSON.stringify({ incidents, events }, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
