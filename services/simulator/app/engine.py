from __future__ import annotations

import math
import random
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx
import simpy

from .config import get_osrm_base_url, get_osrm_exclude
from .models import (
    AmbientRouteSegment,
    AmbientVehicle,
    Coordinate,
    MapViewState,
    SignalLight,
    SimulatorSnapshot,
    TrafficZone,
)
from .scenario_loader import ScenarioConfig, load_scenario_config
from .world_seed import Point

DEFAULT_SPEED_MPS = 9.5
SNAPSHOT_ADVANCE_STEP_SECONDS = 0.5
SIGNAL_STOP_BUFFER_METERS = 3.0
QUEUE_SPACING_METERS = 7.5
MAX_ACCELERATION_MPS2 = 1.8
MAX_BRAKING_MPS2 = 3.6
FOLLOWING_GAP_METERS = 10.0
FOLLOWING_HEADWAY_SECONDS = 1.4
MAX_SIGNAL_ROUTE_SNAP_DISTANCE_METERS = 45.0
SIGNAL_ROUTE_MATCH_METERS = 18.0
SIGNAL_APPROACH_ENGAGE_METERS = 28.0


def haversine_meters(a: Point, b: Point) -> float:
    lat1 = math.radians(a.lat)
    lat2 = math.radians(b.lat)
    d_lat = lat2 - lat1
    d_lng = math.radians(b.lng - a.lng)
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(d_lng / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(min(1.0, math.sqrt(h)))


def interpolate_point(start: Point, end: Point, progress: float) -> Point:
    return Point(
        lat=start.lat + (end.lat - start.lat) * progress,
        lng=start.lng + (end.lng - start.lng) * progress,
    )


def heading_degrees(start: Point, end: Point) -> float:
    y = math.sin(math.radians(end.lng - start.lng)) * math.cos(math.radians(end.lat))
    x = (
        math.cos(math.radians(start.lat)) * math.sin(math.radians(end.lat))
        - math.sin(math.radians(start.lat))
        * math.cos(math.radians(end.lat))
        * math.cos(math.radians(end.lng - start.lng))
    )
    return math.degrees(math.atan2(y, x))


def meters_xy(origin: Point, point: Point) -> tuple[float, float]:
    mean_lat = math.radians((origin.lat + point.lat) / 2)
    lat_meters = (point.lat - origin.lat) * 111_320
    lng_meters = (point.lng - origin.lng) * 111_320 * math.cos(mean_lat)
    return lng_meters, lat_meters


def point_from_local_meters(origin: Point, x_meters: float, y_meters: float) -> Point:
    lat = origin.lat + y_meters / 111_320
    mean_lat = math.radians((origin.lat + lat) / 2)
    lng_scale = 111_320 * max(math.cos(mean_lat), 0.01)
    lng = origin.lng + x_meters / lng_scale
    return Point(lat=lat, lng=lng)


def closest_point_on_segment(
    point: Point,
    start: Point,
    end: Point,
) -> tuple[Point, float]:
    sx, sy = meters_xy(point, start)
    ex, ey = meters_xy(point, end)
    dx = ex - sx
    dy = ey - sy

    if dx == 0 and dy == 0:
        return start, 0.0

    projection = (-sx * dx + -sy * dy) / (dx * dx + dy * dy)
    clamped = max(0.0, min(1.0, projection))
    closest_x = sx + dx * clamped
    closest_y = sy + dy * clamped
    return point_from_local_meters(point, closest_x, closest_y), clamped


def project_point_to_geometry(
    geometry: list[Point],
    point: Point,
) -> tuple[Point, float, float, float]:
    if len(geometry) == 1:
        return geometry[0], 0.0, 0.0, haversine_meters(point, geometry[0])

    best_point = geometry[0]
    best_heading = 0.0
    best_distance = float("inf")
    best_distance_along = 0.0
    traversed = 0.0

    for index in range(1, len(geometry)):
        start = geometry[index - 1]
        end = geometry[index]
        segment_length = haversine_meters(start, end)
        closest_point, progress = closest_point_on_segment(point, start, end)
        distance = haversine_meters(point, closest_point)

        if distance < best_distance:
            best_distance = distance
            best_point = closest_point
            best_heading = heading_degrees(start, end)
            best_distance_along = traversed + segment_length * progress

        traversed += segment_length

    return best_point, best_distance_along, best_heading, best_distance


def offset_point(
    point: Point,
    heading_degrees_value: float,
    right_offset_meters: float = 0.0,
    backward_offset_meters: float = 0.0,
) -> Point:
    heading_radians = math.radians(heading_degrees_value)
    right_radians = heading_radians + math.pi / 2

    east_meters = (
        math.sin(right_radians) * right_offset_meters
        - math.sin(heading_radians) * backward_offset_meters
    )
    north_meters = (
        math.cos(right_radians) * right_offset_meters
        - math.cos(heading_radians) * backward_offset_meters
    )

    return point_from_local_meters(point, east_meters, north_meters)


def dedupe_consecutive_points(points: list[Point]) -> list[Point]:
    deduped: list[Point] = []
    for point in points:
        if not deduped or deduped[-1].lat != point.lat or deduped[-1].lng != point.lng:
            deduped.append(point)
    return deduped


def position_along_route_geometry(
    geometry: list[Point],
    distance_meters: float,
) -> tuple[Point, float]:
    if len(geometry) == 0:
        return Point(0.0, 0.0), 0.0
    if len(geometry) == 1:
        return geometry[0], 0.0

    remaining_distance = max(0.0, distance_meters)
    for index in range(1, len(geometry)):
        start = geometry[index - 1]
        end = geometry[index]
        segment_length = haversine_meters(start, end)
        if segment_length <= 0:
            continue
        if remaining_distance <= segment_length:
            progress = remaining_distance / segment_length
            return interpolate_point(start, end, progress), heading_degrees(start, end)
        remaining_distance -= segment_length

    return geometry[-1], heading_degrees(geometry[-2], geometry[-1])


def request_raw_osrm_route(
    client: httpx.Client,
    base_url: str,
    coordinates: list[tuple[float, float]],
    exclude: str | None = None,
) -> tuple[list[Point], float]:
    coord_string = ";".join(f"{lng},{lat}" for lng, lat in coordinates)
    params: dict[str, str] = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
    }
    if exclude:
        params["exclude"] = exclude

    response = client.get(
        f"{base_url.rstrip('/')}/route/v1/driving/{coord_string}",
        params=params,
    )
    response.raise_for_status()

    payload = response.json()
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(f"OSRM route request failed: {payload}")

    best_route = payload["routes"][0]
    geometry = dedupe_consecutive_points(
        [
            Point(lat=float(point[1]), lng=float(point[0]))
            for point in best_route["geometry"]["coordinates"]
        ]
    )

    if len(geometry) < 2:
        raise RuntimeError(
            "OSRM returned insufficient geometry for ambient route generation."
        )

    return geometry, float(best_route["distance"])


