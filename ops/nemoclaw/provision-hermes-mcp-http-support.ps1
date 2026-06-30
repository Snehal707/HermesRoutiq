param(
  [string]$SandboxName = "routiq",
  [string]$McpVersion = "1.28.0"
)

$ErrorActionPreference = "Stop"

$containerName = docker ps --format "{{.Names}}" | Select-String "^openshell-$SandboxName-" | Select-Object -First 1 | ForEach-Object { $_.Line }

if (-not $containerName) {
  throw "No running OpenShell sandbox container found for sandbox '$SandboxName'."
}

$pythonPath = "/opt/hermes/.venv/bin/python3"
$sitePackagesMarker = "/opt/hermes/.venv/lib/python3.13/site-packages/mcp/client/streamable_http.py"

Write-Host "Provisioning MCP HTTP support in container '$containerName'..."

docker exec $containerName sh -lc @"
set -e
$pythonPath -m ensurepip >/dev/null 2>&1 || true
$pythonPath -m pip install --no-cache-dir "mcp==$McpVersion"
test -f $sitePackagesMarker
"@

Write-Host "Verifying Hermes runtime can see streamable HTTP support..."

docker exec $containerName sh -lc @"
set -e
test -f $sitePackagesMarker
ls -l $sitePackagesMarker
"@

Write-Host "MCP HTTP support is now available in '$containerName'."
