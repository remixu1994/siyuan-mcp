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
    expect(config.auth).toEqual({ mode: "none" });
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
});
