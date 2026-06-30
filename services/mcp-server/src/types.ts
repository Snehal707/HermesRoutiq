import type { Json } from "../../../apps/web/lib/supabase/database.types.js";
import type { SimulationWorld } from "../../../packages/shared/types/index.js";

export interface ServiceContext {
  now: () => Date;
}

export interface BusinessSnapshot {
  tick: {
    elapsedSeconds: number;
    speedMultiplier: number;
    status: string;
    seed: number;
  };
  summary: {
    totalOrders: number;
    activeOrders: number;
    availableDrivers: number;
    activeIncidents: number;
    activeVehicleRoutes: number;
  };
  world: SimulationWorld;
}

export interface ToolResultEnvelope<T> {
  ok: true;
  data: T;
}

export interface AuditMetadata {
  toolName: string;
  input: Json;
  output?: Json;
  incidentId?: string | null;
  idempotencyKey?: string | null;
}
