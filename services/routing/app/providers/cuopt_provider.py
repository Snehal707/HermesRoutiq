from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.cost_matrix import build_osrm_cost_matrix
from app.providers.base import (
    DeadlineViolation,
    DriverAssignment,
    DriverInput,
    DriverRoute,
    OrderedStop,
    OrderInput,
    RoutingProvider,
    RoutingRequest,
    RoutingResponse,
)
from app.providers.osrm_provider import OsrmRoutingProvider


@dataclass(slots=True)
class IndexedLocation:
    key: str
    lng: float
    lat: float


class CuOptRoutingProvider(RoutingProvider):
    provider_name = "cuopt-osrm"

    def __init__(
        self,
        api_url: str,
        api_key: str,
        osrm_provider: OsrmRoutingProvider,
        status_api_url: str | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.status_api_url = (status_api_url or "").rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.osrm_provider = osrm_provider

    async def optimize(self, request: RoutingRequest) -> RoutingResponse:
        if not self.api_key:
            raise RuntimeError("CUOPT_API_KEY is missing.")

        indexed_locations, index_by_key = self._index_locations(request.drivers, request.orders)
        coordinates = [(location.lng, location.lat) for location in indexed_locations]

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            matrix = await build_osrm_cost_matrix(
                client,
                self.osrm_provider.base_url,
                coordinates,
                exclude=self.osrm_provider.exclude,
                avoid_areas=request.avoid_areas,
            )
            payload = self._build_cuopt_payload(
                request.drivers,
                request.orders,
                index_by_key,
                matrix.durations,
                matrix.distances,
            )
            raw_result = await self._submit_and_poll(client, payload)
            solver_response = self._extract_solver_response(raw_result)
            routes, assignments, deadline_violations = await self._build_routes_from_solution(
                client,
                request.drivers,
                request.orders,
                solver_response,
                avoid_areas=request.avoid_areas,
            )

        dropped_tasks = (
            solver_response.get("dropped_tasks", {}).get("task_id", [])
            if isinstance(solver_response.get("dropped_tasks"), dict)
            else []
        )
        unassigned = [str(task_id) for task_id in dropped_tasks]
        total_distance = sum(route.distance_meters for route in routes)
        total_duration = sum(route.duration_seconds for route in routes)
        total_cost = float(
            solver_response.get(
                "solution_cost",
                solver_response.get("objective_values", {}).get("cost", total_duration),
            )
        )

        return RoutingResponse(
            provider=self.provider_name,
            routes=routes,
            assignments=assignments,
            total_cost=total_cost,
            total_distance_meters=total_distance,
            total_duration_seconds=total_duration,
            unassigned_order_ids=unassigned,
            deadline_violations=deadline_violations,
            raw_provider_response=raw_result,
        )

    def _index_locations(
        self, drivers: list[DriverInput], orders: list[OrderInput]
    ) -> tuple[list[IndexedLocation], dict[str, int]]:
        locations: list[IndexedLocation] = []
        index_by_key: dict[str, int] = {}

        def add_location(key: str, lng: float, lat: float) -> None:
            coord_key = f"{lng:.6f},{lat:.6f}"
            if coord_key in index_by_key:
                index_by_key[key] = index_by_key[coord_key]
                return
            index = len(locations)
            locations.append(IndexedLocation(key=key, lng=lng, lat=lat))
            index_by_key[coord_key] = index
            index_by_key[key] = index

        for driver in drivers:
            add_location(
                f"driver-start:{driver.id}",
                driver.start_location.lng,
                driver.start_location.lat,
            )
            end_location = driver.end_location or driver.start_location
            add_location(
                f"driver-end:{driver.id}",
                end_location.lng,
                end_location.lat,
            )

        for order in orders:
            add_location(f"order:{order.id}", order.location.lng, order.location.lat)

        return locations, index_by_key

    def _build_cuopt_payload(
        self,
        drivers: list[DriverInput],
        orders: list[OrderInput],
        index_by_key: dict[str, int],
        duration_matrix: list[list[float]],
        distance_matrix: list[list[float]],
    ) -> dict[str, Any]:
        return {
            "cost_matrix_data": {"data": {"0": distance_matrix}},
            "travel_time_matrix_data": {"data": {"0": duration_matrix}},
            "fleet_data": {
                "vehicle_ids": [driver.id for driver in drivers],
                "vehicle_locations": [
                    [
                        index_by_key[f"driver-start:{driver.id}"],
                        index_by_key[f"driver-end:{driver.id}"],
                    ]
                    for driver in drivers
                ],
                "capacities": [
                    [max(driver.capacity - driver.current_load, 0) for driver in drivers]
                ],
                "vehicle_time_windows": [
                    [driver.time_window.start, driver.time_window.end] for driver in drivers
                ],
                "vehicle_max_times": [
                    driver.max_travel_time_seconds
                    if driver.max_travel_time_seconds is not None
                    else driver.time_window.end - driver.time_window.start
                    for driver in drivers
                ],
                "vehicle_types": [0 for _ in drivers],
                "drop_return_trips": [False for _ in drivers],
            },
            "task_data": {
                "task_ids": [order.id for order in orders],
                "task_locations": [index_by_key[f"order:{order.id}"] for order in orders],
                "demand": [[order.demand for order in orders]],
                "service_times": [order.service_time_seconds for order in orders],
                "task_time_windows": [
                    [
                        order.time_window.start if order.time_window else 0,
                        order.time_window.end if order.time_window else 86_400,
                    ]
                    for order in orders
                ],
            },
        }

    async def _submit_and_poll(
        self, client: httpx.AsyncClient, payload: dict[str, Any]
    ) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        response = await client.post(self.api_url, json=payload, headers=headers)
        if response.is_error:
            raise RuntimeError(
                f"cuOpt submit failed with status {response.status_code}: {response.text}"
            )
        result = response.json()

        if "response" in result:
            return result

        req_id = result.get("reqId")
        if req_id is None or not self.status_api_url:
            return result

        for _ in range(30):
            poll_response = await client.get(
                f"{self.status_api_url}/{req_id}",
                headers={"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"},
            )
            if poll_response.is_error:
                raise RuntimeError(
                    f"cuOpt status polling failed with status {poll_response.status_code}: "
                    f"{poll_response.text}"
                )
            polled = poll_response.json()
            if "response" in polled:
                return polled
            if polled.get("status") == "fulfilled" and polled.get("responseReference"):
                download = await client.get(polled["responseReference"])
                if download.is_error:
                    raise RuntimeError(
                        f"cuOpt response download failed with status {download.status_code}: "
                        f"{download.text}"
                    )
                return download.json()
            if polled.get("status") in {"failed", "error", "rejected"}:
                raise RuntimeError(f"cuOpt solve failed: {polled}")

        raise RuntimeError(f"Timed out waiting for cuOpt response for reqId={req_id}")

    def _extract_solver_response(self, result: dict[str, Any]) -> dict[str, Any]:
        response = result.get("response", {})
        solver_response = response.get("solver_response")
        alternative_solver_response = response.get("solver_infeasible_response")

        # cuOpt responses are inconsistent across submit/poll/download flows:
        # some return {"response": {"solver_response": {...}}}, while others
        # return the solver payload directly at the top level. We also see
        # responses where the usable route data is nested under
        # `solver_infeasible_response` even though `vehicle_data` is present.
        if not isinstance(solver_response, dict) and self._looks_like_solver_response(result):
            solver_response = result
        if (
            not isinstance(solver_response, dict)
            and isinstance(response, dict)
            and self._looks_like_solver_response(response)
        ):
            solver_response = response
        if (
            not isinstance(solver_response, dict)
            and isinstance(alternative_solver_response, dict)
            and self._looks_like_solver_response(alternative_solver_response)
        ):
            solver_response = alternative_solver_response

        if not isinstance(solver_response, dict):
            raise RuntimeError(
                "cuOpt did not return solver_response: "
                f"{alternative_solver_response or result}"
            )

        status = solver_response.get("status")
        if status not in (0, 1):
            raise RuntimeError(f"cuOpt returned unexpected status={status}: {solver_response}")

        return solver_response

    def _looks_like_solver_response(self, payload: dict[str, Any]) -> bool:
        return (
            isinstance(payload.get("status"), (int, float))
            and isinstance(payload.get("vehicle_data"), dict)
            and (
                "solution_cost" in payload
                or "objective_values" in payload
                or "dropped_tasks" in payload
            )
        )

    async def _build_routes_from_solution(
        self,
        client: httpx.AsyncClient,
        drivers: list[DriverInput],
        orders: list[OrderInput],
        solver_response: dict[str, Any],
        avoid_areas: list["AvoidArea"] | None = None,
    ) -> tuple[list[DriverRoute], list[DriverAssignment], list[DeadlineViolation]]:
        driver_map = {driver.id: driver for driver in drivers}
        order_map = {order.id: order for order in orders}
        vehicle_data = solver_response.get("vehicle_data", {})

        routes: list[DriverRoute] = []
        assignments: list[DriverAssignment] = []
        deadline_violations: list[DeadlineViolation] = []

        for vehicle_id, vehicle_solution in vehicle_data.items():
            driver = driver_map.get(str(vehicle_id))
            if driver is None or not isinstance(vehicle_solution, dict):
                continue

            task_ids = [str(task_id) for task_id in vehicle_solution.get("task_id", [])]
            arrival_stamps = [
                float(arrival) for arrival in vehicle_solution.get("arrival_stamp", [])
            ]

            assigned_orders = [
                order_map[task_id] for task_id in task_ids if task_id in order_map
            ]
            for order in assigned_orders:
                assignments.append(DriverAssignment(order_id=order.id, driver_id=driver.id))

            points = [(driver.start_location.lng, driver.start_location.lat)]
            points.extend((order.location.lng, order.location.lat) for order in assigned_orders)
            end_location = driver.end_location or driver.start_location
            points.append((end_location.lng, end_location.lat))
            geometry, distance_meters, duration_seconds, _ = (
                await self.osrm_provider.route_geometry_for_locations(
                    client,
                    points,
                    avoid_areas=avoid_areas,
                )
            )

            ordered_stops: list[OrderedStop] = [
                OrderedStop(
                    id=f"{driver.id}:start",
                    kind="start",
                    location=driver.start_location,
                    eta_seconds=arrival_stamps[0] if arrival_stamps else 0.0,
                )
            ]

            for stop_index, order in enumerate(assigned_orders, start=1):
                eta = arrival_stamps[stop_index] if stop_index < len(arrival_stamps) else 0.0
                ordered_stops.append(
                    OrderedStop(
                        id=f"{driver.id}:{order.id}",
                        kind="order",
                        location=order.location,
                        eta_seconds=eta,
                        order_id=order.id,
                    )
                )
                if order.time_window is not None and eta > order.time_window.end:
                    deadline_violations.append(
                        DeadlineViolation(
                            order_id=order.id,
                            arrival_seconds=eta,
                            latest_allowed_seconds=order.time_window.end,
                        )
                    )

            ordered_stops.append(
                OrderedStop(
                    id=f"{driver.id}:end",
                    kind="end",
                    location=end_location,
                    eta_seconds=arrival_stamps[-1] if arrival_stamps else duration_seconds,
                )
            )

            routes.append(
                DriverRoute(
                    driver_id=driver.id,
                    vehicle_id=driver.vehicle_id,
                    ordered_stops=ordered_stops,
                    geometry=geometry,
                    distance_meters=distance_meters,
                    duration_seconds=duration_seconds,
                )
            )

        return routes, assignments, deadline_violations
