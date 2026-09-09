import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { MockOAuthProvider } from "./mock-oauth-provider.js";

export interface AuthContext {
  subject: string;
  scopes: string[];
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<AuthContext>;
  challenge(reply: FastifyReply, error?: string): void;
}

export function createAuthenticator(
  config: Config["auth"],
  mockOAuthProvider?: MockOAuthProvider,
): Authenticator {
  if (config.mode === "none") return new AnonymousAuthenticator(config.writeEnabled);
  if (config.mode === "fixed") return new FixedTokenAuthenticator(config.token);
  if (config.mode === "mock-oauth") {
    if (!mockOAuthProvider) throw new Error("Mock OAuth provider is required.");
    return new MockOAuthAuthenticator(config.publicUrl, mockOAuthProvider);
  }
  return new OAuthAuthenticator(config);
}

class AnonymousAuthenticator implements Authenticator {
  constructor(private readonly writeEnabled: boolean) {}

  async authenticate(): Promise<AuthContext> {
    return {
      subject: "anonymous",
      scopes: this.writeEnabled ? ["siyuan.read", "siyuan.write"] : ["siyuan.read"],
    };
  }

  challenge(): void {
    // Anonymous mode never rejects a request for missing credentials.
  }
}

class FixedTokenAuthenticator implements Authenticator {
  constructor(private readonly expectedToken: string) {}

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const token = readBearerToken(request.headers.authorization);
    if (!token || !constantTimeEqual(token, this.expectedToken)) {
      throw new AppError("UNAUTHORIZED", "A valid bearer token is required.", 401);
    }
    return { subject: "fixed-token-user", scopes: ["siyuan.read", "siyuan.write"] };
  }

  challenge(reply: FastifyReply): void {
    reply.header("www-authenticate", 'Bearer realm="siyuan-mcp"');
  }
}

class OAuthAuthenticator implements Authenticator {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: Extract<Config["auth"], { mode: "oauth" }>) {
    const jwksUrl = config.jwksUrl ?? `${config.issuerUrl.replace(/\/+$/u, "")}/.well-known/jwks.json`;
    this.#jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      throw new AppError("UNAUTHORIZED", "OAuth authorization is required.", 401);
    }

    try {
      const verified = await jwtVerify(token, this.#jwks, {
        issuer: this.config.issuerUrl,
        audience: this.config.audience,
      });
      const scopes = readScopes(verified.payload);
      const requiredScope = requiredScopeForRequest(request);
      if (requiredScope && !scopes.includes(requiredScope)) {
        throw new AppError("UNAUTHORIZED", "The access token has insufficient scope.", 403);
      }
      return { subject: verified.payload.sub ?? "oauth-user", scopes };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UNAUTHORIZED", "The OAuth access token is invalid or expired.", 401, {
        cause: error,
      });
    }
  }

  challenge(reply: FastifyReply, error = "invalid_token"): void {
    const metadataUrl = `${this.config.publicUrl}/.well-known/oauth-protected-resource`;
    reply.header(
      "www-authenticate",
      `Bearer resource_metadata="${metadataUrl}", error="${error}", error_description="OAuth authorization is required"`,
    );
  }
}

class MockOAuthAuthenticator implements Authenticator {
  constructor(
    private readonly publicUrl: string,
    private readonly provider: MockOAuthProvider,
  ) {}

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const token = readBearerToken(request.headers.authorization);
    const context = token ? this.provider.verifyAccessToken(token) : undefined;
    if (!context) throw new AppError("UNAUTHORIZED", "OAuth authorization is required.", 401);
    const requiredScope = requiredScopeForRequest(request);
    if (requiredScope && !context.scopes.includes(requiredScope)) {
      throw new AppError("UNAUTHORIZED", "The access token has insufficient scope.", 403);
    }
    return context;
  }

  challenge(reply: FastifyReply, error = "invalid_token"): void {
    reply.header(
      "www-authenticate",
      `Bearer resource_metadata="${this.publicUrl}/.well-known/oauth-protected-resource", error="${error}"`,
    );
  }
}

function requiredScopeForRequest(request: FastifyRequest): string | undefined {
  if (request.method !== "POST" || typeof request.body !== "object" || request.body === null) {
    return undefined;
  }
  const body = request.body as { method?: unknown; params?: { name?: unknown } };
  if (body.method !== "tools/call" || typeof body.params?.name !== "string") return undefined;
  return ["create_document", "append_content", "update_block"].includes(body.params.name)
    ? "siyuan.write"
    : "siyuan.read";
}

function readBearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+([^\s]+)$/iu.exec(header ?? "")?.[1];
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return raw.split(/\s+/u).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((scope): scope is string => typeof scope === "string");
  return [];
}
