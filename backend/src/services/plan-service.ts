import { todoContentHash, normalizeTodoContent, normalizePlanRelativePath, makePlanTodoId } from "../shared/todos.js";
import type {
  RequirementBlock,
  RequirementCoverage,
  RequirementStatus,
  VerifyPlanRequest,
  VerifyPlanResult,
  PlanThreadTodos,
  PlanTraceSnapshot,
  DraftPlanRequest,
  DraftPlanResult,
  RefinePlanRequest,
  RefinePlanResult,
  ReplanRequest,
  ReplanResult,
  BuildPlanRequest,
  BuildPlanResult,
  BuildPlanTodo,
} from "../contracts/plan.js";
import {
  buildPlanRelativePath,
  nextAvailablePlanRelativePath,
} from "../shared/gui-plan.js";

/**
 * SDD plan service.
 *
 * - {@link PlanService.verifyPlan} is a PURE port of the frontend spec-coverage
 *   algorithm (the `iSe`/`K0`/`qG`/`GG`/`YG`/`JG`/`rSe` family in the Workbench
 *   bundle). No model call: it parses the requirement SPEC + plan Markdown,
 *   rolls up per-requirement coverage, derives statuses, and diffs a trace
 *   snapshot. The regexes, status ranks, and FNV-1a content hash are
 *   byte-identical to the original (the hash reuses {@link todoContentHash}).
 *
 * - {@link PlanService.draftPlan}/{@link PlanService.refinePlan}/
 *   {@link PlanService.replanPlan} are MODEL-BACKED: they build the faithful
 *   prompt (the `ASe`/`VSe` builders) and call the injected provider-agnostic
 *   {@link PlanComplete} seam — the same `complete()` adapter serve.ts builds
 *   over its positional `oneShot`, also used by the write/review/insight
 *   services. The service NEVER imports a model client.
 *
 * - {@link PlanService.buildPlan} is PURE: it extracts the tracked todo list
 *   from the plan checklist (reusing the shared todo extraction primitives).
 */

/**
 * Provider-agnostic completion function injected by the integration layer
 * (serve.ts adapts its existing `oneShot` helper into this named-object shape;
 * identical to {@link WriteComplete}). The service never imports a model client.
 */
export type PlanComplete = (input: {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}) => Promise<string>;

// --- spec-coverage regexes / ranks (byte-faithful to the bundle) ------------

