import type { ModelHistoryItem, ModelRequest, ToolSpec } from "../ports/model-client.js";

/**
 * Token-economy compression for canonical {@link ModelHistoryItem} history.
 *
 * Ported from Nexus's `loop/token-economy.js`. This is a PURE transform: it
 * never mutates the input array or its items; it returns a NEW array plus an
 * accounting of how many characters were saved.
 *
 * Two compaction surfaces are handled:
 *   - `tool_result.output`  — oversized command / file / search output is
 *     head/tail/signal-line trimmed and per-line clipped, with an explicit
 *     "[token economy: …]" marker so the model knows content was omitted.
 *   - `tool_call.arguments` — oversized string argument blobs are head-trimmed.
 *
 * Prose-protected compression (`withProtectedSegments` + `compressProse`) is
 * preserved exactly: fenced code, inline code, URLs, paths, CONSTANT_CASE
 * identifiers, dotted calls, function-call shapes and version numbers are
 * extracted, never rewritten, then re-inserted verbatim.
 */

// --- Budgets (mirrors the original constants) -------------------------------

const MAX_COMMAND_LINES = 180;
const MAX_COMMAND_BYTES = 24 * 1024;
const MAX_READ_LINES = 320;
const MAX_READ_BYTES = 32 * 1024;
const MAX_GENERIC_TEXT_LINES = 220;
const MAX_GENERIC_TEXT_BYTES = 24 * 1024;
const MAX_GREP_MATCHES = 80;
const MAX_FIND_MATCHES = 160;
const MAX_LS_ENTRIES = 120;
const MAX_ARRAY_ITEMS = 80;
const MAX_LINE_CHARS = 260;

/** A string argument blob on a tool call is trimmed once it exceeds this. */
const MAX_ARG_TEXT_LINES = 220;
const MAX_ARG_TEXT_BYTES = 24 * 1024;

const ESC = String.fromCharCode(27);
const PROTECTED_SEGMENT_PREFIX = "__NEXUS_PROTECTED_SEGMENT_";
const PROTECTED_SEGMENT_SUFFIX = "__";

