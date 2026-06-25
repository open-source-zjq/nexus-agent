import type { Thread } from "../contracts/threads.js";
import type { Turn, TurnStatus, StartTurnRequest, CompactResponse } from "../contracts/turns.js";
import type { TurnItem } from "../contracts/items.js";
import type { SessionStore } from "../adapters/store/types.js";
import type { RuntimeEventRecorder } from "./runtime-event-recorder.js";
import type { ThreadService } from "./thread-service.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { Clock } from "../ports/clock.js";
import type { SteeringQueue } from "../loop/steering-queue.js";
import type { ContextCompactor } from "../loop/context-compactor.js";
import type { InflightTracker } from "../loop/inflight-tracker.js";
import { createTurnRecord, startTurnRecord, finishTurnRecord, finalizeOpenItems, finalizeOpenItem } from "../domain/turn.js";
import { upsertTurn, appendItemToThread, replaceItemInThread, findTurn } from "../domain/thread.js";
import { appendTurnItem } from "../domain/turn.js";
import { makeUserItem, makeErrorItem } from "../domain/item.js";
import { itemsToModelHistory } from "../domain/model-history.js";

export interface TurnServiceDeps {
  threadStore: ThreadService;
  sessionStore: SessionStore;
  events: RuntimeEventRecorder;
  ids: IdGenerator;
  clock: Clock;
  steering: SteeringQueue;
  compactor: ContextCompactor;
  /**
   * Optional active-operation registry. When provided, each model turn is
   * registered as an in-flight `model` operation on startTurn and removed on
   * interrupt/finish/pause — so the runtime can enumerate and abort all active
   * work. Faithful to the original TurnService `inflight` dependency; optional
   * here so a runtime that does not track in-flight ops still works.
   */
  inflight?: InflightTracker;
}

