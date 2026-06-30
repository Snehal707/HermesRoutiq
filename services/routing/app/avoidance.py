from __future__ import annotations

import math
from typing import Iterable

import httpx

from app.providers.base import AvoidArea

# Detour via-points sit a full block (~220 m) outside the box so OSRM commits to
# a parallel street instead of squeezing back through the congested block.
DETOUR_MARGIN_DEGREES = 0.0025
_EARTH_RADIUS_METERS = 6_371_000.0
# Extra seconds charged per metre driven inside a congestion zone. Tuned so a
# clean one-block detour beats crawling through a small congestion patch, while a
# long looping detour never wins.
CONGESTION_SECONDS_PER_METER = 0.5


def _point_in_area(point: tuple[float, float], area: AvoidArea) -> bool:
    lng, lat = point
    return (
        area.min_lng <= lng <= area.max_lng
        and area.min_lat <= lat <= area.max_lat
    )


def _orientation(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
) -> float:
    return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])


def _on_segment(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
) -> bool:
    return (
        min(a[0], c[0]) <= b[0] <= max(a[0], c[0])
        and min(a[1], c[1]) <= b[1] <= max(a[1], c[1])
    )


def _segments_intersect(
    a1: tuple[float, float],
    a2: tuple[float, float],
    b1: tuple[float, float],
    b2: tuple[float, float],
) -> bool:
    o1 = _orientation(a1, a2, b1)
    o2 = _orientation(a1, a2, b2)
    o3 = _orientation(b1, b2, a1)
    o4 = _orientation(b1, b2, a2)

    if o1 == 0 and _on_segment(a1, b1, a2):
        return True
    if o2 == 0 and _on_segment(a1, b2, a2):
        return True
    if o3 == 0 and _on_segment(b1, a1, b2):
        return True
    if o4 == 0 and _on_segment(b1, a2, b2):
        return True

    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0)


def _segment_intersects_area(
    start: tuple[float, float],
    end: tuple[float, float],
    area: AvoidArea,
) -> bool:
    if _point_in_area(start, area) or _point_in_area(end, area):
        return True

    corners = [
        (area.min_lng, area.min_lat),
        (area.max_lng, area.min_lat),
        (area.max_lng, area.max_lat),
        (area.min_lng, area.max_lat),
    ]
    edges = [
        (corners[0], corners[1]),
        (corners[1], corners[2]),
        (corners[2], corners[3]),
        (corners[3], corners[0]),
    ]

    return any(
        _segments_intersect(start, end, edge_start, edge_end)
        for edge_start, edge_end in edges
    )


def geometry_intersects_avoid_areas(
    geometry: Iterable[Iterable[float]],
    avoid_areas: list[AvoidArea],
    allow_start_inside: bool = False,
    allow_end_inside: bool = False,
) -> bool:
    normalized: list[tuple[float, float]] = []
    for point in geometry:
        values = list(point)
        if len(values) < 2:
            continue
        normalized.append((float(values[0]), float(values[1])))
    if len(normalized) < 2:
        return False

    start_index = 0
    if allow_start_inside:
        while start_index < len(normalized) and any(
            _point_in_area(normalized[start_index], area) for area in avoid_areas
        ):
            start_index += 1

    end_index = len(normalized)
    if allow_end_inside:
        while end_index > start_index and any(
            _point_in_area(normalized[end_index - 1], area) for area in avoid_areas
        ):
            end_index -= 1

    normalized = normalized[start_index:end_index]
    if len(normalized) < 2:
        return False

    for index in range(1, len(normalized)):
        segment_start = normalized[index - 1]
        segment_end = normalized[index]
        if any(
            _segment_intersects_area(segment_start, segment_end, area)
            for area in avoid_areas
        ):
            return True

    return False


def _haversine_meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    lng1, lat1 = a
    lng2, lat2 = b
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    sin_lat = math.sin(d_lat / 2)
    sin_lng = math.sin(d_lng / 2)
    h = (
        sin_lat * sin_lat
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * sin_lng * sin_lng
    )
    return 2 * _EARTH_RADIUS_METERS * math.asin(min(1.0, math.sqrt(h)))


def avoid_area_exposure_meters(
    geometry: Iterable[Iterable[float]],
    avoid_areas: list[AvoidArea],
) -> float:
    """Approximate metres of `geometry` that fall inside any avoid area.

    Used to rank candidate routes so congestion recovery can pick the least
    congested option rather than requiring a route that avoids the area entirely
    (which is often impossible when the destination sits inside or beside it).
    """
    normalized: list[tuple[float, float]] = []
    for point in geometry:
        values = list(point)
        if len(values) < 2:
            continue
        normalized.append((float(values[0]), float(values[1])))
    if len(normalized) < 2:
        return 0.0

    total = 0.0
    for index in range(1, len(normalized)):
        segment_start = normalized[index - 1]
        segment_end = normalized[index]
        midpoint = (
            (segment_start[0] + segment_end[0]) / 2,
            (segment_start[1] + segment_end[1]) / 2,
        )
        if any(_point_in_area(midpoint, area) for area in avoid_areas):
            total += _haversine_meters(segment_start, segment_end)
    return total


