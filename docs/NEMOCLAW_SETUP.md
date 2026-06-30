# NemoClaw Setup

This document records the exact NemoClaw setup attempt performed for Phase 8 in the current environment.

## Environment used

- Host shell: Windows PowerShell
- Repo path: `C:\Users\ASUS\HermesRoutiq`
- WSL distro used successfully: `Ubuntu`
- Broken WSL distro observed separately: `Ubuntu-22.04`
- Hermes profile present in WSL: `/home/snehal007/.hermes/profiles/routiq`

## Initial findings

The usable WSL distro was `Ubuntu`, not `Ubuntu-22.04`.

The following commands confirmed the baseline state:

```powershell
wsl.exe -l -v
wsl.exe -d Ubuntu -e bash -lc "uname -a && whoami && pwd"
wsl.exe -d Ubuntu -e bash -lc "command -v hermes || true"
wsl.exe -d Ubuntu -e bash -lc "node -v 2>/dev/null || true; npm -v 2>/dev/null || true"
```

Observed:

- `hermes` existed at `/home/snehal007/.local/bin/hermes`
- Node in WSL was initially `v20.20.1`
- `nemoclaw` and `nemohermes` were not installed yet

## Docker baseline

Before installation:

```powershell
docker version
wsl.exe -d Ubuntu -e bash -lc "docker --version 2>/dev/null || true"
```

Observed:

- Docker Desktop was installed on Windows but not running at first
- The WSL distro did not have working Docker Desktop integration

## NVIDIA installer command that worked

The official installer bootstrap was:

```powershell
wsl.exe -d Ubuntu -e bash -lc "set -o pipefail; export NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1; curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --non-interactive --yes-i-accept-third-party-software"
```

What this accomplished:

- Upgraded Node in WSL from `v20.20.1` to `v22.23.0` using `nvm`
- Installed NemoClaw CLI
- Installed OpenShell CLI
- Created the user-local `nemoclaw` shim at:
  - `/home/snehal007/.local/bin/nemoclaw`

Post-install verification:

```powershell
wsl.exe -d Ubuntu -e bash -lc "source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && nemoclaw"
```

Observed:

- `nemoclaw v0.0.55`
- CLI help rendered successfully

## Docker Desktop startup that worked on Windows

Docker Desktop was started from Windows with:

```powershell
Start-Process -FilePath "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Hidden
docker version
```

Observed after startup:

- Windows-side Docker client/server became healthy
- WSL still did not have proper direct Docker integration for the `Ubuntu` distro

## WSL bridge attempts

The following direct WSL integration symptom was observed:

```powershell
wsl.exe -d Ubuntu -e bash -lc "docker --version 2>/dev/null || true"
```

Output indicated:

- `docker` was not available in the WSL distro
- Docker Desktop integration for this distro was still not enabled

Because the Docker engine itself was reachable from Windows, an interim wrapper was created in WSL so `docker` commands could at least reach the Windows Docker client:

```bash
#!/usr/bin/env bash
cmd.exe /C docker "$@"
```

Written to:

- `/home/snehal007/.local/bin/docker`

This wrapper was sufficient for:

```powershell
wsl.exe -d Ubuntu -e bash -lc "export PATH=\"/home/snehal007/.local/bin:$PATH\"; docker info --format '{{json .ServerVersion}}'"
```

Observed:

- Docker preflight commands could succeed through the wrapper

## Interactive onboard attempt

The real onboarding attempt was run with:

```powershell
wsl.exe -d Ubuntu -e bash -lc "export PATH=\"/home/snehal007/.local/bin:$PATH\"; source ~/.nvm/nvm.sh; nvm use 22 >/dev/null; nemoclaw onboard"
```

The onboarding flow reached:

- license acceptance
- preflight checks
- Docker readiness
- bridge container test
- DNS test
- GPU detection
- OpenShell gateway startup

## Actual blocker encountered

The onboarding run failed during OpenShell gateway startup with this real runtime error:

```text
Docker-driver gateway failed to start.
Gateway process exited with code 126 before becoming ready.
Gateway log tail:
  Unable to find image 'ubuntu:24.04' locally
  24.04: Pulling from library/ubuntu
  ...
  docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "/opt/nemoclaw/openshell-gateway": is a directory: permission denied
  Run 'docker run --help' for more information
```

## Interpretation

This environment currently has a real NemoClaw onboarding blocker:

1. The official installer and CLI setup do work.
2. Docker Desktop itself can run on Windows.
3. The `Ubuntu` WSL distro still lacks proper Docker Desktop WSL integration.
4. A temporary `docker` wrapper can satisfy some preflight checks, but it is not enough for successful gateway container startup.
5. The gateway failure strongly suggests the current WSL-to-Docker bridge is not equivalent to proper supported WSL integration for NemoClaw.

