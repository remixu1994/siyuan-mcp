import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config/env.js";
import { createAuthenticator } from "./auth/authenticator.js";
import { MockOAuthProvider, registerMockOAuthRoutes } from "./auth/mock-oauth-provider.js";
import { AppError, asAppError } from "./errors/app-error.js";
import { createMcpServer } from "./mcp/server.js";
import { SiYuanClient } from "./services/siyuan-client.js";
import { SiYuanNoteService } from "./services/siyuan-note-service.js";

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : { level: "info" },
    bodyLimit: 2_100_000,
    requestIdHeader: "x-request-id",
  });
  const mockOAuthProvider = config.auth.mode === "mock-oauth" ? new MockOAuthProvider(config.auth) : undefined;
  const authenticator = createAuthenticator(config.auth, mockOAuthProvider);
  const client = new SiYuanClient({
    ...config.siyuan,
    logger: app.log,
  });
  const service = new SiYuanNoteService(client, config.notebookAccess);

  app.get("/health", async () => ({ status: "ok" }));

  if (config.auth.mode === "oauth" || config.auth.mode === "mock-oauth") {
    const oauth = config.auth;
    const issuerUrl = oauth.mode === "oauth" ? oauth.issuerUrl : oauth.publicUrl;
    app.get("/.well-known/oauth-protected-resource", async () => ({
      resource: oauth.publicUrl,
      authorization_servers: [issuerUrl],
      scopes_supported: oauth.scopes,
      resource_documentation: `${oauth.publicUrl}/docs`,
    }));
  }

  if (mockOAuthProvider) registerMockOAuthRoutes(app, mockOAuthProvider);

  app.options("/mcp", async (_request, reply) => {
    return reply
      .headers({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,mcp-protocol-version,mcp-session-id",
        "access-control-expose-headers": "mcp-session-id",
      })
      .code(204)
      .send();
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    preHandler: async (request, reply) => {
      try {
        const context = await authenticator.authenticate(request);
        const raw = request.raw as typeof request.raw & { auth?: AuthInfo };
        raw.auth = { token: "", clientId: context.subject, scopes: context.scopes };
      } catch (error) {
        const appError = asAppError(error);
        authenticator.challenge(reply, appError.statusCode === 403 ? "insufficient_scope" : "invalid_token");
        return reply.code(appError.statusCode).send({
          success: false,
          error: { code: appError.code, message: appError.message },
        });
      }
    },
    handler: async (request, reply) => {
      const server = createMcpServer(service, config.auth);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        request.log.error({ err: error, requestId: request.id }, "MCP request failed");
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json");
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal MCP server error" },
              id: null,
            }),
          );
        }
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : asAppError(error);
    reply.code(appError.statusCode).send({
      success: false,
      error: { code: appError.code, message: appError.message },
    });
  });

  return app;
}
