import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config/env.js";

const config: Config = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  auth: { mode: "fixed", token: "1234567890abcdef" },
  siyuan: {
    baseUrl: "http://127.0.0.1:6806",
    token: "separate-siyuan-token",
    timeoutMs: 1_000,
    readRetries: 0,
  },
  notebookAccess: { allowlist: [], denylist: [] },
};

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
};

describe("HTTP MCP endpoint", () => {
  it("keeps health public", async () => {
    const app = buildApp(config);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it.each([
    ["without authorization", undefined],
    ["with a wrong token", "Bearer wrong-token-value"],
  ])("rejects MCP requests %s", async (_label, authorization) => {
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: authorization ? { authorization } : {},
      payload: initializeBody,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    await app.close();
  });

  it("accepts a valid token and initializes MCP", async () => {
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer 1234567890abcdef",
        accept: "application/json, text/event-stream",
      },
      payload: initializeBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "siyuan-mcp", version: "0.1.0" } },
    });
    await app.close();
  });

  it("accepts an unauthenticated client in anonymous mode", async () => {
    const app = buildApp({ ...config, auth: { mode: "none", writeEnabled: false } });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: initializeBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "siyuan-mcp" } },
    });
    await app.close();
  });

  it("publishes OAuth discovery and accepts a valid JWT for ChatGPT mode", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
    const issuerServer = Fastify();
    issuerServer.get("/jwks", async () => ({ keys: [jwk] }));
    await issuerServer.listen({ host: "127.0.0.1", port: 0 });
    const address = issuerServer.server.address();
    if (!address || typeof address === "string") throw new Error("Test issuer did not start");
    const issuer = `http://127.0.0.1:${address.port}/`;
    const audience = "https://mcp.example.com";
    const oauthConfig: Config = {
      ...config,
      auth: {
        mode: "oauth",
        publicUrl: audience,
        issuerUrl: issuer,
        audience,
        jwksUrl: `${issuer}jwks`,
        scopes: ["siyuan.read", "siyuan.write"],
      },
    };
    const token = await new SignJWT({ scope: "siyuan.read" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("chatgpt-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const app = buildApp(oauthConfig);

    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(metadata.json()).toMatchObject({
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ["siyuan.read", "siyuan.write"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: initializeBody,
    });
    expect(response.statusCode).toBe(200);

    await app.close();
    await issuerServer.close();
  });
});
