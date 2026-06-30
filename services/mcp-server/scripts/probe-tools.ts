import { loadSimulationWorld } from "../src/db.js";
import { registerActionTools, registerReadTools } from "../src/tools.js";

type ToolHandler = (input: unknown) => Promise<{ structuredContent: unknown }>;

const handlers = new Map<string, ToolHandler>();

registerReadTools({
  registerTool(name: string, _meta: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

registerActionTools({
  registerTool(name: string, _meta: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

function requireHandler(name: string): ToolHandler {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`Missing handler for ${name}`);
  }

  return handler;
}

async function main() {
  const world = await loadSimulationWorld();
  const firstDriver = world.drivers[0];
  const firstIncident = world.incidents[0];

  if (!firstDriver) {
    throw new Error("No drivers found in simulation world.");
  }

  if (!firstIncident) {
    throw new Error("No incidents found in simulation world.");
  }

  const results = {
    get_business_snapshot: (await requireHandler("get_business_snapshot")({})).structuredContent,
    get_active_orders: (
      await requireHandler("get_active_orders")({
        status: "assigned",
      })
    ).structuredContent,
    get_available_drivers: (await requireHandler("get_available_drivers")({})).structuredContent,
    get_driver_location: (
      await requireHandler("get_driver_location")({
        driverId: firstDriver.id,
      })
    ).structuredContent,
    get_incident_details: (
      await requireHandler("get_incident_details")({
        incidentId: firstIncident.id,
      })
    ).structuredContent,
    check_spending_policy: (
      await requireHandler("check_spending_policy")({
        actionType: "probe_tools",
        amountCents: 500,
        incidentId: firstIncident.id,
      })
    ).structuredContent,
  };

  console.log(JSON.stringify(results, null, 2));
}

void main();