const SIGNAL_LINE_RE =
  /\b(error|failed?|fatal|panic|exception|traceback|warning|warn|denied|timeout|timed out|not found|cannot|invalid)\b/i;
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const FILLERS_RE = /\b(?:just|really|basically|actually|simply|quite|very|essentially|literally|generally)\b/gi;
const PLEASANTRIES_RE =
  /\b(?:please|kindly|thank you|thanks|sure|certainly|of course|happy to|i'?d be happy)\b[,.]?\s*/gi;
const HEDGES_RE =
  /\b(?:perhaps|maybe|might|could potentially|would like to|i think|in my opinion|it seems|it appears)\b\s*/gi;
const LEADERS_RE = /^(?:i'?ll|i will|i can|i'?d|you can|we will|we can|let me|let'?s)\s+/gim;
const ARTICLES_RE = /\b(?:a|an|the)\s+(?=[a-z])/gi;

const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\bhttps?:\/\/\S+/gi,
  /\b[\w.-]*[/\\][\w./\\-]+/g,
  /\b[A-Z][A-Za-z0-9]*(?:_[A-Z][A-Za-z0-9]*)+\b/g,
  /\b\w+\.\w+(?:\.\w+)*\(\)?/g,
  /[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g,
  /\b\d+\.\d+\.\d+\b/g,
];

// --- Public API -------------------------------------------------------------

export interface TokenEconomyOptions {
  /**
   * Compact oversized tool-result output (command/file/search blobs).
   * Defaults to `true`.
   */
  compressToolResults?: boolean;
  /**
   * Compact oversized string blobs inside `tool_call.arguments`.
   * Defaults to `true`.
   */
  compressToolArguments?: boolean;
  /**
   * Apply prose compression to assistant text / reasoning items.
   * Disabled by default to keep user-facing prose untouched unless requested.
   */
  compressAssistantProse?: boolean;
}

export interface TokenEconomyResult {
  history: ModelHistoryItem[];
  savedChars: number;
}

const DEFAULT_OPTIONS: Required<TokenEconomyOptions> = {
  compressToolResults: true,
  compressToolArguments: true,
  compressAssistantProse: false,
};

/**
 * Returns a NEW history array with oversized tool output / argument blobs and
 * (optionally) assistant prose compacted, plus the total characters saved.
 * The input array and its items are never mutated.
 */
export function applyTokenEconomy(
  history: ModelHistoryItem[],
  opts?: TokenEconomyOptions,
): TokenEconomyResult {
  const options = { ...DEFAULT_OPTIONS, ...(opts ?? {}) };
  const before = measureHistoryChars(history);
  const next = history.map((item) => compactHistoryItem(item, options));
  const after = measureHistoryChars(next);
  return { history: next, savedChars: Math.max(0, before - after) };
}

// --- Request-level token economy --------------------------------------------

/**
 * Request-level token-economy configuration. Ported from Nexus's
 * `loop/token-economy.js`. When `enabled`, the per-gate flags decide which
 * compression surfaces are applied to a whole {@link ModelRequest}:
 *   - `compressToolDescriptions` — compress tool `description` + schema
 *     `description` fields.
 *   - `compressToolResults` — compress oversized tool-result output blobs and
 *     user_input question/option prose in history.
 *   - `conciseResponses` — append {@link TOKEN_ECONOMY_INSTRUCTION} to context.
 *   - `historyHygiene` — opaque bag forwarded to the request history hygiene
 *     pass (gated by the loop).
 */
export interface TokenEconomyConfig {
  enabled?: boolean;
  compressToolDescriptions?: boolean;
  compressToolResults?: boolean;
  conciseResponses?: boolean;
  historyHygiene?: Record<string, unknown>;
}

export const DEFAULT_TOKEN_ECONOMY_CONFIG: Required<TokenEconomyConfig> = {
  enabled: false,
  compressToolDescriptions: true,
  compressToolResults: true,
  conciseResponses: true,
  historyHygiene: {},
};

export const TOKEN_ECONOMY_INSTRUCTION = [
  "Token economy mode is enabled.",
  "Reply concisely: answer directly, skip pleasantries, filler, and hedging.",
  "Preserve exact code, commands, paths, URLs, identifiers, and quoted errors.",
  "When tool output says content was omitted, use narrower read/grep/bash ranges instead of guessing.",
].join("\n");

/** Merge a partial config over the defaults (deep-merging `historyHygiene`). */
export function normalizeTokenEconomyConfig(
  input?: TokenEconomyConfig,
): Required<TokenEconomyConfig> {
  return {
    ...DEFAULT_TOKEN_ECONOMY_CONFIG,
    ...(input ?? {}),
    historyHygiene: {
      ...DEFAULT_TOKEN_ECONOMY_CONFIG.historyHygiene,
      ...(input?.historyHygiene ?? {}),
    },
  };
}

/**
 * Apply request-level token economy to a {@link ModelRequest}. PURE: returns a
 * NEW request when enabled, otherwise the input unchanged. Each surface is gated
 * by its config flag. History hygiene is applied separately by the loop using
 * `config.historyHygiene`.
 */
export function applyTokenEconomyToRequest(
  request: ModelRequest,
  config?: TokenEconomyConfig,
): ModelRequest {
  const economy = normalizeTokenEconomyConfig(config);
  if (!economy.enabled) return request;
  return {
    ...request,
    contextInstructions: economy.conciseResponses
      ? [...(request.contextInstructions ?? []), TOKEN_ECONOMY_INSTRUCTION]
      : request.contextInstructions,
    tools: economy.compressToolDescriptions ? request.tools.map(compactToolSpec) : request.tools,
    history: economy.compressToolResults
      ? request.history.map(compactRequestHistoryItem)
      : request.history,
  };
}

/** Compress a tool spec's description and its schema `description` fields. */
export function compactToolSpec(tool: ToolSpec): ToolSpec {
  return {
    ...tool,
    description: compressProse(tool.description),
    inputSchema: compactSchemaDescriptions(tool.inputSchema) as Record<string, unknown>,
  };
}

/** Recursively compress every `description` string field in a JSON schema. */
export function compactSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchemaDescriptions);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      key === "description" && typeof child === "string"
        ? compressProse(child)
        : compactSchemaDescriptions(child);
  }
  return out;
}

