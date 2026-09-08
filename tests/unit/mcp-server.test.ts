import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import type { SiYuanNoteService } from "../../src/services/siyuan-note-service.js";

describe("MCP server", () => {
  it("lists all seven tools and calls a tool", async () => {
    const service = {
      listNotebooks: vi.fn().mockResolvedValue({
        notebooks: [{ id: "20240101000000-abcdefg", name: "Notes", closed: false }],
      }),
    } as unknown as SiYuanNoteService;
    const server = createMcpServer(service, { mode: "fixed", token: "1234567890abcdef" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "vitest", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_notebooks",
      "list_documents",
      "search_notes",
      "get_document",
      "create_document",
      "append_content",
      "update_block",
    ]);

    const result = await client.callTool({ name: "list_notebooks", arguments: {} });
    expect(result.structuredContent).toEqual({
      notebooks: [{ id: "20240101000000-abcdefg", name: "Notes", closed: false }],
    });

    await client.close();
    await server.close();
  });
});
