import type {
  Thread,
  ThreadSummary,
  ThreadGoal,
  ThreadTodoList,
  ThreadTodoItem,
  ThreadTodoStatus,
  ThreadTodoSource,
  ThreadRelation,
} from "../contracts/threads.js";
import type { TurnMode } from "../contracts/policy.js";
import type {
  CreateThreadRequest,
  UpdateThreadRequest,
} from "../contracts/threads.js";
import { ThreadTodoListSchema } from "../contracts/threads.js";
import type { Turn } from "../contracts/turns.js";
import type { TurnItem } from "../contracts/items.js";
import type { ThreadStore, SessionStore, ListThreadsOptions, SessionRecord } from "../adapters/store/types.js";
import type { RuntimeEventRecorder } from "./runtime-event-recorder.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { Clock } from "../ports/clock.js";
import { createThreadRecord } from "../domain/thread.js";
import { finalizeOpenItem } from "../domain/turn.js";
import { repairModelHistoryItems } from "../domain/model-history-repair.js";
import { hydrateThreadItems } from "../adapters/store/file-stores.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import {
  extractPlanTodos,
  mergePlanTodos,
  patchPlanTodoStatus,
  normalizePlanRelativePath,
  normalizeTodoContent,
  todoContentHash,
} from "../shared/todos.js";
import { isGuiPlanRelativePath } from "../shared/gui-plan.js";
import { withFileMutationQueue } from "../adapters/tool/file-mutation-queue.js";

export interface ThreadServiceDeps {
  threadStore: ThreadStore;
  sessionStore: SessionStore;
  events: RuntimeEventRecorder;
  ids: IdGenerator;
  clock: Clock;
  defaultModel: string;
  defaultWorkspace: string;
  /**
   * Optional single-shot title generator (wired in serve.ts over the runtime's
   * `oneShot` helper). Given a thread's opening exchange it returns a short
   * natural-language title. Absent in tests / minimal runtimes, in which case
   * {@link ThreadService.autoTitle} is a no-op that keeps the existing title.
   */
  generateTitle?: (input: {
    modelId?: string;
    firstUserText: string;
    firstAssistantText?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
}

const FINISHED_TURN_STATES = new Set(["completed", "failed", "aborted"]);

export const DEFAULT_THREAD_TITLE = "New thread";

/** Whether a title is still the auto-assigned placeholder (so auto-title may replace it). */
export function isDefaultThreadTitle(title: string | undefined): boolean {
  const trimmed = (title ?? "").trim();
  return trimmed === "" || /^new thread$/i.test(trimmed);
}

/**
 * Clean a model-generated title: take the first non-empty line, drop a leading
 * "Title:" label, strip surrounding quotes/backticks, collapse whitespace, drop
 * a trailing period, and cap the length so it fits the sidebar/header row.
 */
export function sanitizeGeneratedTitle(raw: string): string {
  let title =
    (raw ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  title = title.replace(/^title\s*[:：]\s*/i, "");
  title = title.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  title = title.replace(/\s+/g, " ").replace(/[.。]+$/, "").trim();
  if (title.length > 60) title = `${title.slice(0, 57).trimEnd()}…`;
  return title;
}

export class ThreadService {
  constructor(private readonly deps: ThreadServiceDeps) {}

  // --- raw store delegation (used by TurnService) ---------------------------

  get(id: string): Promise<Thread | null> {
    return this.deps.threadStore.get(id);
  }

  upsert(thread: Thread): Promise<void> {
    return this.deps.threadStore.upsert(thread);
  }

  list(options?: ListThreadsOptions): Promise<ThreadSummary[]> {
    return this.deps.threadStore.list(options);
  }

  // --- API surface ----------------------------------------------------------

  async create(
    request: CreateThreadRequest,
    seed?: { id?: string },
  ): Promise<Thread> {
    // Faithful to the original `threads.create(spec, { id, title })`: an optional
    // seed can pin the thread id (used by delegation so the in-memory child
    // thread id ties back to the persisted ChildRunRecord.id).
    const id = seed?.id ?? this.deps.ids.next("thread");
    const now = this.deps.clock.nowIso();
    const thread = createThreadRecord({
      id,
      title: request.title?.trim() || "New thread",
      workspace: request.workspace || this.deps.defaultWorkspace,
      model: request.model || this.deps.defaultModel,
      mode: request.mode,
      approvalPolicy: request.approvalPolicy,
      sandboxMode: request.sandboxMode,
      costBudgetUsd: request.costBudgetUsd,
      createdAt: now,
    });
    await this.deps.threadStore.upsert(thread);
    await this.deps.events.record({ kind: "thread_created", threadId: id, title: thread.title, status: thread.status });
    return thread;
  }

  /** Hydrated, finalized thread for API responses. */
  async getHydrated(id: string): Promise<{ thread: Thread; latestSeq: number } | null> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) return null;
    const [items, latestSeq] = await Promise.all([
      this.deps.sessionStore.loadItems(id),
      this.deps.sessionStore.highestSeq(id),
    ]);
    const turnStatusById = new Map(thread.turns.map((t) => [t.id, t.status]));
    const finalizedItems = items.map((item) => {
      const status = turnStatusById.get(item.turnId);
      return status && FINISHED_TURN_STATES.has(status) ? finalizeOpenItem(item, status, thread.updatedAt) : item;
    });
    return { thread: hydrateThreadItems(thread, finalizedItems), latestSeq };
  }

  async update(id: string, request: UpdateThreadRequest): Promise<Thread> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    const next: Thread = {
      ...thread,
      title: request.title ?? thread.title,
      workspace: request.workspace ?? thread.workspace,
      status: request.status ?? thread.status,
      approvalPolicy: request.approvalPolicy ?? thread.approvalPolicy,
      sandboxMode: request.sandboxMode ?? thread.sandboxMode,
      costBudgetUsd: request.costBudgetUsd === null ? undefined : request.costBudgetUsd ?? thread.costBudgetUsd,
      updatedAt: this.deps.clock.nowIso(),
    };
    await this.deps.threadStore.upsert(next);
    await this.deps.events.record({ kind: "thread_updated", threadId: id, title: next.title, status: next.status });
    return next;
  }

