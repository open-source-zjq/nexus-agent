import { createHash } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { LocalTool, ToolContext } from "./types.js";
import { defineTool } from "./types.js";
import { canWritePath } from "./sandbox.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import type { ThreadTodoStatus, ThreadTodoSource } from "../../contracts/threads.js";
import { extractPlanTodos, mergePlanTodos, type PlanTodo } from "../../shared/todos.js";
import {
  GUI_PLAN_RELATIVE_DIR,
  buildGuiPlanId,
  guiPlanWorkspaceMatches,
  isGuiPlanCurrentRelativePath,
  isGuiPlanRelativePath,
  nextAvailablePlanRelativePath,
} from "../../shared/gui-plan.js";

const CREATE_PLAN_TOOL_NAME = "create_plan";

const TOOL_DESCRIPTION = [
  "Create or replace a GUI-owned implementation plan.",
  "Available throughout a Plan-mode conversation: investigate first, then",
  "call this once you understand the task to save the full Markdown plan.",
  "Writes the supplied Markdown to a reserved plan artifact under",
  ".nexus-plan/plan and returns structured metadata. Call again to revise.",
].join(" ");

const CREATE_PLAN_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    markdown: {
      type: "string",
      description: "Complete Markdown plan content to save.",
    },
    source_request: {
      type: "string",
      description: "Original user request that this plan answers.",
    },
    title: {
      type: "string",
      description: "Short display title for the plan.",
    },
    operation: {
      type: "string",
      enum: ["draft", "refine"],
      description: 'Use "draft" for a new plan, "refine" when revising an existing one.',
    },
    plan_id: {
      type: "string",
      description: "Optional reserved plan id; when supplied, must match the GUI plan context.",
    },
    plan_relative_path: {
      type: "string",
      description: "Optional reserved relative path; must live directly under .nexus-plan/plan.",
    },
  },
  required: ["markdown", "operation"],
  additionalProperties: false,
};

/** A todo as accepted by the thread store's setTodos. */
export interface PlanDerivedTodo {
  id?: string;
  content: string;
  status: ThreadTodoStatus;
  source?: ThreadTodoSource;
}

/** Dependencies the create_plan tool needs to persist plan state for a thread. */
export interface CreatePlanToolDeps {
  /** Persist the derived todo list for the thread. */
  setTodos: (threadId: string, todos: PlanDerivedTodo[]) => Promise<unknown> | unknown;
  /**
   * Optional: read the thread's existing todos so re-running create_plan
   * preserves prior statuses (completed checkboxes survive a re-derivation).
   */
  getTodos?: (
    threadId: string,
  ) => Promise<{ items: PlanTodo[] } | null | undefined> | { items: PlanTodo[] } | null | undefined;
  /** Optional: persist the raw plan markdown for the thread. */
  setPlan?: (threadId: string, planMarkdown: string) => Promise<void> | void;
  /** Optional: resolve/rewrite the effective workspace root before writing. */
  resolveWorkspaceRoot?: (workspaceRoot: string) => Promise<string> | string;
  /** Optional: override the default plan writer (atomic temp+rename through the mutation queue). */
  writePlan?: (target: PlanWriteTarget, signal: AbortSignal) => Promise<PlanWriteResult>;
  /** Optional: list existing plan relative paths (instead of reading the reserved dir). */
  listPlanFiles?: (workspaceRoot: string) => Promise<string[]> | string[];
  /** Optional: workspace root to fall back to when the context has none. */
  defaultWorkspaceRoot?: string;
}

/** The reserved-target write request passed to the plan writer. */
export interface PlanWriteTarget {
  workspaceRoot: string;
  relativePath: string;
  absolutePath: string;
  markdown: string;
}

/** Result of a plan write. */
export interface PlanWriteResult {
  path: string;
  savedAt: string;
}

/**
 * Some integrations expose a thread's current GUI plan (and a synthesized
 * operation/plan-id/relative-path) on the tool context; we read it best-effort.
 * The canonical {@link ToolContext.guiPlan} carries the operation/id/path/title/
 * source-request; the plan tool additionally reads an optional `todos` seed.
 */
