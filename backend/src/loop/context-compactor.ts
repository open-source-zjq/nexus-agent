import { createHash } from "node:crypto";
import type { TurnItem, CompactionTurnItem } from "../contracts/items.js";

const CHARS_PER_TOKEN = 4;

/**
 * Render an item to its estimation text surface. Faithful to the original
 * `ContextEstimator.collectText`: every persisted kind contributes its real
 * text (including approval/user_input/review), so the estimate is not skewed by
 * a default ~1-token branch for those kinds.
 */
function collectItemText(item: TurnItem): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_text":
    case "assistant_reasoning":
      return item.text;
    case "tool_call":
      return `${item.toolName} ${JSON.stringify(item.arguments)}`;
    case "tool_result":
      return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    case "approval":
      return `${item.toolName} ${item.summary}`;
    case "user_input":
      return item.prompt;
    case "compaction":
      return item.summary;
    case "review":
      return `${item.title ?? ""} ${item.reviewText ?? ""} ${item.output ? JSON.stringify(item.output) : ""}`;
    case "error":
      return item.message;
    default:
      return "";
  }
}

export function estimateItemTokens(item: TurnItem): number {
  return Math.max(1, Math.ceil(collectItemText(item).length / CHARS_PER_TOKEN));
}

export function estimateItemsTokens(items: TurnItem[]): number {
  return items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
}

export type CompactionMode = "normal" | "aggressive" | "force";

export interface CompactionPlan {
  mode: CompactionMode;
  keepRecent: number;
  reason: string;
}

export interface ContextCompactorConfig {
  /** Fraction of the context window that triggers a normal compaction. */
  softRatio: number;
  /** Fraction of the context window that forces compaction. */
  hardRatio: number;
}

// Faithful to the original DEFAULT_CONTEXT_THRESHOLDS (floor(256000*0.86) soft /
// floor(256000*0.94) hard): a generic, non-profiled model compacts at 86% (soft)
// and force-compacts at 94% (hard) of its context window.
export const DEFAULT_COMPACTOR_CONFIG: ContextCompactorConfig = { softRatio: 0.86, hardRatio: 0.94 };

/** Optional model-rewrite summarizer + tuning injected into the compactor. */
export interface ContextCompactorDeps {
  /** When provided and `summaryMode === "model"`, rewrites the heuristic summary. */
  summarize?: (input: { text: string; signal?: AbortSignal }) => Promise<string>;
  summaryMode?: "heuristic" | "model";
  summaryTimeoutMs?: number;
}

const DEFAULT_SUMMARY_TIMEOUT_MS = 15000;

export interface CompactInput {
  threadId: string;
  turnId: string;
  history: TurnItem[];
  keepRecent: number;
  reason: string;
  pinnedConstraints?: string[];
  summaryOverride?: string;
  nowIso: string;
  id: string;
  /** Leading items that must never be folded (e.g. pinned system context). */
  frozenMessageCount?: number;
  /** Compaction mode label included in the summary header. */
  mode?: CompactionMode;
  /** Token budget used to size the summary body and reported in its header. */
  budgetTokens?: number;
}

export interface CompactResult {
  next: TurnItem[];
  summaryItem: CompactionTurnItem;
  replacedTokens: number;
  /**
   * Set when `summaryMode === "model"` was attempted but the model rewrite fell
   * back to the deterministic heuristic (timeout / empty / error). The loop emits
   * a `compaction_summary_fallback` warning event from this (faithful to the
   * original `summarizeCompactionWithModel` recordFallback path). Absent when no
   * rewrite was attempted or the rewrite succeeded.
   */
  summaryFallback?: string;
}

/**
 * Result of splitting a history for compaction. `compact:false` carries the
 * trimmed frozen+history so the no-op path can reproduce the original's
 * `next: [...frozen, ...history]` return; `compact:true` carries the head/tail
 * fold partition.
 */
