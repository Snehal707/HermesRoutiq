from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Point:
    lat: float
    lng: float


MAP_CENTER = Point(lat=37.785, lng=-122.4)

WAYPOINTS: tuple[Point, ...] = (
    Point(37.7905, -122.3968),
    Point(37.7895, -122.3990),
    Point(37.7888, -122.4020),
    Point(37.7875, -122.4045),
    Point(37.7860, -122.4030),
    Point(37.7850, -122.4000),
    Point(37.7845, -122.4010),
    Point(37.7830, -122.3985),
    Point(37.7825, -122.3960),
    Point(37.7815, -122.3995),
    Point(37.7805, -122.4025),
    Point(37.7840, -122.4040),
)

TRAFFIC_ZONES = (
    {
        "id": "market-congestion",
        "center": Point(37.7842, -122.4006),
        "radius_meters": 180.0,
        "severity": "high",
        "slowdown_multiplier": 0.42,
    },
    {
        "id": "battery-corridor",
        "center": Point(37.7882, -122.3993),
        "radius_meters": 125.0,
        "severity": "medium",
        "slowdown_multiplier": 0.65,
    },
)

SIGNAL_LIGHTS = (
    {"id": "signal-market-1", "location": Point(37.7848, -122.4002)},
    {"id": "signal-battery-1", "location": Point(37.7886, -122.3998)},
    {"id": "signal-folsom-1", "location": Point(37.7829, -122.3981)},
)
