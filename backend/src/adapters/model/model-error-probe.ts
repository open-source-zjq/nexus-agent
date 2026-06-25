/**
 * Provider-agnostic model error classifier.
 *
 * Maps raw HTTP responses and fetch/network failures from any OpenAI-/Anthropic-
 * compatible model endpoint into a small, stable set of normalized error codes so
 * upstream callers can decide retry/auth/abort behavior without knowing which
 * provider produced the failure. Pure functions, node builtins only.
 */

/** Normalized model error classification shared by HTTP and network paths. */
export interface ClassifiedModelError {
  /** Stable machine-readable code, e.g. "model_unauthorized". */
  code: string;
  /** Concise human-readable message (truncated to ~400 chars). */
  message: string;
  /** Whether retrying the same request could plausibly succeed. */
  retriable: boolean;
}

const MESSAGE_MAX_LENGTH = 400;

/**
 * Classify a non-OK HTTP response from a model endpoint into the original's
 * generic, model-AGNOSTIC code set (http_404 / rate_limited / http_${status}),
 * mirroring the upstream classifyHttpError mapping byte-for-byte.
 *
 * - 404   -> http_404        (Base URL / endpoint-format hint appended)
 * - 429   -> rate_limited
 * - other -> http_${status}  (raw body echoed)
 *
 * NOTE: The upstream classifier additionally ran a 5xx reachability probe
 * (probeNexusReachable / isNexusHost emitting nexus_http_${status} /
 * nexus_unreachable) gated on Nexus hosts. The brand-gated form is dropped, but
 * the capability is restored in GENERICIZED form (T12.8) via
 * {@link classifyModelHttpErrorWithProbe}, which on any 5xx probes the host and
 * emits `model_host_unreachable` when the endpoint itself is unreachable rather
 * than a generic `http_${status}`. This sync function keeps the probe-free
 * mapping for callers that lack a base URL.
 *
 * `providerId` is accepted for call-site compatibility but, like the original
 * classifyHttpError, is not woven into the user-facing message text.
 */
export function classifyModelHttpError(input: {
  status: number;
  body: string;
  providerId: string;
}): ClassifiedModelError {
  const { status, body } = input;

  if (status === 404) {
    const prefix = body ? `${body} ` : "";
    return {
      code: "http_404",
      message: `model request failed with status 404: ${prefix}Check your model provider configuration, especially Base URL and Endpoint format.`,
      retriable: false,
    };
  }

  if (status === 429) {
    return {
      code: "rate_limited",
      message: `model request was rate limited (HTTP 429): ${body}`,
      retriable: true,
    };
  }

  return {
    code: `http_${status}`,
    message: `model request failed with status ${status}: ${body}`,
    retriable: status >= 500,
  };
}

/** Result of a model-host reachability probe. */
export interface ModelHostReachability {
  reachable: boolean;
  status?: number;
  message: string;
}

/**
 * Derive a lightweight reachability-probe URL from a model base URL: strip a
 * trailing `/`, drop a trailing `beta` or `vN` path segment, then append
 * `/v1/models` (the conventional model-list endpoint). Returns null when the
 * base URL is empty or unparseable. Genericized from the original `probeUrl`
 * (whose empty/invalid fallback pointed at a Nexus host — dropped here).
 */
export function modelProbeUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts.at(-1)?.toLowerCase() ?? "";
    if (last === "beta" || /^v\d+$/i.test(last)) parts.pop();
    url.pathname = `/${[...parts, "v1", "models"].join("/")}`;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Probe whether a model host is reachable, used to refine a 5xx classification.
 * Genericized from the original `probeNexusReachable` (the `isNexusHost` gate is
 * removed): GET the derived probe URL; `reachable` iff the probe itself answers
 * below 500. A thrown error (DNS/connect/TLS/timeout) is reported unreachable.
 */