/**
 * Request-level history-item compaction (token-economy `compressToolResults`).
 * Mirrors the original `compactHistoryItem`: tool-result output is compacted and
 * — where the canonical history union carries questions/options prose — that
 * prose is compressed too. The input item is never mutated.
 */
function compactRequestHistoryItem(item: ModelHistoryItem): ModelHistoryItem {
  // Faithful to the original `user_input` case: compress the prompt question and
  // each option's description. The canonical ModelHistoryItem union in this
  // codebase does not carry `user_input`, so this is a defensive, structural
  // check that becomes a no-op for that shape (and active if a future history
  // item ever carries questions/options prose).
  const withQuestions = item as unknown as {
    kind?: string;
    questions?: Array<{ question?: string; options?: Array<{ description?: string }> }>;
  };
  if (withQuestions.kind === "user_input" && Array.isArray(withQuestions.questions)) {
    return {
      ...item,
      questions: withQuestions.questions.map((question) => ({
        ...question,
        question: typeof question.question === "string" ? compressProse(question.question) : question.question,
        options: Array.isArray(question.options)
          ? question.options.map((option) => ({
              ...option,
              description:
                typeof option.description === "string" ? compressProse(option.description) : option.description,
            }))
          : question.options,
      })),
    } as unknown as ModelHistoryItem;
  }
  if (item.kind === "tool_result") {
    const output = compactToolOutput(item.toolName, item.output);
    return output === item.output ? item : { ...item, output };
  }
  return item;
}

// --- History item dispatch --------------------------------------------------

function compactHistoryItem(
  item: ModelHistoryItem,
  options: Required<TokenEconomyOptions>,
): ModelHistoryItem {
  switch (item.kind) {
    case "tool_result": {
      if (!options.compressToolResults) return item;
      const output = compactToolOutput(item.toolName, item.output);
      return output === item.output ? item : { ...item, output };
    }
    case "tool_call": {
      if (!options.compressToolArguments) return item;
      const args = compactArguments(item.arguments);
      return args === item.arguments ? item : { ...item, arguments: args };
    }
    case "assistant_text":
    case "assistant_reasoning": {
      if (!options.compressAssistantProse) return item;
      const text = compressProse(item.text);
      return text === item.text ? item : { ...item, text };
    }
    default:
      return item;
  }
}

// --- Tool-call argument compaction ------------------------------------------

function compactArguments(args: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const next = compactArgValue(value, key);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : args;
}

function compactArgValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (key === "data_base64") {
      return `[base64 data omitted by token economy: ${value.length} chars]`;
    }
    if (isLargeArgText(value)) {
      return compactHeadText(value, {
        maxLines: MAX_ARG_TEXT_LINES,
        maxBytes: MAX_ARG_TEXT_BYTES,
        label: "argument",
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return compactGenericValue(value);
  }
  if (isRecord(value)) {
    return compactGenericValue(value);
  }
  return value;
}

function isLargeArgText(text: string): boolean {
  return text.length > MAX_ARG_TEXT_BYTES || splitLines(text).length > MAX_ARG_TEXT_LINES;
}

// --- Tool-result output compaction ------------------------------------------

function compactToolOutput(toolName: string, output: unknown): unknown {
  if (typeof output === "string") {
    return compactGenericText(output);
  }
  if (!isRecord(output)) return output;
  switch (toolName) {
    case "bash":
      return compactBashOutput(output);
    case "read":
      return compactReadOutput(output);
    case "grep":
      return compactGrepOutput(output);
    case "find":
      return compactFindOutput(output);
    case "ls":
      return compactLsOutput(output);
    default:
      return compactGenericValue(output);
  }
}

function compactBashOutput(output: Record<string, unknown>): Record<string, unknown> {
  return {
    ...output,
    output:
      typeof output.output === "string"
        ? compactCommandOutput(output.output, Boolean(output.full_output_path))
        : output.output,
  };
}

function compactReadOutput(output: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...output };
  if (typeof next.content === "string") {
    next.content = compactHeadText(next.content, {
      maxLines: MAX_READ_LINES,
      maxBytes: MAX_READ_BYTES,
      label: "file content",
    });
  }
  if (typeof next.data_base64 === "string") {
    next.data_base64 = `[base64 image data omitted by token economy: ${next.data_base64.length} chars]`;
  }
  return next;
}

