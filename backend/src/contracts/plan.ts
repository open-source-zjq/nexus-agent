import { z } from "zod";

/**
 * SDD plan contracts — request/result schemas for the `/v1/plan/*` routes.
 *
 * The SDD ("spec-driven development") plan feature couples a requirement SPEC
 * Markdown (structured `### R-1: …` blocks + acceptance checklists) with a
 * GUI-owned implementation plan Markdown whose actionable `- [ ]` steps carry
 * `(covers: R-1, …)` traceability tags. The verify op is a PURE port of the
 * frontend spec-coverage algorithm (the `iSe`/`K0`/`qG`/`GG`/`YG`/`JG` family);
 * the draft/refine/replan ops are model-backed (they go through the injected
 * provider-agnostic completion seam and emit the full plan Markdown); build is a
 * pure todo-extraction over the plan checklist.
 *
 * Faithful to the original nexus Workbench bundle (`Workbench-*.js`): the
 * regexes, status ranks, and prompt templates are byte-identical.
 */

/** A requirement's lifecycle status (rank-ordered: draft < … < verified). */
export const RequirementStatusSchema = z.enum(["draft", "planned", "building", "done", "verified"]);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

/** A single acceptance-criteria checklist line parsed from a requirement block. */
export const RequirementAcceptanceSchema = z.object({
  text: z.string(),
  checked: z.boolean(),
  lineIndex: z.number().int().nonnegative(),
});
export type RequirementAcceptance = z.infer<typeof RequirementAcceptanceSchema>;

/** A parsed requirement block (`### R-1: title {status}` + body + acceptance). */
export const RequirementBlockSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: RequirementStatusSchema,
  headingLevel: z.number().int().positive(),
  headingLineIndex: z.number().int().nonnegative(),
  endLineIndex: z.number().int().nonnegative(),
  acceptance: z.array(RequirementAcceptanceSchema),
  contentHash: z.string(),
});
export type RequirementBlock = z.infer<typeof RequirementBlockSchema>;

/** Per-requirement coverage rollup (how many covering steps, how many done). */
export const RequirementCoverageSchema = z.object({
  id: z.string(),
  totalSteps: z.number().int().nonnegative(),
  doneSteps: z.number().int().nonnegative(),
});
export type RequirementCoverage = z.infer<typeof RequirementCoverageSchema>;

/**
 * A thread-todo snapshot the verify op consults to bump a requirement to
 * `building` when a covering step is in-progress at runtime (the `rSe` lookup).
 * Mirrors the relevant subset of {@link ThreadTodoItem}.
 */
export const PlanThreadTodoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  source: z
    .object({
      kind: z.literal("plan"),
      relativePath: z.string(),
      contentHash: z.string(),
    })
    .partial({ kind: true })
    .optional(),
});
export type PlanThreadTodo = z.infer<typeof PlanThreadTodoSchema>;

/** The set of thread-todos passed to verify (only `items` is read, like the UI). */
export const PlanThreadTodosSchema = z.object({
  items: z.array(PlanThreadTodoSchema).default([]),
  updatedAt: z.string().optional(),
});
export type PlanThreadTodos = z.infer<typeof PlanThreadTodosSchema>;

/**
 * A trace snapshot (`trace.json`): the requirement content hashes captured when
 * the plan was last (re)built, used to diff which requirements changed/added.
 */
export const PlanTraceSnapshotSchema = z.object({
  requirementHashes: z.record(z.string(), z.string()),
  planRelativePath: z.string(),
  capturedAt: z.string().optional(),
});
export type PlanTraceSnapshot = z.infer<typeof PlanTraceSnapshotSchema>;

// --- POST /v1/plan/verify (pure spec-coverage) ------------------------------

/** Request body for POST /v1/plan/verify (pure local coverage; no model call). */
export const VerifyPlanRequest = z.object({
  /** The requirement SPEC Markdown (`### R-1: …` blocks + acceptance). */
  specMarkdown: z.string(),
  /** The GUI plan Markdown whose `- [ ]` steps carry `(covers: R-N)` tags. */
  planMarkdown: z.string().default(""),
  /** Reserved plan relative path (used to match thread-todo provenance). */
  planRelativePath: z.string().optional(),
  /** Optional live thread-todos used to bump in-progress requirements. */
  threadTodos: PlanThreadTodosSchema.optional(),
  /** Optional prior trace snapshot to diff changed/added requirements. */
  traceSnapshot: PlanTraceSnapshotSchema.optional(),
});
export type VerifyPlanRequest = z.infer<typeof VerifyPlanRequest>;

/** Result of POST /v1/plan/verify — the full {@link iSe} coverage report. */
export const VerifyPlanResult = z.object({
  blocks: z.array(RequirementBlockSchema),
  perRequirement: z.array(RequirementCoverageSchema),
  uncoveredIds: z.array(z.string()),
  derivedStatuses: z.record(z.string(), RequirementStatusSchema),
  changedIds: z.array(z.string()),
  addedIds: z.array(z.string()),
});
export type VerifyPlanResult = z.infer<typeof VerifyPlanResult>;