  /**
   * Summarize a thread's opening exchange into a concise title and persist it.
   * Best-effort and idempotent: unless `force` is set it only replaces a
   * still-default ("New thread"/empty) title, and it silently keeps the current
   * title when no generator is wired, there is no user message yet, or the model
   * call fails. On success it persists via {@link update}, so the standard
   * `thread_updated` event fans out to every connected client. Returns the
   * (possibly unchanged) thread either way.
   */
  async autoTitle(id: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<Thread> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    if (!opts.force && !isDefaultThreadTitle(thread.title)) return thread;
    if (!this.deps.generateTitle) return thread;

    const items = await this.deps.sessionStore.loadItems(id);
    const firstUserText = items
      .find((item): item is Extract<TurnItem, { kind: "user_message" }> => item.kind === "user_message")
      ?.text.trim();
    if (!firstUserText) return thread;
    const firstAssistantText = items
      .find((item): item is Extract<TurnItem, { kind: "assistant_text" }> => item.kind === "assistant_text")
      ?.text.trim();

    let generated: string;
    try {
      generated = await this.deps.generateTitle({
        modelId: thread.model,
        firstUserText,
        ...(firstAssistantText ? { firstAssistantText } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch {
      return thread; // best-effort: never fail the request on a model error
    }
    const title = sanitizeGeneratedTitle(generated);
    if (!title || title === thread.title) return thread;
    return this.update(id, { title });
  }

  async delete(id: string): Promise<boolean> {
    return this.deps.threadStore.delete(id);
  }

  /**
   * Resume a persisted session into a fresh, usable thread. Faithful to the
   * original `POST /v1/sessions/:id/resume-thread` contract.
   *
   * The session id may resolve to (a) a full thread snapshot, (b) a persisted
   * session aggregate, or (c) only a raw item log. When no thread snapshot
   * exists the turns are rebuilt from the raw items ({@link rebuildTurnsFromItems});
   * in every case the turns are deep-cloned with their model history repaired
   * and in-flight statuses coerced to terminal values. A new thread id is
   * minted (the original session is never mutated), the resumed thread is
   * persisted, and a closed session snapshot is written so the resumed thread
   * has its own session aggregate. Returns the new thread plus the resumed
   * session id and the cloned item count.
   */
  async resumeSession(
    sessionId: string,
    request: { workspace?: string; model?: string; mode?: TurnMode } = {},
  ): Promise<{ thread: Thread; sessionId: string; messageCount: number }> {
    const sourceThread = await this.deps.threadStore.get(sessionId);
    const sourceSession = await this.deps.sessionStore.loadSession(sessionId);
    const sourceItems = sourceThread
      ? sourceThread.turns.flatMap((turn) => turn.items)
      : sourceSession?.items.length
        ? sourceSession.items
        : await this.deps.sessionStore.loadItems(sessionId);
    if (!sourceThread && !sourceSession && sourceItems.length === 0) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const now = this.deps.clock.nowIso();
    const threadId = this.deps.ids.next("thread");
    const sourceTurns = sourceThread
      ? sourceThread.turns
      : rebuildTurnsFromItems({
          items: sourceItems,
          threadId,
          fallbackTurnId: this.deps.ids.next("turn"),
          fallbackPrompt: `Resumed session ${sessionId.slice(0, 8)}`,
          now,
        });
    const clonedTurns = sourceTurns.map((turn) => cloneTurnForThread(turn, threadId, now));
    const clonedItems = clonedTurns.flatMap((turn) => turn.items);
    const sourceTitle = sourceThread?.title ?? `Session ${sessionId.slice(0, 8)}`;
    const record = createThreadRecord({
      id: threadId,
      title: `${sourceTitle} resumed`,
      workspace: request.workspace ?? sourceThread?.workspace ?? "~",
      model: request.model ?? sourceThread?.model ?? this.deps.defaultModel,
      mode: request.mode ?? sourceThread?.mode ?? "agent",
      status: "idle",
      approvalPolicy: sourceThread?.approvalPolicy,
      sandboxMode: sourceThread?.sandboxMode,
      forkedFromThreadId: sourceThread?.id,
      forkedFromTitle: sourceThread?.title,
      forkedAt: now,
      forkedFromMessageCount: clonedItems.filter((item) => item.kind === "user_message").length,
      forkedFromTurnCount: clonedTurns.length,
      ...(sourceThread?.todos ? { todos: cloneTodoListForThread(sourceThread.todos, threadId, now) } : {}),
      createdAt: now,
    });
    const resumed: Thread = {
      ...record,
      updatedAt: now,
      turns: clonedTurns,
    };
    for (const item of clonedItems) {
      await this.deps.sessionStore.appendItem(resumed.id, item);
    }
    await this.deps.threadStore.upsert(resumed);
    await this.deps.sessionStore.upsertSession(toSessionSnapshot(resumed, now));
    await this.deps.events.record({ kind: "thread_created", threadId: resumed.id, title: resumed.title, status: resumed.status });
    return { thread: resumed, sessionId, messageCount: clonedItems.length };
  }

  /**
   * Fork (or branch a `side` conversation off) a thread. Faithful to the
   * original: turns are deep-cloned with their model-history repaired and any
   * in-flight item/turn statuses coerced to terminal values; for `relation:
   * "side"` an in-flight turn is aborted and only its user prompt is carried
   * over. Fork metadata (the forkedFrom fields, forkedAt, and the
   * user-message/turn counts) and a cloned todo list are stamped onto the new
   * thread.
   */
  async fork(
    id: string,
    request: { title?: string; relation?: ThreadRelation } | undefined = {},
  ): Promise<Thread> {
    const current = await this.getHydrated(id);
    if (!current) throw new Error(`thread not found: ${id}`);
    const source = current.thread;
    const now = this.deps.clock.nowIso();
    const forkId = this.deps.ids.next("thread");
    const relation = request?.relation ?? "fork";
    const clonedTurns = source.turns.map((turn) => cloneTurnForFork(turn, forkId, now, { relation }));
    const clonedItems = clonedTurns.flatMap((turn) => turn.items);
    const defaultTitle = relation === "side" ? `${source.title} · side` : `${source.title} fork`;
    const fork = createThreadRecord({
      id: forkId,
      title: request?.title?.trim() || defaultTitle,
      workspace: source.workspace,
      model: source.model,
      mode: source.mode,
      status: "idle",
      approvalPolicy: source.approvalPolicy,
      sandboxMode: source.sandboxMode,
      relation,
      parentThreadId: source.id,
      forkedFromThreadId: source.id,
      forkedFromTitle: source.title,
      forkedAt: now,
      forkedFromMessageCount: clonedItems.filter((item) => item.kind === "user_message").length,
      forkedFromTurnCount: clonedTurns.length,
      ...(source.todos ? { todos: cloneTodoListForThread(source.todos, forkId, now) } : {}),
      createdAt: now,
    });
    const record: Thread = {
      ...fork,
      updatedAt: now,
      turns: clonedTurns,
    };
    for (const item of clonedItems) {
      await this.deps.sessionStore.appendItem(record.id, item);
    }
    await this.deps.threadStore.upsert(record);
    await this.deps.events.record({ kind: "thread_created", threadId: record.id, title: record.title, status: record.status });
    return record;
  }

  // --- goal -----------------------------------------------------------------

  async getGoal(id: string): Promise<ThreadGoal | null> {
    return (await this.deps.threadStore.get(id))?.goal ?? null;
  }

  async setGoal(
    id: string,
    request: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null },
  ): Promise<ThreadGoal> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    const now = this.deps.clock.nowIso();
    const goal: ThreadGoal = {
      threadId: id,
      objective: request.objective ?? thread.goal?.objective ?? "",
      status: request.status ?? thread.goal?.status ?? "active",
      tokenBudget: request.tokenBudget === undefined ? thread.goal?.tokenBudget ?? null : request.tokenBudget,
      tokensUsed: thread.goal?.tokensUsed ?? 0,
      timeUsedSeconds: thread.goal?.timeUsedSeconds ?? 0,
      createdAt: thread.goal?.createdAt ?? now,
      updatedAt: now,
    };
    // Faithful to the original thread-service.dup2.js: updating a goal on a
    // thread that has none, without supplying an objective, is rejected with this
    // exact message (the goal route maps `/no goal exists/i` → 400 validation).
    if (!goal.objective) throw new Error(`cannot update goal for thread ${id}: no goal exists`);
    await this.deps.threadStore.upsert({ ...thread, goal, updatedAt: now });
    await this.deps.events.record({ kind: "goal_updated", threadId: id, goal });
    return goal;
  }

  async clearGoal(id: string): Promise<boolean> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread || !thread.goal) return false;
    await this.deps.threadStore.upsert({ ...thread, goal: undefined, updatedAt: this.deps.clock.nowIso() });
    await this.deps.events.record({ kind: "goal_cleared", threadId: id, cleared: true });
    return true;
  }