/** `## R-1: title {status}` — heading levels 2..4. Captures: [, level, id, title]. (C4) */
const REQ_HEADING_RE = /^(#{2,4})\s+(R-\d+)\s*[:：]\s*(.+?)\s*$/;
/** Trailing `{status}` suffix on a requirement title. (XG) */
const STATUS_SUFFIX_RE = /\{\s*(draft|planned|building|done|verified)\s*\}\s*$/;
/** A GitHub task-list line: `- [ ] text` / `* [x] text`. ($1=marker,$2=text). (T4) */
const TASK_LINE_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
/** A `(covers: R-1, R-3)` tag on a plan step. ($1=comma-list of ids). (w5) */
const COVERS_TAG_RE = /[（(]\s*covers\s*[:：]\s*([Rr]-\d+(?:\s*[,，、]\s*[Rr]-\d+)*)\s*[)）]/;
/** Split a covers id-list on ASCII/CJK commas. */
const ID_SPLIT_RE = /[,，、]/;
/** A valid requirement id. */
const ID_VALID_RE = /^R-\d+$/;
/** A heading of any level (used to close an open requirement block). */
const ANY_HEADING_RE = /^(#{1,6})\s/;
/** A fenced-code fence opener/closer. */
const FENCE_RE = /^\s*(```|~~~)/;

/** Status rank: draft < planned < building < done < verified. (y5 / _Q) */
const STATUS_RANK: Record<RequirementStatus, number> = {
  draft: 0,
  planned: 1,
  building: 2,
  done: 3,
  verified: 4,
};

/** Split a requirement title's trailing `{status}` suffix (default "draft"). (A4) */
function splitStatusSuffix(value: string): { title: string; status: RequirementStatus } {
  const match = STATUS_SUFFIX_RE.exec(value);
  if (match) {
    return { title: value.slice(0, match.index).trim(), status: match[1] as RequirementStatus };
  }
  return { title: value.trim(), status: "draft" };
}

/** FNV-1a-32 content hash over normalized+lowercased text. (UG == todoContentHash). */
function requirementContentHash(value: string): string {
  return todoContentHash(value);
}

/**
 * Parse requirement blocks from the SPEC Markdown. (K0)
 *
 * Tracks fenced-code state (lines inside fences are body, never parsed). On a
 * heading whose level ≤ the open block's level, the open block is closed
 * (`endLineIndex`). Matching `### R-N: title {status}` opens a new block; its
 * body lines feed the content hash and any `- [ ]` lines become acceptance.
 */
export function parseRequirementBlocks(requirementMarkdown: string): RequirementBlock[] {
  const lines = requirementMarkdown.split(/\r?\n/);
  const blocks: RequirementBlock[] = [];
  let open:
    | {
        id: string;
        title: string;
        status: RequirementStatus;
        headingLevel: number;
        headingLineIndex: number;
        acceptance: RequirementBlock["acceptance"];
        bodyLines: string[];
      }
    | null = null;
  let inFence = false;

  const close = (endLineIndex: number): void => {
    if (!open) return;
    blocks.push({
      id: open.id,
      title: open.title,
      status: open.status,
      headingLevel: open.headingLevel,
      headingLineIndex: open.headingLineIndex,
      endLineIndex,
      acceptance: open.acceptance,
      contentHash: requirementContentHash(`${open.title}\n${open.bodyLines.join("\n")}`),
    });
    open = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) {
      open?.bodyLines.push(line);
      continue;
    }
    const heading = ANY_HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const reqMatch = REQ_HEADING_RE.exec(line);
      if (open && level <= open.headingLevel) close(index);
      if (reqMatch) {
        const { title, status } = splitStatusSuffix(reqMatch[3]);
        open = {
          id: reqMatch[2].toUpperCase(),
          title,
          status,
          headingLevel: reqMatch[1].length,
          headingLineIndex: index,
          acceptance: [],
          bodyLines: [],
        };
      }
      continue;
    }
    if (!open) continue;
    open.bodyLines.push(line);
    const task = TASK_LINE_RE.exec(line);
    if (task) {
      open.acceptance.push({ text: task[2].trim(), checked: task[1] !== " ", lineIndex: index });
    }
  }
  close(lines.length);
  return blocks;
}

/** A plan checklist step that carries a `(covers: …)` tag. */
interface PlanCoverageTodo {
  requirementIds: string[];
  text: string;
  rawText: string;
  checked: boolean;
  lineIndex: number;
}

/**
 * Parse plan todos from the PLAN Markdown. (qG)
 *
 * Only `- [ ]` lines whose text carries a valid `(covers: R-N, …)` tag emit a
 * coverage todo; the covers tag is stripped from the displayed `text`.
 */
export function parsePlanCoverageTodos(planMarkdown: string): PlanCoverageTodo[] {
  const todos: PlanCoverageTodo[] = [];
  const lines = planMarkdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const task = TASK_LINE_RE.exec(lines[index]);
    if (!task) continue;
    const text = task[2];
    const covers = COVERS_TAG_RE.exec(text);
    if (!covers) continue;
    const requirementIds = covers[1]
      .split(ID_SPLIT_RE)
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ID_VALID_RE.test(id));
    if (requirementIds.length === 0) continue;
    todos.push({
      requirementIds,
      text: text.replace(COVERS_TAG_RE, "").trim(),
      rawText: text.trim(),
      checked: task[1] !== " ",
      lineIndex: index,
    });
  }
  return todos;
}

