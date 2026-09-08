import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { asAppError } from "../errors/app-error.js";
import type { SiYuanNoteService } from "../services/siyuan-note-service.js";

const nodeId = z.string().regex(/^\d{14}-[a-z0-9]{7}$/u, "Must be a valid SiYuan node ID");
const hPath = z
  .string()
  .min(1)
  .max(1024)
  .startsWith("/")
  .refine((value) => !value.includes("//"), "Path cannot contain empty segments");
const markdown = z.string().max(2_000_000);

export function createMcpServer(service: SiYuanNoteService, auth: Config["auth"]): McpServer {
  const server = new McpServer(
    { name: "siyuan-mcp", version: "0.1.0" },
    {
      instructions:
        "Use these tools only for the user's SiYuan notes. Search before reading when an ID is unknown. Before any write, confirm the target notebook, document, or block with the user. Never retry a write whose status is unknown.",
    },
  );
  const securitySchemes =
    auth.mode === "oauth" ? [{ type: "oauth2" as const, scopes: auth.scopes }] : undefined;

  server.registerTool(
    "list_notebooks",
    {
      title: "List SiYuan notebooks",
      description:
        "List the user's SiYuan notebooks. Use this before browsing or creating a document when the notebook ID is unknown.",
      inputSchema: {},
      outputSchema: {
        notebooks: z.array(z.object({ id: z.string(), name: z.string(), closed: z.boolean() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler("list_notebooks", () => service.listNotebooks()),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List SiYuan documents",
      description:
        "List immediate child documents at a human-readable path in a SiYuan notebook. Use this to browse the note tree; use '/' for the notebook root.",
      inputSchema: { notebookId: nodeId, path: hPath.default("/") },
      outputSchema: {
        documents: z.array(
          z.object({
            id: z.string(),
            notebookId: z.string(),
            title: z.string(),
            path: z.string(),
            updated: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler("list_documents", ({ notebookId, path }) => service.listDocuments(notebookId, path)),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search SiYuan notes",
      description:
        "Search the user's SiYuan documents and blocks for a keyword. Use this when the user asks to find, locate, recall, or search existing notes. The server controls the SQL; never ask the user for SQL.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
        notebookId: nodeId.optional(),
      },
      outputSchema: {
        results: z.array(
          z.object({
            blockId: z.string(),
            documentId: z.string(),
            notebookId: z.string(),
            title: z.string(),
            path: z.string(),
            snippet: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler("search_notes", ({ query, limit, notebookId }) =>
      service.searchNotes(query, limit, notebookId),
    ),
  );

  server.registerTool(
    "get_document",
    {
      title: "Read a SiYuan document",
      description:
        "Read the complete Markdown content of a SiYuan document by its document ID. Use search_notes or list_documents first when the ID is unknown.",
      inputSchema: { documentId: nodeId },
      outputSchema: { documentId: z.string(), path: z.string(), markdown: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler("get_document", ({ documentId }) => service.getDocument(documentId)),
  );

  registerWriteTools(server, service, securitySchemes);
  return server;
}

function registerWriteTools(
  server: McpServer,
  service: SiYuanNoteService,
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] }> | undefined,
): void {
  server.registerTool(
    "create_document",
    {
      title: "Create a SiYuan document",
      description:
        "Create a new SiYuan Markdown document at an explicit notebook path. Use only after the user has confirmed the notebook and path. This never overwrites an existing document.",
      inputSchema: { notebookId: nodeId, path: hPath, markdown },
      outputSchema: {
        documentId: z.string(),
        path: z.string(),
        created: z.literal(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler(
      "create_document",
      ({ notebookId, path, markdown: content }: { notebookId: string; path: string; markdown: string }) =>
        service.createDocument(notebookId, path, content),
    ),
  );

  server.registerTool(
    "append_content",
    {
      title: "Append to a SiYuan document",
      description:
        "Append Markdown to the end of an existing SiYuan document while preserving existing content. Use this when the user wants to add content, not replace it. Do not retry after an unknown write status.",
      inputSchema: { documentId: nodeId, markdown: markdown.min(1) },
      outputSchema: {
        documentId: z.string(),
        appended: z.literal(true),
        blockIds: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler(
      "append_content",
      ({ documentId, markdown: content }: { documentId: string; markdown: string }) =>
        service.appendContent(documentId, content),
    ),
  );

  server.registerTool(
    "update_block",
    {
      title: "Update a SiYuan block",
      description:
        "Replace one existing SiYuan block with the provided Markdown. Use only when the user has identified and confirmed the exact block. This changes existing content and must not be retried after an unknown write status.",
      inputSchema: { blockId: nodeId, markdown: markdown.min(1) },
      outputSchema: { blockId: z.string(), updated: z.literal(true) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...(securitySchemes ? { _meta: { securitySchemes } } : {}),
    },
    toolHandler(
      "update_block",
      ({ blockId, markdown: content }: { blockId: string; markdown: string }) =>
        service.updateBlock(blockId, content),
    ),
  );
}

function toolHandler<TArgs extends Record<string, unknown>, TResult extends object>(
  toolName: string,
  operation: (args: TArgs) => Promise<TResult>,
) {
  return async (args: TArgs) => {
    const startedAt = performance.now();
    try {
      const result = await operation(args);
      return {
        structuredContent: result as Record<string, unknown>,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      const appError = asAppError(error);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: { code: appError.code, message: appError.message },
              toolName,
              durationMs: Math.round(performance.now() - startedAt),
            }),
          },
        ],
      };
    }
  };
}
