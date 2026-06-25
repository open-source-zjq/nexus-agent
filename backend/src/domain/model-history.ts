import type { TurnItem } from "../contracts/items.js";
import type { ModelHistoryItem, ModelImage } from "../ports/model-client.js";

/**
 * Read resolved inline images off a persisted user TurnItem. The bytes are not
 * part of the canonical `UserTurnItem` schema (which carries only `attachmentIds`),
 * so they are read structurally and stay optional: when the loop attaches an
 * `images` array to the item, it is carried onto the model history; otherwise the
 * user message is text-only. Faithful to the original, where the model layer
 * renders inline images on the latest user message.
 */
function userItemImages(item: TurnItem): ModelImage[] | undefined {
  const value = (item as { images?: unknown }).images;
  if (!Array.isArray(value)) return undefined;
  const images: ModelImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const mimeType = (entry as { mimeType?: unknown }).mimeType;
    const dataBase64 = (entry as { dataBase64?: unknown }).dataBase64;
    if (typeof mimeType === "string" && typeof dataBase64 === "string" && dataBase64.length > 0) {
      images.push({ mimeType, dataBase64 });
    }
  }
  return images.length > 0 ? images : undefined;
}

/**
 * Map persisted TurnItems to the canonical model history. Drops items that have
 * no model-message meaning (approval/user_input/error). Compaction items with
 * `replacedTokens > 0` become a folded summary message.
 */
export function itemsToModelHistory(items: TurnItem[]): ModelHistoryItem[] {
  const out: ModelHistoryItem[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user_message": {
        const images = userItemImages(item);
        if (item.text.length > 0 || images) out.push({ kind: "user_message", text: item.text, ...(images ? { images } : {}) });
        break;
      }
      case "assistant_text":
        if (item.text.length > 0) out.push({ kind: "assistant_text", text: item.text });
        break;
      case "assistant_reasoning":
        if (item.text.length > 0) out.push({ kind: "assistant_reasoning", text: item.text });
        break;
      case "tool_call":
        out.push({ kind: "tool_call", callId: item.callId, toolName: item.toolName, arguments: item.arguments });
        break;
      case "tool_result":
        out.push({
          kind: "tool_result",
          callId: item.callId,
          toolName: item.toolName,
          output: item.output,
          isError: item.isError,
        });
        break;
      case "compaction":
        if (item.replacedTokens > 0) out.push({ kind: "compaction", summary: item.summary, replacedTokens: item.replacedTokens });
        break;
      case "review":
        // A completed review with non-empty reviewText is re-injected into the
        // model context. Faithful to the original itemToMessage "review" case.
        if (item.status === "completed" && item.reviewText && item.reviewText.trim()) {
          out.push({ kind: "review", reviewText: item.reviewText });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Drop orphaned tool pairs: a `tool_call` with no following `tool_result`
 * (same callId) and a `tool_result` with no preceding `tool_call` are removed,
 * so unresolved tool calls never reach the wire (which providers reject).
 */
export function repairModelHistory(items: ModelHistoryItem[]): ModelHistoryItem[] {
  const resultCallIds = new Set<string>();
  const callCallIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_result") resultCallIds.add(item.callId);
    if (item.kind === "tool_call") callCallIds.add(item.callId);
  }
  return items.filter((item) => {
    if (item.kind === "tool_call") return resultCallIds.has(item.callId);
    if (item.kind === "tool_result") return callCallIds.has(item.callId);
    return true;
  });
}

/**
 * Build the effective model history given an append-only item log that may
 * contain compaction summaries.
 *
 * A compaction summary replaces its `sourceItemIds` (the folded "head") but the
 * preserved "tail" items physically *precede* the appended summary in the log,
 * so a naive slice-from-the-summary would drop them. Instead we exclude every
 * folded item (and every superseded compaction) by id, then place the latest
 * summary in front of whatever remains — preserving the tail and any items
 * appended after the compaction, in order.
 */
export function effectiveHistoryAfterLatestCompaction(items: TurnItem[]): TurnItem[] {
  const compactions = items.filter(
    (item): item is Extract<TurnItem, { kind: "compaction" }> => item.kind === "compaction" && item.replacedTokens > 0,
  );
  if (compactions.length === 0) return items;

  const latest = compactions[compactions.length - 1];
  const excluded = new Set<string>();
  for (const compaction of compactions) {
    for (const id of compaction.sourceItemIds ?? []) excluded.add(id);
    if (compaction.id !== latest.id) excluded.add(compaction.id); // drop superseded summaries
  }

  const kept = items.filter((item) => item.id !== latest.id && !excluded.has(item.id));
  return [latest, ...kept];
}
