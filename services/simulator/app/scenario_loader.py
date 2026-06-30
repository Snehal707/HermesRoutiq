from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field

from .models import Coordinate, MapViewState, ScheduledEvent, TrafficZone
from .world_seed import Point

SCENARIOS_DIR = Path(__file__).resolve().parent.parent / "scenarios"
DEFAULT_SCENARIO_ID = "financial-district"


class ScenarioSignalLight(BaseModel):
    id: str
    location: Coordinate
    control_location: Coordinate | None = None
    display_location: Coordinate | None = None
    controlled_route_from_waypoint_index: int | None = Field(default=None, ge=0)
    controlled_route_to_waypoint_index: int | None = Field(default=None, ge=0)


class ScenarioConfig(BaseModel):
    id: str
    name: str
    market: str
    simulation_speed: float = Field(gt=0)
    vehicle_count: int = Field(gt=0)
    map_view: MapViewState
    waypoints: list[Coordinate] = Field(min_length=2)
    traffic_zones: list[TrafficZone]
    signal_lights: list[ScenarioSignalLight]
    scheduled_events: list[ScheduledEvent]

    def waypoint_points(self) -> tuple[Point, ...]:
        return tuple(Point(lat=point.lat, lng=point.lng) for point in self.waypoints)

    def signal_points(self) -> tuple[dict[str, Point | int | None], ...]:
        return tuple(
            {
                "id": signal.id,
                "location": Point(lat=signal.location.lat, lng=signal.location.lng),
                "control_location": (
                    Point(
                        lat=signal.control_location.lat,
                        lng=signal.control_location.lng,
                    )
                    if signal.control_location is not None
                    else None
                ),
                "display_location": (
                    Point(
                        lat=signal.display_location.lat,
                        lng=signal.display_location.lng,
                    )
                    if signal.display_location is not None
                    else None
                ),
                "controlled_route_from_waypoint_index": signal.controlled_route_from_waypoint_index,
                "controlled_route_to_waypoint_index": signal.controlled_route_to_waypoint_index,
            }
            for signal in self.signal_lights
        )


def resolve_scenario_id(explicit_scenario_id: str | None = None) -> str:
    scenario_id = explicit_scenario_id or os.environ.get(
        "SIMULATOR_SCENARIO_ID",
        DEFAULT_SCENARIO_ID,
    )
    return scenario_id.strip() or DEFAULT_SCENARIO_ID


def load_scenario_config(explicit_scenario_id: str | None = None) -> ScenarioConfig:
    scenario_id = resolve_scenario_id(explicit_scenario_id)
    scenario_path = SCENARIOS_DIR / f"{scenario_id}.json"

    if not scenario_path.exists():
        available = ", ".join(
            sorted(path.stem for path in SCENARIOS_DIR.glob("*.json"))
        ) or "(none)"
        raise FileNotFoundError(
            f"Simulator scenario '{scenario_id}' was not found in {SCENARIOS_DIR}. "
            f"Available scenarios: {available}"
        )

    with scenario_path.open("r", encoding="utf-8") as scenario_file:
        payload = json.load(scenario_file)

    return ScenarioConfig.model_validate(payload)