/** Per-requirement coverage rollup + the uncovered ids. (GG) */
function rollUpCoverage(
  requirements: RequirementBlock[],
  planTodos: PlanCoverageTodo[],
): { perRequirement: RequirementCoverage[]; uncoveredIds: string[] } {
  const perRequirement = requirements.map((requirement) => {
    const hits = planTodos.filter((todo) => todo.requirementIds.includes(requirement.id));
    return {
      id: requirement.id,
      totalSteps: hits.length,
      doneSteps: hits.filter((todo) => todo.checked).length,
    };
  });
  return {
    perRequirement,
    uncoveredIds: perRequirement.filter((p) => p.totalSteps === 0).map((p) => p.id),
  };
}

/** Per-requirement derived status, only bumping UP the rank ladder. (YG) */
function deriveStatuses(
  requirements: RequirementBlock[],
  perRequirement: RequirementCoverage[],
): Record<string, RequirementStatus> {
  const derived: Record<string, RequirementStatus> = {};
  for (const requirement of requirements) {
    const coverage = perRequirement.find((p) => p.id === requirement.id);
    if (!coverage || coverage.totalSteps === 0) continue;
    const candidate: RequirementStatus =
      coverage.doneSteps === coverage.totalSteps ? "done" : coverage.doneSteps > 0 ? "building" : "planned";
    if (STATUS_RANK[candidate] > STATUS_RANK[requirement.status]) {
      derived[requirement.id] = candidate;
    }
  }
  return derived;
}

/**
 * Look up a covering plan step's runtime status from the thread-todos. (rSe)
 *
 * Matches a thread-todo whose `source.kind==="plan"` and
 * `source.relativePath===planRelativePath` and whose contentHash (or
 * re-hashed content) equals the hash of this step's raw text.
 */
function lookupThreadTodoStatus(
  todo: PlanCoverageTodo,
  threadTodos: PlanThreadTodos | undefined,
  planRelativePath: string | undefined,
): "pending" | "in_progress" | "completed" | null {
  if (!threadTodos) return null;
  const target = todoContentHash(todo.rawText);
  for (const item of threadTodos.items) {
    const source = item.source;
    if (
      source?.kind === "plan" &&
      source.relativePath === planRelativePath &&
      (source.contentHash === target || todoContentHash(item.content) === target)
    ) {
      return item.status;
    }
  }
  return null;
}

/** Diff a trace snapshot: changed = hash differs, added = id absent in snapshot. (JG) */
function diffTrace(
  requirementMarkdown: string,
  snapshot: PlanTraceSnapshot,
): { changedIds: string[]; addedIds: string[] } {
  const changedIds: string[] = [];
  const addedIds: string[] = [];
  for (const requirement of parseRequirementBlocks(requirementMarkdown)) {
    const previous = snapshot.requirementHashes[requirement.id];
    if (previous === undefined) addedIds.push(requirement.id);
    else if (previous !== requirement.contentHash) changedIds.push(requirement.id);
  }
  return { changedIds, addedIds };
}

/**
 * Capture a trace snapshot from the current requirement Markdown. (P4) Exposed
 * so a caller (or a future trace.json writer) can persist `requirementHashes`.
 */
export function captureTraceSnapshot(
  requirementMarkdown: string,
  planRelativePath: string,
  now: Date = new Date(),
): PlanTraceSnapshot {
  const requirementHashes: Record<string, string> = {};
  for (const requirement of parseRequirementBlocks(requirementMarkdown)) {
    requirementHashes[requirement.id] = requirement.contentHash;
  }
  return { requirementHashes, planRelativePath, capturedAt: now.toISOString() };
}

// --- prompt templates (byte-faithful to the bundle) -------------------------

const CREATE_PLAN_TOOL_NAME = "create_plan";
const GUI_PLAN_OPEN = "<gui_plan>";
const GUI_PLAN_CLOSE = "</gui_plan>";

const DRAFT_INTRO = "Nexus is asking you to upgrade an SDD requirement draft into a concrete implementation plan.";
const REFINE_INTRO = "Nexus is asking you to revise an existing GUI-owned implementation plan.";

