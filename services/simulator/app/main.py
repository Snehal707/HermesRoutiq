from __future__ import annotations

import os

from fastapi import FastAPI

from .config import bootstrap_env
from .engine import AmbientTrafficSimulator

bootstrap_env()

app = FastAPI(title="Hermes Ambient Simulator", version="0.1.0")
simulator = AmbientTrafficSimulator(
    scenario_id=os.environ.get("SIMULATOR_SCENARIO_ID"),
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/snapshot")
def snapshot():
    return simulator.snapshot()
