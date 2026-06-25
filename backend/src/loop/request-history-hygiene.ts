import type { ModelHistoryItem } from "../ports/model-client.js";

/**
 * Request-history hygiene pass.
 *
 * A pure transform that trims a provider-agnostic conversation history before it
 * is handed to a model client. It does three things:
 *
 *  1. Strips/omits large base64 blobs (data: URIs and long base64-shaped runs)
 *     from tool_result outputs, replacing them with a short marker.
 *  2. Shrinks already-paired tool_call arguments: when a matching tool_result
 *     exists later in the history, the call's verbose argument strings can be
 *     reduced to a short preview, since the model can read the result instead.
 *  3. Compacts tool_result text (collapses repeats, drops low-signal lines, and
 *     fits the remainder into byte/line/token budgets).
 *
 * The function is pure: it never mutates the input and always returns a fresh
 * array (a new array even when nothing changed, for caller convenience).
 */

export interface RequestHistoryHygieneOptions {
  maxToolResultLines?: number;
  maxToolResultBytes?: number;
  maxToolResultTokens?: number;
  maxToolArgumentStringBytes?: number;
  maxToolArgumentStringTokens?: number;
  maxArrayItems?: number;
}

export interface RequestHistoryHygieneResult {
  history: ModelHistoryItem[];
  /** Number of base64 blobs stripped from tool_result outputs. */
  strippedBase64: number;
  /** Number of tool_call argument strings shrunk (paired with a later result). */
  shrunkArgs: number;
}

const DEFAULT_MAX_TOOL_RESULT_LINES = 320;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024;
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8_000;
const DEFAULT_MAX_TOOL_ARGUMENT_STRING_BYTES = 8 * 1024;
const DEFAULT_MAX_TOOL_ARGUMENT_STRING_TOKENS = 2_000;
const DEFAULT_MAX_ARRAY_ITEMS = 80;
const MAX_SIGNAL_LINES = 48;
const MAX_LINE_CHARS = 280;
const LONG_ARGUMENT_PREVIEW_CHARS = 160;

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SIGNAL_LINE_RE =
  /\b(error|failed?|fatal|panic|exception|traceback|warning|warn|denied|timeout|timed out|not found|cannot|invalid)\b/i;
const BASE64_KEY_RE = /(?:^|_)(?:data_)?base64$/i;
const DATA_URL_RE = /^data:[^;,]+;base64,/i;

interface Limits {
  maxToolResultLines: number;
  maxToolResultBytes: number;
  maxToolResultTokens: number;
  maxToolArgumentStringBytes: number;
  maxToolArgumentStringTokens: number;
  maxArrayItems: number;
}

interface CompactedValue {
  value: unknown;
  changed: boolean;
  /** base64 blobs stripped while producing this value. */
  strippedBase64: number;
}

interface Budget {
  maxBytes: number;
  maxTokens: number;
}

interface ArgumentOptions {
  toolName: string;
  maxStringBytes: number;
  maxStringTokens: number;
  maxArrayItems: number;
}

interface CompactedArgs {
  value: Record<string, unknown>;
  changed: boolean;
  /** count of argument strings shrunk into a preview marker. */
  shrunk: number;
}

interface CompactedArgValue {
  value: unknown;
  changed: boolean;
  shrunk: number;
}

/**
 * Run the hygiene pass over a model history. Returns a new array plus counters
 * for how much was stripped/shrunk. Pure: the input array and its items are
 * never mutated.
 */
