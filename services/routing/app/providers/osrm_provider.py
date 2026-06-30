from __future__ import annotations

from collections import defaultdict

import httpx

from app.avoidance import request_osrm_route
from app.providers.base import (
    AvoidArea,
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


def haversine_meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt

    lng1, lat1 = a
    lng2, lat2 = b
    d_lat = radians(lat2 - lat1)
    d_lng = radians(lng2 - lng1)
    lat1_rad = radians(lat1)
    lat2_rad = radians(lat2)
    h = sin(d_lat / 2) ** 2 + cos(lat1_rad) * cos(lat2_rad) * sin(d_lng / 2) ** 2
    return 2 * 6_371_000 * asin(min(1.0, sqrt(h)))


class OsrmRoutingProvider(RoutingProvider):
    provider_name = "osrm"
    # Consecutive geometry points farther apart than this are treated as a routing
    # artefact (e.g. a freeway detour with sparse shape points) rather than real
    # road geometry. SF downtown blocks yield legitimate straight segments up to
    # ~250m, so the threshold sits comfortably above that while still rejecting the
    # multi-kilometre gaps produced by bridge/freeway detours.
    IMPOSSIBLE_JUMP_METERS = 300.0

    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 30.0,
        exclude: str | None = None,
    ) -> None:
        # The public demo server is convenient for development, but OSRM does not
        # guarantee uptime or rate limits there. Swap this base URL to a self-hosted
        # OSRM deployment for production reliability.
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        # OSRM `exclude` class (e.g. "motorway") to keep local deliveries off the
        # freeway. Only supported on OSRM servers compiled with excludable classes
        # (the public demo server returns HTTP 400), so it is opt-in via env.
        self.exclude = exclude or None

    @staticmethod
    def _dedupe_consecutive_points(
        points: list[list[float]],
    ) -> list[list[float]]:
        deduped: list[list[float]] = []
        for point in points:
            if not deduped or deduped[-1] != point:
                deduped.append(point)
        return deduped

    @staticmethod
    def _has_impossible_geometry_jump(geometry: list[list[float]]) -> bool:
        for index in range(1, len(geometry)):
            previous = geometry[index - 1]
            current = geometry[index]
            if haversine_meters(
                (previous[0], previous[1]),
                (current[0], current[1]),
            ) > OsrmRoutingProvider.IMPOSSIBLE_JUMP_METERS:
                return True
        return False

    @staticmethod
    def _count_unique_coordinates(
        coordinates: list[tuple[float, float]],
    ) -> int:
        return len({(lng, lat) for lng, lat in coordinates})

    @classmethod
    def _needs_segment_rebuild(
        cls,
        coordinates: list[tuple[float, float]],
        geometry: list[list[float]],
    ) -> bool:
        if len(coordinates) <= 2:
            return False

        if cls._has_impossible_geometry_jump(geometry):
            return True

        unique_coordinate_count = cls._count_unique_coordinates(coordinates)
        if unique_coordinate_count <= 1:
            return False

        # Multi-stop routes should normally contain more than just one point per stop.
        return len(geometry) <= unique_coordinate_count + 1

    async def _request_route(
        self,
        client: httpx.AsyncClient,
        coordinates: list[tuple[float, float]],
        avoid_areas: list[AvoidArea] | None = None,
    ) -> tuple[list[list[float]], float, float, list[float]]:
        return await request_osrm_route(
            client,
            self.base_url,
            coordinates,
            exclude=self.exclude,
            avoid_areas=avoid_areas,
        )

    async def _route_geometry_by_segments(
        self,
        client: httpx.AsyncClient,
        coordinates: list[tuple[float, float]],
        avoid_areas: list[AvoidArea] | None = None,
    ) -> tuple[list[list[float]], float, float, list[float]]:
        combined_geometry: list[list[float]] = []
        total_distance = 0.0
        total_duration = 0.0
        legs: list[float] = []

        for index in range(1, len(coordinates)):
            segment_geometry, segment_distance, segment_duration, _ = (
                await self._request_route(
                    client,
                    [coordinates[index - 1], coordinates[index]],
                    avoid_areas=avoid_areas,
                )
            )
            combined_geometry.extend(segment_geometry)
            total_distance += segment_distance
            total_duration += segment_duration
            legs.append(segment_duration)

        return (
            self._dedupe_consecutive_points(combined_geometry),
            total_distance,
            total_duration,
            legs,
        )

    async def optimize(self, request: RoutingRequest) -> RoutingResponse:
        assignments: list[DriverAssignment] = []
        deadline_violations: list[DeadlineViolation] = []
        unassigned_order_ids: list[str] = []
        routes: list[DriverRoute] = []

        orders_by_driver: dict[str, list[OrderInput]] = defaultdict(list)
        for order in request.orders:
            if order.assigned_driver_id is None:
                unassigned_order_ids.append(order.id)
                continue
            orders_by_driver[order.assigned_driver_id].append(order)
            assignments.append(
                DriverAssignment(order_id=order.id, driver_id=order.assigned_driver_id)
            )

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for driver in request.drivers:
                ordered_orders = sorted(
                    orders_by_driver.get(driver.id, []),
                    key=lambda order: (
                        order.sequence if order.sequence is not None else 1_000_000,
                        order.id,
                    ),
                )
                route = await self._build_route_for_driver(
                    client,
                    driver,
                    ordered_orders,
                    avoid_areas=request.avoid_areas,
                )
                routes.append(route)

                for stop in route.ordered_stops:
                    if stop.order_id is None:
                        continue
                    matching_order = next(
                        (order for order in ordered_orders if order.id == stop.order_id),
                        None,
                    )
                    if (
                        matching_order is not None
                        and matching_order.time_window is not None
                        and stop.eta_seconds > matching_order.time_window.end
                    ):
                        deadline_violations.append(
                            DeadlineViolation(
                                order_id=matching_order.id,
                                arrival_seconds=stop.eta_seconds,
                                latest_allowed_seconds=matching_order.time_window.end,
                            )
                        )

        total_distance = sum(route.distance_meters for route in routes)
        total_duration = sum(route.duration_seconds for route in routes)

        return RoutingResponse(
            provider=self.provider_name,
            routes=routes,
            assignments=assignments,
            total_cost=total_duration,
            total_distance_meters=total_distance,
            total_duration_seconds=total_duration,
            unassigned_order_ids=unassigned_order_ids,
            deadline_violations=deadline_violations,
        )

    async def route_geometry_for_locations(
        self,
        client: httpx.AsyncClient,
        coordinates: list[tuple[float, float]],
        avoid_areas: list[AvoidArea] | None = None,
    ) -> tuple[list[list[float]], float, float, list[float]]:
        if avoid_areas:
            return await self._route_geometry_by_segments(
                client,
                coordinates,
                avoid_areas=avoid_areas,
            )

        geometry, distance_meters, duration_seconds, legs = await self._request_route(
            client,
            coordinates,
            avoid_areas=None,
        )
        geometry = self._dedupe_consecutive_points(geometry)

        if self._count_unique_coordinates(coordinates) <= 1:
            point = coordinates[0]
            return [[point[0], point[1]]], 0.0, 0.0, [0.0 for _ in range(len(coordinates) - 1)]

        if self._needs_segment_rebuild(coordinates, geometry):
            return await self._route_geometry_by_segments(
                client,
                coordinates,
                avoid_areas=None,
            )

        return geometry, distance_meters, duration_seconds, legs

    async def _build_route_for_driver(
        self,
        client: httpx.AsyncClient,
        driver: DriverInput,
        ordered_orders: list[OrderInput],
        avoid_areas: list[AvoidArea] | None = None,
    ) -> DriverRoute:
        start = (driver.start_location.lng, driver.start_location.lat)
        end_location = driver.end_location or driver.start_location
        end = (end_location.lng, end_location.lat)

        coordinates = [start]
        coordinates.extend((order.location.lng, order.location.lat) for order in ordered_orders)
        coordinates.append(end)

        geometry, distance_meters, duration_seconds, legs = await self.route_geometry_for_locations(
            client,
            coordinates,
            avoid_areas=avoid_areas,
        )

        ordered_stops: list[OrderedStop] = [
            OrderedStop(
                id=f"{driver.id}:start",
                kind="start",
                location=driver.start_location,
                eta_seconds=0.0,
            )
        ]

        elapsed = 0.0
        for index, order in enumerate(ordered_orders, start=1):
            elapsed += legs[index - 1] if index - 1 < len(legs) else 0.0
            ordered_stops.append(
                OrderedStop(
                    id=f"{driver.id}:{order.id}",
                    kind="order",
                    location=order.location,
                    eta_seconds=elapsed,
                    order_id=order.id,
                )
            )
            elapsed += float(order.service_time_seconds)

        elapsed += legs[-1] if legs else 0.0
        ordered_stops.append(
            OrderedStop(
                id=f"{driver.id}:end",
                kind="end",
                location=end_location,
                eta_seconds=elapsed,
            )
        )

        return DriverRoute(
            driver_id=driver.id,
            vehicle_id=driver.vehicle_id,
            ordered_stops=ordered_stops,
            geometry=geometry,
            distance_meters=distance_meters,
            duration_seconds=duration_seconds,
        )
