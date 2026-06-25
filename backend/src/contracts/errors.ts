import { z } from "zod";

/** Severity attached to runtime error events/items. */
export const RuntimeErrorSeverity = z.enum(["info", "warning", "error"]);
export type RuntimeErrorSeverity = z.infer<typeof RuntimeErrorSeverity>;

/**
 * Canonical machine-readable error codes used across the HTTP surface and
 * runtime error envelopes. Ported faithfully from the original Nexus
 * `contracts/errors`.
 */
export const NexusErrorCode = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "turn_in_progress",
  "turn_not_running",
  "approval_not_pending",
  "capability_unavailable",
  "provider_unavailable",
  "policy_blocked",
  "model_modality_unsupported",
  "attachment_validation_failed",
  "workspace_not_git",
  "internal_error",
  "not_implemented",
  "aborted",
]);
export type NexusErrorCode = z.infer<typeof NexusErrorCode>;

/** Wire shape for a structured error body returned by the HTTP API. */
export const NexusErrorBody = z.object({
  code: NexusErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type NexusErrorBody = z.infer<typeof NexusErrorBody>;

/**
 * A structured error carried over the wire. Mirrors the original Nexus
 * `contracts/errors` shape: a stable machine code plus a human message and
 * optional details.
 */
export class RuntimeError extends Error {
  readonly code: string;
  readonly severity: RuntimeErrorSeverity;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { code?: string; severity?: RuntimeErrorSeverity; details?: unknown } = {},
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = options.code ?? "internal_error";
    this.severity = options.severity ?? "error";
    this.details = options.details;
  }
}

export function toErrorPayload(error: unknown): {
  message: string;
  code?: string;
  severity?: RuntimeErrorSeverity;
  details?: unknown;
} {
  if (error instanceof RuntimeError) {
    return { message: error.message, code: error.code, severity: error.severity, details: error.details };
  }
  if (error instanceof Error) {
    return { message: error.message, code: "runtime_error", severity: "error" };
  }
  return { message: String(error), code: "runtime_error", severity: "error" };
}
