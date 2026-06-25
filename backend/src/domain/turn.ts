import type { Turn, TurnStatus, GuiPlanContext } from "../contracts/turns.js";
import type { TurnItem } from "../contracts/items.js";
import type { TurnMode, ReasoningEffort } from "../contracts/policy.js";
import { upsertItems } from "./item.js";

export function createTurnRecord(input: {
  id: string;
  threadId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  guiPlan?: GuiPlanContext;
  mode?: TurnMode;
  status?: TurnStatus;
  attachmentIds?: string[];
  disableUserInput?: boolean;
  feishuChatId?: string;
  atMembers?: { id: string; name?: string }[];
  createdAt?: string;
}): Turn {
  const model = input.model?.trim();
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  const feishuChatId = input.feishuChatId?.trim();
  return {
    id: input.id,
    threadId: input.threadId,
    status: input.status ?? "queued",
    prompt: input.prompt,
    steering: [],
    items: [],
    attachmentIds: [...(input.attachmentIds ?? [])],
    activeSkillIds: [],
    injectedMemoryIds: [],
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(input.guiPlan ? { guiPlan: input.guiPlan } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.disableUserInput ? { disableUserInput: true } : {}),
    ...(feishuChatId ? { feishuChatId } : {}),
    ...(input.atMembers?.length ? { atMembers: input.atMembers } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** `auto` defers to the router, so it is persisted as "no explicit effort". */
export function normalizeReasoningEffort(effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
  return effort && effort !== "auto" ? effort : undefined;
}

export function startTurnRecord(turn: Turn, startedAt: string): Turn {
  return { ...turn, status: "running", startedAt };
}

export function appendTurnItem(turn: Turn, item: TurnItem): Turn {
  return { ...turn, items: upsertItems(turn.items, item) };
}

export function replaceTurnItem(turn: Turn, item: TurnItem): Turn {
  return { ...turn, items: upsertItems(turn.items, item) };
}

export function finishTurnRecord(turn: Turn, status: TurnStatus, finishedAt: string, error?: string): Turn {
  return { ...turn, status, finishedAt, steering: [], error: error ?? turn.error };
}

/**
 * Finalize any still-open (pending/running) items when a turn ends.
 * approval -> expired, user_input -> cancelled, everything else -> the turn status.
 */
export function finalizeOpenItems(turn: Turn, status: TurnStatus, finishedAt: string): Turn {
  const items = turn.items.map((item) => finalizeOpenItem(item, status, finishedAt));
  return { ...turn, items };
}

export function finalizeOpenItem(item: TurnItem, status: TurnStatus, finishedAt: string): TurnItem {
  if (item.kind === "approval") {
    return item.status === "pending" ? { ...item, status: "expired", finishedAt } : item;
  }
  if (item.kind === "user_input") {
    return item.status === "pending" ? { ...item, status: "cancelled", finishedAt } : item;
  }
  if (item.status === "pending" || item.status === "running") {
    const finalStatus: "completed" | "failed" | "aborted" =
      status === "completed" ? "completed" : status === "failed" ? "failed" : "aborted";
    return { ...item, status: finalStatus, finishedAt };
  }
  return item;
}
