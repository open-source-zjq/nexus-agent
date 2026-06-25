import type { NexusErrorCode } from "../contracts/errors.js";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Build a structured error body with a canonical {@link NexusErrorCode}. */
function errorResponse(code: NexusErrorCode, message: string, status: number, details?: unknown): Response {
  return jsonResponse({ code, message, ...(details !== undefined ? { details } : {}) }, status);
}

export const ERRORS = {
  validation(message: string, details?: unknown): Response {
    return errorResponse("validation_error", message, 400, details);
  },
  notFound(message = "not found"): Response {
    return errorResponse("not_found", message, 404);
  },
  conflict(message: string): Response {
    return errorResponse("conflict", message, 409);
  },
  unauthorized(): Response {
    return errorResponse("unauthorized", "missing or invalid bearer token", 401);
  },
  forbidden(message: string): Response {
    return errorResponse("forbidden", message, 403);
  },
  /** Capability/provider switched off or otherwise not usable right now. */
  unavailable(message: string): Response {
    return errorResponse("capability_unavailable", message, 503);
  },
  /** Attachment upload/download payload failed validation. */
  attachmentValidation(message: string, details?: unknown): Response {
    return errorResponse("attachment_validation_failed", message, 400, details);
  },
  /** Review/workspace operation requires a Git repository workspace. */
  workspaceNotGit(message: string, details?: unknown): Response {
    return errorResponse("workspace_not_git", message, 400, details);
  },
  /** A surface that exists but is intentionally not implemented in this build. */
  notImplemented(message: string): Response {
    return errorResponse("not_implemented", message, 501);
  },
  internal(message: string): Response {
    return errorResponse("internal_error", message, 500);
  },
};

/**
 * Raw binary/text content response with an explicit MIME type. Used to stream
 * stored attachment bytes back to the client with their original content type.
 */
export function binaryResponse(body: Uint8Array | ArrayBuffer, mimeType: string, status = 200): Response {
  const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body);
  return new Response(bytes, {
    status,
    headers: { "content-type": mimeType || "application/octet-stream" },
  });
}

export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text().catch(() => "");
  if (!text || text.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, response: ERRORS.validation("invalid JSON body", (error as Error).message) };
  }
}
