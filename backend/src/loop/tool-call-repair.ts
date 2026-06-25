import type { ToolKind } from "../contracts/items.js";

/**
 * Strengthened tool-call argument repair.
 *
 * Models frequently emit tool arguments wrapped in an extra envelope key
 * (`{ "arguments": { ... } }`), as a JSON string, fenced in markdown, or with
 * pathologically large string values. This module normalizes those shapes back
 * into a flat `Record<string, unknown>` before the loop dispatches the call.
 *
 * Pure functions only: no I/O, no clock, no global state.
 */

/** Default cap for an individual string argument value (~512KB). */
const DEFAULT_MAX_STRING_BYTES = 512 * 1024;

/** Envelope keys a model may wrap the real arguments inside (incl. "__raw"). */
const WRAPPER_KEYS = ["arguments", "args", "input", "parameters", "params", "payload", "__raw"] as const;

/**
 * Keys that are tool-call metadata rather than real arguments. Their presence
 * alongside a wrapper key does not block flattening (metadata tolerance).
 */
const TOOL_METADATA_KEYS = new Set<string>([
  "tool",
  "toolName",
  "tool_name",
  "name",
  "id",
  "callId",
  "call_id",
  "type",
]);

const TRUNCATION_MARKER = "\n...[truncated by Nexus tool argument repair]";

export interface RepairToolArgumentsOptions {
  /** Per-string byte cap before truncation. Defaults to ~512KB. */
  maxStringBytes?: number;
  /**
   * Tool side-effect surface. When `"file_change"`, large string values
   * (new_text/old_text/content edit payloads) are preserved verbatim instead
   * of being truncated.
   */
  toolKind?: ToolKind;
}

export interface RepairToolArgumentsResult {
  arguments: Record<string, unknown>;
  notes: string[];
}

/**
 * Repair tool-call arguments. Returns the normalized argument record directly
 * (drop-in replacement for the weak inlined `repairToolArguments`).
 *
 * Pass `options.toolKind` to preserve file-change payloads from truncation.
 */
export function repairDispatchToolArguments(
  args: Record<string, unknown>,
  options: RepairToolArgumentsOptions = {},
): Record<string, unknown> {
  return repairDispatchToolArgumentsDetailed(args, options).arguments;
}

/**
 * Same as {@link repairDispatchToolArguments} but also returns human-readable
 * notes describing each transformation applied (for logging/telemetry).
 */
export function repairDispatchToolArgumentsDetailed(
  raw: Record<string, unknown>,
  options: RepairToolArgumentsOptions = {},
): RepairToolArgumentsResult {
  const notes: string[] = [];
  let current = shallowCloneRecord(raw);

  const flattened = flattenWrapper(current);
  if (flattened) {
    current = flattened.arguments;
    notes.push(flattened.note);
  } else {
    const scavenged = scavengeSingleJsonString(current);
    if (scavenged) {
      current = scavenged.arguments;
      notes.push(scavenged.note);
    }
  }

  const truncated = truncateOversizedStrings(current, {
    maxStringBytes: options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
    preserveLongStrings: options.toolKind === "file_change",
  });
  if (truncated.changed) {
    current = truncated.value;
    notes.push(`truncated ${truncated.count} oversized argument string(s)`);
  }

  return { arguments: current, notes };
}

interface FlattenResult {
  arguments: Record<string, unknown>;
  note: string;
}

function shallowCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function flattenWrapper(raw: Record<string, unknown>): FlattenResult | null {
  for (const key of WRAPPER_KEYS) {
    if (!(key in raw)) continue;
    if (!canFlattenWrapper(raw, key)) continue;
    const value = raw[key];
    const parsed = valueToObject(value);
    if (!parsed) continue;
    return {
      arguments: parsed,
      note: `flattened ${key} wrapper`,
    };
  }
  return null;
}

function canFlattenWrapper(raw: Record<string, unknown>, wrapperKey: string): boolean {
  const keys = Object.keys(raw);
  if (keys.length === 1) return true;
  return keys.every((key) => key === wrapperKey || TOOL_METADATA_KEYS.has(key));
}

function scavengeSingleJsonString(raw: Record<string, unknown>): FlattenResult | null {
  const entries = Object.entries(raw);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0] ?? [];
  if (!key || typeof value !== "string") return null;
  const parsed = parseJsonishObject(value);
  if (!parsed) return null;
  return {
    arguments: parsed,
    note: `scavenged JSON object from ${key}`,
  };
}

function valueToObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return { ...value };
  if (typeof value === "string") return parseJsonishObject(value);
  return null;
}

function parseJsonishObject(text: string): Record<string, unknown> | null {
  const candidates = [
    text.trim(),
    stripMarkdownFence(text.trim()),
    extractFirstJsonObject(text),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) return { ...parsed };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

interface TruncateOptions {
  maxStringBytes: number;
  preserveLongStrings: boolean;
}

interface TruncateResult {
  value: Record<string, unknown>;
  changed: boolean;
  count: number;
}

interface TruncateState {
  changed: boolean;
  count: number;
}

function truncateOversizedStrings(
  value: Record<string, unknown>,
  options: TruncateOptions,
): TruncateResult {
  if (options.preserveLongStrings) return { value, changed: false, count: 0 };
  const state: TruncateState = { changed: false, count: 0 };
  const next = truncateValue(value, options.maxStringBytes, state);
  return {
    value: isPlainObject(next) ? next : value,
    changed: state.changed,
    count: state.count,
  };
}

function truncateValue(value: unknown, maxBytes: number, state: TruncateState): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    state.changed = true;
    state.count += 1;
    return `${sliceUtf8(value, maxBytes)}${TRUNCATION_MARKER}`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, maxBytes, state));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = truncateValue(child, maxBytes, state);
  }
  return out;
}

function stripMarkdownFence(text: string): string {
  const fence = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fence?.[1]?.trim() ?? text;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function sliceUtf8(value: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const char of value) {
    const next = Buffer.byteLength(char, "utf8");
    if (used + next > maxBytes) break;
    out += char;
    used += next;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
