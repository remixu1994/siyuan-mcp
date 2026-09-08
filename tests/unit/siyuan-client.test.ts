import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors/app-error.js";
import { SiYuanClient } from "../../src/services/siyuan-client.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

describe("SiYuanClient", () => {
  it("uses SiYuan Token auth and unwraps successful responses", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: "", data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = makeClient(fetch);
    await expect(client.post("/api/test", {}, "read")).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Token siyuan-token",
    });
  });

  it("retries temporary read failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, msg: "", data: [] }), { status: 200 }),
      );
    const client = makeClient(fetch);
    await expect(client.post("/api/query/sql", {}, "read")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never retries an indeterminate write", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("socket closed"));
    const client = makeClient(fetch);
    await expect(client.post("/api/block/appendBlock", {}, "write")).rejects.toMatchObject({
      code: "OPERATION_STATUS_UNKNOWN",
    } satisfies Partial<AppError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function makeClient(fetch: ReturnType<typeof vi.fn>): SiYuanClient {
  return new SiYuanClient({
    baseUrl: "http://127.0.0.1:6806",
    token: "siyuan-token",
    timeoutMs: 1_000,
    readRetries: 1,
    logger,
    fetch: fetch as typeof globalThis.fetch,
  });
}
