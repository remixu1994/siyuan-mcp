import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

const base = {
  NODE_ENV: "test",
  SIYUAN_BASE_URL: "http://127.0.0.1:6806",
  SIYUAN_TOKEN: "siyuan-secret",
};

describe("loadConfig", () => {
  it("loads anonymous mode without an MCP token", () => {
    const config = loadConfig({ ...base, AUTH_MODE: "none" });
    expect(config.auth).toEqual({ mode: "none", writeEnabled: false });
    expect(config.notebookAccess).toEqual({ allowlist: [], denylist: [] });
  });

  it("requires an allowlist before enabling anonymous writes", () => {
    expect(() =>
      loadConfig({ ...base, AUTH_MODE: "none", ANONYMOUS_WRITE_ENABLED: "true" }),
    ).toThrow();
  });

  it("loads anonymous writes with notebook allow and deny lists", () => {
    const allowed = "20250220160346-dudilkq";
    const denied = "20240101000000-abcdefg";
    const config = loadConfig({
      ...base,
      AUTH_MODE: "none",
      ANONYMOUS_WRITE_ENABLED: "true",
      SIYUAN_NOTEBOOK_ALLOWLIST: `${allowed}, ${allowed}`,
      SIYUAN_NOTEBOOK_DENYLIST: denied,
    });
    expect(config.auth).toEqual({ mode: "none", writeEnabled: true });
    expect(config.notebookAccess).toEqual({ allowlist: [allowed], denylist: [denied] });
  });

  it("loads fixed-token mode without mixing the SiYuan token", () => {
    const config = loadConfig({ ...base, AUTH_MODE: "fixed", MCP_FIXED_TOKEN: "1234567890abcdef" });
    expect(config.auth).toEqual({ mode: "fixed", token: "1234567890abcdef" });
    expect(config.siyuan.token).toBe("siyuan-secret");
  });

  it("requires OAuth resource-server settings for ChatGPT mode", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "oauth" })).toThrow();
  });

  it("loads OAuth mode", () => {
    const config = loadConfig({
      ...base,
      AUTH_MODE: "oauth",
      MCP_PUBLIC_URL: "https://mcp.example.com/",
      OAUTH_ISSUER_URL: "https://issuer.example.com/",
      OAUTH_AUDIENCE: "https://mcp.example.com",
    });
    expect(config.auth).toMatchObject({
      mode: "oauth",
      publicUrl: "https://mcp.example.com",
      issuerUrl: "https://issuer.example.com/",
    });
  });

  it("requires all mock OAuth settings and a notebook allowlist", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "mock-oauth" })).toThrow();
  });

  it("loads mock OAuth mode for a predefined public client", () => {
    const config = loadConfig({
      ...base,
      AUTH_MODE: "mock-oauth",
      MCP_PUBLIC_URL: "https://mcp.example.com/",
      MOCK_OAUTH_CLIENT_ID: "chatgpt-siyuan-mcp",
      MOCK_OAUTH_REDIRECT_URI: "https://chatgpt.com/connector/oauth/test",
      MOCK_OAUTH_ACCESS_CODE: "a-secure-temporary-code",
      SIYUAN_NOTEBOOK_ALLOWLIST: "20250220160346-dudilkq",
    });
    expect(config.auth).toMatchObject({
      mode: "mock-oauth",
      publicUrl: "https://mcp.example.com",
      clientId: "chatgpt-siyuan-mcp",
      tokenTtlSeconds: 3_600,
    });
  });
});
