import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main(): Promise<void> {
  const [, , toolName, rawArgs = "{}", role = "operations", baseUrl = "http://127.0.0.1:8644/mcp"] = process.argv;

  if (!toolName) {
    throw new Error(
      "Usage: tsx scripts/call-tool-http.ts <toolName> [jsonArgs] [role] [baseUrl]",
    );
  }

  const argsSource = rawArgs.startsWith("@")
    ? await readFile(rawArgs.slice(1), "utf8")
    : rawArgs;
  const args = JSON.parse(argsSource) as Record<string, unknown>;
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: {
      headers: {
        "x-routiq-role": role,
      },
    },
  });
  const client = new Client(
    {
      name: "call-tool-http",
      version: "0.1.0",
    },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
