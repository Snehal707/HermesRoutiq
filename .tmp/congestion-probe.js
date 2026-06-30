const BASE = 'http://127.0.0.1:3001';
async function j(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}
(async () => {
  const log = [];
  const state1 = await j(`${BASE}/api/sim/state`);
  log.push({ step: 'initial', tick: state1.json.tick, order: state1.json.world.orders[0], incidents: state1.json.world.incidents.length });

  const start = await j(`${BASE}/api/sim/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
  log.push({ step: 'start', ok: start.ok, status: start.status, tick: start.json.tick });

  const tick10 = await j(`${BASE}/api/sim/tick`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tick: { elapsedSeconds: 10, speedMultiplier: 1, status: 'running', seed: 42 }, vehicleStates: {} }) });
  log.push({ step: 'tick10', ok: tick10.ok, status: tick10.status, json: tick10.json });

  const state2 = await j(`${BASE}/api/sim/state`);
  log.push({ step: 'state10', tick: state2.json.tick, order: state2.json.world.orders[0], vehicle: state2.json.world.vehicles.find(v => v.id === 'vehicle-1'), incidents: state2.json.world.incidents });

  const congestion = await j(`${BASE}/api/sim/congestion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicleId: 'vehicle-1' }) });
  log.push({ step: 'congestion', ok: congestion.ok, status: congestion.status, json: congestion.json });

  const incidentId = congestion.json.world?.incidents?.at(-1)?.id ?? null;
  if (incidentId) {
    const reason = await j(`${BASE}/api/dashboard/reason`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ incidentId }) });
    log.push({ step: 'reason', ok: reason.ok, status: reason.status, json: reason.json });

    const recover = await j(`${BASE}/api/dashboard/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ incidentId }) });
    log.push({ step: 'recover', ok: recover.ok, status: recover.status, json: recover.json });
  }

  const state3 = await j(`${BASE}/api/sim/state`);
  log.push({ step: 'final', tick: state3.json.tick, order: state3.json.world.orders[0], vehicle: state3.json.world.vehicles.find(v => v.id === 'vehicle-1'), incidents: state3.json.world.incidents });

  console.log(JSON.stringify(log, null, 2));
})().catch((error) => { console.error(error); process.exit(1); });