type CompactionSplit =
  | { compact: false; frozen: TurnItem[]; history: TurnItem[] }
  | { compact: true; frozen: TurnItem[]; head: TurnItem[]; tail: TurnItem[] };

/** Two-archetype context folder: deterministic heuristic summary of older items. */
export class ContextCompactor {
  private readonly config: ContextCompactorConfig;
  private readonly deps: ContextCompactorDeps;

  constructor(config: Partial<ContextCompactorConfig> = {}, deps: ContextCompactorDeps = {}) {
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
    this.deps = deps;
  }

  planCompaction(
    items: TurnItem[],
    input: {
      contextWindowTokens: number;
      promptTokens?: number;
      softRatio?: number;
      hardRatio?: number;
      /** Leading items excluded from the compactable estimate (never folded). */
      frozenMessageCount?: number;
    },
  ): CompactionPlan | null {
    const softRatio = input.softRatio ?? this.config.softRatio;
    const hardRatio = input.hardRatio ?? this.config.hardRatio;
    const soft = Math.floor(input.contextWindowTokens * softRatio);
    const hard = Math.floor(input.contextWindowTokens * hardRatio);
    const frozenMessageCount = normalizeFrozenMessageCount(input.frozenMessageCount, items.length);
    const compactableItems = frozenMessageCount > 0 ? items.slice(frozenMessageCount) : items;
    const estimated = estimateItemsTokens(compactableItems);
    const promptTokens = typeof input.promptTokens === "number" ? input.promptTokens : undefined;
    const tokens = Math.max(estimated, promptTokens ?? 0);
    if (tokens < soft) return null;
    const aggressive = soft + Math.floor((hard - soft) * 0.6);
    const mode: CompactionMode = tokens >= hard ? "force" : tokens >= aggressive ? "aggressive" : "normal";
    // Attribute the trigger to the real usage prompt_tokens vs the estimated
    // history tokens (faithful to the original planCompaction reason text).
    const source = promptTokens !== undefined && promptTokens >= estimated ? "usage prompt_tokens" : "estimated prompt tokens";
    const keepRecent = mode === "force" ? 1 : mode === "aggressive" ? 2 : 4;
    return { mode, keepRecent, reason: `${source} ${tokens} reached ${mode} compaction threshold` };
  }

  compact(input: CompactInput): CompactResult {
    const split = this.splitForCompaction(input);
    if (!split.compact) {
      const noop = this.buildSummaryItem(input, "no compaction needed", 0, [], undefined);
      return { next: [...split.frozen, ...split.history], summaryItem: noop, replacedTokens: 0 };
    }
    const baseSummary = input.summaryOverride?.trim() || buildHeuristicSummary(split, input);
    return this.assemble(input, split, baseSummary);
  }

  /**
   * Async variant: builds the deterministic heuristic summary first, then — when
   * `summaryMode === "model"` and a summarizer is wired — rewrites it via the
   * model under a timeout, silently falling back to the heuristic on
   * timeout/empty/error. The sha256 tool_digest marker and tiers are preserved.
   */
  async compactAsync(input: CompactInput & { signal?: AbortSignal }): Promise<CompactResult> {
    const split = this.splitForCompaction(input);
    if (!split.compact) {
      const noop = this.buildSummaryItem(input, "no compaction needed", 0, [], undefined);
      return { next: [...split.frozen, ...split.history], summaryItem: noop, replacedTokens: 0 };
    }
    const heuristic = input.summaryOverride?.trim() || buildHeuristicSummary(split, input);
    let baseSummary = heuristic;
    let summaryFallback: string | undefined;
    if (this.deps.summaryMode === "model" && this.deps.summarize && !input.summaryOverride?.trim()) {
      const rewrite = await this.rewriteViaModel(heuristic, input.signal);
      if (rewrite.text) baseSummary = rewrite.text;
      else summaryFallback = rewrite.reason; // model rewrite fell back to heuristic
    }
    const result = this.assemble(input, split, baseSummary);
    return summaryFallback ? { ...result, summaryFallback } : result;
  }

