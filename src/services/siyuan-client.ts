import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../errors/app-error.js";
import type { SiYuanEnvelope } from "../types/siyuan.js";

export type OperationKind = "read" | "write";

export interface SiYuanClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  readRetries: number;
  logger: FastifyBaseLogger;
  fetch?: typeof globalThis.fetch;
}

export class SiYuanClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #readRetries: number;
  readonly #logger: FastifyBaseLogger;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: SiYuanClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#readRetries = options.readRetries;
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async post<T>(endpoint: string, body: unknown, operation: OperationKind): Promise<T> {
    const attempts = operation === "read" ? this.#readRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = performance.now();
      try {
        const response = await this.#fetch(new URL(endpoint, this.#baseUrl), {
          method: "POST",
          headers: {
            authorization: `Token ${this.#token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        this.#logger.info({
          siyuanEndpoint: endpoint,
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });

        if (response.status === 401 || response.status === 403) {
          throw new AppError(
            "SIYUAN_AUTH_FAILED",
            "SiYuan rejected the configured API token.",
            502,
          );
        }

        if (!response.ok) {
          if (operation === "read" && isRetryableStatus(response.status) && attempt < attempts) {
            await delay(50 * attempt);
            continue;
          }
          throw new AppError(
            operation === "write" ? "OPERATION_STATUS_UNKNOWN" : "SIYUAN_UNAVAILABLE",
            operation === "write"
              ? "SiYuan did not confirm whether the write completed. Inspect the note before retrying."
              : "SiYuan is temporarily unavailable.",
            502,
          );
        }

        const envelope = (await response.json()) as SiYuanEnvelope<T>;
        if (!isEnvelope(envelope)) {
          throw new AppError("SIYUAN_UNAVAILABLE", "SiYuan returned an invalid response.", 502);
        }
        if (envelope.code !== 0) {
          throw new AppError(
            "OPERATION_FAILED",
            sanitizeSiYuanMessage(envelope.msg),
            502,
          );
        }

        return envelope.data;
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        this.#logger.warn({
          siyuanEndpoint: endpoint,
          durationMs: Math.round(performance.now() - startedAt),
          attempt,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });

        if (operation === "read" && attempt < attempts) {
          await delay(50 * attempt);
          continue;
        }

        throw new AppError(
          operation === "write" ? "OPERATION_STATUS_UNKNOWN" : "SIYUAN_UNAVAILABLE",
          operation === "write"
            ? "SiYuan did not confirm whether the write completed. Inspect the note before retrying."
            : "SiYuan is temporarily unavailable.",
          502,
          { cause: error },
        );
      }
    }

    throw new AppError("SIYUAN_UNAVAILABLE", "SiYuan is temporarily unavailable.", 502, {
      cause: lastError,
    });
  }
}

function isEnvelope(value: unknown): value is SiYuanEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "msg" in value &&
    typeof value.msg === "string" &&
    "data" in value
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function sanitizeSiYuanMessage(message: string): string {
  if (!message) return "SiYuan could not complete the operation.";
  return message.slice(0, 300).replace(/[\r\n]+/gu, " ");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