export class TurnService {
  private readonly inflightTurns = new Map<string, AbortController>();
  private readonly threadMutationQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: TurnServiceDeps) {}

  // --- start ----------------------------------------------------------------

  async startTurn(input: {
    threadId: string;
    request: StartTurnRequest;
  }): Promise<{ threadId: string; turnId: string; userMessageItemId: string }> {
    const { threadId, request } = input;
    const thread = await this.deps.threadStore.get(threadId);
    if (!thread) throw new Error(`thread not found: ${threadId}`);

    const turnId = this.deps.ids.next("turn");
    const now = this.deps.clock.nowIso();
    const attachmentIds = request.attachmentIds ?? [];
    const turn = startTurnRecord(
      createTurnRecord({
        id: turnId,
        threadId,
        prompt: request.prompt,
        model: request.model ?? thread.model,
        reasoningEffort: request.reasoningEffort,
        guiPlan: request.guiPlan,
        mode: request.mode,
        attachmentIds,
        disableUserInput: request.disableUserInput,
        feishuChatId: request.feishuChatId,
        atMembers: request.atMembers,
        createdAt: now,
      }),
      now,
    );
    const userItem = makeUserItem({
      id: `item_${turnId}_user`,
      turnId,
      threadId,
      createdAt: now,
      text: request.prompt,
      displayText: request.displayText,
      attachmentIds,
    });

    const controller = new AbortController();
    this.inflightTurns.set(turnId, controller);

    await this.upsertThread(threadId, (current) => ({
      ...upsertTurn(current, appendTurnItem(turn, userItem)),
      status: "running",
      approvalPolicy: request.approvalPolicy ?? current.approvalPolicy,
      sandboxMode: request.sandboxMode ?? current.sandboxMode,
    }));
    await this.deps.sessionStore.appendItem(threadId, userItem);
    await this.deps.events.record({ kind: "turn_started", threadId, turnId });
    await this.deps.events.record({ kind: "item_created", threadId, turnId, itemId: userItem.id, item: userItem });
    this.deps.inflight?.begin({ id: turnId, kind: "model", threadId, turnId });
    this.deps.steering.setTurn(turnId);

    return { threadId, turnId, userMessageItemId: userItem.id };
  }

  // --- queries --------------------------------------------------------------

  getAbortController(turnId: string): AbortController | undefined {
    return this.inflightTurns.get(turnId);
  }

  async getTurn(threadId: string, turnId: string): Promise<Turn | null> {
    // Return the turn record as stored (its own items array). Faithful to the
    // original `thread?.turns.find(...)`.
    const thread = await this.deps.threadStore.get(threadId);
    return thread?.turns.find((turn) => turn.id === turnId) ?? null;
  }

  // --- steering / interrupt -------------------------------------------------

  async steerTurn(input: { threadId: string; turnId: string; text: string }): Promise<{ ok: true }> {
    this.deps.steering.enqueue(input.turnId, input.text);
    await this.deps.events.record({ kind: "turn_steered", threadId: input.threadId, turnId: input.turnId, text: input.text });
    return { ok: true };
  }

  async interruptTurn(input: {
    threadId: string;
    turnId: string;
    discard?: boolean;
  }): Promise<{ threadId: string; turnId: string; status: TurnStatus }> {
    const controller = this.inflightTurns.get(input.turnId);
    controller?.abort();
    this.deps.steering.clear();
    this.inflightTurns.delete(input.turnId);
    this.deps.inflight?.end(input.turnId);
    await this.deps.events.record({ kind: "turn_aborted", threadId: input.threadId, turnId: input.turnId, status: "aborted" });
    // On a discarded interrupt, strip the turn's non-user items from the
    // session log; otherwise just finalize any still-open persisted items.
    if (input.discard) {
      await this.discardTurnItems(input.threadId, input.turnId);
    } else {
      await this.finalizePersistedOpenItems(input.threadId, input.turnId, "aborted");
    }
    const now = this.deps.clock.nowIso();
    await this.upsertThread(input.threadId, (current) => {
      const turn = findTurn(current, input.turnId);
      // Unknown turn id: leave the thread unchanged (status untouched). Faithful
      // to the original interruptTurn `if (!turn) return current`.
      if (!turn) return current;
      // For a discarded interrupt keep only the user items on the turn record
      // before finalizing, mirroring the discarded session log.
      const base = input.discard ? { ...turn, items: this.keepUserItems(turn.items) } : turn;
      const finished = finalizeOpenItems(finishTurnRecord(base, "aborted", now), "aborted", now);
      return { ...upsertTurn(current, finished), status: "idle" };
    });
    return { threadId: input.threadId, turnId: input.turnId, status: "aborted" };
  }

  // --- rewind (edit a past user message and resend from that point) ----------

  /**
   * Truncate the thread back to BEFORE `turnId` (dropping that turn and every
   * later turn + their items), then start a fresh turn with the edited prompt.
   * Faithful to the original rewind: history is rewritten, not branched.
   */
  async rewind(input: {
    threadId: string;
    turnId: string;
    prompt: string;
  }): Promise<{ threadId: string; turnId: string; userMessageItemId: string }> {
    const thread = await this.deps.threadStore.get(input.threadId);
    if (!thread) throw new Error(`thread not found: ${input.threadId}`);
    const index = thread.turns.findIndex((turn) => turn.id === input.turnId);
    if (index < 0) throw new Error(`turn not found: ${input.turnId}`);

    const keptTurns = thread.turns.slice(0, index);
    const keptTurnIds = new Set(keptTurns.map((turn) => turn.id));
    const items = await this.deps.sessionStore.loadItems(input.threadId);
    const keptItems = items.filter((item) => keptTurnIds.has(item.turnId));
    await this.deps.sessionStore.rewriteItems(input.threadId, keptItems);
    await this.deps.threadStore.upsert({
      ...thread,
      turns: keptTurns,
      status: "idle",
      updatedAt: this.deps.clock.nowIso(),
    });
    return this.startTurn({
      threadId: input.threadId,
      request: { prompt: input.prompt, mode: thread.mode, attachmentIds: [] },
    });
  }

  // --- compaction (manual /compact) -----------------------------------------

  async compact(input: {
    threadId: string;
    turnId?: string;
    request: { reason?: string; budgetTokens?: number };
  }): Promise<CompactResponse> {
    const thread = await this.deps.threadStore.get(input.threadId);
    if (!thread) throw new Error(`thread not found: ${input.threadId}`);
    // Prefer an explicitly supplied turnId, else the last turn, else a fresh id.
    // Faithful to the original `input.turnId ?? lastTurn ?? ids.next("turn")`.
    const turnId = input.turnId ?? thread.turns[thread.turns.length - 1]?.id ?? this.deps.ids.next("turn");
    const items = (await this.deps.sessionStore.loadItems(input.threadId)).filter(
      (item) => item.kind !== "compaction" && item.kind !== "error",
    );
    const now = this.deps.clock.nowIso();
    // Manual compaction pins "preserve recent turns" and forwards the user-supplied
    // budgetTokens so the summary body is sized to the request (original compact()).
    const pinnedConstraints = ["user: preserve recent turns"];
    const result = this.deps.compactor.compact({
      threadId: input.threadId,
      turnId,
      history: items,
      keepRecent: 4,
      reason: input.request.reason ?? "manual compaction",
      pinnedConstraints,
      ...(input.request.budgetTokens !== undefined ? { budgetTokens: input.request.budgetTokens } : {}),
      nowIso: now,
      // Deterministic id (matches the loop's `compaction_${turnId}_${ids.next}`
      // scheme) instead of a Date.now() suffix.
      id: `compaction_${turnId}_${this.deps.ids.next("c")}`,
    });
    const summaryItem = result.summaryItem;
    if (result.replacedTokens > 0) {
      await this.deps.sessionStore.appendItem(input.threadId, summaryItem);
      await this.deps.events.record({
        kind: "compaction_completed",
        threadId: input.threadId,
        turnId,
        itemId: summaryItem.id,
        summary: summaryItem.summary,
        replacedTokens: result.replacedTokens,
        pinnedConstraints,
        ...(summaryItem.sourceDigest ? { sourceDigest: summaryItem.sourceDigest } : {}),
        ...(summaryItem.digestMarker ? { digestMarker: summaryItem.digestMarker } : {}),
        ...(summaryItem.sourceItemIds ? { sourceItemIds: summaryItem.sourceItemIds } : {}),
      });
    }
    return {
      threadId: input.threadId,
      replacedTokens: result.replacedTokens,
      summary: summaryItem.summary,
      pinnedConstraints,
      ...(summaryItem.sourceDigest ? { sourceDigest: summaryItem.sourceDigest } : {}),
      ...(summaryItem.digestMarker ? { digestMarker: summaryItem.digestMarker } : {}),
      ...(summaryItem.sourceItemIds ? { sourceItemIds: summaryItem.sourceItemIds } : {}),
    };
  }

  // --- loop-driven persistence ----------------------------------------------

  async finishTurn(input: { threadId: string; turnId: string; status: TurnStatus; error?: string }): Promise<void> {
    this.inflightTurns.delete(input.turnId);
    this.deps.inflight?.end(input.turnId);
    this.deps.steering.clear();
    const now = this.deps.clock.nowIso();
    await this.finalizePersistedOpenItems(input.threadId, input.turnId, input.status);
    await this.upsertThread(input.threadId, (current) => {
      const turn = findTurn(current, input.turnId);
      if (!turn) return { ...current, status: "idle" };
      const finished = finalizeOpenItems(finishTurnRecord(turn, input.status, now, input.error), input.status, now);
      return { ...upsertTurn(current, finished), status: "idle" };
    });
    // Terminal turn event carries the error message (when present); the error is
    // conveyed via this event's `message`, not a separate item_created event.
    const kind =
      input.status === "completed" ? "turn_completed" : input.status === "aborted" ? "turn_aborted" : "turn_failed";
    await this.deps.events.record({
      kind,
      threadId: input.threadId,
      turnId: input.turnId,
      status: input.status,
      ...(input.error ? { message: input.error } : {}),
    });
    if (input.error) {
      // Silent append: no item_created event (the message rode the turn event).
      // Faithful to the original finishTurn -> appendItem (no event emission).
      await this.appendItemSilently(
        input.threadId,
        makeErrorItem({
          id: `item_${input.turnId}_error`,
          turnId: input.turnId,
          threadId: input.threadId,
          createdAt: now,
          finishedAt: now,
          message: input.error,
          code: "turn_failed",
          severity: "error",
        }),
      );
    }
  }

  /** Persist an item to the session log + thread snapshot without an event. */
  private async appendItemSilently(threadId: string, item: TurnItem): Promise<void> {
    await this.deps.sessionStore.appendItem(threadId, item);
    await this.upsertThread(threadId, (current) => appendItemToThread(current, item));
  }

  async applyItem(threadId: string, item: TurnItem): Promise<void> {
    await this.deps.sessionStore.appendItem(threadId, item);
    await this.upsertThread(threadId, (current) => appendItemToThread(current, item));
    await this.deps.events.record({ kind: "item_created", threadId, turnId: item.turnId, itemId: item.id, item });
  }

  async updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null> {
    const merged = await this.deps.sessionStore.updateItem(threadId, itemId, patch);
    if (!merged) return null;
    await this.upsertThread(threadId, (current) => replaceItemInThread(current, merged));
    await this.deps.events.record({ kind: "item_updated", threadId, turnId: merged.turnId, itemId, item: merged });
    return merged;
  }

  async updateTurnMetadata(
    threadId: string,
    turnId: string,
    patch: Partial<
      Pick<
        Turn,
        | "toolCatalogFingerprint"
        | "toolCatalogToolCount"
        | "toolCatalogDrift"
        | "model"
        | "activeSkillIds"
        | "injectedMemoryIds"
        | "skillInjectionBytes"
      >
    >,
  ): Promise<void> {
    await this.upsertThread(threadId, (current) => {
      const turn = findTurn(current, turnId);
      if (!turn) return current;
      return upsertTurn(current, {
        ...turn,
        ...(patch.activeSkillIds ? { activeSkillIds: [...patch.activeSkillIds] } : {}),
        ...(patch.injectedMemoryIds ? { injectedMemoryIds: [...patch.injectedMemoryIds] } : {}),
        ...(patch.skillInjectionBytes !== undefined ? { skillInjectionBytes: patch.skillInjectionBytes } : {}),
        ...(patch.toolCatalogFingerprint ? { toolCatalogFingerprint: patch.toolCatalogFingerprint } : {}),
        ...(patch.toolCatalogToolCount !== undefined ? { toolCatalogToolCount: patch.toolCatalogToolCount } : {}),
        ...(patch.toolCatalogDrift !== undefined ? { toolCatalogDrift: patch.toolCatalogDrift } : {}),
        ...(patch.model ? { model: patch.model } : {}),
      });
    });
  }

  /** On startup, pause turns left running/queued by a previous crash. */
  async settleOrphanedRunningTurns(
    reason = "runtime restarted before the turn finished",
  ): Promise<{ threads: number; turns: number }> {
    const summaries = await this.deps.threadStore.list({
      limit: 500,
      includeArchived: true,
      includeSide: true,
    });
    const recoveredThreadIds = new Set<string>();
    let turns = 0;
    for (const summary of summaries) {
      const thread = await this.deps.threadStore.get(summary.id);
      if (!thread) continue;
      const openTurns = thread.turns.filter((turn) => turn.status === "queued" || turn.status === "running");
      if (openTurns.length === 0) {
        // No open turns but the thread is still marked running -> pause it.
        if (thread.status === "running") {
          recoveredThreadIds.add(thread.id);
          await this.upsertThread(thread.id, (current) => ({ ...current, status: "paused" }));
        }
        continue;
      }
      recoveredThreadIds.add(thread.id);
      for (const turn of openTurns) {
        turns += 1;
        await this.pauseOrphanedTurn(thread.id, turn.id, `[Nexus turn paused] ${reason}`);
      }
    }
    return { threads: recoveredThreadIds.size, turns };
  }

  /** Crash-recovery for a single orphaned turn: finalize, record, pause. */
  private async pauseOrphanedTurn(threadId: string, turnId: string, error: string): Promise<void> {
    this.inflightTurns.delete(turnId);
    this.deps.inflight?.end(turnId);
    this.deps.steering.clear();
    await this.finalizePersistedOpenItems(threadId, turnId, "aborted");
    const now = this.deps.clock.nowIso();
    await this.upsertThread(threadId, (current) => {
      const turn = findTurn(current, turnId);
      if (!turn) return { ...current, status: "paused" };
      const finished = finalizeOpenItems(finishTurnRecord(turn, "aborted", now, error), "aborted", now);
      return { ...upsertTurn(current, finished), status: "paused" };
    });
    await this.deps.events.record({ kind: "turn_aborted", threadId, turnId, status: "aborted", message: error });
    await this.applyItem(
      threadId,
      makeErrorItem({
        id: `item_${turnId}_error`,
        turnId,
        threadId,
        createdAt: now,
        finishedAt: now,
        message: error,
        code: "turn_paused",
        severity: "error",
      }),
    );
  }

  /** Build the model-history view for a turn's thread (used by the loop). */
  async loadModelHistory(threadId: string): Promise<ReturnType<typeof itemsToModelHistory>> {
    const items = await this.deps.sessionStore.loadItems(threadId);
    return itemsToModelHistory(items);
  }

  // --- internals ------------------------------------------------------------

  private async finalizePersistedOpenItems(threadId: string, turnId: string, status: TurnStatus): Promise<void> {
    const now = this.deps.clock.nowIso();
    const items = await this.deps.sessionStore.loadItems(threadId);
    let changed = false;
    const next = items.map((item) => {
      if (item.turnId !== turnId) return item;
      const finalized = finalizeOpenItem(item, status, now);
      if (finalized !== item) changed = true;
      return finalized;
    });
    if (changed) await this.deps.sessionStore.rewriteItems(threadId, next);
  }

  /** Drop a discarded turn's non-user items from the persisted session log. */
  private async discardTurnItems(threadId: string, turnId: string): Promise<void> {
    const items = await this.deps.sessionStore.loadItems(threadId);
    await this.deps.sessionStore.rewriteItems(
      threadId,
      items.filter((item) => item.turnId !== turnId || item.kind === "user_message"),
    );
  }

  /** Keep only the user messages from a turn's items (used by discarded interrupts). */
  private keepUserItems(items: TurnItem[]): TurnItem[] {
    return items.filter((item) => item.kind === "user_message");
  }

  /** Serialized per-thread mutation queue — the only writer of thread snapshots. */
  private async upsertThread(threadId: string, mutator: (thread: Thread) => Thread): Promise<void> {
    const previous = this.threadMutationQueues.get(threadId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.deps.threadStore.get(threadId);
        if (!current) return;
        const next = mutator(current);
        await this.deps.threadStore.upsert({ ...next, updatedAt: this.deps.clock.nowIso() });
      });
    this.threadMutationQueues.set(threadId, run);
    try {
      await run;
    } finally {
      if (this.threadMutationQueues.get(threadId) === run) this.threadMutationQueues.delete(threadId);
    }
  }
}
