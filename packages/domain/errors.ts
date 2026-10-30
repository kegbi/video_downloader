import { z } from "zod";

export const errorCodeSchema = z.enum([
  "invalid_url",
  "unsupported_url",
  "unauthorized",
  "queue_full",
  "active_job_limit",
  "cancelled",
  "source_unavailable",
  "extractor_failure",
  "timeout",
  "no_format_within_limit",
  "temp_storage_limit",
  "processing_failure",
  "storage_failure",
  "storage_full",
  "delivery_retryable",
  "delivery_permanent",
  "cleanup_failure",
  "conflict",
  "not_found",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