  // --- todos ----------------------------------------------------------------

  async getTodos(id: string): Promise<ThreadTodoList | null> {
    return (await this.deps.threadStore.get(id))?.todos ?? null;
  }

  async setTodos(
    id: string,
    todos: Array<{ id?: string; content: string; status: ThreadTodoStatus; source?: ThreadTodoSource }>,
  ): Promise<ThreadTodoList> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    const now = this.deps.clock.nowIso();
    // Normalize the raw list (faithful to the original normalizeTodoItems):
    // collapse/trim content (throwing on empty), reject unknown statuses, allow
    // at most one in_progress (throwing on a second), validate plan sources, and
    // re-associate each entry to an existing todo by a caller-supplied id or a
    // content-hash/source match so stable ids and created-at timestamps survive
    // round-trips and only changed items bump updatedAt.
    const items = normalizeTodoItems({
      rawItems: todos,
      existingItems: thread.todos?.items ?? [],
      now,
      ids: this.deps.ids,
    });
    // Validate the assembled list against the persisted-todo schema (content
    // min(1), the single-in_progress superRefine, etc) so a degenerate list is
    // surfaced as a structured error rather than persisted.
    const list: ThreadTodoList = ThreadTodoListSchema.parse({
      threadId: id,
      items,
      updatedAt: now,
    });
    // When a todo with `source.kind === "plan"` changes status, write the
    // checkbox flip back into the plan markdown file(s) before persisting the
    // list, so the GUI plan document stays in sync with the thread todos.
    await this.patchPlanMarkdownForTodoStatusChanges(thread, list.items);
    await this.deps.threadStore.upsert({ ...thread, todos: list, updatedAt: now });
    await this.deps.events.record({ kind: "todos_updated", threadId: id, todos: list });
    return list;
  }

  /**
   * Re-derive todos from a GUI plan markdown and merge them into the thread's
   * existing todo list (stable plan-derived ids round-trip across re-derivations;
   * completed status survives a re-derivation unless `preserveCompleted` is
   * disabled). The plan path must resolve under the reserved GUI plan dir.
   */
  async syncTodosFromPlan(
    id: string,
    options: {
      planId: string;
      relativePath: string;
      markdown: string;
      preserveCompleted?: boolean;
    },
  ): Promise<ThreadTodoList> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread) throw new Error(`thread not found: ${id}`);
    const relativePath = normalizePlanRelativePath(options.relativePath);
    if (!isGuiPlanRelativePath(relativePath)) {
      throw new Error(`invalid GUI plan relative path: ${options.relativePath}`);
    }
    const now = this.deps.clock.nowIso();
    const planItems = extractPlanTodos({
      markdown: options.markdown,
      planId: options.planId,
      relativePath,
      now,
    });
    const todos: ThreadTodoList = ThreadTodoListSchema.parse(
      mergePlanTodos({
        threadId: id,
        existing: thread.todos ?? null,
        planItems,
        now,
        preserveCompleted: options.preserveCompleted ?? true,
      }),
    );
    await this.deps.threadStore.upsert({ ...thread, todos, updatedAt: now });
    await this.deps.events.record({ kind: "todos_updated", threadId: id, todos });
    return todos;
  }

  /**
   * When plan-sourced todos change status (or are newly introduced), rewrite the
   * checkbox marker back into the originating plan markdown file. Mutations are
   * serialized per-file via {@link withFileMutationQueue}, and each plan path is
   * re-validated as a GUI plan path and re-confirmed to stay inside the thread
   * workspace before any write.
   */
  private async patchPlanMarkdownForTodoStatusChanges(
    current: Thread,
    nextItems: ThreadTodoList["items"],
  ): Promise<void> {
    const previousById = new Map((current.todos?.items ?? []).map((item) => [item.id, item]));
    const changedPlanItems = nextItems.filter((item) => {
      if (item.source?.kind !== "plan") return false;
      const previous = previousById.get(item.id);
      return !previous || previous.status !== item.status;
    });
    if (changedPlanItems.length === 0) return;

    const byRelativePath = new Map<string, ThreadTodoList["items"]>();
    for (const item of changedPlanItems) {
      const source = item.source;
      if (!source || source.kind !== "plan") continue;
      const relativePath = normalizePlanRelativePath(source.relativePath);
      if (!isGuiPlanRelativePath(relativePath)) {
        throw new Error(`invalid GUI plan relative path: ${source.relativePath}`);
      }
      byRelativePath.set(relativePath, [...(byRelativePath.get(relativePath) ?? []), item]);
    }

    for (const [relativePath, items] of byRelativePath) {
      const absolutePath = this.resolveWorkspaceRelativePath(current.workspace, relativePath);
      await withFileMutationQueue(absolutePath, async () => {
        let markdown = await readFile(absolutePath, "utf-8");
        let changed = false;
        for (const item of items) {
          const patched = patchPlanTodoStatus(markdown, {
            id: item.id,
            content: item.content,
            status: item.status,
            source: item.source,
          });
          markdown = patched.markdown;
          changed ||= patched.changed;
        }
        if (changed) await writeFile(absolutePath, markdown, "utf-8");
      });
    }
  }

  /**
   * Resolve a workspace-relative path to an absolute path, throwing if it escapes
   * the workspace root (faithful to the original `resolveWorkspaceRelativePath`).
   */
  private resolveWorkspaceRelativePath(workspace: string, relativePath: string): string {
    const root = resolve(workspace);
    const target = resolve(root, relativePath);
    const fromRoot = relative(root, target);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(`plan path escapes workspace: ${relativePath}`);
    }
    return target;
  }

  async clearTodos(id: string): Promise<boolean> {
    const thread = await this.deps.threadStore.get(id);
    if (!thread || !thread.todos) return false;
    await this.deps.threadStore.upsert({ ...thread, todos: undefined, updatedAt: this.deps.clock.nowIso() });
    await this.deps.events.record({ kind: "todos_cleared", threadId: id, cleared: true });
    return true;
  }
}

