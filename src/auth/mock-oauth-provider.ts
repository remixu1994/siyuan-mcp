import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config/env.js";

type MockOAuthConfig = Extract<Config["auth"], { mode: "mock-oauth" }>;
const maxInMemoryRecords = 1_000;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  expiresAt: number;
}

interface AccessTokenRecord {
  subject: string;
  scopes: string[];
  expiresAt: number;
}

export interface MockTokenContext {
  subject: string;
  scopes: string[];
}

export class MockOAuthProvider {
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #codes = new Map<string, PendingAuthorization>();
  readonly #tokens = new Map<string, AccessTokenRecord>();

  constructor(readonly config: MockOAuthConfig) {}

  get issuer(): string {
    return this.config.publicUrl;
  }

  createAuthorizationPage(query: Record<string, unknown>): string {
    this.cleanup();
    const pending = this.validateAuthorizationRequest(query);
    this.ensureCapacity(this.#pending);
    const requestId = randomToken();
    this.#pending.set(requestId, pending);
    return renderAuthorizationPage(requestId, pending.resource, pending.scopes);
  }

  approve(body: Record<string, unknown>): string {
    this.cleanup();
    const requestId = readString(body, "request_id");
    const accessCode = readString(body, "access_code");
    const pending = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new MockOAuthError("invalid_request", "The authorization request expired.", 400);
    }
    if (!constantTimeEqual(accessCode, this.config.accessCode)) {
      throw new MockOAuthError("access_denied", "The access code is invalid.", 401);
    }

    const code = randomToken();
    this.ensureCapacity(this.#codes);
    this.#codes.set(code, pending);
    const callback = new URL(pending.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", pending.state);
    return callback.toString();
  }

  exchange(body: Record<string, unknown>): {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope: string;
  } {
    this.cleanup();
    if (readString(body, "grant_type") !== "authorization_code") {
      throw new MockOAuthError("unsupported_grant_type", "Only authorization_code is supported.", 400);
    }
    const code = readString(body, "code");
    const authorization = this.#codes.get(code);
    this.#codes.delete(code);
    if (!authorization || authorization.expiresAt <= Date.now()) {
      throw new MockOAuthError("invalid_grant", "The authorization code is invalid or expired.", 400);
    }
    if (
      readString(body, "client_id") !== authorization.clientId ||
      readString(body, "redirect_uri") !== authorization.redirectUri ||
      readString(body, "resource") !== authorization.resource
    ) {
      throw new MockOAuthError("invalid_grant", "The authorization request binding does not match.", 400);
    }
    const verifier = readString(body, "code_verifier");
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
      throw new MockOAuthError("invalid_grant", "The PKCE verifier is invalid.", 400);
    }
    if (!constantTimeEqual(pkceChallenge(verifier), authorization.codeChallenge)) {
      throw new MockOAuthError("invalid_grant", "PKCE verification failed.", 400);
    }

    const accessToken = randomToken();
    this.ensureCapacity(this.#tokens);
    this.#tokens.set(accessToken, {
      subject: "mock-oauth-user",
      scopes: authorization.scopes,
      expiresAt: Date.now() + this.config.tokenTtlSeconds * 1_000,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.tokenTtlSeconds,
      scope: authorization.scopes.join(" "),
    };
  }

  verifyAccessToken(token: string): MockTokenContext | undefined {
    this.cleanup();
    const record = this.#tokens.get(token);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return { subject: record.subject, scopes: [...record.scopes] };
  }

  private validateAuthorizationRequest(query: Record<string, unknown>): PendingAuthorization {
    const clientId = readString(query, "client_id");
    const redirectUri = readString(query, "redirect_uri");
    const resource = readString(query, "resource");
    const state = readString(query, "state");
    const codeChallenge = readString(query, "code_challenge");
    const requestedScopes = (readOptionalString(query, "scope") ?? this.config.scopes.join(" "))
      .split(/\s+/u)
      .filter(Boolean);

    if (readString(query, "response_type") !== "code") {
      throw new MockOAuthError("unsupported_response_type", "Only response_type=code is supported.", 400);
    }
    if (clientId !== this.config.clientId || redirectUri !== this.config.redirectUri) {
      throw new MockOAuthError("invalid_request", "The OAuth client or redirect URI is invalid.", 400);
    }
    if (resource !== this.config.publicUrl) {
      throw new MockOAuthError("invalid_target", "The OAuth resource is invalid.", 400);
    }
    if (readString(query, "code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
      throw new MockOAuthError("invalid_request", "PKCE S256 is required.", 400);
    }
    if (!state || requestedScopes.some((scope) => !this.config.scopes.includes(scope))) {
      throw new MockOAuthError("invalid_scope", "The state or requested OAuth scopes are invalid.", 400);
    }

    return {
      clientId,
      redirectUri,
      resource,
      scopes: requestedScopes,
      state,
      codeChallenge,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.#pending) if (value.expiresAt <= now) this.#pending.delete(key);
    for (const [key, value] of this.#codes) if (value.expiresAt <= now) this.#codes.delete(key);
    for (const [key, value] of this.#tokens) if (value.expiresAt <= now) this.#tokens.delete(key);
  }

  private ensureCapacity(records: Map<string, unknown>): void {
    if (records.size >= maxInMemoryRecords) {
      throw new MockOAuthError("temporarily_unavailable", "The mock OAuth store is full.", 503);
    }
  }
}

export class MockOAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export function registerMockOAuthRoutes(app: FastifyInstance, provider: MockOAuthProvider): void {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const encoded = typeof body === "string" ? body : body.toString("utf8");
        done(null, Object.fromEntries(new URLSearchParams(encoded)));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  const authorizationServerMetadata = () => ({
    issuer: provider.issuer,
    authorization_endpoint: `${provider.issuer}/authorize`,
    token_endpoint: `${provider.issuer}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: provider.config.scopes,
  });
  const sendAuthorizationServerMetadata = async (_request: unknown, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    return authorizationServerMetadata();
  };

  app.get("/.well-known/oauth-authorization-server", sendAuthorizationServerMetadata);
  // Some clients derive RFC 8414 discovery from the MCP endpoint path.
  app.get("/.well-known/oauth-authorization-server/mcp", sendAuthorizationServerMetadata);

  app.get("/authorize", async (request, reply) => {
    try {
      return reply.type("text/html; charset=utf-8").headers(htmlSecurityHeaders()).send(
        provider.createAuthorizationPage(request.query as Record<string, unknown>),
      );
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.post("/authorize", async (request, reply) => {
    try {
      const callbackUrl = provider.approve(request.body as Record<string, unknown>);
      request.log.info(
        {
          callbackUrl: redactAuthorizationCode(callbackUrl),
          redirectStatus: 303,
        },
        "Mock OAuth authorization redirect issued",
      );
      return reply
        .code(303)
        .headers({
          "cache-control": "no-store",
          location: callbackUrl,
        })
        .send();
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.post("/token", async (request, reply) => {
    try {
      return reply.headers(tokenHeaders()).send(provider.exchange(request.body as Record<string, unknown>));
    } catch (error) {
      const oauthError = normalizeOAuthError(error);
      return reply
        .code(oauthError.statusCode)
        .headers(tokenHeaders())
        .send({ error: oauthError.error, error_description: oauthError.message });
    }
  });
}

function renderAuthorizationPage(requestId: string, resource: string, scopes: string[]): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize SiYuan MCP</title><style>
body{font:16px system-ui,sans-serif;max-width:520px;margin:10vh auto;padding:24px;color:#18181b}
main{border:1px solid #d4d4d8;border-radius:16px;padding:28px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px}
button{background:#18181b;color:white;border:0;border-radius:8px}code{overflow-wrap:anywhere}
</style></head><body><main><h1>授权 SiYuan MCP</h1>
<p>资源：<code>${escapeHtml(resource)}</code></p><p>权限：<code>${escapeHtml(scopes.join(" "))}</code></p>
<form method="POST" action="/authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label>临时访问码<input type="password" name="access_code" required autocomplete="current-password"></label>
<button type="submit">授权 ChatGPT</button></form></main></body></html>`;
}

function sendOAuthError(reply: FastifyReply, error: unknown) {
  const oauthError = normalizeOAuthError(error);
  return reply
    .code(oauthError.statusCode)
    .type("text/html; charset=utf-8")
    .headers(htmlSecurityHeaders())
    .send(`<h1>OAuth error</h1><p>${escapeHtml(oauthError.message)}</p>`);
}

function normalizeOAuthError(error: unknown): MockOAuthError {
  return error instanceof MockOAuthError
    ? error
    : new MockOAuthError("server_error", "The mock OAuth request failed.", 500);
}

function readString(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) {
    throw new MockOAuthError("invalid_request", `Missing OAuth parameter: ${key}`, 400);
  }
  return value;
}

function readOptionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value ? value : undefined;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function htmlSecurityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  };
}

function tokenHeaders(): Record<string, string> {
  return { "cache-control": "no-store", pragma: "no-cache" };
}

function redactAuthorizationCode(callbackUrl: string): string {
  const redacted = new URL(callbackUrl);
  if (redacted.searchParams.has("code")) redacted.searchParams.set("code", "[redacted]");
  return redacted.toString();
}
