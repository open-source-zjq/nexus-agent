import type {
  TurnItem,
  TurnItemStatus,
  UserTurnItem,
  AssistantTextTurnItem,
  AssistantReasoningTurnItem,
  ToolCallTurnItem,
  ToolResultTurnItem,
  ApprovalTurnItem,
  UserInputTurnItem,
  CompactionTurnItem,
  ReviewTurnItem,
  ErrorTurnItem,
} from "../contracts/items.js";
import type { ToolKind } from "../contracts/items.js";
import type { RuntimeErrorSeverity } from "../contracts/errors.js";

/** Terminal statuses gain a `finishedAt` timestamp when not supplied. */
const TERMINAL_STATUSES = new Set<TurnItemStatus>(["completed", "failed", "aborted"]);

function deriveFinishedAt(status: TurnItemStatus, createdAt: string, finishedAt?: string): string | undefined {
  if (finishedAt) return finishedAt;
  return TERMINAL_STATUSES.has(status) ? createdAt : undefined;
}

interface BaseInput {
  id: string;
  turnId: string;
  threadId: string;
  createdAt: string;
  status?: TurnItemStatus;
  finishedAt?: string;
}

const COMPLETED: TurnItemStatus = "completed";

export function makeUserItem(
  input: BaseInput & { text: string; displayText?: string; attachmentIds?: string[] },
): UserTurnItem {
  const displayText = input.displayText?.trim();
  const attachmentIds = input.attachmentIds?.filter((id) => id.trim().length > 0);
  return {
    kind: "user_message",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "user",
    status: input.status ?? COMPLETED,
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    text: input.text,
    ...(displayText && displayText !== input.text ? { displayText } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  };
}

export function makeAssistantTextItem(input: BaseInput & { text: string }): AssistantTextTurnItem {
  return {
    kind: "assistant_text",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "assistant",
    status: input.status ?? "running",
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    text: input.text,
  };
}

export function makeAssistantReasoningItem(input: BaseInput & { text: string }): AssistantReasoningTurnItem {
  return {
    kind: "assistant_reasoning",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "assistant",
    status: input.status ?? "running",
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    text: input.text,
  };
}

export function makeToolCallItem(
  input: BaseInput & {
    toolName: string;
    callId: string;
    toolKind: ToolKind;
    arguments: Record<string, unknown>;
    summary?: string;
  },
): ToolCallTurnItem {
  return {
    kind: "tool_call",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "tool",
    status: input.status ?? "pending",
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    toolName: input.toolName,
    callId: input.callId,
    toolKind: input.toolKind,
    arguments: input.arguments,
    summary: input.summary,
  };
}

export function makeToolResultItem(
  input: BaseInput & {
    toolName: string;
    callId: string;
    toolKind: ToolKind;
    output: unknown;
    isError: boolean;
  },
): ToolResultTurnItem {
  const status = input.status ?? COMPLETED;
  return {
    kind: "tool_result",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "tool",
    status,
    createdAt: input.createdAt,
    finishedAt: deriveFinishedAt(status, input.createdAt, input.finishedAt),
    toolName: input.toolName,
    callId: input.callId,
    toolKind: input.toolKind,
    output: input.output,
    isError: input.isError,
  };
}

// approval / user_input items override the base lifecycle `status` with their
// own enum, so these constructors omit BaseInput.status.
type BaseInputNoStatus = Omit<BaseInput, "status">;

export function makeApprovalItem(
  input: BaseInputNoStatus & { approvalId: string; toolName: string; summary: string; status?: ApprovalTurnItem["status"] },
): ApprovalTurnItem {
  return {
    kind: "approval",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "tool",
    status: input.status ?? "pending",
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    approvalId: input.approvalId,
    toolName: input.toolName,
    summary: input.summary,
  };
}

export function makeUserInputItem(
  input: BaseInputNoStatus & {
    inputId: string;
    prompt: string;
    questions?: UserInputTurnItem["questions"];
    status?: UserInputTurnItem["status"];
  },
): UserInputTurnItem {
  return {
    kind: "user_input",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "tool",
    status: input.status ?? "pending",
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    inputId: input.inputId,
    prompt: input.prompt,
    questions: input.questions ?? [],
  };
}

export function makeCompactionItem(
  input: BaseInput & {
    summary: string;
    replacedTokens: number;
    pinnedConstraints: string[];
    sourceDigest?: string;
    digestMarker?: string;
    sourceItemIds?: string[];
  },
): CompactionTurnItem {
  return {
    kind: "compaction",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "system",
    status: input.status ?? COMPLETED,
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    summary: input.summary,
    replacedTokens: input.replacedTokens,
    pinnedConstraints: input.pinnedConstraints,
    sourceDigest: input.sourceDigest,
    digestMarker: input.digestMarker,
    sourceItemIds: input.sourceItemIds,
  };
}

export function makeReviewItem(
  input: BaseInput & {
    title: string;
    target: ReviewTurnItem["target"];
    reviewText?: string;
    output?: ReviewTurnItem["output"];
    // Backward-compatible simplified fields (mirrored from review-service).
    summary?: string;
    findings?: ReviewTurnItem["findings"];
    overallExplanation?: string;
    overallCorrectness?: ReviewTurnItem["overallCorrectness"];
    overallConfidenceScore?: number;
  },
): ReviewTurnItem {
  const status = input.status ?? "running";
  return {
    kind: "review",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "assistant",
    status,
    createdAt: input.createdAt,
    finishedAt: deriveFinishedAt(status, input.createdAt, input.finishedAt),
    title: input.title,
    target: input.target,
    findings: input.findings ?? [],
    ...(input.reviewText ? { reviewText: input.reviewText } : {}),
    ...(input.output ? { output: input.output } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.overallExplanation !== undefined ? { overallExplanation: input.overallExplanation } : {}),
    ...(input.overallCorrectness ? { overallCorrectness: input.overallCorrectness } : {}),
    ...(input.overallConfidenceScore !== undefined ? { overallConfidenceScore: input.overallConfidenceScore } : {}),
  };
}

export function makeErrorItem(
  input: BaseInput & { message: string; code?: string; details?: unknown; severity?: RuntimeErrorSeverity },
): ErrorTurnItem {
  return {
    kind: "error",
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: "system",
    status: input.status ?? COMPLETED,
    createdAt: input.createdAt,
    finishedAt: input.finishedAt,
    message: input.message,
    code: input.code,
    details: input.details,
    severity: input.severity,
  };
}

/** Idempotent append: replaces in place when an item with the same id exists. */
export function upsertItems(items: TurnItem[], item: TurnItem): TurnItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}
