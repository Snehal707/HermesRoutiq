"use client";

import type { RouteStatus, SimulationWorld } from "@/lib/sim/types";
import { useMemo } from "react";

const ROUTE_TRAIL_COLORS: Record<RouteStatus, [number, number, number]> = {
  normal: [0, 255, 128],
  at_risk: [0, 220, 255],
  incident: [255, 50, 50],
  recovery: [50, 150, 255],
  completed: [0, 255, 128],
};

const LEGEND_LABELS: Record<
  Exclude<RouteStatus, "completed">,
  string
> = {
  normal: "Active Route",
  at_risk: "Delayed Route",
  incident: "Disrupted Route",
  recovery: "Recovery Route",
};

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

export function Legend({ world }: { world: SimulationWorld | null }) {
  const visibleStatuses = useMemo(() => {
    const orderedStatuses: Array<Exclude<RouteStatus, "completed">> = [
      "normal",
      "at_risk",
      "incident",
      "recovery",
    ];

    if (!world) {
      return [] as Array<Exclude<RouteStatus, "completed">>;
    }

    const activeStatuses = new Set(
      world.vehicles
        .filter(
          (vehicle) =>
            (vehicle.status === "en_route" && vehicle.route.length > 1) ||
            vehicle.routeStatus === "incident" ||
            vehicle.routeStatus === "recovery" ||
            vehicle.routeStatus === "at_risk",
        )
        .map((vehicle) => vehicle.routeStatus)
        .filter(
          (status): status is Exclude<RouteStatus, "completed"> =>
            status !== "completed",
        ),
    );

    return orderedStatuses.filter((status) => activeStatuses.has(status));
  }, [world]);

  return (
    <section className="control-section">
      <h2 className="eyebrow-label">Route Status</h2>
      {visibleStatuses.length > 0 ? (
        <ul className="legend-list">
          {visibleStatuses.map((status) => (
            <li key={status} className="legend-item flex items-center justify-between group cursor-default">
              <span className="text-xs font-medium text-slate-300 group-hover:text-white transition-colors duration-150">
                {LEGEND_LABELS[status]}
              </span>
              <span
                className={`inline-block shrink-0 rounded-full transition-all duration-300 ${
                  status === "incident" || status === "recovery"
                    ? "h-1.5 w-8 shadow-[0_0_8px_currentColor] scale-105"
                    : "h-1 w-8 opacity-80 group-hover:opacity-100"
                }`}
                style={{
                  backgroundColor: rgbToCss(ROUTE_TRAIL_COLORS[status]),
                  color: rgbToCss(ROUTE_TRAIL_COLORS[status]),
                }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          No active routes yet.
        </p>
      )}
    </section>
  );
}
