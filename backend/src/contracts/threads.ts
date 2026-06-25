import { z } from "zod";
import {
  ApprovalPolicySchema,
  SandboxModeSchema,
  TurnModeSchema,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
} from "./policy.js";
import { TurnSchema } from "./turns.js";

export const ThreadStatus = z.enum(["idle", "running", "paused", "archived", "deleted"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const ThreadRelation = z.enum(["primary", "fork", "side"]);
export type ThreadRelation = z.infer<typeof ThreadRelation>;

// ---- Goal ------------------------------------------------------------------

export const ThreadGoalStatus = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000;

export const ThreadGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().trim().min(1).max(MAX_THREAD_GOAL_OBJECTIVE_CHARS),
  status: ThreadGoalStatus,
  tokenBudget: z.number().int().positive().nullable().optional(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ThreadGoal = z.infer<typeof ThreadGoalSchema>;

// ---- Todos -----------------------------------------------------------------

export const ThreadTodoStatus = z.enum(["pending", "in_progress", "completed"]);
export type ThreadTodoStatus = z.infer<typeof ThreadTodoStatus>;

/** Provenance for a todo synthesized from a plan document. */
export const ThreadTodoSourceSchema = z.object({
  kind: z.literal("plan"),
  planId: z.string().min(1),
  relativePath: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
});
export type ThreadTodoSource = z.infer<typeof ThreadTodoSourceSchema>;

export const MAX_THREAD_TODO_CONTENT_CHARS = 1000;
export const MAX_THREAD_TODOS = 200;

export const ThreadTodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1).max(MAX_THREAD_TODO_CONTENT_CHARS),
  status: ThreadTodoStatus,
  source: ThreadTodoSourceSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ThreadTodoItem = z.infer<typeof ThreadTodoItemSchema>;

export const ThreadTodoListSchema = z
  .object({
    threadId: z.string().min(1),
    items: z.array(ThreadTodoItemSchema).max(MAX_THREAD_TODOS),
    updatedAt: z.string(),
  })
  .superRefine((value, ctx) => {
    const inProgress = value.items.filter((item) => item.status === "in_progress").length;
    if (inProgress > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "at most one todo can be in_progress",
      });
    }
  });
export type ThreadTodoList = z.infer<typeof ThreadTodoListSchema>;

// ---- Thread ----------------------------------------------------------------

export const ThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  workspace: z.string(),
  model: z.string(),
  mode: TurnModeSchema,
  status: ThreadStatus,
  approvalPolicy: ApprovalPolicySchema.default(DEFAULT_APPROVAL_POLICY),
  sandboxMode: SandboxModeSchema.default(DEFAULT_SANDBOX_MODE),
  costBudgetUsd: z.number().positive().optional(),
  costBudgetWarningSent: z.boolean().optional(),
  relation: ThreadRelation.default("primary"),
  parentThreadId: z.string().optional(),
  forkedFromThreadId: z.string().optional(),
  forkedFromTitle: z.string().optional(),
  forkedAt: z.string().optional(),
  forkedFromMessageCount: z.number().int().nonnegative().optional(),
  forkedFromTurnCount: z.number().int().nonnegative().optional(),
  goal: ThreadGoalSchema.optional(),
  todos: ThreadTodoListSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z.array(TurnSchema).default([]),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ThreadSummarySchema = ThreadSchema.omit({ turns: true });
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

// ---- Requests / responses --------------------------------------------------

export const CreateThreadRequest = z.object({
  title: z.string().optional(),
  // Optional: the thread service fills these from the runtime defaults
  // (defaultWorkspace = config.defaultWorkspace ?? process.cwd(); defaultModel)
  // when the client omits them — so a fresh install can create a thread before
  // a workspace/model is configured. Empty strings are coerced to undefined.
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  mode: TurnModeSchema.default("agent"),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  costBudgetUsd: z.number().positive().optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const ForkThreadRequest = z
  .object({
    relation: ThreadRelation.default("fork"),
    title: z.string().optional(),
  })
  .optional();
export type ForkThreadRequest = z.infer<typeof ForkThreadRequest>;

export const UpdateThreadRequest = z
  .object({
    title: z.string().optional(),
    workspace: z.string().min(1).optional(),
    status: ThreadStatus.optional(),
    approvalPolicy: ApprovalPolicySchema.optional(),
    sandboxMode: SandboxModeSchema.optional(),
    costBudgetUsd: z.number().positive().nullable().optional(),
    costBudgetWarningSent: z.boolean().optional(),
    relation: ThreadRelation.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.workspace !== undefined ||
      v.status !== undefined ||
      v.approvalPolicy !== undefined ||
      v.sandboxMode !== undefined ||
      v.costBudgetUsd !== undefined ||
      v.costBudgetWarningSent !== undefined ||
      v.relation !== undefined,
    { message: "update request must change at least one field" },
  );
export type UpdateThreadRequest = z.infer<typeof UpdateThreadRequest>;

export const SetThreadGoalRequest = z
  .object({
    objective: z.string().trim().min(1).max(MAX_THREAD_GOAL_OBJECTIVE_CHARS).optional(),
    status: ThreadGoalStatus.optional(),
    tokenBudget: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.objective !== undefined || v.status !== undefined || v.tokenBudget !== undefined, {
    message: "goal request must change at least one field",
  });
export type SetThreadGoalRequest = z.infer<typeof SetThreadGoalRequest>;

export const ThreadGoalResponse = z.object({ goal: ThreadGoalSchema.nullable() });
export type ThreadGoalResponse = z.infer<typeof ThreadGoalResponse>;

export const ClearThreadGoalResponse = z.object({ cleared: z.boolean() });
export type ClearThreadGoalResponse = z.infer<typeof ClearThreadGoalResponse>;

export const SetThreadTodosRequest = z
  .object({
    todos: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          content: z.string().trim().min(1).max(MAX_THREAD_TODO_CONTENT_CHARS),
          status: ThreadTodoStatus,
          source: ThreadTodoSourceSchema.optional(),
        }),
      )
      .max(MAX_THREAD_TODOS),
  })
  .superRefine((value, ctx) => {
    const inProgress = value.todos.filter((item) => item.status === "in_progress").length;
    if (inProgress > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["todos"], message: "at most one todo can be in_progress" });
    }
  });
export type SetThreadTodosRequest = z.infer<typeof SetThreadTodosRequest>;

export const ThreadTodosResponse = z.object({ todos: ThreadTodoListSchema.nullable() });
export type ThreadTodosResponse = z.infer<typeof ThreadTodosResponse>;

export const ClearThreadTodosResponse = z.object({ cleared: z.boolean() });
export type ClearThreadTodosResponse = z.infer<typeof ClearThreadTodosResponse>;

export const ListThreadsResponse = z.object({ threads: z.array(ThreadSummarySchema) });
export const DeleteThreadResponse = z.object({ id: z.string().min(1), deleted: z.literal(true) });