def request_osrm_nearest_point(
    client: httpx.Client,
    base_url: str,
    point: Point,
) -> Point:
    response = client.get(
        f"{base_url.rstrip('/')}/nearest/v1/driving/{point.lng},{point.lat}",
        params={"number": 1},
    )
    response.raise_for_status()

    payload = response.json()
    if payload.get("code") != "Ok" or not payload.get("waypoints"):
        raise RuntimeError(f"OSRM nearest request failed: {payload}")

    location = payload["waypoints"][0].get("location")
    if (
        not isinstance(location, list)
        or len(location) < 2
        or not isinstance(location[0], (int, float))
        or not isinstance(location[1], (int, float))
    ):
        raise RuntimeError(f"OSRM nearest response missing location: {payload}")

    return Point(lat=float(location[1]), lng=float(location[0]))


def build_route_segments(scenario: ScenarioConfig) -> list[AmbientRouteSegment]:
    waypoints = scenario.waypoint_points()
    requested_pairs: set[tuple[int, int]] = set()

    for index in range(scenario.vehicle_count):
        route_index = index % len(waypoints)
        next_route_index = (route_index + 1 + (index % 3)) % len(waypoints)
        requested_pairs.add((route_index, next_route_index))

    for route_index in range(len(waypoints)):
        requested_pairs.add((route_index, (route_index + 1) % len(waypoints)))

    with httpx.Client(timeout=30.0) as client:
        segments: list[AmbientRouteSegment] = []
        for from_index, to_index in sorted(requested_pairs):
            start = waypoints[from_index]
            end = waypoints[to_index]
            geometry, distance_meters = request_raw_osrm_route(
                client,
                get_osrm_base_url(),
                [(start.lng, start.lat), (end.lng, end.lat)],
                exclude=get_osrm_exclude(),
            )
            segments.append(
                AmbientRouteSegment(
                    from_waypoint_index=from_index,
                    to_waypoint_index=to_index,
                    geometry=[
                        Coordinate(lat=point.lat, lng=point.lng)
                        for point in geometry
                    ],
                    distance_meters=distance_meters,
                )
            )
    return segments