  private async rewriteViaModel(
    heuristic: string,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string | null; reason?: string }> {
    const summarize = this.deps.summarize;
    if (!summarize) return { text: null };
    const timeoutMs = this.deps.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const text = await summarize({ text: heuristic, signal: controller.signal });
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (trimmed.length > 0) return { text: trimmed };
      return { text: null, reason: "compaction summary model rewrite returned an empty summary; using heuristic summary" };
    } catch (error) {
      const reason = timedOut
        ? `compaction summary model rewrite timed out after ${timeoutMs}ms; using heuristic summary`
        : `compaction summary model rewrite failed (${error instanceof Error ? error.message : String(error)}); using heuristic summary`;
      return { text: null, reason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private splitForCompaction(input: CompactInput): CompactionSplit {
    const frozenMessageCount = normalizeFrozenMessageCount(input.frozenMessageCount, input.history.length);
    const frozen = frozenMessageCount > 0 ? input.history.slice(0, frozenMessageCount) : [];
    // Drop trailing tool_call items: a fold must not orphan a call from its result.
    const history = trimTrailingToolCalls(input.history.slice(frozenMessageCount));
    // Faithful to the original compact(): a single-item (or empty) history always
    // no-ops; otherwise keepRecent is clamped to [0, history.length-1] (so 0 is
    // honored: the whole history folds with an empty tail).
    const requestedKeepRecent = Math.max(0, input.keepRecent ?? 4);
    const keepRecent = history.length <= 1 ? history.length : Math.min(requestedKeepRecent, history.length - 1);
    if (history.length <= 1 || history.length - keepRecent <= 0) {
      return { compact: false, frozen, history };
    }
    const head = keepRecent === 0 ? history : history.slice(0, history.length - keepRecent);
    const tail = keepRecent === 0 ? [] : history.slice(history.length - keepRecent);
    return { compact: true, frozen, head, tail };
  }

  private assemble(
    input: CompactInput,
    split: { frozen: TurnItem[]; head: TurnItem[]; tail: TurnItem[] },
    baseSummary: string,
  ): CompactResult {
    const { frozen, head, tail } = split;
    const replacedTokens = estimateItemsTokens(head);
    // Hash the FOLDED CONTENT (not just {id,kind}) so the digest is a true
    // fingerprint of what was summarized away.
    const sourceDigest = createHash("sha256").update(compactedItemsDigestSource(head)).digest("hex").slice(0, 16);
    const digestMarker = `<nexus:tool_digest sha256="${escapeMarkerAttribute(sourceDigest)}">`;
    const summary = appendDigestMarker(baseSummary, digestMarker);
    const summaryItem = this.buildSummaryItem(
      input,
      summary,
      replacedTokens,
      head.map((item) => item.id),
      { sourceDigest, digestMarker },
    );
    return { next: [...frozen, summaryItem, ...tail], summaryItem, replacedTokens };
  }

  private buildSummaryItem(
    input: CompactInput,
    summary: string,
    replacedTokens: number,
    sourceItemIds: string[],
    digest: { sourceDigest: string; digestMarker: string } | undefined,
  ): CompactionTurnItem {
    return {
      kind: "compaction",
      id: input.id,
      turnId: input.turnId,
      threadId: input.threadId,
      role: "system",
      status: "completed",
      createdAt: input.nowIso,
      finishedAt: input.nowIso,
      summary,
      replacedTokens,
      pinnedConstraints: input.pinnedConstraints ?? [],
      sourceDigest: digest?.sourceDigest,
      digestMarker: digest?.digestMarker,
      sourceItemIds,
    };
  }
}

// --- Frozen-prefix + trailing-call trimming ---------------------------------

/** Drop trailing `tool_call` items so a fold never orphans a call from its result. */
function trimTrailingToolCalls(history: TurnItem[]): TurnItem[] {
  let end = history.length;
  while (end > 0) {
    const item = history[end - 1];
    if (item.kind !== "tool_call") break;
    end -= 1;
  }
  return end === history.length ? history : history.slice(0, end);
}

function normalizeFrozenMessageCount(value: number | undefined, historyLength: number): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(historyLength, Math.floor(value)));
}