interface PlanAwareToolContext extends Omit<ToolContext, "guiPlan"> {
  guiPlan?: NonNullable<ToolContext["guiPlan"]> & {
    todos?: PlanTodo[];
  };
}

interface CreatePlanInput {
  markdown: string | undefined;
  source_request: string | undefined;
  title: string | undefined;
  operation: "draft" | "refine" | undefined;
  plan_id: string | undefined;
  plan_relative_path: string | undefined;
}

interface ResolvedPlanTarget {
  workspaceRoot: string;
  relativePath: string;
  planId: string;
  operation: "draft" | "refine";
  sourceRequest?: string;
  title?: string;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickOperation(value: unknown): "draft" | "refine" | undefined {
  return value === "draft" || value === "refine" ? value : undefined;
}

function computeContentFingerprint(markdown: string): { hash: string; bytes: number } {
  const bytes = Buffer.byteLength(markdown, "utf8");
  const hash = createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 16);
  return { hash, bytes };
}

function buildTempPath(target: string): string {
  const dot = target.lastIndexOf(".");
  const base = dot > 0 ? target.slice(0, dot) : target;
  const ext = dot > 0 ? target.slice(dot) : "";
  return `${base}.tmp-${process.pid}-${Date.now()}${ext}`;
}

function toRelativePath(raw: string): string {
  return raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function planDirectory(workspaceRoot: string): string {
  return isAbsolute(workspaceRoot)
    ? join(workspaceRoot, GUI_PLAN_RELATIVE_DIR)
    : join(process.cwd(), workspaceRoot, GUI_PLAN_RELATIVE_DIR);
}

function assertWithinWorkspace(absolutePath: string, workspaceRoot: string): void {
  const rel = relative(workspaceRoot, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("plan write escaped the configured workspace root");
  }
}

function deriveFeatureName(seed: string | undefined): string {
  const raw = (seed ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/[<>:"|?*\\/]+/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-\s]+/, "")
    .replace(/[.\-\s]+$/, "");
  const safe = raw.slice(0, 96).replace(/[.\-\s]+$/, "");
  return safe || "plan";
}

async function defaultWritePlan(target: PlanWriteTarget, signal: AbortSignal): Promise<PlanWriteResult> {
  return withFileMutationQueue(target.absolutePath, async () => {
    if (signal.aborted) {
      throw new Error("plan write aborted before start");
    }
    await mkdir(dirname(target.absolutePath), { recursive: true });
    const tempPath = buildTempPath(target.absolutePath);
    await writeFile(tempPath, target.markdown, "utf8");
    if (signal.aborted) {
      throw new Error("plan write aborted before atomic rename");
    }
    await rename(tempPath, target.absolutePath);
    return { path: target.absolutePath, savedAt: new Date().toISOString() };
  });
}

async function listExistingPlanRelativePaths(
  workspaceRoot: string,
  deps: CreatePlanToolDeps,
): Promise<string[]> {
  if (deps.listPlanFiles) {
    return deps.listPlanFiles(workspaceRoot);
  }
  try {
    const entries = await readdir(planDirectory(workspaceRoot));
    return entries
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .map((name) => `${GUI_PLAN_RELATIVE_DIR}/${name}`);
  } catch {
    return [];
  }
}

/** Only advertised when Plan mode or an active GUI plan is in scope. */
function isPlanToolContextActive(context: ToolContext | undefined): boolean {
  if (!context) return false;
  return Boolean(context.guiPlan) || context.threadMode === "plan";
}

function resolveReservedTarget(
  input: CreatePlanInput,
  context: PlanAwareToolContext,
): ResolvedPlanTarget | { error: string } {
  const contextPlan = context.guiPlan;
  if (!contextPlan) {
    return { error: "create_plan requires an active GUI plan context" };
  }
  if (input.operation !== contextPlan.operation) {
    return { error: "operation does not match the active GUI plan operation" };
  }
  if (!guiPlanWorkspaceMatches(context.workspace, contextPlan.workspaceRoot ?? context.workspace)) {
    return { error: "tool workspace does not match the active GUI plan workspace" };
  }
  const relativePath = toRelativePath(contextPlan.relativePath ?? "");
  if (!relativePath || !isGuiPlanRelativePath(relativePath)) {
    return { error: "plan_relative_path must be a direct Markdown file under .nexus-plan/plan" };
  }
  if (
    input.plan_relative_path &&
    toRelativePath(input.plan_relative_path) !== contextPlan.relativePath
  ) {
    return { error: "plan_relative_path does not match the reserved GUI plan path" };
  }
  if (input.plan_id && input.plan_id !== contextPlan.planId) {
    return { error: "plan_id does not match the reserved GUI plan id" };
  }
  const workspaceRoot = contextPlan.workspaceRoot ?? context.workspace;
  if (!workspaceRoot) {
    return { error: "workspace root is required" };
  }
  return {
    workspaceRoot,
    relativePath,
    planId: contextPlan.planId ?? input.plan_id ?? buildGuiPlanId(workspaceRoot, relativePath),
    operation: input.operation as "draft" | "refine",
    sourceRequest: contextPlan.sourceRequest,
    title: contextPlan.title,
  };
}

async function resolveFreeFormTarget(
  input: CreatePlanInput,
  context: PlanAwareToolContext,
  deps: CreatePlanToolDeps,
): Promise<ResolvedPlanTarget | { error: string }> {
  const workspaceRoot = context.workspace?.trim() || deps.defaultWorkspaceRoot?.trim() || "";
  if (!workspaceRoot) {
    return { error: "workspace root is required" };
  }
  let relativePath: string;
  if (input.plan_relative_path) {
    const candidate = toRelativePath(input.plan_relative_path);
    if (!candidate || !isGuiPlanCurrentRelativePath(candidate)) {
      return { error: "plan_relative_path must be a direct Markdown file under .nexus-plan/plan" };
    }
    relativePath = candidate;
  } else {
    const featureName = deriveFeatureName(input.title ?? input.source_request);
    const existing = await listExistingPlanRelativePaths(workspaceRoot, deps);
    relativePath = nextAvailablePlanRelativePath(featureName, existing);
  }
  return {
    workspaceRoot,
    relativePath,
    planId: buildGuiPlanId(workspaceRoot, relativePath),
    operation: input.operation as "draft" | "refine",
    sourceRequest: input.source_request,
    title: input.title,
  };
}

/**
 * Additive (non-source) side effect: derive a tracked todo list from the plan
 * markdown and persist it for the thread, preserving prior statuses. This keeps
 * the GUI todo feature working without affecting the source-faithful contract,
 * so failures here never fail the plan write.
 */
async function deriveAndPersistTodos(
  deps: CreatePlanToolDeps,
  context: PlanAwareToolContext,
  resolved: ResolvedPlanTarget,
  markdown: string,
): Promise<PlanTodo[] | undefined> {
  try {
    const now = context.clock.nowIso();
    const planItems = extractPlanTodos({
      markdown,
      planId: resolved.planId,
      relativePath: resolved.relativePath,
      now,
    });
    const existing =
      (await deps.getTodos?.(context.threadId)) ??
      (context.guiPlan?.todos ? { items: context.guiPlan.todos } : null);
    const merged = mergePlanTodos({
      existing: existing ?? undefined,
      planItems,
      preserveCompleted: true,
      threadId: context.threadId,
      now,
    });
    await deps.setTodos(
      context.threadId,
      merged.items.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        ...(todo.source ? { source: todo.source } : {}),
      })),
    );
    if (deps.setPlan) {
      await deps.setPlan(context.threadId, markdown);
    }
    return merged.items;
  } catch {
    // Never let the additive todo feature break the plan write.
    return undefined;
  }
}