// --- turn / item cloning (fork + resume) ------------------------------------

/**
 * Deep-clone a turn into another thread: each item is re-targeted and its
 * in-flight status coerced to a terminal value, the model history is repaired
 * (so no dangling tool_call/tool_result survives), the turn status is settled
 * (queued/running -> completed), and the turn's attachment ids are re-derived
 * from the cloned user messages when the turn carried none.
 */
function cloneTurnForThread(turn: Turn, threadId: string, now: string): Turn {
  const items = repairModelHistoryItems(turn.items.map((item) => cloneItemForThread(item, threadId, now)));
  const attachmentIds = turn.attachmentIds.length > 0 ? turn.attachmentIds : attachmentIdsFromItems(items);
  return {
    ...turn,
    threadId,
    status: turn.status === "queued" || turn.status === "running" ? "completed" : turn.status,
    finishedAt: turn.finishedAt ?? now,
    attachmentIds,
    items,
  };
}

/**
 * Like {@link cloneTurnForThread}, but for a fork. When forking a `side`
 * conversation off an in-flight (queued/running) turn, the turn is aborted and
 * only its user prompt is carried over — half-streamed assistant/tool state is
 * dropped so it never leaks into the side thread. Otherwise this is a plain
 * clone.
 */
function cloneTurnForFork(
  turn: Turn,
  threadId: string,
  now: string,
  options: { relation: ThreadRelation },
): Turn {
  const isInFlight = turn.status === "queued" || turn.status === "running";
  if (options.relation === "side" && isInFlight) {
    const userPromptItem = turn.items.find((item) => item.kind === "user_message");
    const userPromptItemCloned = userPromptItem ? cloneItemForThread(userPromptItem, threadId, now) : undefined;
    return {
      ...turn,
      threadId,
      status: "aborted",
      finishedAt: turn.finishedAt ?? now,
      attachmentIds:
        turn.attachmentIds.length > 0
          ? turn.attachmentIds
          : attachmentIdsFromItems(userPromptItemCloned ? [userPromptItemCloned] : []),
      // Keep the user prompt; drop everything else to avoid carrying
      // half-streamed assistant/tool state into the side thread.
      items: userPromptItemCloned ? [userPromptItemCloned] : [],
    };
  }
  return cloneTurnForThread(turn, threadId, now);
}

