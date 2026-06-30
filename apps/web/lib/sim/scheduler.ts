import "server-only";

import type {
  ScheduledSimulatorEvent,
  ScheduledSimulatorEventKind,
} from "@hermes-routiq/shared";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  loadPersistedSimulation,
  persistBreakdown,
  persistTickAndVehicles,
} from "@/lib/sim/persistence";
import {
  findCongestionVehicleId,
  hasActiveCongestion,
  triggerBreakdown,
  triggerCongestion,
} from "@/lib/sim/world";

export interface ScheduledEventReconcileResult {
  appliedEventIds: string[];
  blockedEvents: Array<{
    eventId: string;
    reason: string;
  }>;
}

type ScheduledEventLogType =
  | "simulator_scheduled_event_applied"
  | "simulator_scheduled_event_blocked";

async function insertSimulationEvent(
  eventType: ScheduledEventLogType,
  payload: Record<string, unknown>,
  simSeconds: number,
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("simulation_events").insert({
    event_type: eventType,
    payload,
    sim_seconds: simSeconds,
  });

  if (error) {
    throw new Error(`Failed to persist simulation event ${eventType}: ${error.message}`);
  }
}

async function readProcessedScheduledEventIds(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("simulation_events")
    .select("event_type,payload")
    .in("event_type", [
      "simulator_scheduled_event_applied",
      "simulator_scheduled_event_blocked",
    ])
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(`Failed to read scheduled event log: ${error.message}`);
  }

  const eventIds = new Set<string>();

  for (const row of data ?? []) {
    const payload =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload
        : null;
    const eventId = payload?.scheduledEventId;
    if (typeof eventId === "string") {
      eventIds.add(eventId);
    }
  }

  return eventIds;
}

async function applyScheduledBreakdown(
  scheduledEvent: ScheduledSimulatorEvent,
  simTimeSeconds: number,
): Promise<{ applied: true; incidentId: string } | { applied: false; reason: string }> {
  const { world, tick } = await loadPersistedSimulation();

  // Don't stack a scheduled incident on top of an active one (e.g. while a
  // manual breakdown is still being recovered). world.incidents already
  // excludes resolved incidents, so any entry here is live.
  if (world.incidents.length > 0) {
    return { applied: false, reason: "Another incident is already active" };
  }

  const beforeIncidentIds = new Set(world.incidents.map((incident) => incident.id));
  const updatedWorld = triggerBreakdown(world, Math.max(tick.elapsedSeconds, simTimeSeconds));
  // Only persist a genuinely new incident. triggerBreakdown returns the world
  // unchanged when there's no dispatchable target, in which case .at(-1) would
  // be a pre-existing incident and re-inserting it violates incidents_pkey.
  const incident = updatedWorld.incidents.find(
    (candidate) => !beforeIncidentIds.has(candidate.id),
  );

  if (!incident || incident.type !== "vehicle_breakdown") {
    return { applied: false, reason: "No dispatchable breakdown target was available" };
  }

  await persistBreakdown(updatedWorld, incident);
  await persistTickAndVehicles(
    { ...tick, elapsedSeconds: Math.max(tick.elapsedSeconds, simTimeSeconds) },
    updatedWorld,
  );

  await insertSimulationEvent(
    "simulator_scheduled_event_applied",
    {
      scheduledEventId: scheduledEvent.id,
      kind: scheduledEvent.kind,
      dueAtSimSeconds: scheduledEvent.due_at_sim_seconds,
      appliedAtSimSeconds: simTimeSeconds,
      incidentId: incident.id,
    },
    simTimeSeconds,
  );

  return { applied: true, incidentId: incident.id };
}

async function applyScheduledCongestion(
  scheduledEvent: ScheduledSimulatorEvent,
  simTimeSeconds: number,
): Promise<{ applied: true; incidentId: string } | { applied: false; reason: string }> {
  const { world, tick } = await loadPersistedSimulation();

  // Don't stack a scheduled incident on top of an active one.
  if (world.incidents.length > 0) {
    return { applied: false, reason: "Another incident is already active" };
  }

  const congestionVehicleId = findCongestionVehicleId(world);

  if (!congestionVehicleId) {
    return { applied: false, reason: "No active route currently intersects the congestion area" };
  }

  if (hasActiveCongestion(world, congestionVehicleId)) {
    return { applied: false, reason: "Congestion is already active for the affected vehicle" };
  }

  const beforeIncidentIds = new Set(world.incidents.map((incident) => incident.id));
  const updatedWorld = triggerCongestion(world, Math.max(tick.elapsedSeconds, simTimeSeconds));
  // Only persist a genuinely new incident (see applyScheduledBreakdown).
  const incident = updatedWorld.incidents.find(
    (candidate) => !beforeIncidentIds.has(candidate.id),
  );

  if (!incident || incident.type !== "congestion") {
    return { applied: false, reason: "Congestion incident could not be created" };
  }

  await persistBreakdown(updatedWorld, incident);
  await persistTickAndVehicles(
    { ...tick, elapsedSeconds: Math.max(tick.elapsedSeconds, simTimeSeconds) },
    updatedWorld,
  );

  await insertSimulationEvent(
    "simulator_scheduled_event_applied",
    {
      scheduledEventId: scheduledEvent.id,
      kind: scheduledEvent.kind,
      dueAtSimSeconds: scheduledEvent.due_at_sim_seconds,
      appliedAtSimSeconds: simTimeSeconds,
      incidentId: incident.id,
      vehicleId: incident.vehicleId,
    },
    simTimeSeconds,
  );

  return { applied: true, incidentId: incident.id };
}

async function applyScheduledEvent(
  scheduledEvent: ScheduledSimulatorEvent,
  simTimeSeconds: number,
): Promise<{ applied: true } | { applied: false; reason: string }> {
  switch (scheduledEvent.kind as ScheduledSimulatorEventKind) {
    case "congestion": {
      const result = await applyScheduledCongestion(scheduledEvent, simTimeSeconds);
      return result.applied ? { applied: true } : result;
    }
    case "vehicle_breakdown": {
      const result = await applyScheduledBreakdown(scheduledEvent, simTimeSeconds);
      return result.applied ? { applied: true } : result;
    }
    default:
      return { applied: false, reason: `Unsupported scheduled event kind: ${scheduledEvent.kind}` };
  }
}

export async function reconcileScheduledSimulatorEvents(params: {
  simTimeSeconds: number;
  scheduledEvents: ScheduledSimulatorEvent[];
}): Promise<ScheduledEventReconcileResult> {
  const processedEventIds = await readProcessedScheduledEventIds();
  const dueEvents = params.scheduledEvents
    .filter((event) => event.due_at_sim_seconds <= params.simTimeSeconds)
    .filter((event) => !processedEventIds.has(event.id))
    .sort((left, right) => left.due_at_sim_seconds - right.due_at_sim_seconds);

  const appliedEventIds: string[] = [];
  const blockedEvents: Array<{ eventId: string; reason: string }> = [];

  for (const event of dueEvents) {
    const result = await applyScheduledEvent(event, params.simTimeSeconds);
    if (result.applied) {
      appliedEventIds.push(event.id);
      continue;
    }

    blockedEvents.push({ eventId: event.id, reason: result.reason });
    await insertSimulationEvent(
      "simulator_scheduled_event_blocked",
      {
        scheduledEventId: event.id,
        kind: event.kind,
        dueAtSimSeconds: event.due_at_sim_seconds,
        attemptedAtSimSeconds: params.simTimeSeconds,
        reason: result.reason,
      },
      params.simTimeSeconds,
    );
  }

  return {
    appliedEventIds,
    blockedEvents,
  };
}
