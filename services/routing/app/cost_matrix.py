from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.avoidance import request_osrm_route
from app.providers.base import AvoidArea


@dataclass(slots=True)
class CostMatrixResult:
    durations: list[list[float]]
    distances: list[list[float]]


async def build_osrm_cost_matrix(
    client: httpx.AsyncClient,
    base_url: str,
    coordinates: list[tuple[float, float]],
    exclude: str | None = None,
    avoid_areas: list[AvoidArea] | None = None,
) -> CostMatrixResult:
    if not coordinates:
        return CostMatrixResult(durations=[], distances=[])

    if avoid_areas:
        durations = [[0.0 for _ in coordinates] for _ in coordinates]
        distances = [[0.0 for _ in coordinates] for _ in coordinates]

        for origin_index, origin in enumerate(coordinates):
            for destination_index, destination in enumerate(coordinates):
                if origin_index == destination_index:
                    continue
                _, distance_meters, duration_seconds, _ = await request_osrm_route(
                    client,
                    base_url,
                    [origin, destination],
                    exclude=exclude,
                    avoid_areas=avoid_areas,
                )
                durations[origin_index][destination_index] = duration_seconds
                distances[origin_index][destination_index] = distance_meters

        return CostMatrixResult(durations=durations, distances=distances)

    coord_string = ";".join(f"{lng},{lat}" for lng, lat in coordinates)
    params: dict[str, str] = {"annotations": "duration,distance"}
    if exclude:
        # Keep the cost matrix consistent with the rendered geometry so the
        # solver does not order stops assuming a freeway shortcut we exclude.
        params["exclude"] = exclude
    response = await client.get(
        f"{base_url.rstrip('/')}/table/v1/driving/{coord_string}",
        params=params,
    )
    response.raise_for_status()

    payload = response.json()
    if payload.get("code") != "Ok":
        raise RuntimeError(f"OSRM table request failed: {payload}")

    durations = payload.get("durations")
    distances = payload.get("distances")
    if durations is None or distances is None:
        raise RuntimeError(f"OSRM matrix response missing durations/distances: {payload}")

    return CostMatrixResult(durations=durations, distances=distances)