async function executeCreatePlanTool(
  args: Record<string, unknown>,
  context: PlanAwareToolContext,
  deps: CreatePlanToolDeps,
): Promise<{ output: unknown; isError?: boolean }> {
  if (!isPlanToolContextActive(context)) {
    return {
      output: { error: "create_plan requires Plan mode or an active GUI plan context" },
      isError: true,
    };
  }
  const input: CreatePlanInput = {
    markdown: pickString(args.markdown),
    source_request: pickString(args.source_request),
    title: pickString(args.title),
    operation: pickOperation(args.operation),
    plan_id: pickString(args.plan_id),
    plan_relative_path: pickString(args.plan_relative_path),
  };
  if (input.operation !== "draft" && input.operation !== "refine") {
    return { output: { error: 'operation must be "draft" or "refine"' }, isError: true };
  }
  if (typeof input.markdown !== "string" || !input.markdown.trim()) {
    return { output: { error: "markdown is required and must be non-empty" }, isError: true };
  }
  const resolved = context.guiPlan
    ? resolveReservedTarget(input, context)
    : await resolveFreeFormTarget(input, context, deps);
  if ("error" in resolved) {
    return { output: { error: resolved.error }, isError: true };
  }
  const resolvedWorkspace = deps.resolveWorkspaceRoot
    ? await deps.resolveWorkspaceRoot(resolved.workspaceRoot)
    : resolved.workspaceRoot;
  const absolutePath = isAbsolute(resolvedWorkspace)
    ? normalize(join(resolvedWorkspace, resolved.relativePath))
    : normalize(join(planDirectory(resolvedWorkspace), basename(resolved.relativePath)));
  assertWithinWorkspace(absolutePath, resolvedWorkspace);
  const writePermission = canWritePath(absolutePath, context);
  if (!writePermission.ok) {
    return {
      output: {
        code: writePermission.code,
        error: writePermission.message,
      },
      isError: true,
    };
  }
  if (context.abortSignal.aborted) {
    return { output: { error: "plan write aborted" }, isError: true };
  }
  const writer = deps.writePlan ?? defaultWritePlan;
  const fingerprint = computeContentFingerprint(input.markdown);
  const written = await writer(
    {
      workspaceRoot: resolvedWorkspace,
      relativePath: resolved.relativePath,
      absolutePath,
      markdown: input.markdown,
    },
    context.abortSignal,
  );
  if (context.abortSignal.aborted) {
    return { output: { error: "plan write aborted" }, isError: true };
  }

  // Additive GUI todo feature: derive + persist tracked todos (best-effort).
  await deriveAndPersistTodos(deps, context, resolved, input.markdown);

  const output = {
    summary: `${resolved.operation === "refine" ? "Refined" : "Created"} GUI plan at ${resolved.relativePath}.`,
    plan_id: resolved.planId,
    workspace_root: resolvedWorkspace,
    relative_path: resolved.relativePath,
    absolute_path: written.path,
    source_request: input.source_request ?? resolved.sourceRequest,
    title: input.title ?? resolved.title,
    operation: resolved.operation,
    saved_at: written.savedAt,
    content_hash: fingerprint.hash,
    byte_size: fingerprint.bytes,
  };
  return { output };
}

/**
 * Build the `create_plan` local tool.
 *
 * Faithful port of the original nexus create_plan tool: a `file_change` tool
 * (policy `auto`) that is only advertised in Plan mode / when a GUI plan is
 * active. It writes the supplied Markdown to a reserved plan artifact under
 * `.nexus-plan/plan` (atomic temp-file + rename through the file-mutation queue),
 * enforces the workspace sandbox via {@link canWritePath}, and returns
 * structured metadata (content sha256 hash, byte size, saved-at, etc.).
 *
 * As an ADDITIVE side effect (so the GUI todo feature is preserved), it derives
 * a tracked todo list from the plan checklist and persists it via
 * `deps.setTodos`; this never affects the source-faithful write contract.
 */
export function buildCreatePlanLocalTool(deps: CreatePlanToolDeps): LocalTool {
  return defineTool({
    name: CREATE_PLAN_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    toolKind: "file_change",
    inputSchema: CREATE_PLAN_INPUT_SCHEMA,
    policy: "auto",
    shouldAdvertise: (context) => isPlanToolContextActive(context),
    execute: async (args, context) =>
      executeCreatePlanTool(args ?? {}, context as PlanAwareToolContext, deps),
  });
}