// --- Compaction digest (over folded CONTENT) --------------------------------

/**
 * Deterministic source string for the tool_digest hash. Faithful to the
 * original `compactedItemsDigestSource` (= `stableStringify3`): each folded item
 * is projected to a stable content shape, then the ENTIRE array — including each
 * shape object's top-level keys (kind/callId/toolName/...) — is recursively
 * key-sorted via `stableShape` before JSON-serializing, so the digest is a true,
 * insertion-order-independent fingerprint of the summarized-away CONTENT.
 */
function compactedItemsDigestSource(items: TurnItem[]): string {
  return JSON.stringify(stableShape(items.map(compactionDigestShape)));
}

function compactionDigestShape(item: TurnItem): unknown {
  switch (item.kind) {
    case "user_message":
      return { kind: item.kind, text: item.text };
    case "assistant_text":
      return { kind: item.kind, text: item.text };
    case "assistant_reasoning":
      return { kind: item.kind, text: item.text };
    case "tool_call":
      return {
        kind: item.kind,
        callId: item.callId,
        toolName: item.toolName,
        arguments: stableShape(item.arguments),
        summary: item.summary,
      };
    case "tool_result":
      return {
        kind: item.kind,
        callId: item.callId,
        toolName: item.toolName,
        output: stableShape(item.output),
        isError: item.isError,
      };
    case "approval":
      return {
        kind: item.kind,
        approvalId: item.approvalId,
        toolName: item.toolName,
        summary: item.summary,
        status: item.status,
      };
    case "user_input":
      return {
        kind: item.kind,
        inputId: item.inputId,
        prompt: item.prompt,
        status: item.status,
      };
    case "compaction":
      return {
        kind: item.kind,
        summary: item.summary,
        sourceDigest: item.sourceDigest,
        digestMarker: item.digestMarker,
        sourceItemIds: item.sourceItemIds,
        replacedTokens: item.replacedTokens,
      };
    case "review":
      return {
        kind: item.kind,
        title: item.title,
        reviewText: item.reviewText,
        output: stableShape(item.output),
      };
    case "error":
      return {
        kind: item.kind,
        message: item.message,
        code: item.code,
      };
    default:
      return { kind: (item as { kind: string }).kind };
  }
}

function stableShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableShape);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableShape((value as Record<string, unknown>)[key]);
  }
  return out;
}

function escapeMarkerAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function appendDigestMarker(summary: string, digestMarker: string): string {
  const trimmed = summary.trim();
  if (trimmed.includes(digestMarker)) return trimmed;
  return `${trimmed}\n\nCompaction digest marker: ${digestMarker}`;
}

// --- Heuristic summary body (ported from buildCompactionSummary) ------------

/**
 * Build the deterministic heuristic summary. Faithful to the original
 * `buildCompactionSummary`: a Reason/Mode/Budget header, the pinned constraints
 * (preserved across compaction) listed in the body, any extracted skill pins,
 * then a budget-aware fitted conversation summary (first-4 / last-14 line
 * selection when long).
 */
