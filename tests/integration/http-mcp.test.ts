import { createHash } from "node:crypto";
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

  it("runs the mock OAuth authorization-code and PKCE flow", async () => {
    const publicUrl = "https://mcp.example.com";
    const clientId = "chatgpt-siyuan-mcp";
    const redirectUri = "https://chatgpt.com/connector/oauth/test";
    const verifier = "mock-pkce-verifier-that-is-longer-than-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const mockConfig: Config = {
      ...config,
      auth: {
        mode: "mock-oauth",
        publicUrl,
        clientId,
        redirectUri,
        accessCode: "a-secure-temporary-code",
        scopes: ["siyuan.read", "siyuan.write"],
        tokenTtlSeconds: 600,
      },
      notebookAccess: { allowlist: ["20250220160346-dudilkq"], denylist: [] },
    };
    const app = buildApp(mockConfig);

    const protectedMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(protectedMetadata.json()).toMatchObject({
      resource: publicUrl,
      authorization_servers: [publicUrl],
    });
    expect(protectedMetadata.headers["cache-control"]).toBe("no-store");

    const pathAwareProtectedMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });
    expect(pathAwareProtectedMetadata.json()).toEqual(protectedMetadata.json());

    const authorizationMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(authorizationMetadata.json()).toMatchObject({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(authorizationMetadata.headers["cache-control"]).toBe("no-store");

    const pathAwareAuthorizationMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server/mcp",
    });
    expect(pathAwareAuthorizationMetadata.json()).toEqual(authorizationMetadata.json());

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: initializeBody,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toContain(
      `${publicUrl}/.well-known/oauth-protected-resource`,
    );

    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: publicUrl,
      scope: "siyuan.read",
      state: "chatgpt-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const authorizationPage = await app.inject({
      method: "GET",
      url: `/authorize?${authorizeQuery}`,
    });
    expect(authorizationPage.statusCode).toBe(200);
    expect(authorizationPage.body).toContain('<form method="POST" action="/authorize">');
    expect(authorizationPage.body).not.toContain("fetch(");
    expect(authorizationPage.headers["content-security-policy"]).toContain(
      "form-action 'self' https://chatgpt.com",
    );
    expect(authorizationPage.headers["content-security-policy"]).not.toContain("form-action *");
    expect(authorizationPage.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const requestId = /name="request_id" value="([^"]+)"/u.exec(authorizationPage.body)?.[1];
    expect(requestId).toBeTruthy();

    const approval = await app.inject({
      method: "POST",
      url: "/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        request_id: requestId!,
        access_code: "a-secure-temporary-code",
      }).toString(),
    });
    expect(approval.statusCode).toBe(303);
    expect(approval.headers["cache-control"]).toBe("no-store");
    expect(approval.headers.refresh).toBeUndefined();
    expect(approval.body).toBe("");
    const callback = new URL(approval.headers.location!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("chatgpt-state");

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: publicUrl,
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenResponse.statusCode).toBe(200);
    expect(tokenResponse.json()).toMatchObject({
      token_type: "Bearer",
      expires_in: 600,
      scope: "siyuan.read",
    });
    const accessToken = tokenResponse.json<{ access_token: string }>().access_token;

    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
      },
      payload: initializeBody,
    });
    expect(initialized.statusCode).toBe(200);

    const writeWithReadScope = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_document",
          arguments: {
            notebookId: "20250220160346-dudilkq",
            path: "/Forbidden",
            markdown: "# Forbidden",
          },
        },
      },
    });
    expect(writeWithReadScope.statusCode).toBe(403);

    await app.close();
  });
});