/** Build the `draft` (build-plan-from-spec) prompt. (ASe) */
function buildDraftPrompt(input: {
  spec: string;
  workspaceRoot?: string;
  draftRelativePath?: string;
  planRelativePath: string;
  assistantContext?: string;
}): string {
  const lines: string[] = [
    DRAFT_INTRO,
    `Workspace: ${input.workspaceRoot ?? "."}`,
    `Draft file: ${input.draftRelativePath ?? "(inline draft)"}`,
    `Reserved plan file: ${input.planRelativePath}`,
    "",
    "You MUST use the `create_plan` tool exactly once to save the final plan.",
    "- Set `operation` to `draft`.",
    "- Set `markdown` to the complete executable implementation plan.",
    "- Set `source_request` to a concise summary of the SDD draft.",
    "- Set `title` to a short feature title derived from the requirement.",
    `- Set \`plan_relative_path\` to \`${input.planRelativePath}\`.`,
    "- Do not edit project files directly during this planning turn.",
    "- Save exactly to the reserved plan file above.",
    "",
    "Requirement draft Markdown:",
    "```markdown",
    input.spec.trim(),
    "```",
    "",
  ];
  if (input.assistantContext?.trim()) {
    lines.push(
      "Requirement AI conversation context:",
      "Use this as supporting context from the sidebar Requirement AI conversation. The draft remains the source of truth when there is a conflict.",
      "```text",
      input.assistantContext.trim(),
      "```",
      "",
    );
  }
  lines.push(
    "",
    "Plan expectations:",
    "- Preserve the user intent from the draft.",
    "- Turn fuzzy requirement notes into concrete implementation steps.",
    "- Include UI/data-flow/API behavior where relevant.",
    "- Include tests and acceptance criteria.",
    "- If images affect requirements, cite them by Image N in the plan.",
    "",
    "Requirement traceability (covers tags):",
    "- The draft may contain structured requirement blocks: level-3 headings like `### R-1: title {status}` followed by a description and an acceptance checklist.",
    "- When requirement blocks exist, every actionable `- [ ]` step in the plan MUST end with a covers tag linking it to the requirement ids it implements, e.g. `- [ ] Implement export API (covers: R-1)` or `(covers: R-1, R-3)`.",
    "- Together the steps must cover every requirement id present in the draft. Do not leave any R-id uncovered, and do not invent R-ids that are not in the draft.",
    "- Steps that are pure scaffolding may omit the covers tag, but prefer attaching them to the closest requirement.",
  );
  return lines.join("\n");
}

/** Build the `refine`/`replan` prompt. (VSe) */
function buildRefinePrompt(input: {
  planMarkdown: string;
  feedback: string;
  planRelativePath: string;
}): string {
  return [
    REFINE_INTRO,
    `The GUI will overwrite \`${input.planRelativePath}\` with your revised Markdown.`,
    `You MUST use the \`${CREATE_PLAN_TOOL_NAME}\` tool to save the revised plan. Call it exactly once with:`,
    "- `operation` set to `refine`",
    "- `markdown` set to the complete revised Markdown",
    "- `source_request` set to the original request if known",
    "- `title` set to the existing or updated short feature title",
    `- \`plan_relative_path\` set to \`${input.planRelativePath}\``,
    "Do not call any other tools for this planning turn. Do not edit project files directly.",
    "",
    "User feedback:",
    input.feedback.trim(),
    "",
    "Current plan:",
    "```markdown",
    input.planMarkdown.trim(),
    "```",
    "",
    "Suggested revised Markdown (write the full revised plan into the tool call):",
    GUI_PLAN_OPEN,
    "<complete revised markdown plan>",
    GUI_PLAN_CLOSE,
  ].join("\n");
}

/**
 * System prompts for the model-backed ops. The backend variant drives the model
 * to RETURN the plan Markdown directly (no `create_plan` tool surface here — the
 * tool path is the frontend's turn-based flow); the user prompt above keeps the
 * full faithful instruction set so the model produces a complete plan.
 */
