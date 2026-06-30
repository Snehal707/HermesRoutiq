param(
  [string]$SandboxName = "",
  [string]$McpUrl = "http://172.20.96.1:8644/mcp",
  [string]$TemplatePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $SandboxName) {
  if ($env:HERMES_SANDBOX_NAME) {
    $SandboxName = $env:HERMES_SANDBOX_NAME
  } else {
    $SandboxName = "hermes-runway"
  }
}

if (-not $TemplatePath) {
  $TemplatePath = Join-Path $PSScriptRoot "routiq-hermes-role-scoped-mcp.yaml"
}

if (-not (Test-Path -LiteralPath $TemplatePath)) {
  throw "Template file not found: $TemplatePath"
}

$containerName = docker ps --filter "label=openshell.ai/sandbox-name=$SandboxName" --format "{{.Names}}" | Select-Object -First 1
if (-not $containerName) {
  throw "No running OpenShell sandbox container found for sandbox '$SandboxName'."
}

$pythonPath = "/opt/hermes/.venv/bin/python"

$templateRaw = Get-Content -LiteralPath $TemplatePath -Raw
$templateResolved = $templateRaw.Replace("__ROUTIQ_MCP_URL__", $McpUrl)
$templateB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($templateResolved))

$pythonScript = @"
import base64
import json
import os
import shutil
import time

import yaml

CONFIG_PATH = "/sandbox/.hermes/config.yaml"
LEGACY_SERVER_NAMES = ("hermes-routiq",)

with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
    config = yaml.safe_load(fh) or {}

overlay = yaml.safe_load(
    base64.b64decode(os.environ["ROUTIQ_MCP_TEMPLATE_B64"]).decode("utf-8")
) or {}

mcp_servers = config.get("mcp_servers")
if not isinstance(mcp_servers, dict):
    mcp_servers = {}

for legacy_name in LEGACY_SERVER_NAMES:
    legacy_config = mcp_servers.get(legacy_name)
    if isinstance(legacy_config, dict):
        legacy_config["enabled"] = False

overlay_servers = overlay.get("mcp_servers") or {}
for server_name, server_config in overlay_servers.items():
    mcp_servers[server_name] = server_config

config["mcp_servers"] = mcp_servers

backup_path = f"{CONFIG_PATH}.bak.{int(time.time())}"
shutil.copy2(CONFIG_PATH, backup_path)

with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
    yaml.safe_dump(config, fh, sort_keys=False, allow_unicode=True)

summary = {
    "configPath": CONFIG_PATH,
    "backupPath": backup_path,
    "mcpServers": sorted(mcp_servers.keys()),
    "appliedServers": sorted(overlay_servers.keys()),
    "legacyDisabled": [name for name in LEGACY_SERVER_NAMES if name in mcp_servers],
}
print(json.dumps(summary, indent=2))
"@

$pythonScript | docker exec `
  -i `
  -e "ROUTIQ_MCP_TEMPLATE_B64=$templateB64" `
  $containerName `
  $pythonPath -

if ($LASTEXITCODE -ne 0) {
  throw "Failed to apply role-scoped Routiq MCP config inside '$containerName'."
}

Write-Host "Role-scoped Routiq MCP config applied to '$containerName'."
