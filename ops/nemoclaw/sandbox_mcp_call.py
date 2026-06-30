import argparse
import base64
import json

import anyio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def run(url: str, tool_name: str, payload: dict[str, object]) -> None:
    async with streamablehttp_client(url) as (read_stream, write_stream, _get_session_id):
        async with ClientSession(read_stream, write_stream) as session:
            init_result = await session.initialize()
            print(
                json.dumps(
                    {
                        "initialize": {
                            "protocolVersion": init_result.protocolVersion,
                            "serverInfo": {
                                "name": init_result.serverInfo.name,
                                "version": init_result.serverInfo.version,
                            },
                        }
                    },
                    indent=2,
                )
            )
            result = await session.call_tool(tool_name, payload)
            output = {
                "tool": tool_name,
                "isError": bool(getattr(result, "isError", False)),
                "structuredContent": result.structuredContent,
                "content": [
                    {
                        "type": item.type,
                        "text": getattr(item, "text", None),
                    }
                    for item in result.content
                ],
            }
            print(json.dumps(output, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--tool", required=True)
    parser.add_argument("--payload", default="{}")
    parser.add_argument("--payload-b64")
    args = parser.parse_args()

    if args.payload_b64:
        payload = json.loads(base64.b64decode(args.payload_b64).decode("utf-8"))
    else:
        payload = json.loads(args.payload)
    anyio.run(run, args.url, args.tool, payload)


if __name__ == "__main__":
    main()
