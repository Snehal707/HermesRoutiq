/**
 * Regression: Reset → Start → Breakdown twice must not collide on incidents_pkey.
 * Run: npx tsx scripts/test-breakdown-idempotency.ts
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3001";

async function post(path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as { error?: string; world?: { incidents: { id: string }[] } };
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${payload.error ?? "unknown"}`);
  }
  return payload;
}

async function runCycle(cycle: number): Promise<string> {
  await post("/api/sim/control", { action: "reset" });
  await post("/api/sim/control", { action: "start" });
  const result = await post("/api/sim/breakdown");
  const incident = result.world?.incidents.at(-1);
  if (!incident?.id) {
    throw new Error(`cycle ${cycle}: no incident returned`);
  }
  console.log(`cycle ${cycle}: incident id = ${incident.id}`);
  return incident.id;
}

async function main(): Promise<void> {
  const id1 = await runCycle(1);
  const id2 = await runCycle(2);

  if (id1 === id2) {
    throw new Error(`FAIL: duplicate incident IDs across cycles: ${id1}`);
  }

  console.log("PASS: two breakdown cycles completed with distinct incident IDs");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