## What actually fixed the WSL runtime

The original blocker was not just "Docker unavailable". Two separate issues had to be resolved:

1. Docker Desktop WSL integration had to be active for the `Ubuntu` distro.
2. The temporary `~/.local/bin/docker` wrapper had to be removed once native Docker integration became available, otherwise NemoClaw kept invoking the wrong client path.

The commands that confirmed the fixed state were:

```powershell
wsl.exe -d Ubuntu -e bash -lc "type -a docker && docker version"
wsl.exe -d Ubuntu -e bash -lc "docker run --rm -v /home/snehal007/.local/bin/openshell-gateway:/opt/nemoclaw/openshell-gateway:ro ubuntu:24.04 ls -ld /opt/nemoclaw/openshell-gateway"
```

Observed:

- `docker` resolved to `/usr/bin/docker` backed by Docker Desktop's Linux-side CLI.
- The bind mount test showed `/opt/nemoclaw/openshell-gateway` as a file, not a directory.

## Local WSL compatibility patch that was required

Even after native Docker integration was fixed, the OpenShell Docker-driver gateway still failed on this machine under WSL because NemoClaw's compatibility-container launch path assumed `--network host` made `127.0.0.1:8080` reachable from the WSL host. In this environment it did not.

To proceed with a real runtime test, a local patch was applied to the installed NemoClaw source so the compatibility gateway publishes `127.0.0.1:<port>` under WSL instead of relying on host networking.

Patched files:

- `\\wsl$\\Ubuntu\\home\\snehal007\\.nemoclaw\\source\\src\\lib\\onboard\\docker-driver-gateway-launch.ts`
- `\\wsl$\\Ubuntu\\home\\snehal007\\.nemoclaw\\source\\dist\\lib\\onboard\\docker-driver-gateway-launch.js`

Behavior change:

- Under WSL, the gateway compatibility container now launches with:
  - `--publish 127.0.0.1:8080:8080`
- Instead of:
  - `--network host`

This was enough for onboarding to pass the real OpenShell gateway health checks.

## First successful onboard path

With native Docker working and the local gateway patch in place, this command successfully completed NemoClaw onboarding:

```powershell
wsl.exe -d Ubuntu -e bash -lc "set -a; source /home/snehal007/.hermes/profiles/routiq/.env; set +a; export COMPATIBLE_API_KEY=\"$OPENROUTER_API_KEY\"; export NEMOCLAW_ENDPOINT_URL=\"https://openrouter.ai/api/v1\"; export NEMOCLAW_MODEL=\"nvidia/nemotron-3-ultra-550b-a55b\"; source /home/snehal007/.nvm/nvm.sh; nvm use 22 >/dev/null; nemoclaw onboard --name routiq"
```

Observed:

- OpenShell gateway reached healthy state.
- Inference provider setup succeeded against OpenRouter's OpenAI-compatible endpoint.
- Sandbox image built successfully.
- A real sandbox named `routiq` was created and reached Ready state.

## Important correction: `nemoclaw onboard` defaulted to OpenClaw, not Hermes

The first successful sandbox creation proved the runtime worked, but it created an `OpenClaw` sandbox rather than a `Hermes Agent` sandbox. That was the wrong agent flavor for this project phase.

The corrective command path is:

```powershell
wsl.exe -d Ubuntu -e bash -lc "set -a; source /home/snehal007/.hermes/profiles/routiq/.env; set +a; export COMPATIBLE_API_KEY=\"$OPENROUTER_API_KEY\"; export NEMOCLAW_ENDPOINT_URL=\"https://openrouter.ai/api/v1\"; export NEMOCLAW_MODEL=\"nvidia/nemotron-3-ultra-550b-a55b\"; source /home/snehal007/.nvm/nvm.sh; nvm use 22 >/dev/null; nemohermes onboard --fresh --recreate-sandbox --name routiq --agent hermes"
```

Observed so far:

- The recreate flow correctly detected the old sandbox as OpenClaw.
- It backed up the prior state.
- It deleted the old `routiq` sandbox.
- It started pulling `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:v0.0.55`.

## Phase 8 status right now

Partially unblocked, not passed yet.

What is now proven:

- NemoClaw/NemoHermes can be installed and run in this WSL environment.
- The OpenShell gateway can be made healthy here.
- A real sandbox can be created here.

What is still in progress:

- Recreating `routiq` specifically as a Hermes sandbox instead of the default OpenClaw sandbox.
- After that, implementing and testing the real role/tool policy mapping, allow/deny logging, and blocked/allowed behavior checks for Phase 8.

