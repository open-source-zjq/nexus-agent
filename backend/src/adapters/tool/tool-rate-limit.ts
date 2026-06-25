// Ported faithfully from the original `adapters/tool/tool-rate-limit`.
//
// Detects provider rate-limit / quota signals embedded anywhere in a tool result
// (string, array, or shallow object) and rewrites the output into a stable,
// machine-readable envelope so the agent loop can back off / retry. Detection is
// best-effort and bounded (recursion depth <= 4) so a pathological tool result
// can never blow the stack or hang the host.

/** Matches the common rate-limit / quota / HTTP-429 phrasings (case-insensitive). */
const RATE_LIMIT_RE =
  /\b(rate[-\s]?limit(?:ed|ing)?|too many requests|quota exceeded|request limit|(?:http|status)\s*:?\s*429)\b/i;

/** Extracts the numeric "retry after" hint and its optional time unit. */
const RETRY_AFTER_RE =
  /\b(?:retry[-\s]?after|try again in|wait)\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?\b/i;

/** Parsed rate-limit signal (internal, camelCase). */
export interface RateLimitSignal {
  rateLimited: true;
  message: string;
  retryAfterSeconds?: number;
}

/** The normalized envelope produced for a rate-limited tool result. */
export interface NormalizedRateLimitedOutput {
  output: unknown;
  isError: boolean;
  rateLimited: boolean;
}

/**
 * Inspect a tool result `output` for rate-limit signals. Returns a parsed signal
 * (with a compacted message and optional `retryAfterSeconds`) when one is found,
 * otherwise `null`.
 */
export function parseRateLimitedToolResult(output: unknown): RateLimitSignal | null {
  const text = collectText(output).join("\n").trim();
  if (!text || !RATE_LIMIT_RE.test(text)) return null;
  const retryAfter = parseRetryAfterSeconds(text);
  return {
    rateLimited: true,
    message: compactRateLimitMessage(text),
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
  };
}

/**
 * Normalize a tool result `output`. When a rate-limit signal is detected, rewrite
 * the output into a `{ code: "rate_limited", rate_limited: true, error, retry_after_seconds?, original }`
 * envelope and mark the result as an error. Otherwise the output passes through
 * unchanged with `isError: false`.
 */
export function normalizeRateLimitedToolOutput(output: unknown): NormalizedRateLimitedOutput {
  const parsed = parseRateLimitedToolResult(output);
  if (!parsed) return { output, isError: false, rateLimited: false };
  return {
    output: {
      code: "rate_limited",
      rate_limited: true,
      error: parsed.message,
      ...(parsed.retryAfterSeconds !== undefined ? { retry_after_seconds: parsed.retryAfterSeconds } : {}),
      original: output,
    },
    isError: true,
    rateLimited: true,
  };
}

/**
 * Recursively flatten a value into a list of text fragments, bounded to a depth
 * of 4. Scalars become their string form; object entries are rendered as
 * `key: value` for scalar children and recursed otherwise.
 */
function collectText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1));
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      out.push(`${key}: ${String(child)}`);
      continue;
    }
    out.push(...collectText(child, depth + 1));
  }
  return out;
}

/**
 * Parse a "retry after" hint into whole seconds. Handles ms / s / m units; an
 * absent unit defaults to seconds. Non-finite or negative values yield undefined.
 */
function parseRetryAfterSeconds(text: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("millisecond")) return Math.ceil(value / 1e3);
  if (unit.startsWith("m") && !unit.startsWith("ms")) return Math.ceil(value * 60);
  return Math.ceil(value);
}

/** Collapse whitespace and truncate to 360 chars (with an ellipsis) for the envelope message. */
function compactRateLimitMessage(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 360) return compact;
  return `${compact.slice(0, 357).trim()}...`;
}
