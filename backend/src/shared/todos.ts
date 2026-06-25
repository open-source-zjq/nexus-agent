import type { ThreadTodoStatus, ThreadTodoSource } from "../contracts/threads.js";

/**
 * Shared plan/todo helpers — faithfully ported from the original nexus
 * `shared/todos.js`.
 *
 * Todos derived from a plan markdown carry stable ids derived from a FNV-1a
 * hash of their structured `source` provenance ({planId, relativePath, ordinal,
 * contentHash}). The same checklist line keeps the same id across edits, which
 * lets us preserve user/agent-set status (completed checkboxes survive a plan
 * re-derivation) and rewrite the in-markdown checkbox marker when status flips.
 */

/** A todo item compatible with the ThreadTodoItem schema in contracts/threads.ts. */
export interface PlanTodo {
  id: string;
  content: string;
  status: ThreadTodoStatus;
  /** Structured provenance when this todo was synthesized from a plan document. */
  source?: ThreadTodoSource;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Matches a markdown task-list line, capturing the leading bullet+`[`, the
 * marker char, the trailing `]` + space, and the task text:
 * `- [ ] text`, `* [x] text`, `+ [X] text`.
 *
 * The capture-group layout ($1 prefix, $2 marker, $3 separator, $4 content)
 * is load-bearing for {@link patchPlanTodoStatus}, which rewrites only $2.
 */
const TASK_LINE_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;

/** Collapse internal whitespace and trim. */
export function normalizeTodoContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * FNV-1a (32-bit) hash of the (already-normalized + lowercased) content,
 * returned as a base-36 string.
 *
 * Per the original: the multiply-then-add step ordering is
 * `hash ^= charCode; hash = Math.imul(hash, 16777619)` (XOR first, then
 * multiply by the FNV prime). Returns `(hash >>> 0).toString(36)`.
 */
export function todoContentHash(value: string): string {
  const normalized = normalizeTodoContent(value).toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Deterministic stable id for a plan-derived todo, hashed over its full
 * structured source so identical content in different plans/files/positions
 * stays distinct: `todo_plan_<hash(planId:relativePath:ordinal:contentHash)>`.
 */
export function makePlanTodoId(input: {
  planId: string;
  relativePath: string;
  ordinal: number;
  contentHash: string;
}): string {
  const base = `${input.planId}:${input.relativePath}:${input.ordinal}:${input.contentHash}`;
  return `todo_plan_${todoContentHash(base)}`;
}

function taskMarkerToStatus(marker: string | undefined): ThreadTodoStatus {
  return marker?.toLowerCase() === "x" ? "completed" : "pending";
}

/** Normalize a relative path: backslashes -> `/`, collapse `//`, strip leading `./`. */
export function normalizePlanRelativePath(relativePath: string): string {
  return relativePath
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
}

/**
 * Parse a plan markdown into structured plan todos.
 *
 * Recognizes GitHub-style task-list items only (`- [ ] foo` / `- [x] foo`),
 * assigning a 0-based `ordinal` and a content hash, and stamps each with
 * `source` provenance + created/updated timestamps. Ids are derived from the
 * structured source via {@link makePlanTodoId} so they are stable across
 * re-derivations.
 */
export function extractPlanTodos(input: {
  markdown: string;
  planId: string;
  relativePath: string;
  now: string;
}): PlanTodo[] {
  const items: PlanTodo[] = [];
  const lines = input.markdown.split(/\r?\n/);
  let ordinal = 0;
  for (const line of lines) {
    const match = TASK_LINE_RE.exec(line);
    if (!match) continue;
    const content = normalizeTodoContent(match[4] ?? "");
    if (!content) continue;
    const contentHash = todoContentHash(content);
    const source: ThreadTodoSource = {
      kind: "plan",
      planId: input.planId,
      relativePath: normalizePlanRelativePath(input.relativePath),
      ordinal,
      contentHash,
    };
    items.push({
      id: makePlanTodoId(source),
      content,
      status: taskMarkerToStatus(match[2]),
      source,
      createdAt: input.now,
      updatedAt: input.now,
    });
    ordinal += 1;
  }
  return items;
}

/**
 * Merge freshly extracted plan todos with the existing thread list.
 *
 * - Each plan item is matched against an existing todo by progressively fuzzier
 *   keys (see {@link findExistingPlanTodo}); a match reuses the existing id and
 *   created-at timestamp, and (when `preserveCompleted`) keeps a `completed`
 *   status even if the plan re-derives it as pending.
 * - Existing todos no longer present in the plan are kept, but any that were
 *   plan-sourced are demoted to orphans (their `source` is cleared) so they no
 *   longer track a checkbox.
 */
export function mergePlanTodos(options: {
  existing?: { items: PlanTodo[] } | null;
  planItems: PlanTodo[];
  preserveCompleted: boolean;
  threadId: string;
  now: string;
}): { threadId: string; items: PlanTodo[]; updatedAt: string } {
  const existingItems = options.existing?.items ?? [];
  const usedExistingIds = new Set<string>();
  const nextItems: PlanTodo[] = [];

  for (const planItem of options.planItems) {
    const existing = findExistingPlanTodo(existingItems, usedExistingIds, planItem);
    if (existing) usedExistingIds.add(existing.id);
    const status =
      existing && options.preserveCompleted && existing.status === "completed"
        ? existing.status
        : existing?.status ?? planItem.status;
    nextItems.push({
      ...planItem,
      id: existing?.id ?? planItem.id,
      status,
      createdAt: existing?.createdAt ?? planItem.createdAt,
      updatedAt:
        existing && existing.content === planItem.content && existing.status === status
          ? existing.updatedAt
          : options.now,
    });
  }

  for (const item of existingItems) {
    if (usedExistingIds.has(item.id)) continue;
    if (item.source?.kind === "plan") {
      nextItems.push({
        ...item,
        source: undefined,
        updatedAt: options.now,
      });
    } else {
      nextItems.push(item);
    }
  }

  return {
    threadId: options.threadId,
    items: nextItems,
    updatedAt: options.now,
  };
}

/**
 * Rewrite the in-markdown checkbox for a plan-sourced todo to match its status.
 *
 * Finds the matching task line by progressively fuzzier keys (exact
 * ordinal+contentHash, then contentHash, then ordinal) and flips only the
 * marker char (`x` for completed, ` ` otherwise). Returns the (possibly
 * unchanged) markdown plus a `changed` flag. No-ops for non-plan todos.
 */
export function patchPlanTodoStatus(
  markdown: string,
  item: PlanTodo,
): { markdown: string; changed: boolean } {
  const source = item.source;
  if (!source || source.kind !== "plan") return { markdown, changed: false };
  const lines = markdown.split(/\r?\n/);
  const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n";
  const tasks = lines
    .map((line, lineIndex) => ({ line, lineIndex, match: TASK_LINE_RE.exec(line) }))
    .filter((entry): entry is { line: string; lineIndex: number; match: RegExpExecArray } =>
      Boolean(entry.match),
    )
    .map((entry, ordinal) => ({
      ...entry,
      ordinal,
      content: normalizeTodoContent(entry.match[4] ?? ""),
      contentHash: todoContentHash(entry.match[4] ?? ""),
    }));

  const target =
    tasks.find((task) => task.ordinal === source.ordinal && task.contentHash === source.contentHash) ??
    tasks.find((task) => task.contentHash === source.contentHash) ??
    tasks.find((task) => task.ordinal === source.ordinal);
  if (!target) return { markdown, changed: false };

  const marker = item.status === "completed" ? "x" : " ";
  const currentMarker = target.match[2] ?? " ";
  if (currentMarker.toLowerCase() === marker) return { markdown, changed: false };

  lines[target.lineIndex] = target.line.replace(TASK_LINE_RE, `$1${marker}$3$4`);
  return { markdown: lines.join(lineEnding), changed: true };
}

function findExistingPlanTodo(
  existingItems: PlanTodo[],
  usedExistingIds: Set<string>,
  planItem: PlanTodo,
): PlanTodo | undefined {
  const source = planItem.source;
  const candidates = existingItems.filter((item) => !usedExistingIds.has(item.id));
  if (!source) {
    return candidates.find((item) => item.id === planItem.id);
  }
  return (
    candidates.find(
      (item) =>
        item.source?.kind === "plan" &&
        item.source.planId === source.planId &&
        item.source.relativePath === source.relativePath &&
        item.source.contentHash === source.contentHash,
    ) ??
    candidates.find(
      (item) =>
        item.source?.kind === "plan" &&
        item.source.relativePath === source.relativePath &&
        item.source.contentHash === source.contentHash,
    ) ??
    candidates.find((item) => todoContentHash(item.content) === source.contentHash) ??
    candidates.find(
      (item) =>
        item.source?.kind === "plan" &&
        item.source.planId === source.planId &&
        item.source.relativePath === source.relativePath &&
        item.source.ordinal === source.ordinal,
    )
  );
}