const DRAFT_SYSTEM =
  "You are an SDD implementation-planning engine. Produce a complete, executable implementation plan in Markdown for the supplied requirement draft, following the traceability rules. " +
  "Return ONLY the plan Markdown — no preamble, no code fences wrapping the whole document, no commentary.";
const REFINE_SYSTEM =
  "You are an SDD implementation-planning engine. Revise the supplied GUI-owned plan per the user feedback, preserving traceability `(covers: R-N)` tags. " +
  "Return ONLY the complete revised plan Markdown — no preamble, no surrounding code fences, no commentary, and no `<gui_plan>` wrapper.";

const DRAFT_MAX_TOKENS = 4096;
const REFINE_MAX_TOKENS = 4096;

/**
 * Strip a wrapping `<gui_plan>…</gui_plan>` envelope and/or an outer fenced code
 * block the model occasionally returns, leaving the raw plan Markdown.
 */
function sanitizePlanOutput(raw: string): string {
  let out = raw.trim();
  const wrapped = new RegExp(`^${GUI_PLAN_OPEN}\\n?([\\s\\S]*?)\\n?${GUI_PLAN_CLOSE}\\s*$`).exec(out);
  if (wrapped && wrapped[1] !== undefined) out = wrapped[1].trim();
  const fence = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(out);
  if (fence && fence[1] !== undefined) out = fence[1];
  return out.trim();
}

export interface PlanServiceDeps {
  complete: PlanComplete;
}

