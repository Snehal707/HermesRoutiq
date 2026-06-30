param(
  [string]$SandboxName = "hermes-runway",
  [string]$McpUrl = "http://172.20.96.1:8644/mcp",
  [string]$Role = "monitoring",
  [string]$ToolName = "get_business_snapshot",
  [string]$ToolPayloadJson = "{}",
  [string]$Distro = "Ubuntu-24.04"
)

$escapedMcpUrl = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($McpUrl)
$escapedRole = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Role)
$escapedToolName = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($ToolName)
$escapedToolPayloadJson = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($ToolPayloadJson)

$python = @"
import anyio, json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = '$escapedMcpUrl'
ROLE = '$escapedRole'
TOOL = '$escapedToolName'
PAYLOAD = json.loads('$escapedToolPayloadJson')

async def main():
    async with streamablehttp_client(URL, headers={"x-routiq-role": ROLE}) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            init = await session.initialize()
            tools = await session.list_tools()
            result = await session.call_tool(TOOL, PAYLOAD)
            print(json.dumps({
                "server": init.serverInfo.name,
                "version": init.serverInfo.version,
                "toolCount": len(tools.tools),
                "firstTools": [tool.name for tool in tools.tools[:10]],
                "calledTool": TOOL,
                "isError": bool(getattr(result, "isError", False)),
                "structuredContent": result.structuredContent,
            }, indent=2))

anyio.run(main)
"@

$python | wsl.exe -d $Distro -e bash -lc "source ~/.nvm/nvm.sh >/dev/null 2>&1; nemohermes $SandboxName exec -- /opt/hermes/.venv/bin/python -"
