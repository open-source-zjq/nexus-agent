import { z } from "zod";
import { RuntimeErrorSeverity } from "./errors.js";
import { ReviewTargetSchema, ReviewOutputSchema } from "./review.js";

export const TurnItemRole = z.enum(["user", "assistant", "system", "tool"]);
export type TurnItemRole = z.infer<typeof TurnItemRole>;

export const TurnItemStatus = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export type TurnItemStatus = z.infer<typeof TurnItemStatus>;

/** Classifies the side-effect surface of a tool call (drives sandbox policy). */
export const ToolKind = z.enum(["tool_call", "command_execution", "file_change"]);
export type ToolKind = z.infer<typeof ToolKind>;

const TurnItemBase = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  threadId: z.string().min(1),
  role: TurnItemRole,
  status: TurnItemStatus,
  createdAt: z.string(),
  finishedAt: z.string().optional(),
});

export const UserInputOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});

export const UserInputQuestionSchema = z.object({
  header: z.string().min(1),
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(UserInputOptionSchema),
});

export const UserTurnItem = TurnItemBase.extend({
  kind: z.literal("user_message"),
  text: z.string(),
  displayText: z.string().optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
});

export const AssistantTextTurnItem = TurnItemBase.extend({
  kind: z.literal("assistant_text"),
  text: z.string(),
});

export const AssistantReasoningTurnItem = TurnItemBase.extend({
  kind: z.literal("assistant_reasoning"),
  text: z.string(),
});

export const ToolCallTurnItem = TurnItemBase.extend({
  kind: z.literal("tool_call"),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  toolKind: ToolKind,
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string().optional(),
});

export const ToolResultTurnItem = TurnItemBase.extend({
  kind: z.literal("tool_result"),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  toolKind: ToolKind,
  output: z.unknown(),
  isError: z.boolean().default(false),
});

export const ApprovalTurnItem = TurnItemBase.extend({
  kind: z.literal("approval"),
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string(),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
});

export const UserInputTurnItem = TurnItemBase.extend({
  kind: z.literal("user_input"),
  inputId: z.string().min(1),
  prompt: z.string(),
  questions: z.array(UserInputQuestionSchema).default([]),
  status: z.enum(["pending", "submitted", "cancelled"]),
});

export const CompactionTurnItem = TurnItemBase.extend({
  kind: z.literal("compaction"),
  summary: z.string(),
  replacedTokens: z.number().int().nonnegative(),
  pinnedConstraints: z.array(z.string()),
  sourceDigest: z.string().min(1).optional(),
  digestMarker: z.string().min(1).optional(),
  sourceItemIds: z.array(z.string().min(1)).optional(),
});

export const ErrorTurnItem = TurnItemBase.extend({
  kind: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  severity: RuntimeErrorSeverity.optional(),
});

/**
 * Backward-compatible simplified finding shape used by the flattened
 * review-service output (priority/title/detail/file/line). The structured
 * finding shape lives in contracts/review.ts (ReviewFindingSchema there).
 */
export const SimpleReviewFindingSchema = z.object({
  priority: z.number().int(),
  title: z.string(),
  detail: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
});
export type SimpleReviewFinding = z.infer<typeof SimpleReviewFindingSchema>;

export const ReviewTurnItem = TurnItemBase.extend({
  kind: z.literal("review"),
  // Faithful to the original ReviewTurnItem: `target` is the canonical
  // ReviewTargetSchema (uncommittedChanges|baseBranch|commit|custom) and is
  // required, and `title` is a required non-empty string.
  target: ReviewTargetSchema,
  title: z.string().min(1),
  reviewText: z.string().optional(),
  output: ReviewOutputSchema.optional(),
  // Backward-compatible simplified fields (mirrored from the replica's
  // review-service output, which flattens ReviewOutputSchema onto the item).
  summary: z.string().optional(),
  findings: z.array(SimpleReviewFindingSchema).default([]),
  overallExplanation: z.string().optional(),
  overallCorrectness: z.enum(["patch is correct", "patch is incorrect"]).optional(),
  overallConfidenceScore: z.number().optional(),
});

export const TurnItem = z.discriminatedUnion("kind", [
  UserTurnItem,
  AssistantTextTurnItem,
  AssistantReasoningTurnItem,
  ToolCallTurnItem,
  ToolResultTurnItem,
  ApprovalTurnItem,
  UserInputTurnItem,
  CompactionTurnItem,
  ErrorTurnItem,
  ReviewTurnItem,
]);
export type TurnItem = z.infer<typeof TurnItem>;

export type UserTurnItem = z.infer<typeof UserTurnItem>;
export type AssistantTextTurnItem = z.infer<typeof AssistantTextTurnItem>;
export type AssistantReasoningTurnItem = z.infer<typeof AssistantReasoningTurnItem>;
export type ToolCallTurnItem = z.infer<typeof ToolCallTurnItem>;
export type ToolResultTurnItem = z.infer<typeof ToolResultTurnItem>;
export type ApprovalTurnItem = z.infer<typeof ApprovalTurnItem>;
export type UserInputTurnItem = z.infer<typeof UserInputTurnItem>;
export type CompactionTurnItem = z.infer<typeof CompactionTurnItem>;
export type ErrorTurnItem = z.infer<typeof ErrorTurnItem>;
export type ReviewTurnItem = z.infer<typeof ReviewTurnItem>;