/** SDD plan service (see file header). */
export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  /**
   * PURE spec-coverage verification (the `iSe` family). No model call. Parses
   * the requirement SPEC + plan Markdown, rolls up per-requirement coverage,
   * derives statuses, bumps in-progress requirements to `building`, and diffs a
   * trace snapshot. Byte-faithful to the original frontend algorithm.
   */
  verifyPlan(request: VerifyPlanRequest): VerifyPlanResult {
    const blocks = parseRequirementBlocks(request.specMarkdown);
    const rawTodos = request.planMarkdown ? parsePlanCoverageTodos(request.planMarkdown) : [];

    // Fold runtime thread-todo status in: in_progress requirements get bumped to
    // `building`; completed steps are treated as checked for coverage.
    const inProgressIds = new Set<string>();
    const todos = rawTodos.map((todo) => {
      const status = lookupThreadTodoStatus(todo, request.threadTodos, request.planRelativePath);
      if (status === "in_progress") {
        for (const id of todo.requirementIds) inProgressIds.add(id);
      }
      return status === "completed" ? { ...todo, checked: true } : todo;
    });

    const { perRequirement, uncoveredIds } = rollUpCoverage(blocks, todos);
    const derivedStatuses = deriveStatuses(blocks, perRequirement);

    for (const id of inProgressIds) {
      const block = blocks.find((b) => b.id === id);
      if (!block) continue;
      const current = derivedStatuses[id] ?? block.status;
      if (STATUS_RANK[current] < STATUS_RANK.building) derivedStatuses[id] = "building";
    }

    const diff = request.traceSnapshot
      ? diffTrace(request.specMarkdown, request.traceSnapshot)
      : { changedIds: [], addedIds: [] };

    return {
      blocks,
      perRequirement,
      uncoveredIds,
      derivedStatuses,
      changedIds: diff.changedIds,
      addedIds: diff.addedIds,
    };
  }

  /** MODEL-BACKED: build an implementation plan from an SDD draft. (draft / ASe) */
  async draftPlan(request: DraftPlanRequest, signal?: AbortSignal): Promise<DraftPlanResult> {
    const planRelativePath = request.planRelativePath
      ? normalizePlanRelativePath(request.planRelativePath)
      : request.existingPaths && request.existingPaths.length > 0
        ? nextAvailablePlanRelativePath(deriveFeatureName(request.featureName), request.existingPaths)
        : buildPlanRelativePath(deriveFeatureName(request.featureName));

    const prompt = buildDraftPrompt({
      spec: request.spec,
      ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
      planRelativePath,
      ...(request.assistantContext ? { assistantContext: request.assistantContext } : {}),
    });
    const raw = await this.deps.complete({
      system: DRAFT_SYSTEM,
      prompt,
      maxTokens: DRAFT_MAX_TOKENS,
      ...(request.model ? { model: request.model } : {}),
      ...(signal ? { signal } : {}),
    });
    return { content: sanitizePlanOutput(raw), planRelativePath };
  }

  /** MODEL-BACKED: revise an existing plan per user feedback. (refine / VSe) */
  async refinePlan(request: RefinePlanRequest, signal?: AbortSignal): Promise<RefinePlanResult> {
    const feedback = request.spec?.trim()
      ? `${request.instruction.trim()}\n\nRequirement SPEC (for context):\n${request.spec.trim()}`
      : request.instruction;
    const prompt = buildRefinePrompt({
      planMarkdown: request.planMarkdown,
      feedback,
      planRelativePath: request.planRelativePath ?? "(reserved plan path)",
    });
    const raw = await this.deps.complete({
      system: REFINE_SYSTEM,
      prompt,
      maxTokens: REFINE_MAX_TOKENS,
      ...(request.model ? { model: request.model } : {}),
      ...(signal ? { signal } : {}),
    });
    return { content: sanitizePlanOutput(raw) };
  }

  /**
   * MODEL-BACKED: re-plan changed/added requirements. (replan / VSe with the
   * changed/added R-ids as the feedback). Reuses the refine template.
   */
  async replanPlan(request: ReplanRequest, signal?: AbortSignal): Promise<ReplanResult> {
    const ids = request.changedIds.filter((id) => ID_VALID_RE.test(id));
    const idList = ids.length > 0 ? ids.join(", ") : "(all changed requirements)";
    const feedback =
      `The following requirements changed or were added and must be re-covered: ${idList}.\n` +
      "Update the plan so every actionable step still carries a `(covers: R-N)` tag and every requirement id is covered.\n\n" +
      `Requirement SPEC:\n${request.spec.trim()}`;
    const prompt = buildRefinePrompt({
      planMarkdown: request.planMarkdown,
      feedback,
      planRelativePath: request.planRelativePath ?? "(reserved plan path)",
    });
    const raw = await this.deps.complete({
      system: REFINE_SYSTEM,
      prompt,
      maxTokens: REFINE_MAX_TOKENS,
      ...(request.model ? { model: request.model } : {}),
      ...(signal ? { signal } : {}),
    });
    return { content: sanitizePlanOutput(raw) };
  }

  /**
   * PURE: extract the tracked todo list from the plan checklist. Mirrors the
   * `extractPlanTodos` provenance but is self-contained so callers without a
   * plan id still get stable per-line ids.
   */
  buildPlan(request: BuildPlanRequest, now: string = new Date().toISOString()): BuildPlanResult {
    const planId = request.planId ?? request.threadId ?? "gui-plan";
    const relativePath = normalizePlanRelativePath(request.planRelativePath ?? "");
    const todos: BuildPlanTodo[] = [];
    const lines = request.planMarkdown.split(/\r?\n/);
    let ordinal = 0;
    for (const line of lines) {
      const match = TASK_LINE_RE.exec(line);
      if (!match) continue;
      const content = normalizeTodoContent(match[2] ?? "");
      if (!content) continue;
      const contentHash = todoContentHash(content);
      const todo: BuildPlanTodo = {
        id: makePlanTodoId({ planId, relativePath, ordinal, contentHash }),
        content,
        status: match[1].toLowerCase() === "x" ? "completed" : "pending",
        source: { kind: "plan", planId, relativePath, ordinal, contentHash },
      };
      todos.push(todo);
      ordinal += 1;
    }
    void now;
    return { todos };
  }
}

/** Sanitize a feature name into a filesystem-safe slug (mirrors create-plan-tool). */
function deriveFeatureName(seed: string): string {
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
