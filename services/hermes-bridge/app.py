from __future__ import annotations

import base64
import functools
import json
import os
import re
import subprocess
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse


def repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def helper_script_path() -> str:
    return os.path.join(repo_root(), "ops", "nemoclaw", "hermes-chat-completions.sh")


def helper_script_wsl_path() -> str:
    normalized = helper_script_path().replace("\\", "/")
    if len(normalized) >= 3 and normalized[1:3] == ":/":
        drive = normalized[0].lower()
        rest = normalized[3:]
        return f"/mnt/{drive}/{rest}"
    return normalized


def run_command(
    command: list[str],
    *,
    timeout: int,
    cwd: str | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd or repo_root(),
        check=False,
    )


DEFAULT_DISTRO = os.environ.get("HERMES_WSL_DISTRO", "Ubuntu-24.04")
DEFAULT_SANDBOX = os.environ.get("HERMES_SANDBOX_NAME", "hermes-runway")
DEFAULT_PROFILE = os.environ.get("HERMES_PROFILE_NAME", "routiq")

app = FastAPI(title="Hermes Local Bridge")


@functools.lru_cache(maxsize=1)
def read_profile_model_config() -> dict[str, str]:
    profile_path = f"/home/snehal007/.hermes/profiles/{DEFAULT_PROFILE}/config.yaml"
    try:
        result = subprocess.run(
            [
                "wsl.exe",
                "-d",
                DEFAULT_DISTRO,
                "-e",
                "bash",
                "-lc",
                f"if [ -f '{profile_path}' ]; then sed -n '1,40p' '{profile_path}'; fi",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=repo_root(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {}

    if result.returncode != 0:
        return {}

    text = result.stdout
    model_match = re.search(r"(?m)^\s*default:\s*(\S+)\s*$", text)
    provider_match = re.search(r"(?m)^\s*provider:\s*(\S+)\s*$", text)
    config: dict[str, str] = {}
    if model_match:
        config["model"] = model_match.group(1).strip()
    if provider_match:
        config["provider"] = provider_match.group(1).strip()
    return config


def run_hermes_chat(payload: dict[str, Any]) -> dict[str, Any]:
    compact_payload = json.dumps(payload, separators=(",", ":"))

    host_result = run_hermes_chat_via_host_docker(compact_payload)
    if host_result is not None:
      stdout, stderr = host_result
      response = decode_bridge_response(stdout, stderr)
      if isinstance(response, dict):
          profile_config = read_profile_model_config()
          if profile_config.get("model") and not response.get("model"):
              response["model"] = profile_config["model"]
          if profile_config.get("provider"):
              response["provider"] = profile_config["provider"]
      return response

    try:
        result = run_command(
            [
                "wsl.exe",
                "-d",
                DEFAULT_DISTRO,
                "-e",
                "bash",
                helper_script_wsl_path(),
                DEFAULT_SANDBOX,
                base64.b64encode(compact_payload.encode("utf-8")).decode("ascii"),
            ],
            timeout=150,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Hermes bridge timed out") from exc

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()

    if result.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Hermes bridge subprocess failed",
                "returncode": result.returncode,
                "stderr": stderr,
                "stdout": stdout,
            },
        )

    if not stdout:
        raise HTTPException(status_code=502, detail="Hermes bridge returned an empty response")

    response = decode_bridge_response(stdout, stderr)

    if isinstance(response, dict):
        profile_config = read_profile_model_config()
        if profile_config.get("model") and not response.get("model"):
            response["model"] = profile_config["model"]
        if profile_config.get("provider"):
            response["provider"] = profile_config["provider"]

    return response


def run_hermes_chat_via_host_docker(payload_json: str) -> tuple[str, str] | None:
    try:
        container_lookup = run_command(
            [
                "docker",
                "ps",
                "--filter",
                f"label=openshell.ai/sandbox-name={DEFAULT_SANDBOX}",
                "--format",
                "{{.Names}}",
            ],
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    container_name = container_lookup.stdout.strip().splitlines()[0] if container_lookup.stdout.strip() else ""
    if container_lookup.returncode != 0 or not container_name:
        return None

    try:
        gateway_pid_result = run_command(
            [
                "docker",
                "exec",
                "-u",
                "sandbox",
                "-e",
                "HOME=/sandbox",
                "-e",
                "HERMES_HOME=/sandbox/.hermes",
                container_name,
                "sh",
                "-lc",
                r"ps -ef | awk '/[h]ermes gateway run/ { print $2; exit }'",
            ],
            timeout=20,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Hermes bridge timed out") from exc

    gateway_pid = gateway_pid_result.stdout.strip()
    if gateway_pid_result.returncode != 0 or not gateway_pid:
        return None

    try:
        bridge_result = run_command(
            [
                "docker",
                "exec",
                "-i",
                container_name,
                "nsenter",
                "-t",
                gateway_pid,
                "-n",
                "curl",
                "-sS",
                "--max-time",
                "135",
                "http://127.0.0.1:18642/v1/chat/completions",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                "@-",
            ],
            timeout=150,
            input_text=payload_json,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Hermes bridge timed out") from exc

    stdout = bridge_result.stdout.strip()
    stderr = bridge_result.stderr.strip()
    if bridge_result.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Hermes bridge subprocess failed",
                "returncode": bridge_result.returncode,
                "stderr": stderr,
                "stdout": stdout,
            },
        )

    return stdout, stderr


def decode_bridge_response(stdout: str, stderr: str) -> dict[str, Any]:
    if not stdout:
        raise HTTPException(status_code=502, detail="Hermes bridge returned an empty response")

    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Hermes bridge returned non-JSON output",
                "stdout": stdout,
                "stderr": stderr,
            },
        ) from exc

    return response


@app.get("/health")
def health() -> dict[str, str]:
    profile_config = read_profile_model_config()
    return {
        "status": "ok",
        "profile": DEFAULT_PROFILE,
        "provider": profile_config.get("provider", "unknown"),
        "model": profile_config.get("model", "unknown"),
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    profile_config = read_profile_model_config()
    model_id = profile_config.get("model", "hermes-agent")
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": 0,
                "owned_by": "hermes",
                "permission": [],
                "root": model_id,
                "parent": None,
            }
        ],
    }


@app.post("/v1/chat/completions")
def chat_completions(payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(run_hermes_chat(payload))
