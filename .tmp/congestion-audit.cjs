const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const incidents = (await c.query("select id,type,vehicle_id,order_ids,created_at_sim_seconds,created_at from incidents order by created_at desc limit 8")).rows;
  const events = (await c.query("select event_type, created_at, left(payload::text, 500) as payload from simulation_events order by created_at desc limit 20")).rows;
  const vehicles = (await c.query("select id,status,route_status,frozen_at_seconds,left(route::text,300) as route from vehicles order by id")).rows;
  console.log(JSON.stringify({ incidents, events, vehicles }, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