## MCP HTTP support durability

The temporary `/sandbox/pydeps` overlay used during the first HTTP MCP proof is only partly durable.

What was verified live:

- A plain Docker container restart preserves `/sandbox/pydeps`.
- The marker file at `/sandbox/pydeps/.durability-marker` survived `docker restart` on `openshell-routiq-9f207caf-ca9c-48f7-ab33-8199d6d93869`.
- The upgraded package files were still present after restart, including:
  - `/sandbox/pydeps/mcp/client/streamable_http.py`

What that means:

- The overlay survives an ordinary container restart because it lives in the container's writable layer.
- It is not backed by a dedicated Docker volume or bind mount.
- It should be treated as ephemeral across any sandbox recreation path such as `rebuild`, `destroy`, or a fresh onboard, because those create a new container and discard the old writable layer.

The Windows-side `docker inspect` evidence was:

- Only the OpenShell launcher binary was mounted from outside the container.
- No mount existed for `/sandbox`, `/sandbox/pydeps`, or the Hermes Python site-packages directory.

So the safe conclusion is:

- `restart`: survives
- `recover`: irrelevant to this package state, because it only restarts gateway / dashboard helpers
- `rebuild` or any container recreation: does not survive by default

## Repeatable fix currently in repo

Until the upstream Hermes sandbox image bakes in a new enough `mcp` package, the repeatable fix is a post-onboard reprovision step that installs `mcp==1.28.0` into Hermes's own venv inside the running sandbox.

Script added:

- [ops/nemoclaw/provision-hermes-mcp-http-support.ps1](/C:/Users/ASUS/HermesRoutiq/ops/nemoclaw/provision-hermes-mcp-http-support.ps1)

What it does:

1. Finds the running `openshell-<sandbox>-...` container.
2. Ensures `pip` exists in `/opt/hermes/.venv`.
3. Installs `mcp==1.28.0` into `/opt/hermes/.venv`.
4. Verifies that `mcp.client.streamable_http` is importable from the Hermes runtime path.

Run it after every fresh onboard or rebuild:

```powershell
powershell -ExecutionPolicy Bypass -File .\ops\nemoclaw\provision-hermes-mcp-http-support.ps1 -SandboxName routiq
```

Why this is better than `/sandbox/pydeps`:

- Hermes sees the package on its normal import path without a manual `PYTHONPATH` export.
- It remains valid across plain container restarts.
- It is still not image-durable across a full sandbox recreation, so the script must be re-run after `rebuild` or a fresh onboard.

## Preferred long-term fix

The real durable fix is image-level: update the Hermes sandbox image build so `/opt/hermes/.venv` already contains `mcp>=1.28.0`, then recreate the sandbox from that image.

The relevant image recipe is the Hermes sandbox Dockerfile used by NemoClaw. In the current installed image, that Dockerfile already creates and owns `/opt/hermes/.venv`, so this package belongs there rather than in `/sandbox/pydeps`.

Until that source image is patched and rebuilt, the repo's reprovision script is the required step after every sandbox recreation.

## Important limit: current NemoClaw Hermes build does not expose per-MCP-tool role gating

The current Hermes sandbox does carry the environment variable:

- `NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=W10=`

`W10=` decodes to `[]`, so the live sandbox starts with no configured gateway presets.

However, in the current shipped Hermes/NemoClaw runtime, this setting is **not** the missing switch for MCP-tool role allowlists.

What was verified:

- The live Hermes gateway process (`/opt/hermes/.venv/bin/python /usr/local/bin/hermes gateway run`) receives `NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64`.
- The NemoClaw Hermes entrypoint script is [usr/local/bin/nemoclaw-start] inside the sandbox and does not translate that env var into MCP tool allow/deny rules.
- The built-in Hermes NemoClaw plugin at `/sandbox/.hermes/plugins/nemoclaw/__init__.py` only patches managed external tool gateways (Nous-hosted `web`, `image`, `audio`, `browser`, `modal`/code-style services). It does not implement MCP tool-name filtering.
- The Hermes managed-tool helper at `/opt/hermes/tools/managed_tool_gateway.py` is also about vendor gateway URL + token resolution, not per-tool authorization.
- The OpenShell policy schema used by NemoClaw explicitly documents that `tool_policy` is not supported in the sandbox policy YAML; only filesystem, landlock, process, and network policies are accepted.

Practical conclusion:

