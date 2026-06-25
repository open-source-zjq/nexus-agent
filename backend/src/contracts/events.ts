import { z } from "zod";
import { TurnItem, UserInputQuestionSchema } from "./items.js";
import { ThreadGoalSchema, ThreadTodoListSchema } from "./threads.js";
import { UsageSnapshotSchema } from "./usage.js";
import { ApprovalPolicySchema, SandboxModeSchema } from "./policy.js";
import { RuntimeErrorSeverity } from "./errors.js";

/** Pipeline stage markers surfaced for observability while a turn runs. */
export const PipelineStage = z.enum([
  "setup",
  "pre_start",
  "post_start",
  "input_received",
  "input_routed",
  "input_compressed",
  "input_cached",
  "input_remembered",
  "pre_send",
  "post_send",
  "response_received",
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

/** Identifies an event produced by a child (delegated) agent run. */
export const RuntimeEventChildEnvelopeSchema = z.object({
  parentThreadId: z.string().min(1),
  parentTurnId: z.string().min(1),
  childId: z.string().min(1),
  childLabel: z.string().optional(),
  childStatus: z.enum(["queued", "running", "completed", "failed", "aborted"]),
  childSeq: z.number().int().nonnegative(),
});
export type RuntimeEventChildEnvelope = z.infer<typeof RuntimeEventChildEnvelopeSchema>;

const RuntimeEventBase = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  threadId: z.string().min(1),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  /** Present when the event originated from a child (delegated) agent run. */
  child: RuntimeEventChildEnvelopeSchema.optional(),
});

const ItemEvent = RuntimeEventBase.extend({
  kind: z.enum([
    "item_created",
    "item_updated",
    "item_completed",
    "assistant_text_delta",
    "assistant_reasoning_delta",
    "tool_call_started",
    "tool_call_finished",
  ]),
  item: TurnItem,
  /** Incremental text for *_delta events. */
  delta: z.string().optional(),
});

const ThreadLifecycleEvent = RuntimeEventBase.extend({
  kind: z.enum(["thread_created", "thread_updated"]),
  title: z.string().optional(),
  status: z.string().optional(),
});

const TurnLifecycleEvent = RuntimeEventBase.extend({
  kind: z.enum(["turn_started", "turn_completed", "turn_failed", "turn_aborted", "turn_steered"]),
  status: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  severity: RuntimeErrorSeverity.optional(),
});

const ApprovalEvent = RuntimeEventBase.extend({
  kind: z.enum(["approval_requested", "approval_resolved"]),
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  summary: z.string().optional(),
});

const UserInputEvent = RuntimeEventBase.extend({
  kind: z.enum(["user_input_requested", "user_input_resolved"]),
  inputId: z.string().min(1),
  status: z.enum(["pending", "submitted", "cancelled"]),
  /** Item the request/resolution is attached to (forwarded from the pending
   *  gate record). Mirrors the original loop, which records `itemId` on both
   *  the user_input_requested and user_input_resolved events. */
  itemId: z.string().optional(),
  prompt: z.string().optional(),
  /** Structured multi-question form surfaced to the UI. */
  questions: z.array(UserInputQuestionSchema).optional(),
});

const ToolCallReadyEvent = RuntimeEventBase.extend({
  kind: z.literal("tool_call_ready"),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  readyCount: z.number().int().positive(),
});

const ToolStormSuppressedEvent = RuntimeEventBase.extend({
  kind: z.literal("tool_storm_suppressed"),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  message: z.string(),
});

const ToolCatalogEvent = RuntimeEventBase.extend({
  kind: z.literal("tool_catalog_changed"),
  fingerprint: z.string().min(1),
  toolCount: z.number().int().nonnegative(),
  changeKind: z.enum(["additive", "breaking"]).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  message: z.string().optional(),
});

const CompactionEvent = RuntimeEventBase.extend({
  kind: z.enum(["compaction_started", "compaction_completed"]),
  summary: z.string().optional(),
  replacedTokens: z.number().int().nonnegative().optional(),
  pinnedConstraints: z.array(z.string()).optional(),
  sourceDigest: z.string().min(1).optional(),
  digestMarker: z.string().min(1).optional(),
  sourceItemIds: z.array(z.string().min(1)).optional(),
});

const GoalEvent = RuntimeEventBase.extend({
  kind: z.enum(["goal_updated", "goal_cleared"]),
  goal: ThreadGoalSchema.nullable().optional(),
  cleared: z.boolean().optional(),
});

const TodoEvent = RuntimeEventBase.extend({
  kind: z.enum(["todos_updated", "todos_cleared"]),
  todos: ThreadTodoListSchema.nullable().optional(),
  cleared: z.boolean().optional(),
});

const UsageEvent = RuntimeEventBase.extend({
  kind: z.literal("usage"),
  model: z.string().optional(),
  usage: UsageSnapshotSchema,
});

const PipelineStageEvent = RuntimeEventBase.extend({
  kind: z.literal("pipeline_stage"),
  stage: PipelineStage,
  label: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ErrorEvent = RuntimeEventBase.extend({
  kind: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  severity: RuntimeErrorSeverity.optional(),
});

/** Detectors that can publish a proactive suggestion / insight decision. */
const InsightDetector = z.enum(["knowledge_capture", "meeting_alignment", "data_to_sheet"]);

const SuggestionEvent = RuntimeEventBase.extend({
  kind: z.literal("suggestion"),
  suggestionId: z.string().min(1),
  detector: InsightDetector,
  title: z.string().min(1),
  confidence: z.number().min(0).max(1),
  topic: z.string().optional(),
  /** Detector-specific draft payload the UI can act on. Optional so the host
   *  emitter (which surfaces a flat detail/source) keeps compiling. */
  draftPayload: z.record(z.string(), z.unknown()).optional(),
  detail: z.string().optional(),
  source: z.string().optional(),
});

const InsightDecisionEvent = RuntimeEventBase.extend({
  kind: z.literal("insight_decision"),
  detector: InsightDetector,
  reason: z.enum([
    "published",
    "prefilter_skipped",
    "dismissed",
    "cooldown",
    "model_error",
    "unparseable",
    "type_mismatch",
    "below_confidence",
  ]),
  detail: z.string(),
  topic: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ToolUploadStatusEvent = RuntimeEventBase.extend({
  kind: z.literal("tool_result_upload_wait"),
  status: z.literal("waiting"),
  toolResultCount: z.number().int().nonnegative(),
});

const HeartbeatEvent = RuntimeEventBase.extend({ kind: z.literal("heartbeat") });

export const RuntimeEvent = z.discriminatedUnion("kind", [
  ItemEvent,
  ThreadLifecycleEvent,
  TurnLifecycleEvent,
  ApprovalEvent,
  UserInputEvent,
  ToolCallReadyEvent,
  ToolStormSuppressedEvent,
  ToolCatalogEvent,
  CompactionEvent,
  GoalEvent,
  TodoEvent,
  PipelineStageEvent,
  UsageEvent,
  SuggestionEvent,
  InsightDecisionEvent,
  ToolUploadStatusEvent,
  ErrorEvent,
  HeartbeatEvent,
]);
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;
export type RuntimeEventKind = RuntimeEvent["kind"];

/** Event without the transport-allocated `seq`/`timestamp` (the recorder fills them). */
export type RuntimeEventInput = DistributiveOmit<RuntimeEvent, "seq" | "timestamp">;

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