/**
 * Re-target an item onto another thread and coerce any still-open status to a
 * terminal value: approval -> expired, user_input -> cancelled, everything else
 * -> completed (stamping a `finishedAt` when absent). Already-terminal items are
 * cloned unchanged apart from `threadId`.
 */
function cloneItemForThread(item: TurnItem, threadId: string, now: string): TurnItem {
  const cloned = { ...item, threadId };
  if (cloned.status === "pending" || cloned.status === "running") {
    if (cloned.kind === "approval") {
      return { ...cloned, status: "expired", finishedAt: cloned.finishedAt ?? now };
    }
    if (cloned.kind === "user_input") {
      return { ...cloned, status: "cancelled", finishedAt: cloned.finishedAt ?? now };
    }
    return { ...cloned, status: "completed", finishedAt: cloned.finishedAt ?? now };
  }
  return cloned;
}

/** Clone a thread's todo list onto another thread, fresh-copying each item. */
function cloneTodoListForThread(todos: ThreadTodoList, threadId: string, now: string): ThreadTodoList {
  return {
    threadId,
    items: todos.items.map((item) => ({ ...item })),
    updatedAt: now,
  };
}

/** Collect the unique, trimmed attachment ids carried by the user messages. */
function attachmentIdsFromItems(items: TurnItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "user_message") continue;
    for (const id of item.attachmentIds ?? []) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return [...ids];
}