def snap_signal_locations(scenario: ScenarioConfig) -> list[Point]:
    snapped_points: list[Point] = []
    with httpx.Client(timeout=30.0) as client:
        for signal in scenario.signal_points():
            original_location = signal["location"]
            try:
                snapped_points.append(
                    request_osrm_nearest_point(
                        client,
                        get_osrm_base_url(),
                        original_location,
                    )
                )
            except Exception:
                snapped_points.append(original_location)
    return snapped_points


def build_signal_states(
    scenario: ScenarioConfig,
    route_segments: list[AmbientRouteSegment],
    rng: random.Random,
) -> list["SignalState"]:
    signal_states: list[SignalState] = []
    route_segment_by_pair = {
        (segment.from_waypoint_index, segment.to_waypoint_index): segment
        for segment in route_segments
    }

    with httpx.Client(timeout=30.0) as client:
        for entry in scenario.signal_points():
            authored_location = entry["location"]
            authored_control_location = entry.get("control_location") or authored_location
            authored_display_location = entry.get("display_location") or authored_location
            explicit_from_index = entry.get("controlled_route_from_waypoint_index")
            explicit_to_index = entry.get("controlled_route_to_waypoint_index")
            snapped_location = authored_control_location

            if explicit_from_index is None or explicit_to_index is None:
                try:
                    snapped_location = request_osrm_nearest_point(
                        client,
                        get_osrm_base_url(),
                        authored_control_location,
                    )
                except Exception:
                    snapped_location = authored_control_location

            best_anchor = snapped_location
            best_heading = 0.0
            best_distance = float("inf")
            best_from_index = 0
            best_to_index = 0

            candidate_segments = route_segments
            if explicit_from_index is not None and explicit_to_index is not None:
                explicit_segment = route_segment_by_pair.get(
                    (explicit_from_index, explicit_to_index)
                )
                if explicit_segment is None:
                    continue
                candidate_segments = [explicit_segment]

            for segment in candidate_segments:
                geometry = segment_geometry(segment)
                if len(geometry) < 2:
                    continue

                anchor, _, heading, distance = project_point_to_geometry(
                    geometry,
                    snapped_location,
                )
                if distance < best_distance:
                    best_anchor = anchor
                    best_heading = heading
                    best_distance = distance
                    best_from_index = segment.from_waypoint_index
                    best_to_index = segment.to_waypoint_index

            if (
                explicit_from_index is None
                and explicit_to_index is None
                and best_distance > MAX_SIGNAL_ROUTE_SNAP_DISTANCE_METERS
            ):
                continue

            control_location = best_anchor
            display_location = authored_display_location

            signal = SignalState(
                id=entry["id"],
                location=control_location,
                display_location=display_location,
                controlled_route_from_waypoint_index=best_from_index,
                controlled_route_to_waypoint_index=best_to_index,
            )
            signal.apply_cycle_offset(0.0, rng.random() * signal.cycle_seconds)
            signal_states.append(signal)

    return signal_states


def segment_geometry(segment: AmbientRouteSegment) -> list[Point]:
    return [Point(lat=point.lat, lng=point.lng) for point in segment.geometry]


