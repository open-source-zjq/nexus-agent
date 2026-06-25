import type { Thread, ThreadStatus, ThreadRelation, ThreadGoal, ThreadTodoList } from "../contracts/threads.js";
import type { Turn } from "../contracts/turns.js";
import type { TurnItem } from "../contracts/items.js";
import type { ApprovalPolicy, SandboxMode, TurnMode } from "../contracts/policy.js";
import { DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX_MODE } from "../contracts/policy.js";
import { appendTurnItem, replaceTurnItem } from "./turn.js";

export function createThreadRecord(input: {
  id: string;
  title: string;
  workspace: string;
  model: string;
  mode?: TurnMode;
  status?: ThreadStatus;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  costBudgetUsd?: number;
  costBudgetWarningSent?: boolean;
  relation?: ThreadRelation;
  parentThreadId?: string;
  forkedFromThreadId?: string;
  forkedFromTitle?: string;
  forkedAt?: string;
  forkedFromMessageCount?: number;
  forkedFromTurnCount?: number;
  goal?: ThreadGoal;
  todos?: ThreadTodoList;
  createdAt: string;
}): Thread {
  return {
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: input.model,
    mode: input.mode ?? "agent",
    status: input.status ?? "idle",
    approvalPolicy: input.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
    sandboxMode: input.sandboxMode ?? DEFAULT_SANDBOX_MODE,
    relation: input.relation ?? "primary",
    // Conditionally seeded only when supplied, matching the original
    // createThreadRecord (the key is absent — not `false`/`undefined` — on a
    // fresh thread).
    ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
    ...(input.costBudgetWarningSent !== undefined ? { costBudgetWarningSent: input.costBudgetWarningSent } : {}),
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.forkedFromThreadId ? { forkedFromThreadId: input.forkedFromThreadId } : {}),
    ...(input.forkedFromTitle ? { forkedFromTitle: input.forkedFromTitle } : {}),
    ...(input.forkedAt ? { forkedAt: input.forkedAt } : {}),
    ...(input.forkedFromMessageCount !== undefined ? { forkedFromMessageCount: input.forkedFromMessageCount } : {}),
    ...(input.forkedFromTurnCount !== undefined ? { forkedFromTurnCount: input.forkedFromTurnCount } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.todos ? { todos: input.todos } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    turns: [],
  };
}

export function findTurn(thread: Thread, turnId: string): Turn | undefined {
  return thread.turns.find((turn) => turn.id === turnId);
}

export function upsertTurn(thread: Thread, turn: Turn): Thread {
  const index = thread.turns.findIndex((existing) => existing.id === turn.id);
  if (index === -1) return { ...thread, turns: [...thread.turns, turn] };
  const turns = thread.turns.slice();
  turns[index] = turn;
  return { ...thread, turns };
}

/** Append/replace an item onto the turn it belongs to. */
export function appendItemToThread(thread: Thread, item: TurnItem): Thread {
  const turn = findTurn(thread, item.turnId);
  if (!turn) return thread;
  return upsertTurn(thread, appendTurnItem(turn, item));
}

export function replaceItemInThread(thread: Thread, item: TurnItem): Thread {
  const turn = findTurn(thread, item.turnId);
  if (!turn) return thread;
  return upsertTurn(thread, replaceTurnItem(turn, item));
}
