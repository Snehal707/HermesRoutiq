export interface SimulatorCoordinate {
  lat: number;
  lng: number;
}

export type AmbientVehicleState = "moving" | "waiting_signal" | "congested";
export type TrafficZoneSeverity = "low" | "medium" | "high";
export type SignalPhase = "green" | "yellow" | "red";
export type ScheduledSimulatorEventKind = "congestion" | "vehicle_breakdown";

export interface AmbientVehicle {
  id: string;
  position: SimulatorCoordinate;
  heading_degrees: number;
  speed_mps: number;
  state: AmbientVehicleState;
  route_id: string;
  route_from_waypoint_index: number;
  route_to_waypoint_index: number;
  distance_along_route_meters: number;
}

export interface TrafficZone {
  id: string;
  center: SimulatorCoordinate;
  radius_meters: number;
  severity: TrafficZoneSeverity;
  slowdown_multiplier: number;
}

export interface SignalLight {
  id: string;
  location: SimulatorCoordinate;
  control_location: SimulatorCoordinate;
  controlled_route_from_waypoint_index: number;
  controlled_route_to_waypoint_index: number;
  phase: SignalPhase;
  remaining_seconds: number;
}

export interface ScheduledSimulatorEvent {
  id: string;
  kind: ScheduledSimulatorEventKind;
  due_at_sim_seconds: number;
  title: string;
  description: string;
}

export interface SimulatorMapView {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface AmbientRouteSegment {
  from_waypoint_index: number;
  to_waypoint_index: number;
  geometry: SimulatorCoordinate[];
  distance_meters: number;
}

export interface SimulatorSnapshot {
  sim_time_seconds: number;
  simulation_speed: number;
  generated_at: string;
  scenario_id: string;
  scenario_name: string;
  market: string;
  map_view: SimulatorMapView;
  ambient_route_segments: AmbientRouteSegment[];
  ambient_vehicles: AmbientVehicle[];
  traffic_zones: TrafficZone[];
  signal_lights: SignalLight[];
  scheduled_events: ScheduledSimulatorEvent[];
}