@dataclass
class SignalState:
    id: str
    location: Point
    display_location: Point
    controlled_route_from_waypoint_index: int
    controlled_route_to_waypoint_index: int
    green_seconds: float = 16.0
    yellow_seconds: float = 4.0
    red_seconds: float = 14.0
    phase: str = "green"
    phase_started_at: float = 0.0

    def set_phase(self, phase: str, now: float) -> None:
        self.phase = phase
        self.phase_started_at = now

    def remaining_seconds(self, now: float) -> float:
        duration = {
            "green": self.green_seconds,
            "yellow": self.yellow_seconds,
            "red": self.red_seconds,
        }[self.phase]
        return max(0.0, duration - (now - self.phase_started_at))

    @property
    def cycle_seconds(self) -> float:
        return self.green_seconds + self.yellow_seconds + self.red_seconds

    def apply_cycle_offset(self, now: float, offset_seconds: float) -> None:
        normalized = offset_seconds % self.cycle_seconds
        if normalized < self.green_seconds:
            self.set_phase("green", now - normalized)
            return
        normalized -= self.green_seconds
        if normalized < self.yellow_seconds:
            self.set_phase("yellow", now - normalized)
            return
        normalized -= self.yellow_seconds
        self.set_phase("red", now - normalized)


@dataclass
class VehicleState:
    id: str
    route_index: int
    next_route_index: int
    previous_route_index: int | None
    base_speed_mps: float
    position: Point
    heading: float
    speed_mps: float
    route_geometry: list[Point]
    route_length_meters: float
    distance_along_route_meters: float
    state: str = "moving"
    wait_until: float = 0.0


@dataclass
class SimulatorRuntime:
    env: simpy.Environment
    rng: random.Random
    signals: list[SignalState]
    vehicles: list[VehicleState]
    started_at_wall: float
    scenario: ScenarioConfig
    route_segments: list[AmbientRouteSegment]
    route_cache: dict[tuple[int, int], AmbientRouteSegment]
    adjacency_by_from: dict[int, list[int]]
    lock: threading.Lock = field(default_factory=threading.Lock)


def active_slowdown_multiplier(
    position: Point,
    traffic_zones: list[TrafficZone],
) -> tuple[float, str]:
    for zone in traffic_zones:
        zone_center = Point(lat=zone.center.lat, lng=zone.center.lng)
        if haversine_meters(position, zone_center) <= zone.radius_meters:
            return zone.slowdown_multiplier, "congested"
    return 1.0, "moving"


def signal_engages_vehicle(signal: SignalState, vehicle: VehicleState) -> bool:
    """A red light stops a vehicle when the light sits on the road the vehicle
    is driving (small lateral offset) and is still ahead of it within braking
    range. This is proximity-based rather than keyed to a single authored
    waypoint pair, so every approach through the intersection is governed."""
    if signal.phase != "red":
        return False

    _, distance_along, _, lateral_distance = project_point_to_geometry(
        vehicle.route_geometry,
        signal.location,
    )
    if lateral_distance > SIGNAL_ROUTE_MATCH_METERS:
        return False

    gap = distance_along - vehicle.distance_along_route_meters
    return -SIGNAL_STOP_BUFFER_METERS <= gap <= SIGNAL_APPROACH_ENGAGE_METERS


def create_signal_process(runtime: SimulatorRuntime, signal: SignalState):
    def run():
        while True:
            yield runtime.env.timeout(signal.remaining_seconds(runtime.env.now))
            next_phase = {
                "green": "yellow",
                "yellow": "red",
                "red": "green",
            }[signal.phase]
            signal.set_phase(next_phase, runtime.env.now)

    return run()


def signal_distance_along_geometry(
    geometry: list[Point],
    signal: SignalState,
) -> float:
    _, distance_along, _, _ = project_point_to_geometry(geometry, signal.location)
    return distance_along


def queued_vehicle_count_ahead(
    runtime: SimulatorRuntime,
    vehicle: VehicleState,
    signal: SignalState,
) -> int:
    count = 0
    for other in runtime.vehicles:
        if other.id == vehicle.id:
            continue
        if other.route_index != vehicle.route_index:
            continue
        if other.next_route_index != vehicle.next_route_index:
            continue
        if other.state != "waiting_signal":
            continue
        if other.distance_along_route_meters > vehicle.distance_along_route_meters:
            count += 1
    return count