export async function probeModelHostReachable(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelHostReachability> {
  const url = modelProbeUrl(input.baseUrl);
  if (!url) return { reachable: false, message: "model endpoint base URL is empty or invalid." };
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
    });
    return {
      reachable: response.status < 500,
      status: response.status,
      message:
        response.status < 500
          ? `model endpoint is reachable (probe status ${response.status}).`
          : `model endpoint probe also returned ${response.status}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      message: `model endpoint probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Async variant of {@link classifyModelHttpError} that, on a 5xx, runs a host
 * reachability probe so an unreachable endpoint produces a specific
 * `model_host_unreachable` code instead of a generic `http_${status}`. Non-5xx
 * (and 5xx without a base URL) fall straight through to the sync classifier.
 * The genericized restoration of the original's nexus_http_/nexus_unreachable
 * 5xx probe (T12.8).
 */
export async function classifyModelHttpErrorWithProbe(input: {
  status: number;
  body: string;
  providerId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClassifiedModelError> {
  const base = classifyModelHttpError(input);
  if (input.status < 500 || !input.baseUrl) return base;
  const probe = await probeModelHostReachable({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });
  if (!probe.reachable) {
    return {
      code: "model_host_unreachable",
      message: `model request failed with status ${input.status}: ${input.body}\n${probe.message}`,
      retriable: true,
    };
  }
  // Reachable: keep the original status mapping but annotate with the probe.
  return { ...base, message: `${base.message}\n${probe.message}` };
}

/**
 * Classify a thrown error from a fetch/stream attempt that never produced an
 * HTTP response (DNS failure, connection refused/reset, TLS error, or abort).
 *
 * - AbortError / aborted signal -> aborted            (not retriable)
 * - DNS / ECONN* / network      -> model_unreachable  (retriable)
 * - anything else               -> model_request_failed (retriable)
 */
export function classifyModelRequestError(error: unknown, providerId: string): ClassifiedModelError {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "model request was aborted",
      retriable: false,
    };
  }

  const raw = errorMessage(error);
  if (isUnreachableError(error, raw)) {
    return {
      code: "model_unreachable",
      message: compose(`could not reach model provider "${providerId}"`, raw),
      retriable: true,
    };
  }

  return {
    code: "model_request_failed",
    message: compose(`model request to provider "${providerId}" failed`, raw),
    retriable: true,
  };
}

// --- Helpers ----------------------------------------------------------------

/**
 * Pull a concise message out of common provider error body shapes:
 *   { error: { message } } | { error: "..." } | { message } | plain text.
 * Returns an empty string when nothing useful can be extracted.
 */
export function extractProviderMessage(body: string): string {
  const text = typeof body === "string" ? body.trim() : "";
  if (text.length === 0) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — treat the raw text as the message.
    return truncate(text);
  }

  const fromShape = messageFromShape(parsed);
  if (fromShape) return truncate(fromShape);

  // JSON, but an unrecognized shape: fall back to the serialized form.
  return truncate(text);
}

function messageFromShape(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;

  const err = obj.error;
  if (typeof err === "string" && err.trim().length > 0) return err.trim();
  if (err && typeof err === "object") {
    const nested = (err as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  }

  const message = obj.message;
  if (typeof message === "string" && message.trim().length > 0) return message.trim();

  const detail = obj.detail;
  if (typeof detail === "string" && detail.trim().length > 0) return detail.trim();

  return "";
}

function compose(prefix: string, detail: string): string {
  if (!detail) return truncate(prefix);
  return truncate(`${prefix}: ${detail}`);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "ABORT_ERR") return true;
  }
  return /\baborted\b/i.test(errorMessage(error));
}

/**
 * Heuristically detect DNS/connection-level failures across Node's error codes
 * and the opaque "fetch failed" wrapper undici throws (the real cause lives in
 * `error.cause`).
 */
function isUnreachableError(error: unknown, message: string): boolean {
  const codes = new Set<string>();
  collectErrorCodes(error, codes, 0);

  for (const code of codes) {
    if (
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "EPIPE" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET" ||
      code.startsWith("CERT_") ||
      code.startsWith("ERR_TLS")
    ) {
      return true;
    }
  }

  return (
    /fetch failed/i.test(message) ||
    /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)/i.test(message) ||
    /getaddrinfo|network|dns|socket hang up|connect/i.test(message)
  );
}

function collectErrorCodes(error: unknown, out: Set<string>, depth: number): void {
  if (!error || typeof error !== "object" || depth > 4) return;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") out.add(code);
  const cause = (error as { cause?: unknown }).cause;
  if (cause) collectErrorCodes(cause, out, depth + 1);
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const nested of errors) collectErrorCodes(nested, out, depth + 1);
  }
}