export function applyRequestHistoryHygiene(
  history: ModelHistoryItem[],
  options: RequestHistoryHygieneOptions = {},
): RequestHistoryHygieneResult {
  const limits = normalizeOptions(options);
  const pairedToolCallIds = new Set(
    history
      .filter((item): item is Extract<ModelHistoryItem, { kind: "tool_result" }> => item.kind === "tool_result")
      .map((item) => item.callId),
  );

  let strippedBase64 = 0;
  let shrunkArgs = 0;

  const next = history.map((item): ModelHistoryItem => {
    if (item.kind === "tool_result") {
      const output = compactToolResultOutput(item.output, limits);
      strippedBase64 += output.strippedBase64;
      if (!output.changed) return item;
      return { ...item, output: output.value };
    }
    if (item.kind === "tool_call" && pairedToolCallIds.has(item.callId)) {
      const args = compactCompletedToolArguments(item.arguments, {
        toolName: item.toolName,
        maxStringBytes: limits.maxToolArgumentStringBytes,
        maxStringTokens: limits.maxToolArgumentStringTokens,
        maxArrayItems: limits.maxArrayItems,
      });
      shrunkArgs += args.shrunk;
      if (!args.changed) return item;
      return { ...item, arguments: args.value };
    }
    return item;
  });

  return { history: next, strippedBase64, shrunkArgs };
}

function normalizeOptions(options: RequestHistoryHygieneOptions): Limits {
  return {
    maxToolResultLines: Math.max(1, Math.floor(options.maxToolResultLines ?? DEFAULT_MAX_TOOL_RESULT_LINES)),
    maxToolResultBytes: Math.max(512, Math.floor(options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES)),
    maxToolResultTokens: Math.max(128, Math.floor(options.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS)),
    maxToolArgumentStringBytes: Math.max(
      512,
      Math.floor(options.maxToolArgumentStringBytes ?? DEFAULT_MAX_TOOL_ARGUMENT_STRING_BYTES),
    ),
    maxToolArgumentStringTokens: Math.max(
      128,
      Math.floor(options.maxToolArgumentStringTokens ?? DEFAULT_MAX_TOOL_ARGUMENT_STRING_TOKENS),
    ),
    maxArrayItems: Math.max(1, Math.floor(options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS)),
  };
}

function compactToolResultOutput(output: unknown, limits: Limits): CompactedValue {
  return compactToolResultValue(output, "", limits);
}

function compactToolResultValue(value: unknown, key: string, limits: Limits): CompactedValue {
  if (typeof value === "string") {
    if (shouldOmitBase64(key, value)) {
      return {
        value: `[cache hygiene: omitted base64 data, ${formatBytes(Buffer.byteLength(value, "utf8"))}]`,
        changed: true,
        strippedBase64: 1,
      };
    }
    const text = compactToolResultText(value, limits);
    return { value: text.value, changed: text.changed, strippedBase64: 0 };
  }
  if (Array.isArray(value)) {
    return compactArray(value, limits);
  }
  if (!isRecord(value)) return { value, changed: false, strippedBase64: 0 };

  let changed = false;
  let strippedBase64 = 0;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const child = compactToolResultValue(childValue, childKey, limits);
    out[childKey] = child.value;
    changed ||= child.changed;
    strippedBase64 += child.strippedBase64;
  }
  return changed ? { value: out, changed: true, strippedBase64 } : { value, changed: false, strippedBase64 };
}

function compactArray(values: unknown[], limits: Limits): CompactedValue {
  const keepHead = Math.max(1, Math.floor(limits.maxArrayItems * 0.75));
  const keepTail = Math.max(0, limits.maxArrayItems - keepHead);
  const tail = keepTail > 0 ? values.slice(values.length - keepTail) : [];
  const selected: unknown[] =
    values.length > limits.maxArrayItems
      ? [
          ...values.slice(0, keepHead),
          { cache_hygiene_omitted_items: values.length - limits.maxArrayItems },
          ...tail,
        ]
      : values;

  let changed = selected !== values;
  let strippedBase64 = 0;
  const out = selected.map((value) => {
    const compacted = compactToolResultValue(value, "", limits);
    changed ||= compacted.changed;
    strippedBase64 += compacted.strippedBase64;
    return compacted.value;
  });
  return changed
    ? { value: out, changed: true, strippedBase64 }
    : { value: values, changed: false, strippedBase64 };
}