- In this NemoClaw/Hermes version, network egress is enforced by OpenShell/NemoClaw.
- MCP server reachability can therefore be allowed or denied at the network layer.
- But once Hermes is allowed to reach the MCP endpoint, the current runtime does **not** provide a separate NemoClaw-native per-MCP-tool allowlist/denylist layer for role scoping.
- The `$20` cap we proved for `create_driver_payout` is currently enforced by the MCP server's own `check_spending_policy`, not by a distinct outer NemoClaw tool-role gate.

So Phase 8 is only partially provable with today's Hermes/NemoClaw capability surface unless NVIDIA adds one of:

1. A Hermes-side MCP tool allow/deny policy mechanism in the NemoClaw plugin/runtime.
2. A gateway-time tool filtering layer before Hermes sees discovered MCP tools.
3. A documented OpenShell/NemoClaw tool policy feature for Hermes sandboxes, analogous to OpenClaw's extra-agent `tools.allow` / `tools.deny` controls.

## Correction: live HermesRoutiq runtime is the `hermes-runway` sandbox

The current app runtime used by HermesRoutiq is not the older `routiq` profile discussed in the earlier Phase 8 notes.

What is true in the current environment:

- `.env` points the local bridge at:
  - `HERMES_WSL_DISTRO=Ubuntu-24.04`
  - `HERMES_SANDBOX_NAME=hermes-runway`
- The running OpenShell container is named like:
  - `openshell-hermes-runway-...`
- The live sandbox config file is:
  - `/sandbox/.hermes/config.yaml`

What was verified from the live container:

- `/sandbox/.hermes/config.yaml` exists and is the real runtime config Hermes is using.
- That file currently has **no** `mcp_servers` section by default.
- So the live NemoHermes runtime was not yet natively wired to the Routiq MCP tool surface, even though the repo already had the Node MCP server and role policy implementation.

Practical consequence:

- The earlier `~/.hermes/profiles/routiq/config.yaml` work was useful for discovering Hermes's supported `mcp_servers` format, but it is not the active target for HermesRoutiq today.
- The correct target for live integration is the running `hermes-runway` sandbox config inside the container.

## Repo helpers added for the live `hermes-runway` target

To align the repo with the real runtime target, the following helpers were added:

- [ops/nemoclaw/routiq-hermes-role-scoped-mcp.yaml](/C:/Users/ASUS/HermesRoutiq/ops/nemoclaw/routiq-hermes-role-scoped-mcp.yaml)
- [ops/nemoclaw/apply-hermes-role-scoped-mcp.ps1](/C:/Users/ASUS/HermesRoutiq/ops/nemoclaw/apply-hermes-role-scoped-mcp.ps1)
- [ops/nemoclaw/prove-hermes-role-scoped-mcp.ps1](/C:/Users/ASUS/HermesRoutiq/ops/nemoclaw/prove-hermes-role-scoped-mcp.ps1)

What they do:

- `routiq-hermes-role-scoped-mcp.yaml`
  - defines five Hermes MCP server entries:
    - `routiq_monitoring`
    - `routiq_routing`
    - `routiq_finance`
    - `routiq_operations`
    - `routiq_payment`
  - each points at the host Routiq MCP HTTP endpoint and sends a different `x-routiq-role` header
- `apply-hermes-role-scoped-mcp.ps1`
  - finds the running `openshell-<sandbox>-...` container
  - backs up `/sandbox/.hermes/config.yaml`
  - injects the role-scoped `mcp_servers` entries into the live sandbox config
  - disables any legacy `hermes-routiq` full-access MCP entry if it exists
- `prove-hermes-role-scoped-mcp.ps1`
  - runs inside the live sandbox container
  - loads Hermes's own `mcp_servers` config
  - connects to each `routiq_*` MCP server entry one-by-one
  - prints the tool list Hermes sees for each role-scoped server

This is the honest Phase 8 shape today:

- Hermes skills remain sandbox-side.
- Routiq tools come in through Hermes's supported `mcp_servers` connection layer.
- Least-privilege role scoping is enforced by our MCP server's role-scoped HTTP tool registration.
- NemoHermes provides the outer sandbox and skills runtime, but not a separate NVIDIA-native per-tool role policy layer.

Live proof after applying the helper to `hermes-runway` showed:

- 5 role-scoped Hermes MCP server entries loaded from `/sandbox/.hermes/config.yaml`
- `routiq_monitoring`: 3 tools
- `routiq_routing`: 7 tools
- `routiq_finance`: 4 tools
- `routiq_operations`: 11 tools
- `routiq_payment`: 2 tools

So the current live sandbox-native integration is now:

- Hermes sandbox config owns the MCP connections
- each connection carries a distinct `x-routiq-role` header
- the Node MCP server exposes only that role's tool subset for the HTTP session
- Hermes therefore sees separate least-privilege tool surfaces through its own `mcp_servers` layer
