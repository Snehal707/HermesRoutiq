"use client";

import type { SimClockStatus } from "@/lib/sim/clock";

export interface SimControlsProps {
  status: SimClockStatus;
  breakdownTriggered: boolean;
  planningInProgress: boolean;
  canSimulateBreakdown: boolean;
  canSimulateCongestion: boolean;
  incidentVehicleId: string | null;
  incidentVehicleOptions: Array<{
    id: string;
    label: string;
  }>;
  onIncidentVehicleChange: (vehicleId: string) => void;
  onStart: () => void;
  onReset: () => void;
  onBreakdown: () => void;
  onCongestion: () => void;
}

export function SimControls({
  status,
  breakdownTriggered,
  planningInProgress,
  canSimulateBreakdown,
  canSimulateCongestion,
  incidentVehicleId,
  incidentVehicleOptions,
  onIncidentVehicleChange,
  onStart,
  onReset,
  onBreakdown,
  onCongestion,
}: SimControlsProps) {
  const isRunning = status === "running";
  const controlsDisabled = planningInProgress;
  const breakdownDisabled =
    controlsDisabled || breakdownTriggered || !canSimulateBreakdown;
  const congestionDisabled = controlsDisabled || !canSimulateCongestion;

  return (
    <section className="control-section">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow-label">Simulation</h2>
      </div>
      <div className="mt-3">
        <label className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Incident Vehicle
        </label>
        <select
          value={incidentVehicleId ?? ""}
          onChange={(event) => onIncidentVehicleChange(event.target.value)}
          disabled={controlsDisabled || incidentVehicleOptions.length === 0}
          className="w-full rounded-xl border border-white/10 bg-[#0b1622] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-400/40"
        >
          <option value="" disabled>
            {incidentVehicleOptions.length === 0
              ? "No active delivery vehicles"
              : "Select live vehicle"}
          </option>
          {incidentVehicleOptions.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.id}>
              {vehicle.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={isRunning || controlsDisabled}
          className="control-button control-button-primary flex items-center justify-center"
        >
          <svg className="mr-1.5 h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
              clipRule="evenodd"
            />
          </svg>
          Start Vehicle Motion
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={controlsDisabled}
          className="control-button flex items-center justify-center"
        >
          <svg
            className="mr-1.5 h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12"
            />
          </svg>
          Reset to Empty
        </button>
      </div>
      <button
        type="button"
        onClick={onCongestion}
        disabled={congestionDisabled}
        className="breakdown-button"
      >
        <svg
          className="mr-1.5 h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 15c1.5-2 3-3 4.5-3S10.5 13 12 15s3 3 4.5 3S19.5 17 21 15M3 9c1.5-2 3-3 4.5-3S10.5 7 12 9s3 3 4.5 3S19.5 11 21 9"
          />
        </svg>
        Trigger Traffic Congestion
      </button>
      <button
        type="button"
        onClick={onBreakdown}
        disabled={breakdownDisabled}
        className="breakdown-button"
      >
        <svg
          className="mr-1.5 h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        Trigger Vehicle Breakdown
      </button>
      {planningInProgress ? (
        <p className="panel-meta mt-3 rounded border border-sky-400/10 bg-sky-500/5 p-2 text-center font-mono text-sky-300">
          Route planning is still running.
          <br />
          Incident actions unlock when the live plan is ready.
        </p>
      ) : !canSimulateBreakdown && !canSimulateCongestion ? (
        <p className="panel-meta mt-3 rounded border border-white/10 bg-white/[0.03] p-2 text-center font-mono text-slate-400">
          No active dispatch yet.
          <br />
          Create a paid delivery to release work into the fleet.
        </p>
      ) : !incidentVehicleId ? (
        <p className="panel-meta mt-3 rounded border border-white/10 bg-white/[0.03] p-2 text-center font-mono text-slate-400">
          Select a live vehicle first.
          <br />
          Incidents now target a specific active route instead of a canned vehicle.
        </p>
      ) : null}
    </section>
  );
}