// --- POST /v1/plan/draft (model-backed) -------------------------------------

/** Request body for POST /v1/plan/draft — build a plan from an SDD draft. */
export const DraftPlanRequest = z.object({
  /** The SDD requirement draft Markdown. */
  spec: z.string().min(1),
  /** A short feature name; used to allocate the reserved plan path. */
  featureName: z.string().min(1).default("plan"),
  /** Existing plan relative paths (for collision-free path allocation). */
  existingPaths: z.array(z.string()).optional(),
  /** Optional workspace root, recorded in the prompt's `Workspace:` line. */
  workspaceRoot: z.string().optional(),
  /** Optional reserved plan relative path; allocated under .nexus-plan/plan when omitted. */
  planRelativePath: z.string().optional(),
  /** Optional supporting sidebar AI-conversation context. */
  assistantContext: z.string().optional(),
  /** Optional model override; falls back to the seam's default. */
  model: z.string().min(1).optional(),
});
export type DraftPlanRequest = z.infer<typeof DraftPlanRequest>;

export const DraftPlanResult = z.object({
  content: z.string(),
  planRelativePath: z.string(),
});
export type DraftPlanResult = z.infer<typeof DraftPlanResult>;

// --- POST /v1/plan/refine (model-backed) ------------------------------------

/** Request body for POST /v1/plan/refine — revise an existing plan. */
export const RefinePlanRequest = z.object({
  /** The current plan Markdown to revise. */
  planMarkdown: z.string().min(1),
  /** The user feedback / instruction driving the revision. */
  instruction: z.string().min(1),
  /** Optional requirement SPEC for additional context. */
  spec: z.string().optional(),
  /** Reserved plan relative path (echoed into the prompt). */
  planRelativePath: z.string().optional(),
  /** Optional model override. */
  model: z.string().min(1).optional(),
});
export type RefinePlanRequest = z.infer<typeof RefinePlanRequest>;

export const RefinePlanResult = z.object({
  content: z.string(),
});
export type RefinePlanResult = z.infer<typeof RefinePlanResult>;

// --- POST /v1/plan/replan (model-backed) ------------------------------------

/** Request body for POST /v1/plan/replan — re-plan changed/added requirements. */
export const ReplanRequest = z.object({
  /** The current plan Markdown to revise. */
  planMarkdown: z.string().min(1),
  /** The requirement SPEC the plan must re-cover. */
  spec: z.string().min(1),
  /** The changed/added requirement ids to re-cover (e.g. ["R-1","R-3"]). */
  changedIds: z.array(z.string()).default([]),
  /** Reserved plan relative path (echoed into the prompt). */
  planRelativePath: z.string().optional(),
  /** Optional model override. */
  model: z.string().min(1).optional(),
});
export type ReplanRequest = z.infer<typeof ReplanRequest>;

export const ReplanResult = z.object({
  content: z.string(),
});
export type ReplanResult = z.infer<typeof ReplanResult>;

// --- POST /v1/plan/build (pure todo extraction) -----------------------------

/** Request body for POST /v1/plan/build — extract tracked todos from a plan. */
export const BuildPlanRequest = z.object({
  /** The plan Markdown whose `- [ ]` checklist lines become todos. */
  planMarkdown: z.string(),
  /** Optional thread id; recorded into each todo's provenance when present. */
  threadId: z.string().optional(),
  /** Optional reserved plan relative path; recorded into todo provenance. */
  planRelativePath: z.string().optional(),
  /** Optional plan id; recorded into todo provenance. */
  planId: z.string().optional(),
});
export type BuildPlanRequest = z.infer<typeof BuildPlanRequest>;

/** A single extracted todo (the structured plan-derived todo shape). */
export const BuildPlanTodoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  source: z
    .object({
      kind: z.literal("plan"),
      planId: z.string(),
      relativePath: z.string(),
      ordinal: z.number().int().nonnegative(),
      contentHash: z.string(),
    })
    .optional(),
});
export type BuildPlanTodo = z.infer<typeof BuildPlanTodoSchema>;

export const BuildPlanResult = z.object({
  todos: z.array(BuildPlanTodoSchema),
});
export type BuildPlanResult = z.infer<typeof BuildPlanResult>;

// --- POST /v1/files/write (path-safe workspace text write) ------------------

/** Request body for POST /v1/files/write — write a text file inside the workspace. */
export const WriteWorkspaceFileRequest = z.object({
  /** Optional workspace root; resolves to the default workspace when omitted. */
  workspace: z.string().optional(),
  /** Workspace-relative (or absolute, contained) path to write. */
  path: z.string().min(1),
  /** The text content to write. */
  content: z.string(),
});
export type WriteWorkspaceFileRequest = z.infer<typeof WriteWorkspaceFileRequest>;