def build_detour_candidates(
    start: tuple[float, float],
    end: tuple[float, float],
    avoid_area: AvoidArea,
) -> list[list[tuple[float, float]]]:
    min_lng = avoid_area.min_lng - DETOUR_MARGIN_DEGREES
    max_lng = avoid_area.max_lng + DETOUR_MARGIN_DEGREES
    min_lat = avoid_area.min_lat - DETOUR_MARGIN_DEGREES
    max_lat = avoid_area.max_lat + DETOUR_MARGIN_DEGREES
    center_lng = (avoid_area.min_lng + avoid_area.max_lng) / 2
    center_lat = (avoid_area.min_lat + avoid_area.max_lat) / 2

    # A single via-point just outside one side of the box lets OSRM bend cleanly
    # around that side. Routing through two opposite corners (the old approach)
    # forced a zig-zag that produced long looping detours.
    return [
        [start, (min_lng, center_lat), end],  # around the west side
        [start, (max_lng, center_lat), end],  # around the east side
        [start, (center_lng, max_lat), end],  # around the north side
        [start, (center_lng, min_lat), end],  # around the south side
    ]


async def request_raw_osrm_route(
    client: httpx.AsyncClient,
    base_url: str,
    coordinates: list[tuple[float, float]],
    exclude: str | None = None,
) -> tuple[list[list[float]], float, float, list[float]]:
    if len(coordinates) < 2:
        point = coordinates[0] if coordinates else (0.0, 0.0)
        return [[point[0], point[1]]], 0.0, 0.0, []

    coord_string = ";".join(f"{lng},{lat}" for lng, lat in coordinates)
    params: dict[str, str] = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
    }
    if exclude:
        params["exclude"] = exclude

    response = await client.get(
        f"{base_url.rstrip('/')}/route/v1/driving/{coord_string}",
        params=params,
    )
    response.raise_for_status()

    payload = response.json()
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(f"OSRM route request failed: {payload}")

    best_route = payload["routes"][0]
    geometry = best_route["geometry"]["coordinates"]
    duration_seconds = float(best_route["duration"])
    distance_meters = float(best_route["distance"])
    legs = [float(leg["duration"]) for leg in best_route.get("legs", [])]
    return geometry, distance_meters, duration_seconds, legs


async def request_osrm_route(
    client: httpx.AsyncClient,
    base_url: str,
    coordinates: list[tuple[float, float]],
    exclude: str | None = None,
    avoid_areas: list[AvoidArea] | None = None,
) -> tuple[list[list[float]], float, float, list[float]]:
    allow_start_inside = bool(
        avoid_areas
        and any(_point_in_area(coordinates[0], area) for area in avoid_areas)
    )
    allow_end_inside = bool(
        avoid_areas
        and any(_point_in_area(coordinates[-1], area) for area in avoid_areas)
    )
    geometry, distance_meters, duration_seconds, legs = await request_raw_osrm_route(
        client,
        base_url,
        coordinates,
        exclude=exclude,
    )
    if not avoid_areas or not geometry_intersects_avoid_areas(
        geometry,
        avoid_areas,
        allow_start_inside=allow_start_inside,
        allow_end_inside=allow_end_inside,
    ):
        return geometry, distance_meters, duration_seconds, legs

    if len(coordinates) != 2:
        raise RuntimeError(
            "Avoid-area routing currently requires pairwise segment routing."
        )

    start, end = coordinates

    RouteOption = tuple[list[list[float]], float, float, list[float]]

    # Score routes by *effective* travel time: real OSRM duration plus a penalty
    # for every metre spent inside a congestion zone (a stand-in for the slowdown
    # there). This makes a short detour around a small congestion patch win, while
    # an absurdly long looping detour never beats simply driving through — so we
    # reduce congestion without sending the vehicle on a giant loop.
    def effective_seconds(duration: float, route_geometry: list[list[float]]) -> float:
        exposure = avoid_area_exposure_meters(route_geometry, avoid_areas)
        return duration + exposure * CONGESTION_SECONDS_PER_METER

    scored_options: list[tuple[float, RouteOption]] = [
        (
            effective_seconds(duration_seconds, geometry),
            (geometry, distance_meters, duration_seconds, legs),
        )
    ]

    for area in avoid_areas:
        for candidate in build_detour_candidates(start, end, area):
            candidate_geometry, candidate_distance, candidate_duration, candidate_legs = (
                await request_raw_osrm_route(
                    client,
                    base_url,
                    candidate,
                    exclude=exclude,
                )
            )
            scored_options.append(
                (
                    effective_seconds(candidate_duration, candidate_geometry),
                    (
                        candidate_geometry,
                        candidate_distance,
                        candidate_duration,
                        candidate_legs,
                    ),
                )
            )

    scored_options.sort(key=lambda option: option[0])
    return scored_options[0][1]
