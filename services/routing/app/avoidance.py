from __future__ import annotations

from typing import Iterable

import httpx

from app.providers.base import AvoidArea

DETOUR_MARGIN_DEGREES = 0.0008


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


def build_detour_candidates(
    start: tuple[float, float],
    end: tuple[float, float],
    avoid_area: AvoidArea,
) -> list[list[tuple[float, float]]]:
    min_lng = avoid_area.min_lng - DETOUR_MARGIN_DEGREES
    max_lng = avoid_area.max_lng + DETOUR_MARGIN_DEGREES
    min_lat = avoid_area.min_lat - DETOUR_MARGIN_DEGREES
    max_lat = avoid_area.max_lat + DETOUR_MARGIN_DEGREES

    return [
        [start, (min_lng, max_lat), (max_lng, max_lat), end],
        [start, (min_lng, min_lat), (max_lng, min_lat), end],
        [start, (min_lng, min_lat), (min_lng, max_lat), end],
        [start, (max_lng, min_lat), (max_lng, max_lat), end],
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
    viable_candidates: list[tuple[list[list[float]], float, float, list[float]]] = []
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
            if geometry_intersects_avoid_areas(
                candidate_geometry,
                avoid_areas,
                allow_start_inside=allow_start_inside,
                allow_end_inside=allow_end_inside,
            ):
                continue
            viable_candidates.append(
                (
                    candidate_geometry,
                    candidate_distance,
                    candidate_duration,
                    candidate_legs,
                )
            )

    if not viable_candidates:
        raise RuntimeError(
            "OSRM could not find a route that avoids the congestion area."
        )

    viable_candidates.sort(key=lambda option: option[2])
    return viable_candidates[0]