function compactGrepOutput(output: Record<string, unknown>): Record<string, unknown> {
  const matches = Array.isArray(output.matches) ? output.matches : [];
  return {
    ...output,
    matches: matches.slice(0, MAX_GREP_MATCHES).map(compactGrepMatch),
    token_economy_omitted_matches:
      matches.length > MAX_GREP_MATCHES ? matches.length - MAX_GREP_MATCHES : undefined,
  };
}

function compactGrepMatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    text: typeof value.text === "string" ? compactLine(value.text) : value.text,
    context_before: compactContextLines(value.context_before),
    context_after: compactContextLines(value.context_after),
  };
}

function compactFindOutput(output: Record<string, unknown>): Record<string, unknown> {
  const matches = Array.isArray(output.matches) ? output.matches : [];
  return {
    ...output,
    matches: matches.slice(0, MAX_FIND_MATCHES),
    token_economy_omitted_matches:
      matches.length > MAX_FIND_MATCHES ? matches.length - MAX_FIND_MATCHES : undefined,
  };
}

function compactLsOutput(output: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(output.entries) ? output.entries : [];
  const names = Array.isArray(output.names) ? output.names : [];
  return {
    ...output,
    entries: entries.slice(0, MAX_LS_ENTRIES),
    names: names.slice(0, MAX_LS_ENTRIES),
    token_economy_omitted_entries:
      entries.length > MAX_LS_ENTRIES ? entries.length - MAX_LS_ENTRIES : undefined,
  };
}

function compactGenericValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "description") return compressProse(value);
    if (key === "data_base64") {
      return `[base64 data omitted by token economy: ${value.length} chars]`;
    }
    if (isLargeText(value)) return compactGenericText(value);
    return value;
  }
  if (Array.isArray(value)) {
    const mapped: unknown[] = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactGenericValue(item));
    if (value.length > MAX_ARRAY_ITEMS) {
      mapped.push({ token_economy_omitted_items: value.length - MAX_ARRAY_ITEMS });
    }
    return mapped;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = compactGenericValue(childValue, childKey);
  }
  return out;
}

function compactContextLines(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 2).map((line) => (typeof line === "string" ? compactLine(line) : line));
}

// --- Text compaction primitives ---------------------------------------------

function compactCommandOutput(text: string, hasFullOutputPath: boolean): string {
  const normalized = normalizeTextBlock(text);
  if (fitsTextBudget(normalized, MAX_COMMAND_LINES, MAX_COMMAND_BYTES)) return normalized;
  const lines = splitLines(normalized);
  const indexes = new Set<number>();
  const headCount = Math.min(24, Math.floor(MAX_COMMAND_LINES * 0.15));
  const tailCount = Math.min(96, Math.floor(MAX_COMMAND_LINES * 0.55));
  for (let index = 0; index < Math.min(headCount, lines.length); index += 1) indexes.add(index);
  for (let index = Math.max(0, lines.length - tailCount); index < lines.length; index += 1) {
    indexes.add(index);
  }
  for (let index = 0; index < lines.length && indexes.size < MAX_COMMAND_LINES; index += 1) {
    if (SIGNAL_LINE_RE.test(lines[index] ?? "")) indexes.add(index);
  }
  const selected = [...indexes].sort((a, b) => a - b).map((index) => compactLine(lines[index] ?? ""));
  const fitted = fitLinesToBudget(selected, MAX_COMMAND_LINES, MAX_COMMAND_BYTES);
  const suffix = hasFullOutputPath
    ? "full_output_path retained"
    : "run a narrower command or inspect with read/grep";
  return [...fitted, `[token economy: showing ${fitted.length} of ${lines.length} lines; ${suffix}]`].join(
    "\n",
  );
}

