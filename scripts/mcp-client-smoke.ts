import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:8080/mcp";
const authorization = process.env.MCP_AUTHORIZATION;
const toolName = process.env.MCP_TEST_TOOL ?? "list_notebooks";

let toolArguments: Record<string, unknown> = {};
if (process.env.MCP_TEST_ARGUMENTS) {
  const parsed: unknown = JSON.parse(process.env.MCP_TEST_ARGUMENTS);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP_TEST_ARGUMENTS must be a JSON object.");
  }
  toolArguments = parsed as Record<string, unknown>;
}

const client = new Client({ name: "siyuan-mcp-smoke-client", version: "0.1.0" });
const transportOptions = authorization
  ? { requestInit: { headers: { authorization } } }
  : {};
const transport = new StreamableHTTPClientTransport(new URL(endpoint), transportOptions);

try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === toolName)) {
    throw new Error(`Tool '${toolName}' was not advertised by the server.`);
  }

  const result = await client.callTool({ name: toolName, arguments: toolArguments });
  console.log(
    JSON.stringify(
      {
        connected: true,
        endpoint,
        tools: listed.tools.map((tool) => tool.name),
        call: {
          tool: toolName,
          isError: result.isError ?? false,
          structuredContent: result.structuredContent ?? null,
          content: result.content,
        },
      },
      null,
      2,
    ),
  );

  if (result.isError) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        connected: false,
        endpoint,
        error: error instanceof Error ? error.message : "Unknown client error",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