/**
 * Reconstruct turns from a raw item log when no thread snapshot exists. Items
 * are grouped by their `turnId` (falling back to a synthesized turn id), each
 * group becomes a completed turn whose prompt is its first user message (or the
 * supplied fallback). With no items, a single empty completed turn is returned.
 */
function rebuildTurnsFromItems(input: {
  items: TurnItem[];
  threadId: string;
  fallbackTurnId: string;
  fallbackPrompt: string;
  now: string;
}): Turn[] {
  const byTurn = new Map<string, TurnItem[]>();
  for (const item of input.items) {
    const turnId = item.turnId || input.fallbackTurnId;
    byTurn.set(turnId, [...(byTurn.get(turnId) ?? []), { ...item, threadId: input.threadId }]);
  }
  if (byTurn.size === 0) {
    return [
      {
        id: input.fallbackTurnId,
        threadId: input.threadId,
        status: "completed",
        prompt: input.fallbackPrompt,
        steering: [],
        attachmentIds: [],
        activeSkillIds: [],
        injectedMemoryIds: [],
        createdAt: input.now,
        finishedAt: input.now,
        items: [],
      },
    ];
  }
  return [...byTurn.entries()].map(([turnId, items]) => {
    const prompt =
      items.find((item): item is Extract<TurnItem, { kind: "user_message" }> => item.kind === "user_message")?.text ??
      input.fallbackPrompt;
    return {
      id: turnId,
      threadId: input.threadId,
      status: "completed",
      prompt,
      steering: [],
      attachmentIds: attachmentIdsFromItems(items),
      activeSkillIds: [],
      injectedMemoryIds: [],
      createdAt: items[0]?.createdAt ?? input.now,
      finishedAt: input.now,
      items,
    };
  });
}