def choose_next_route_index(
    runtime: SimulatorRuntime,
    route_index: int,
    previous_route_index: int | None,
) -> int:
    candidates = runtime.adjacency_by_from.get(route_index, [])
    if not candidates:
        return route_index

    if previous_route_index is not None:
        non_backtracking = [
            candidate for candidate in candidates if candidate != previous_route_index
        ]
        if non_backtracking:
            candidates = non_backtracking

    return runtime.rng.choice(candidates)


def advance_speed_toward_target(
    current_speed: float,
    target_speed: float,
    step_seconds: float,
) -> float:
    if target_speed >= current_speed:
        return min(target_speed, current_speed + MAX_ACCELERATION_MPS2 * step_seconds)
    return max(target_speed, current_speed - MAX_BRAKING_MPS2 * step_seconds)


def following_speed_cap(
    runtime: SimulatorRuntime,
    vehicle: VehicleState,
    target_speed: float,
) -> tuple[float, str | None]:
    lead_vehicles = [
        other
        for other in runtime.vehicles
        if other.id != vehicle.id
        and other.route_index == vehicle.route_index
        and other.next_route_index == vehicle.next_route_index
        and other.distance_along_route_meters > vehicle.distance_along_route_meters
    ]
    if not lead_vehicles:
        return target_speed, None

    lead_vehicle = min(
        lead_vehicles,
        key=lambda candidate: candidate.distance_along_route_meters,
    )
    gap_meters = (
        lead_vehicle.distance_along_route_meters - vehicle.distance_along_route_meters
    )
    effective_gap = max(0.0, gap_meters - FOLLOWING_GAP_METERS)
    if effective_gap <= 0:
        return 0.0, "queued"

    lead_speed = max(0.0, lead_vehicle.speed_mps)
    safe_follow_speed = min(
        lead_speed + effective_gap / FOLLOWING_HEADWAY_SECONDS,
        effective_gap / SNAPSHOT_ADVANCE_STEP_SECONDS,
    )
    if safe_follow_speed < target_speed:
        return safe_follow_speed, "following"
    return target_speed, None


def signal_speed_cap(
    runtime: SimulatorRuntime,
    vehicle: VehicleState,
    current_speed: float,
    signal: SignalState | None,
) -> tuple[float, float | None]:
    if signal is None:
        return current_speed, None

    stop_distance = max(
        0.0,
        signal_distance_along_geometry(
            vehicle.route_geometry,
            signal,
        )
        - SIGNAL_STOP_BUFFER_METERS,
    )
    queue_index = queued_vehicle_count_ahead(runtime, vehicle, signal)
    target_distance = max(
        0.0,
        stop_distance - queue_index * QUEUE_SPACING_METERS,
    )
    remaining_distance = target_distance - vehicle.distance_along_route_meters

    if remaining_distance <= 0:
        return 0.0, target_distance

    braking_speed_cap = math.sqrt(
        max(0.0, 2 * MAX_BRAKING_MPS2 * remaining_distance)
    )
    hard_step_cap = remaining_distance / SNAPSHOT_ADVANCE_STEP_SECONDS
    return min(current_speed, braking_speed_cap, hard_step_cap), target_distance


