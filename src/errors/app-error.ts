import type { ErrorCode } from "./error-codes.js";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("OPERATION_FAILED", "The operation could not be completed.", 500, {
    cause: error,
  });
}
