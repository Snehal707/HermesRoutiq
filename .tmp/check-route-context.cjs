const { Client } = require('pg');
(async()=>{
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const latestOrder = (await c.query(`
    select o.id, o.status, o.pickup_hub_id, o.vehicle_id, o.revenue_cents,
           c.id as customer_id, c.name as customer_name, c.lat as customer_lat, c.lng as customer_lng,
           h.name as hub_name, h.lat as hub_lat, h.lng as hub_lng,
           v.route_status, v.status as vehicle_status, v.frozen_at_seconds, left(v.route::text, 600) as route_preview
    from orders o
    join customer_locations c on c.id = o.customer_id
    join pickup_hubs h on h.id = o.pickup_hub_id
    join vehicles v on v.id = o.vehicle_id
    order by o.created_at desc
    limit 1
  `)).rows[0];
  const latestIncident = (await c.query(`
    select id, type, vehicle_id, order_ids, created_at_sim_seconds, created_at
    from incidents
    order by created_at desc
    limit 1
  `)).rows[0];
  console.log(JSON.stringify({ latestOrder, latestIncident }, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
