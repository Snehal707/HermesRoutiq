const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const events = (await c.query("select event_type, created_at, left(payload::text, 300) as payload from simulation_events order by created_at desc limit 10")).rows;
  console.log(JSON.stringify(events, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
