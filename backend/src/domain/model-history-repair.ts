import type { TurnItem } from "../contracts/items.js";

/**
 * Block-aware repair of tool_call / tool_result pairs in a persisted item log.
 *
 * Providers reject histories where a tool_call has no matching tool_result (or
 * vice versa). A naive flat filter (drop any call/result whose callId lacks a
 * partner) is too weak: it does not respect the *block structure* of a turn,
 * where a run of consecutive tool_calls is answered by a run of tool_results,
 * and the two runs may be interleaved with "bridge" items (reasoning, approval,
 * user_input, error, and pre-result assistant_text) that legitimately sit
 * between the calls and their results.
 *
 * This walks each consecutive run of tool_calls, locates the matching block of
 * tool_results (tolerating bridge items between them), and keeps only the calls
 * and results whose callId appears in BOTH the call run and the result block.
 */
export function repairModelHistoryItems(items: TurnItem[]): TurnItem[] {
  const keptCallIndexes = new Set<number>();
  const keptResultIndexes = new Set<number>();

  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item?.kind !== "tool_call") {
      index += 1;
      continue;
    }

    const calls: { item: Extract<TurnItem, { kind: "tool_call" }>; index: number }[] = [];
    const seenCallIds = new Set<string>();
    let cursor = index;
    while (cursor < items.length && items[cursor]?.kind === "tool_call") {
      const call = items[cursor] as Extract<TurnItem, { kind: "tool_call" }>;
      if (!seenCallIds.has(call.callId)) {
        seenCallIds.add(call.callId);
        calls.push({ item: call, index: cursor });
      }
      cursor += 1;
    }

    const result = findResultBlock(items, cursor, {
      turnId: item.turnId,
      expectedCallIds: seenCallIds,
    });

    if (calls.length > 0 && result.resultCallIds.size > 0) {
      for (const call of calls) {
        if (result.resultCallIds.has(call.item.callId)) keptCallIndexes.add(call.index);
      }
      for (const resultIndex of result.resultIndexes) keptResultIndexes.add(resultIndex);
    }

    index = cursor;
  }

  let changed = false;
  const repaired = items.filter((item, itemIndex) => {
    if (item.kind === "tool_call") {
      const keep = keptCallIndexes.has(itemIndex);
      changed ||= !keep;
      return keep;
    }
    if (item.kind === "tool_result") {
      const keep = keptResultIndexes.has(itemIndex);
      changed ||= !keep;
      return keep;
    }
    return true;
  });

  return changed ? repaired : items;
}

interface FindResultBlockOptions {
  turnId: string;
  expectedCallIds: Set<string>;
}

interface ResultBlock {
  resultCallIds: Set<string>;
  resultIndexes: number[];
}

/**
 * Scan forward from `startIndex` collecting tool_results that answer one of the
 * `expectedCallIds`, tolerating interleaved bridge items. Stops at the first
 * non-result, non-bridge item.
 */
function findResultBlock(items: TurnItem[], startIndex: number, options: FindResultBlockOptions): ResultBlock {
  const seenResultIds = new Set<string>();
  const resultIndexes: number[] = [];
  let sawResult = false;
  let index = startIndex;

  while (index < items.length) {
    const item = items[index];
    if (!item) break;

    if (item.kind === "tool_result") {
      sawResult = true;
      if (options.expectedCallIds.has(item.callId) && !seenResultIds.has(item.callId)) {
        seenResultIds.add(item.callId);
        resultIndexes.push(index);
      }
      index += 1;
      continue;
    }

    if (isToolResultBridgeItem(item, { turnId: options.turnId, sawResult })) {
      index += 1;
      continue;
    }

    break;
  }

  return { resultCallIds: seenResultIds, resultIndexes };
}

interface ToolResultBridgeOptions {
  turnId: string;
  sawResult: boolean;
}

/**
 * Items that may legitimately appear between a run of tool_calls and the run of
 * matching tool_results without breaking the block. Reasoning/approval/
 * user_input/error are always allowed; assistant_text only counts as a bridge
 * before any result has been seen and only when it belongs to the same turn.
 */
function isToolResultBridgeItem(item: TurnItem, options: ToolResultBridgeOptions): boolean {
  switch (item.kind) {
    case "assistant_reasoning":
    case "approval":
    case "user_input":
    case "error":
      return true;
    case "assistant_text":
      return !options.sawResult && item.turnId === options.turnId;
    default:
      return false;
  }
}
