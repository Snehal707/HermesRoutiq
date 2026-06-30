param(
  [string]$SandboxName = "",
  [string]$ServerPrefix = "routiq_"
)

$ErrorActionPreference = "Stop"

if (-not $SandboxName) {
  if ($env:HERMES_SANDBOX_NAME) {
    $SandboxName = $env:HERMES_SANDBOX_NAME
  } else {
    $SandboxName = "hermes-runway"
  }
}

$containerName = docker ps --filter "label=openshell.ai/sandbox-name=$SandboxName" --format "{{.Names}}" | Select-Object -First 1
if (-not $containerName) {
  throw "No running OpenShell sandbox container found for sandbox '$SandboxName'."
}

$pythonPath = "/opt/hermes/.venv/bin/python"
$sandboxHome = "/sandbox"
$hermesHome = "/sandbox/.hermes"

$pythonScript = @"
import json
import traceback

from tools.mcp_tool import _load_mcp_config, register_mcp_servers, shutdown_mcp_servers

SERVER_PREFIX = "$ServerPrefix"
servers = _load_mcp_config()
target_names = sorted(name for name in servers.keys() if name.startswith(SERVER_PREFIX))

results = {}
for name in target_names:
    try:
        tools = register_mcp_servers({name: servers[name]})
        results[name] = {
            "toolCount": len(tools),
            "tools": tools,
            "headers": (servers[name].get("headers") or {}),
            "url": servers[name].get("url"),
        }
    except Exception as exc:
        results[name] = {
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "headers": (servers[name].get("headers") or {}),
            "url": servers[name].get("url"),
        }
    finally:
        try:
            shutdown_mcp_servers()
        except Exception:
            pass

print(json.dumps({
    "serverPrefix": SERVER_PREFIX,
    "serverCount": len(target_names),
    "loadedServerNames": target_names,
    "servers": results,
}, indent=2))
"@

$pythonScript | docker exec `
  -i `
  -e "HOME=$sandboxHome" `
  -e "HERMES_HOME=$hermesHome" `
  $containerName `
  $pythonPath -

if ($LASTEXITCODE -ne 0) {
  throw "Failed to prove role-scoped Routiq MCP config inside '$containerName'."
}