/**
 * Build the closed session snapshot persisted for a resumed thread. The first
 * turn seeds the started-at timestamp (mapped onto the snapshot's createdAt),
 * and every cloned item is captured as the session's item log.
 */
function toSessionSnapshot(thread: Thread, now: string): SessionRecord {
  const firstTurn = thread.turns[0];
  return {
    threadId: thread.id,
    createdAt: firstTurn?.createdAt ?? thread.createdAt,
    updatedAt: now,
    items: thread.turns.flatMap((turn) => turn.items),
    events: [],
  };
}

// --- todo normalization (setTodos) ------------------------------------------

interface NormalizeTodoItemsInput {
  rawItems: Array<{ id?: string; content: string; status: ThreadTodoStatus; source?: ThreadTodoSource }>;
  existingItems: ThreadTodoItem[];
  now: string;
  ids: IdGenerator;
}

/**
 * Faithful port of the original `normalizeTodoItems`. For each raw todo:
 * collapse/trim its content (throwing when empty), validate the status and any
 * plan source, allow at most one in_progress (throwing on a second), and
 * re-associate it to an existing todo by a caller-supplied id or a
 * content-hash/source match so a stable id + created-at timestamp survives a
 * round-trip and only changed items bump their updatedAt.
 */
function normalizeTodoItems(input: NormalizeTodoItemsInput): ThreadTodoItem[] {
  const existingById = new Map(input.existingItems.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  let inProgressSeen = false;
  return input.rawItems.map((raw) => {
    const content = normalizeTodoContent(raw.content);
    if (!content) throw new Error("todo content is required");
    const status = normalizeTodoStatus(raw.status);
    if (status === "in_progress") {
      if (inProgressSeen) throw new Error("at most one todo can be in_progress");
      inProgressSeen = true;
    }
    const source = raw.source ? normalizeTodoSource(raw.source) : undefined;
    const requestedId = raw.id?.trim();
    const existing =
      (requestedId ? existingById.get(requestedId) : undefined) ??
      findExistingTodoForRaw(input.existingItems, usedIds, { content, source });
    const id = uniqueTodoId(requestedId || existing?.id || input.ids.next("todo"), usedIds, input.ids);
    const changed =
      !existing ||
      existing.content !== content ||
      existing.status !== status ||
      !sameTodoSource(existing.source, source);
    usedIds.add(id);
    return {
      id,
      content,
      status,
      ...(source ? { source } : {}),
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: changed ? input.now : existing.updatedAt,
    };
  });
}

function normalizeTodoStatus(status: string): ThreadTodoStatus {
  if (status === "pending" || status === "in_progress" || status === "completed") return status;
  throw new Error(`unsupported todo status: ${String(status)}`);
}

function normalizeTodoSource(source: ThreadTodoSource): ThreadTodoSource {
  if (source.kind !== "plan") throw new Error(`unsupported todo source: ${String(source.kind)}`);
  const relativePath = normalizePlanRelativePath(source.relativePath);
  if (!isGuiPlanRelativePath(relativePath)) {
    throw new Error(`invalid GUI plan relative path: ${source.relativePath}`);
  }
  return {
    kind: "plan",
    planId: source.planId,
    relativePath,
    ordinal: source.ordinal,
    contentHash: source.contentHash,
  };
}

/**
 * Find an unused existing todo that the raw item should re-use the id of:
 * matched by progressively fuzzier source keys when the raw item carries a plan
 * source, or by content hash for an orphan (source-less) todo.
 */
function findExistingTodoForRaw(
  existingItems: ThreadTodoItem[],
  usedIds: Set<string>,
  raw: { content: string; source?: ThreadTodoSource },
): ThreadTodoItem | undefined {
  const candidates = existingItems.filter((item) => !usedIds.has(item.id));
  if (raw.source) {
    const source = raw.source;
    return (
      candidates.find((item) => item.source && sameTodoSource(item.source, source)) ??
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
          item.source.planId === source.planId &&
          item.source.relativePath === source.relativePath &&
          item.source.ordinal === source.ordinal,
      )
    );
  }
  const hash = todoContentHash(raw.content);
  return candidates.find((item) => !item.source && todoContentHash(item.content) === hash);
}

function sameTodoSource(first: ThreadTodoSource | undefined, second: ThreadTodoSource | undefined): boolean {
  if (!first || !second) return !first && !second;
  return (
    first.kind === second.kind &&
    first.planId === second.planId &&
    first.relativePath === second.relativePath &&
    first.ordinal === second.ordinal &&
    first.contentHash === second.contentHash
  );
}

/** Settle on a non-empty id not already used in this list, minting a fresh one if needed. */
function uniqueTodoId(requested: string, usedIds: Set<string>, ids: IdGenerator): string {
  let candidate = requested.trim();
  while (!candidate || usedIds.has(candidate)) {
    candidate = ids.next("todo");
  }
  return candidate;
}