def create_vehicle_process(runtime: SimulatorRuntime, vehicle: VehicleState):
    def run():
        while True:
            now = runtime.env.now
            if vehicle.wait_until > now:
                vehicle.speed_mps = 0.0
                vehicle.state = "waiting_signal"
                yield runtime.env.timeout(min(vehicle.wait_until - now, 1.0))
                continue

            current_point, current_heading = position_along_route_geometry(
                vehicle.route_geometry,
                vehicle.distance_along_route_meters,
            )
            slowdown_multiplier, state = active_slowdown_multiplier(
                current_point,
                runtime.scenario.traffic_zones,
            )
            target_speed = vehicle.base_speed_mps * slowdown_multiplier

            blocking_signal = next(
                (
                    signal
                    for signal in runtime.signals
                    if signal_engages_vehicle(signal, vehicle)
                ),
                None,
            )
            target_speed, signal_target_distance = signal_speed_cap(
                runtime,
                vehicle,
                target_speed,
                blocking_signal,
            )
            target_speed, following_state = following_speed_cap(
                runtime,
                vehicle,
                target_speed,
            )
            next_speed = advance_speed_toward_target(
                vehicle.speed_mps,
                target_speed,
                SNAPSHOT_ADVANCE_STEP_SECONDS,
            )
            projected_distance = (
                vehicle.distance_along_route_meters
                + next_speed * SNAPSHOT_ADVANCE_STEP_SECONDS
            )
            if blocking_signal is not None:
                target_distance = signal_target_distance or vehicle.distance_along_route_meters

                if projected_distance >= target_distance:
                    vehicle.distance_along_route_meters = target_distance
                    vehicle.position, vehicle.heading = position_along_route_geometry(
                        vehicle.route_geometry,
                        vehicle.distance_along_route_meters,
                    )
                    vehicle.speed_mps = 0.0
                    vehicle.state = "waiting_signal"
                    vehicle.wait_until = now + SNAPSHOT_ADVANCE_STEP_SECONDS
                    yield runtime.env.timeout(SNAPSHOT_ADVANCE_STEP_SECONDS)
                    continue

                vehicle.state = "congested" if state == "congested" else "moving"
                vehicle.speed_mps = next_speed
                vehicle.heading = current_heading
                vehicle.distance_along_route_meters = min(
                    projected_distance,
                    target_distance,
                )
                vehicle.position, vehicle.heading = position_along_route_geometry(
                    vehicle.route_geometry,
                    vehicle.distance_along_route_meters,
                )
                vehicle.wait_until = 0.0
                yield runtime.env.timeout(SNAPSHOT_ADVANCE_STEP_SECONDS)
                continue

            vehicle.state = (
                "congested"
                if state == "congested"
                else "congested"
                if following_state == "following"
                else "moving"
            )
            vehicle.speed_mps = next_speed
            vehicle.heading = current_heading
            vehicle.wait_until = 0.0
            vehicle.distance_along_route_meters += (
                next_speed * SNAPSHOT_ADVANCE_STEP_SECONDS
            )
            vehicle.position, vehicle.heading = position_along_route_geometry(
                vehicle.route_geometry,
                vehicle.distance_along_route_meters,
            )

            while vehicle.distance_along_route_meters >= vehicle.route_length_meters:
                overflow = vehicle.distance_along_route_meters - vehicle.route_length_meters
                previous_route_index = vehicle.route_index
                vehicle.route_index = vehicle.next_route_index
                vehicle.previous_route_index = previous_route_index
                vehicle.next_route_index = choose_next_route_index(
                    runtime,
                    vehicle.route_index,
                    previous_route_index,
                )
                next_segment = runtime.route_cache[
                    (vehicle.route_index, vehicle.next_route_index)
                ]
                vehicle.route_geometry = segment_geometry(next_segment)
                vehicle.route_length_meters = max(next_segment.distance_meters, 1.0)
                vehicle.distance_along_route_meters = min(
                    overflow,
                    vehicle.route_length_meters,
                )
                vehicle.position, vehicle.heading = position_along_route_geometry(
                    vehicle.route_geometry,
                    vehicle.distance_along_route_meters,
                )

            yield runtime.env.timeout(SNAPSHOT_ADVANCE_STEP_SECONDS)

    return run()


