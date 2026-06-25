/**
 * Deep, recursive secret redaction for config and diagnostics.
 *
 * Ported from the original `config/secret-redaction.js`: walks nested
 * objects/arrays and masks any value whose KEY looks secret
 * (apiKey/token/authorization/secret/password/bearer/client-secret), and also
 * scrubs inline `key=value` / `Bearer xxx` fragments inside string values.
 *
 * The replacement sentinel is configurable (defaults to the original
 * `<redacted>`) so callers that need a round-trippable mask (the UI relies on
 * `MASKED_SECRET`) can supply their own.
 */

export const DEFAULT_REDACTED_SECRET = "<redacted>";

const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|client[-_]?secret|password|secret|token)/i;

const secretTextPatterns = (): RegExp[] => [
  /\b(authorization|api[-_]?key|client[-_]?secret|password|token)\s*[:=]\s*((?:Bearer\s+)?[^\s,;]+)/gi,
  /\bbearer\s+([^\s,;]+)/gi,
];

/** Return a deep copy of `value` with secret-looking fields/fragments masked. */
export function redactSecrets<T>(value: T, redacted: string = DEFAULT_REDACTED_SECRET): T {
  return redact(value, "", redacted) as T;
}

function redact(value: unknown, key: string, redacted: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, "", redacted));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (SECRET_KEY_PATTERN.test(key)) return redacted;
    return redactSecretText(value, redacted);
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    // A secret-looking key masks its value wholesale (including an empty string).
    out[childKey] = SECRET_KEY_PATTERN.test(childKey) ? redacted : redact(childValue, childKey, redacted);
  }
  return out;
}

function redactSecretText(value: string, redacted: string): string {
  return secretTextPatterns().reduce(
    (current, pattern) =>
      current.replace(pattern, (match, capturedKey) =>
        match.toLowerCase().startsWith("bearer ") ? `Bearer ${redacted}` : `${capturedKey}=${redacted}`,
      ),
    value,
  );
}