function buildHeuristicSummary(
  split: { head: TurnItem[]; tail: TurnItem[] },
  input: CompactInput,
): string {
  const history = [...split.head, ...split.tail];
  const contentBudget = summaryCharBudget(input.budgetTokens);
  const pinnedConstraints = input.pinnedConstraints ?? [];
  const lines: string[] = [];
  if (input.reason) lines.push(`Reason: ${input.reason}`);
  if (input.mode) lines.push(`Mode: ${input.mode}`);
  if (input.budgetTokens !== undefined) lines.push(`Budget: ${input.budgetTokens} tokens`);
  lines.push("Pinned constraints (preserved across compaction):");
  if (pinnedConstraints.length === 0) {
    lines.push("- (none)");
  } else {
    for (const pinned of pinnedConstraints) lines.push(`- ${pinned}`);
  }
  const skillPins = extractSkillPins(history);
  if (skillPins.length > 0) {
    lines.push("Pinned skills (preserved across compaction):");
    for (const skillPin of skillPins) lines.push(`- ${skillPin}`);
    lines.push("");
  }
  lines.push("");
  lines.push(
    `Summarized ${history.length} item(s); ${split.tail.length} recent item(s) are also kept verbatim for the current request.`,
  );
  lines.push("Conversation and work summary:");
  const summaryLines = fitLinesToBudget(
    selectSummaryLines(history.map(summarizeItem).filter((line) => line.length > 0)),
    contentBudget,
  );
  if (summaryLines.length === 0) {
    lines.push("- No user-visible content before compaction.");
  } else {
    lines.push(...summaryLines);
  }
  return lines.join("\n");
}

/** Extract `Active Skill:` / `Skill Pin:` / `Pinned Skill:` lines from prose items. */
function extractSkillPins(history: TurnItem[]): string[] {
  const pins = new Set<string>();
  for (const item of history) {
    if (item.kind !== "assistant_text" && item.kind !== "user_message" && item.kind !== "compaction") continue;
    const text = item.kind === "compaction" ? item.summary : item.text;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^(Active Skill:|Skill Pin:|Pinned Skill:)/i.test(trimmed)) {
        pins.add(clipText(trimmed, 600));
      }
    }
  }
  return [...pins];
}

function summaryCharBudget(budgetTokens: number | undefined): number {
  if (budgetTokens === undefined) return 4000;
  return Math.max(1200, Math.min(12000, budgetTokens * 4));
}

function summarizeItem(item: TurnItem): string {
  switch (item.kind) {
    case "user_message":
      return `- User: ${clipText(item.text)}`;
    case "assistant_text":
      return `- Assistant: ${clipText(item.text)}`;
    case "assistant_reasoning":
      return "";
    case "tool_call":
      return `- Tool call ${item.toolName}: ${clipText(item.summary || stringifyCompact(item.arguments))}`;
    case "tool_result":
      return `- Tool result ${item.toolName}${item.isError ? " error" : ""}: ${clipText(stringifyCompact(item.output))}`;
    case "approval":
      return `- Approval ${item.status} for ${item.toolName}: ${clipText(item.summary)}`;
    case "user_input":
      return `- User input ${item.status}: ${clipText(item.prompt)}`;
    case "compaction":
      return item.replacedTokens > 0 ? `- Earlier compaction summary: ${clipText(item.summary, 600)}` : "";
    case "review":
      return `- Review ${item.title ?? ""}: ${clipText(item.reviewText || stringifyCompact(item.output))}`;
    case "error":
      return `- Error${item.code ? ` ${item.code}` : ""}: ${clipText(item.message)}`;
    default:
      return "";
  }
}

/** Keep the first 4 + last 14 lines (with an elision marker) when very long. */
function selectSummaryLines(lines: string[]): string[] {
  if (lines.length <= 20) return lines;
  const start = lines.slice(0, 4);
  const end = lines.slice(-14);
  return [
    ...start,
    `- ${lines.length - start.length - end.length} middle item(s) omitted from this compact summary.`,
    ...end,
  ];
}

function fitLinesToBudget(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextCost = line.length + 1;
    if (used + nextCost <= budget) {
      out.push(line);
      used += nextCost;
      continue;
    }
    const remaining = budget - used;
    if (remaining > 80) out.push(clipText(line, remaining));
    break;
  }
  return out;
}

function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clipText(text: string, max = 360): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trim()}...`;
}