function compactToolResultText(text: string, limits: Limits): { value: string; changed: boolean } {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const originalLines = countLines(text);
  const originalTokens = estimateTokens(text);
  if (
    originalBytes <= limits.maxToolResultBytes &&
    originalLines <= limits.maxToolResultLines &&
    originalTokens <= limits.maxToolResultTokens
  ) {
    return { value: text, changed: false };
  }

  const normalized = normalizeTextBlock(text);
  const lines = normalized ? normalized.split("\n") : [];
  const selected = selectCacheUsefulLines(lines, limits.maxToolResultLines);
  const omittedBytes = Math.max(0, originalBytes - Buffer.byteLength(selected.join("\n"), "utf8"));
  const selectedTokens = estimateTokens(selected.join("\n"));
  const omittedTokens = Math.max(0, originalTokens - selectedTokens);
  const marker = [
    `[cache hygiene: omitted ${Math.max(0, lines.length - selected.length)} line(s), `,
    `${formatBytes(omittedBytes)}, approx ${omittedTokens} token(s); use narrower read/grep/bash ranges for details]`,
  ].join("");
  const budgetForText = Math.max(0, limits.maxToolResultBytes - Buffer.byteLength(marker, "utf8") - 1);
  const budgetForTokens = Math.max(0, limits.maxToolResultTokens - estimateTokens(marker) - 1);
  const fitted = fitLinesToBudget(selected.map(compactLine), {
    maxBytes: budgetForText,
    maxTokens: budgetForTokens,
  });
  return {
    value: [...fitted, marker].join("\n"),
    changed: true,
  };
}

function selectCacheUsefulLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  const indexes = new Set<number>();
  const headCount = Math.min(80, Math.max(1, Math.floor(maxLines * 0.25)));
  const tailCount = Math.min(120, Math.max(1, Math.floor(maxLines * 0.35)));
  for (let index = 0; index < Math.min(headCount, lines.length); index += 1) {
    indexes.add(index);
  }
  for (let index = Math.max(0, lines.length - tailCount); index < lines.length; index += 1) {
    indexes.add(index);
  }
  let signalCount = 0;
  for (let index = 0; index < lines.length && indexes.size < maxLines; index += 1) {
    if (!SIGNAL_LINE_RE.test(lines[index] ?? "")) continue;
    indexes.add(index);
    signalCount += 1;
    if (signalCount >= MAX_SIGNAL_LINES) break;
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((index) => lines[index] ?? "");
}

function compactCompletedToolArguments(
  args: Record<string, unknown>,
  options: ArgumentOptions,
): CompactedArgs {
  let changed = false;
  let shrunk = 0;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const compacted = compactArgumentValue(value, key, options);
    out[key] = compacted.value;
    changed ||= compacted.changed;
    shrunk += compacted.shrunk;
  }
  return changed ? { value: out, changed: true, shrunk } : { value: args, changed: false, shrunk };
}