function compactGenericText(text: string): string {
  return compactHeadText(text, {
    maxLines: MAX_GENERIC_TEXT_LINES,
    maxBytes: MAX_GENERIC_TEXT_BYTES,
    label: "text",
  });
}

interface HeadTextOptions {
  maxLines: number;
  maxBytes: number;
  label: string;
}

function compactHeadText(text: string, options: HeadTextOptions): string {
  const normalized = normalizeTextBlock(text);
  if (fitsTextBudget(normalized, options.maxLines, options.maxBytes)) return normalized;
  const lines = splitLines(normalized).map(compactLine);
  const fitted = fitLinesToBudget(lines, options.maxLines, options.maxBytes);
  return [
    ...fitted,
    `[token economy: showing first ${fitted.length} of ${lines.length} ${options.label} lines]`,
  ].join("\n");
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

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split("\n");
}

function fitsTextBudget(text: string, maxLines: number, maxBytes: number): boolean {
  return splitLines(text).length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes;
}

function fitLinesToBudget(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) break;
    out.push(line);
    bytes += lineBytes;
  }
  return out;
}

function compactLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line.trim();
  const head = Math.floor(MAX_LINE_CHARS * 0.6);
  const tail = MAX_LINE_CHARS - head - 5;
  return `${line.slice(0, head).trimEnd()} ... ${line.slice(-tail).trimStart()}`;
}

function isLargeText(text: string): boolean {
  return text.length > MAX_GENERIC_TEXT_BYTES || splitLines(text).length > MAX_GENERIC_TEXT_LINES;
}

// --- Prose protection -------------------------------------------------------

/**
 * Compresses prose while preserving protected segments (code fences, inline
 * code, URLs, paths, CONSTANT_CASE identifiers, dotted calls, function-call
 * shapes, version numbers). Protected segments are extracted before rewriting
 * and re-inserted verbatim afterwards.
 */
export function compressProse(text: string): string {
  if (!text.trim()) return text;
  return withProtectedSegments(text, (value) => {
    let out = value;
    out = out.replace(LEADERS_RE, "");
    out = out.replace(PLEASANTRIES_RE, "");
    out = out.replace(HEDGES_RE, "");
    out = out.replace(FILLERS_RE, "");
    out = out.replace(ARTICLES_RE, "");
    out = out.replace(/[ \t]{2,}/g, " ");
    out = out.replace(/\s+([,.;:!?])/g, "$1");
    out = out.replace(/\n{3,}/g, "\n\n");
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix: string, ch: string) => prefix + ch.toUpperCase());
    return out.trim();
  });
}

/**
 * Extracts protected segments into placeholders, runs `transform` over the rest,
 * then restores the protected segments verbatim. Protected text is never passed
 * through the compression transform.
 */
export function withProtectedSegments(text: string, transform: (value: string) => string): string {
  const segments: string[] = [];
  let working = text;
  for (const pattern of PROTECTED_PATTERNS) {
    working = working.replace(pattern, (match) => {
      const index = segments.length;
      segments.push(match);
      return `${PROTECTED_SEGMENT_PREFIX}${index}${PROTECTED_SEGMENT_SUFFIX}`;
    });
  }
  const markerRe = new RegExp(`${PROTECTED_SEGMENT_PREFIX}(\\d+)${PROTECTED_SEGMENT_SUFFIX}`, "g");
  return transform(working).replace(markerRe, (_match, index: string) => segments[Number(index)] ?? "");
}

// --- Accounting -------------------------------------------------------------

function measureHistoryChars(history: ModelHistoryItem[]): number {
  return history.reduce((sum, item) => sum + measureItemChars(item), 0);
}

function measureItemChars(item: ModelHistoryItem): number {
  switch (item.kind) {
    case "user_message":
    case "assistant_text":
    case "assistant_reasoning":
      return item.text.length;
    case "tool_call":
      return stableStringify(item.arguments).length;
    case "tool_result":
      return typeof item.output === "string"
        ? item.output.length
        : stableStringify(item.output).length;
    case "compaction":
      return item.summary.length;
    default:
      return 0;
  }
}

/** Deterministic JSON stringify (sorted keys) for stable char accounting. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

// --- Helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