def create_runtime(scenario: ScenarioConfig, seed: int = 42) -> SimulatorRuntime:
    env = simpy.Environment()
    rng = random.Random(seed)
    waypoints = scenario.waypoint_points()
    route_segments = build_route_segments(scenario)
    route_cache = {
        (segment.from_waypoint_index, segment.to_waypoint_index): segment
        for segment in route_segments
    }
    adjacency_by_from: dict[int, list[int]] = {}
    for segment in route_segments:
        adjacency_by_from.setdefault(segment.from_waypoint_index, []).append(
            segment.to_waypoint_index
        )
    signals = build_signal_states(scenario, route_segments, rng)
    vehicles: list[VehicleState] = []

    for index in range(scenario.vehicle_count):
        route_index = index % len(waypoints)
        next_route_index = (route_index + 1 + (index % 3)) % len(waypoints)
        segment = route_cache[(route_index, next_route_index)]
        geometry = segment_geometry(segment)
        route_length_meters = max(segment.distance_meters, 1.0)
        distance_along_route_meters = rng.random() * route_length_meters
        position, heading = position_along_route_geometry(
            geometry,
            distance_along_route_meters,
        )

        vehicles.append(
            VehicleState(
                id=f"ambient-{index + 1}",
                route_index=route_index,
                next_route_index=next_route_index,
                previous_route_index=None,
                base_speed_mps=DEFAULT_SPEED_MPS + rng.uniform(-2.0, 3.0),
                position=position,
                heading=heading,
                speed_mps=DEFAULT_SPEED_MPS,
                route_geometry=geometry,
                route_length_meters=route_length_meters,
                distance_along_route_meters=distance_along_route_meters,
            )
        )

    runtime = SimulatorRuntime(
        env=env,
        rng=rng,
        signals=signals,
        vehicles=vehicles,
        started_at_wall=datetime.now(timezone.utc).timestamp(),
        scenario=scenario,
        route_segments=route_segments,
        route_cache=route_cache,
        adjacency_by_from=adjacency_by_from,
    )

    for signal in signals:
        env.process(create_signal_process(runtime, signal))
    for vehicle in vehicles:
        env.process(create_vehicle_process(runtime, vehicle))

    return runtime


class AmbientTrafficSimulator:
    def __init__(self, seed: int = 42, scenario_id: str | None = None) -> None:
        self._scenario = load_scenario_config(scenario_id)
        self._runtime = create_runtime(self._scenario, seed=seed)

    def _target_sim_time(self) -> float:
        now = datetime.now(timezone.utc).timestamp()
        elapsed_wall = max(0.0, now - self._runtime.started_at_wall)
        return elapsed_wall * self._scenario.simulation_speed

    def _advance_to_target(self) -> None:
        target = self._target_sim_time()
        while self._runtime.env.now + SNAPSHOT_ADVANCE_STEP_SECONDS < target:
            self._runtime.env.run(until=self._runtime.env.now + SNAPSHOT_ADVANCE_STEP_SECONDS)
        if self._runtime.env.now < target:
            self._runtime.env.run(until=target)

    def snapshot(self) -> SimulatorSnapshot:
        with self._runtime.lock:
            self._advance_to_target()
            now = self._runtime.env.now
            ambient_vehicles = [
                AmbientVehicle(
                    id=vehicle.id,
                    position=Coordinate(
                        lat=vehicle.position.lat,
                        lng=vehicle.position.lng,
                    ),
                    heading_degrees=vehicle.heading,
                    speed_mps=round(vehicle.speed_mps, 2),
                    state=vehicle.state,
                    route_id=f"loop-{vehicle.route_index}",
                    route_from_waypoint_index=vehicle.route_index,
                    route_to_waypoint_index=vehicle.next_route_index,
                    distance_along_route_meters=round(
                        vehicle.distance_along_route_meters,
                        2,
                    ),
                )
                for vehicle in self._runtime.vehicles
            ]
            signal_lights = [
                SignalLight(
                    id=signal.id,
                    location=Coordinate(
                        lat=signal.display_location.lat,
                        lng=signal.display_location.lng,
                    ),
                    control_location=Coordinate(
                        lat=signal.location.lat,
                        lng=signal.location.lng,
                    ),
                    controlled_route_from_waypoint_index=signal.controlled_route_from_waypoint_index,
                    controlled_route_to_waypoint_index=signal.controlled_route_to_waypoint_index,
                    phase=signal.phase,
                    remaining_seconds=round(signal.remaining_seconds(now), 1),
                )
                for signal in self._runtime.signals
            ]
            return SimulatorSnapshot(
                sim_time_seconds=round(now, 1),
                simulation_speed=self._scenario.simulation_speed,
                generated_at=datetime.now(timezone.utc).isoformat(),
                scenario_id=self._scenario.id,
                scenario_name=self._scenario.name,
                market=self._scenario.market,
                map_view=MapViewState.model_validate(self._scenario.map_view),
                ambient_route_segments=self._runtime.route_segments,
                ambient_vehicles=ambient_vehicles,
                traffic_zones=self._scenario.traffic_zones,
                signal_lights=signal_lights,
                scheduled_events=self._scenario.scheduled_events,
            )