function compactArgumentValue(value: unknown, key: string, options: ArgumentOptions): CompactedArgValue {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    const tokens = estimateTokens(value);
    if (bytes <= options.maxStringBytes && tokens <= options.maxStringTokens) {
      return { value, changed: false, shrunk: 0 };
    }
    const preview = value.slice(0, LONG_ARGUMENT_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
    const suffix = preview ? ` preview=${JSON.stringify(preview)}` : "";
    return {
      value: `[cache hygiene: omitted completed ${options.toolName}.${key} argument, ${formatBytes(bytes)}, approx ${tokens} token(s), ${countLines(value)} line(s); see following tool result]${suffix}`,
      changed: true,
      shrunk: 1,
    };
  }
  if (Array.isArray(value)) {
    if (value.length <= options.maxArrayItems) {
      let changed = false;
      let shrunk = 0;
      const out = value.map((child) => {
        const compacted = compactArgumentValue(child, key, options);
        changed ||= compacted.changed;
        shrunk += compacted.shrunk;
        return compacted.value;
      });
      return changed ? { value: out, changed: true, shrunk } : { value, changed: false, shrunk };
    }
    return {
      value: [
        ...value.slice(0, Math.max(1, options.maxArrayItems - 1)),
        { cache_hygiene_omitted_items: value.length - options.maxArrayItems },
      ],
      changed: true,
      shrunk: 0,
    };
  }
  if (!isRecord(value)) return { value, changed: false, shrunk: 0 };

  let changed = false;
  let shrunk = 0;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const compacted = compactArgumentValue(childValue, childKey, options);
    out[childKey] = compacted.value;
    changed ||= compacted.changed;
    shrunk += compacted.shrunk;
  }
  return changed ? { value: out, changed: true, shrunk } : { value, changed: false, shrunk };
}

function shouldOmitBase64(key: string, value: string): boolean {
  return value.length > 256 && (BASE64_KEY_RE.test(key) || DATA_URL_RE.test(value));
}

function normalizeTextBlock(text: string): string {
  const stripped = text.replace(/\r\n/g, "\n").replace(ANSI_RE, "");
  const lines = stripped.split("\n").map((line) => line.trimEnd());
  const out: string[] = [];
  let blankRun = 0;
  let previous = "";
  let repeatCount = 0;
  const flushRepeat = () => {
    if (repeatCount > 1) out.push(`[previous line repeated ${repeatCount - 1} time(s)]`);
    repeatCount = 0;
  };
  for (const line of lines) {
    if (!line.trim()) {
      flushRepeat();
      blankRun += 1;
      if (blankRun <= 2) out.push("");
      previous = "";
      continue;
    }
    blankRun = 0;
    if (line === previous) {
      repeatCount += 1;
      continue;
    }
    flushRepeat();
    out.push(line);
    previous = line;
    repeatCount = 1;
  }
  flushRepeat();
  return out.join("\n").trim();
}

function fitLinesToBudget(lines: string[], budget: Budget): string[] {
  const out: string[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0);
    const lineTokens = estimateTokens(line) + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > budget.maxBytes || tokens + lineTokens > budget.maxTokens) break;
    out.push(line);
    bytes += lineBytes;
    tokens += lineTokens;
  }
  if (out.length === 0 && lines.length > 0 && budget.maxBytes > 0 && budget.maxTokens > 0) {
    out.push(truncateStringToBudget(lines[0] ?? "", budget));
  }
  return out;
}

function compactLine(line: string): string {
  const trimmed = line.trimEnd();
  if (trimmed.length <= MAX_LINE_CHARS) return trimmed;
  const head = Math.floor(MAX_LINE_CHARS * 0.6);
  const tail = Math.max(0, MAX_LINE_CHARS - head - 5);
  return `${trimmed.slice(0, head).trimEnd()} ... ${trimmed.slice(-tail).trimStart()}`;
}

function truncateStringToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function truncateStringToBudget(text: string, budget: Budget): string {
  let out = "";
  let bytes = 0;
  let tokens = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    const charTokens = estimateTokens(char);
    if (bytes + charBytes > budget.maxBytes || tokens + charTokens > budget.maxTokens) break;
    out += char;
    bytes += charBytes;
    tokens += charTokens;
  }
  return out || truncateStringToBytes(text, budget.maxBytes);
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiRun = 0;
  let tokens = 0;
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };
  for (const char of text) {
    if (char.charCodeAt(0) <= 127) {
      asciiRun += 1;
      continue;
    }
    flushAscii();
    tokens += isCombiningMark(char) ? 0 : 1;
  }
  flushAscii();
  return Math.max(1, tokens);
}

function isCombiningMark(char: string): boolean {
  return /[̀-ͯ︀-️]/u.test(char);
}
