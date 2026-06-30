from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.providers.base import ProviderName, RoutingRequest, RoutingResponse
from app.providers.cuopt_provider import CuOptRoutingProvider
from app.providers.osrm_provider import OsrmRoutingProvider


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue

        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        os.environ[key] = value


def bootstrap_env() -> None:
    service_root = Path(__file__).resolve().parents[1]
    repo_root = service_root.parents[1]

    # Prefer service-local overrides first, then fall back to repo-level env files.
    for candidate in (
        service_root / ".env",
        repo_root / ".env",
        repo_root / "apps" / "web" / ".env.local",
    ):
        load_env_file(candidate)


bootstrap_env()


class HealthResponse(BaseModel):
    ok: bool
    default_provider: ProviderName


def get_default_provider_name() -> ProviderName:
    return os.environ.get("ROUTING_PROVIDER", "cuopt-osrm").strip().lower() or "cuopt-osrm"  # type: ignore[return-value]


@lru_cache(maxsize=1)
def get_osrm_provider() -> OsrmRoutingProvider:
    return OsrmRoutingProvider(
        base_url=os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org"),
        exclude=os.environ.get("OSRM_EXCLUDE") or None,
    )


@lru_cache(maxsize=1)
def get_cuopt_provider() -> CuOptRoutingProvider:
    return CuOptRoutingProvider(
        api_url=os.environ.get("CUOPT_API_URL", "https://optimize.api.nvidia.com/v1/nvidia/cuopt"),
        status_api_url=os.environ.get("CUOPT_STATUS_API_URL", "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status"),
        api_key=os.environ.get("CUOPT_API_KEY", ""),
        osrm_provider=get_osrm_provider(),
    )


def resolve_provider(name: ProviderName):
    if name == "osrm":
        return get_osrm_provider()
    if name in {"cuopt", "cuopt-osrm"}:
        return get_cuopt_provider()
    raise HTTPException(status_code=400, detail=f"Unsupported provider: {name}")


app = FastAPI(title="Hermes Routiq Routing Service", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(ok=True, default_provider=get_default_provider_name())


@app.post("/route", response_model=RoutingResponse)
@app.post("/optimize", response_model=RoutingResponse)
async def route(request: RoutingRequest) -> RoutingResponse:
    provider_name = request.provider or get_default_provider_name()
    provider = resolve_provider(provider_name)

    try:
        return await provider.optimize(request)
    except HTTPException:
        raise
    except Exception as error:  # pragma: no cover - surfaced to caller for debugging
        raise HTTPException(status_code=502, detail=str(error)) from error
