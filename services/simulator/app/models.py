from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Coordinate(BaseModel):
    lat: float
    lng: float


class AmbientVehicle(BaseModel):
    id: str
    position: Coordinate
    heading_degrees: float = Field(ge=-180, le=180)
    speed_mps: float = Field(ge=0)
    state: Literal["moving", "waiting_signal", "congested"]
    route_id: str
    route_from_waypoint_index: int = Field(ge=0)
    route_to_waypoint_index: int = Field(ge=0)
    distance_along_route_meters: float = Field(ge=0)


class TrafficZone(BaseModel):
    id: str
    center: Coordinate
    radius_meters: float = Field(gt=0)
    severity: Literal["low", "medium", "high"]
    slowdown_multiplier: float = Field(gt=0, le=1)


class SignalLight(BaseModel):
    id: str
    location: Coordinate
    control_location: Coordinate
    controlled_route_from_waypoint_index: int = Field(ge=0)
    controlled_route_to_waypoint_index: int = Field(ge=0)
    phase: Literal["green", "yellow", "red"]
    remaining_seconds: float = Field(ge=0)


class MapViewState(BaseModel):
    longitude: float
    latitude: float
    zoom: float
    pitch: float = Field(ge=0, le=85)
    bearing: float = Field(ge=-180, le=180)


class AmbientRouteSegment(BaseModel):
    from_waypoint_index: int = Field(ge=0)
    to_waypoint_index: int = Field(ge=0)
    geometry: list[Coordinate] = Field(min_length=2)
    distance_meters: float = Field(ge=0)


class ScheduledEvent(BaseModel):
    id: str
    kind: Literal["congestion", "vehicle_breakdown"]
    due_at_sim_seconds: float = Field(ge=0)
    title: str
    description: str


class SimulatorSnapshot(BaseModel):
    sim_time_seconds: float = Field(ge=0)
    simulation_speed: float = Field(gt=0)
    generated_at: str
    scenario_id: str
    scenario_name: str
    market: str
    map_view: MapViewState
    ambient_route_segments: list[AmbientRouteSegment]
    ambient_vehicles: list[AmbientVehicle]
    traffic_zones: list[TrafficZone]
    signal_lights: list[SignalLight]
    scheduled_events: list[ScheduledEvent]
