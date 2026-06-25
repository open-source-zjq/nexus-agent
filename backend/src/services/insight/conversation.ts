import type { TurnItem } from "../../contracts/items.js";

/**
 * Read-only helpers over a thread's TurnItem history. Ported faithfully from the
 * original insight conversation utilities, adapted to the nexus-agent TurnItem
 * union (user_message/assistant_text/tool_call/tool_result/...).
 */

const MAX_EXCERPT_CHARS = 4000;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Best-effort plain text for an item; empty string for kinds without text. */
export function itemText(item: TurnItem): string {
  switch (item.kind) {
    case "user_message":
      return item.displayText ?? item.text;
    case "assistant_text":
    case "assistant_reasoning":
      return item.text;
    case "tool_result":
      return typeof item.output === "string" ? item.output : safeJson(item.output);
    case "review":
      return item.reviewText ?? item.title;
    default:
      return "";
  }
}

export function latestAssistantText(items: TurnItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.kind === "assistant_text" && item.text.trim()) return item.text;
  }
  return "";
}

export function latestUserText(items: TurnItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.kind === "user_message") return item.displayText ?? item.text;
  }
  return "";
}

interface RecentToolCall {
  toolName: string;
  text: string;
}

export function recentToolCalls(items: TurnItem[]): RecentToolCall[] {
  return items
    .filter((item): item is Extract<TurnItem, { kind: "tool_call" }> => item.kind === "tool_call")
    .map((item) => ({ toolName: item.toolName, text: safeJson(item.arguments) }));
}

const SEARCH =
  /(search|fetch|grep|find|browse|query|lookup|retrieve|crawl|scrape|read|web|wiki|lark|feishu|doc)/i;

export function searchToolCallCount(items: TurnItem[]): number {
  return recentToolCalls(items).filter((call) => SEARCH.test(call.toolName)).length;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function markdownTableRowCount(text: string): number {
  return text
    .split("\n")
    .filter((line) => TABLE_ROW.test(line) && !/^\s*\|[\s|:-]+\|\s*$/.test(line)).length;
}

export function jsonArrayRowCount(text: string): number {
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) return 0;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** A trimmed, role-tagged tail of the conversation fed to the classifier. */
export function conversationExcerpt(items: TurnItem[], maxChars = MAX_EXCERPT_CHARS): string {
  const tail = items.slice(-12);
  const lines: string[] = [];
  for (const item of tail) {
    const text = itemText(item).trim();
    if (!text) continue;
    const role =
      item.kind === "user_message"
        ? "User"
        : item.kind === "tool_call" || item.kind === "tool_result"
          ? `Tool(${"toolName" in item ? item.toolName : "tool"})`
          : "Assistant";
    lines.push(`${role}: ${text.slice(0, 800)}`);
  }
  const joined = lines.join("\n");
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

function normalizeTopic(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 48).toLowerCase();
}

export function topicFromItems(items: TurnItem[]): string {
  const user = latestUserText(items).trim();
  if (user) return normalizeTopic(user);
  return normalizeTopic(latestAssistantText(items));
}

export function extractMarkdownTable(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => TABLE_ROW.test(line));
  if (start < 0) return "";
  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !TABLE_ROW.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

/** Tolerant JSON-object extraction from a model reply (bare or fenced). */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace-slice
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
