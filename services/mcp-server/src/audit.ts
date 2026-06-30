import type { Json } from "../../../apps/web/lib/supabase/database.types.js";
import { insertSimulationEvent, readTickState } from "./db.js";
import type { AuditMetadata } from "./types.js";

export async function writeActionAudit(metadata: AuditMetadata): Promise<void> {
  const tick = await readTickState();

  await insertSimulationEvent({
    eventType: `mcp.${metadata.toolName}`,
    payload: {
      input: metadata.input,
      output: metadata.output ?? null,
      incidentId: metadata.incidentId ?? null,
      idempotencyKey: metadata.idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
    } satisfies Json,
    simSeconds: tick.elapsedSeconds,
  });
}
