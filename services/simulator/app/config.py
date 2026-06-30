from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


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

    for candidate in (
        service_root / ".env",
        repo_root / ".env",
        repo_root / "apps" / "web" / ".env.local",
    ):
        load_env_file(candidate)


@lru_cache(maxsize=1)
def get_osrm_base_url() -> str:
    return os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org").strip()


@lru_cache(maxsize=1)
def get_osrm_exclude() -> str | None:
    value = os.environ.get("OSRM_EXCLUDE", "").strip()
    return value or None
