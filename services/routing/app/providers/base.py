from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

from pydantic import BaseModel, Field


ProviderName = Literal["osrm", "cuopt", "cuopt-osrm"]
StopKind = Literal["start", "order", "end"]


class LatLng(BaseModel):
    lat: float
    lng: float


class TimeWindow(BaseModel):
    start: int = 0
    end: int = 86_400


class AvoidArea(BaseModel):
    min_lat: float
    max_lat: float
    min_lng: float
    max_lng: float


class DriverInput(BaseModel):
    id: str
    name: str
    vehicle_id: str | None = None
    start_location: LatLng
    end_location: LatLng | None = None
    capacity: int = 10
    current_load: int = 0
    time_window: TimeWindow = Field(default_factory=TimeWindow)
    max_travel_time_seconds: int | None = None


class OrderInput(BaseModel):
    id: str
    location: LatLng
    demand: int = 1
    service_time_seconds: int = 120
    time_window: TimeWindow | None = None
    assigned_driver_id: str | None = None
    sequence: int | None = None


class OrderedStop(BaseModel):
    id: str
    kind: StopKind
    location: LatLng
    eta_seconds: float
    order_id: str | None = None


class DriverAssignment(BaseModel):
    order_id: str
    driver_id: str


class DeadlineViolation(BaseModel):
    order_id: str
    arrival_seconds: float
    latest_allowed_seconds: int


class DriverRoute(BaseModel):
    driver_id: str
    vehicle_id: str | None = None
    ordered_stops: list[OrderedStop]
    geometry: list[list[float]]
    distance_meters: float
    duration_seconds: float


class RoutingRequest(BaseModel):
    provider: ProviderName | None = None
    drivers: list[DriverInput]
    orders: list[OrderInput]
    avoid_areas: list[AvoidArea] = Field(default_factory=list)


class RoutingResponse(BaseModel):
    provider: ProviderName
    routes: list[DriverRoute]
    assignments: list[DriverAssignment]
    total_cost: float
    total_distance_meters: float
    total_duration_seconds: float
    unassigned_order_ids: list[str]
    deadline_violations: list[DeadlineViolation]
    raw_provider_response: dict | None = None


class RoutingProvider(ABC):
    provider_name: ProviderName

    @abstractmethod
    async def optimize(self, request: RoutingRequest) -> RoutingResponse:
        raise NotImplementedError
