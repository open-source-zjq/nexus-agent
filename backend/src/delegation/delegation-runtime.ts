import type { UsageSnapshot } from "../contracts/usage.js";
import type { RuntimeEventInput } from "../contracts/events.js";
import type { ChildAgentExecutor, ChildRunInput, ChildRunResult } from "./child-agent-executor.js";
import {
  ChildRunRecordSchema,
  InMemoryDelegationStore,
  type ChildRunRecord,
  type ChildRunUsage,
  type DelegationStore,
} from "./file-delegation-store.js";

export interface DelegationConfig {
  enabled: boolean;
  /** Maximum number of child runs allowed to execute concurrently (process-wide). */
  maxParallel: number;
  /** Maximum number of child runs allowed for a single parent thread. */
  maxChildRuns: number;
}

/** Records a child lifecycle event onto the parent thread's event stream. */
export interface DelegationEventSink {
  record(event: RuntimeEventInput): Promise<unknown> | unknown;
}

export interface DelegationRuntimeOptions {
  config: DelegationConfig;
  executor: ChildAgentExecutor;
  /**
   * Persistence for child-run records. Defaults to an in-memory store so the
   * runtime works without any wiring; serve.ts may inject a FileDelegationStore.
   */
  store?: DelegationStore;
  /** Optional sink for child lifecycle events (turn_started / _completed / _failed / _aborted). */
  events?: DelegationEventSink;
  /** Roll child usage back up to the parent thread's usage accumulator. */
  onChildUsage?: (parentThreadId: string, usage: UsageSnapshot) => void;
  /** Injectable clock for deterministic timestamps in tests. */
  nowIso?: () => string;
  /** Injectable id generator for deterministic child ids in tests. */
  idGenerator?: () => string;
}

/** Per-bucket aggregate of child runs keyed by `${label}:${model}`. */
export interface ChildRunAggregate {
  key: string;
  label?: string;
  model?: string;
  runs: number;
  completed: number;
  failed: number;
  aborted: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageTotalTokens: number;
  costUsd?: number;
  averageCostUsd?: number;
}

/** Snapshot returned by {@link DelegationRuntime.diagnostics}. */
export interface DelegationDiagnostics {
  enabled: boolean;
  active: number;
  childRuns: ChildRunRecord[];
  aggregates: ChildRunAggregate[];
}

/**
 * Enforces the three delegation budget gates, tracks active/per-parent run
 * counts, persists each run, emits child lifecycle events, delegates each run to
 * the isolated child executor, and rolls the child's usage back up to the parent
 * thread.
 */
export class DelegationRuntime {
  private active = 0;
  private childSeq = 0;
  private readonly store: DelegationStore;

  constructor(private readonly options: DelegationRuntimeOptions) {
    this.store = options.store ?? new InMemoryDelegationStore();
  }

  async runChild(input: ChildRunInput): Promise<ChildRunResult> {
    const { config } = this.options;

    // --- three budget gates (faithful order + messages) --------------------
    if (!config.enabled) throw new Error("delegation is disabled by config");
    if (this.active >= config.maxParallel) throw new Error("delegation parallel budget exhausted");
    const existing = await this.store.list(input.parentThreadId);
    if (existing.length >= config.maxChildRuns) throw new Error("delegation child-run budget exhausted");

    const now = this.now();
    const id = this.options.idGenerator?.() ?? `child_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    let record: ChildRunRecord = ChildRunRecordSchema.parse({
      id,
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      ...(input.label ? { label: input.label } : {}),
      prompt: input.task,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.model ? { model: input.model } : {}),
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await this.store.upsert(record);
    await this.recordChildEvent(record);

    // Reserve budget before running so concurrent calls see the new counts.
    this.active += 1;
    try {
      // Seed the executor with the generated record id so the isolated child
      // thread id ties back to this ChildRunRecord (original: childId: id).
      const result = await this.options.executor.runOnce({ ...input, childId: id });
      record = ChildRunRecordSchema.parse({
        ...record,
        status: "completed",
        summary: result.output,
        usage: result.usage ? toChildRunUsage(result.usage) : record.usage,
        updatedAt: this.now(),
      });
      await this.store.upsert(record);
      await this.recordChildEvent(record);
      if (result.usage) this.options.onChildUsage?.(input.parentThreadId, result.usage);
      return result;
    } catch (error) {
      // Faithful to the original runChild catch: mark the record aborted/failed,
      // persist it, emit the lifecycle event, and RETURN the record (no re-throw).
      // The child executor is fail-fast (throws on a runtime error event or a
      // non-completed turn), so this catch is the single place a failed/aborted
      // child is recorded — surfacing it to the parent as a failed/aborted run
      // rather than propagating an exception.
      record = ChildRunRecordSchema.parse({
        ...record,
        status: input.abortSignal.aborted ? "aborted" : "failed",
        error: errorMessage(error),
        updatedAt: this.now(),
      });
      await this.store.upsert(record);
      await this.recordChildEvent(record);
      return { output: record.summary ?? record.error ?? `child agent ${record.status}` };
    } finally {
      this.active -= 1;
    }
  }

  /** Active concurrent child runs (process-wide). */
  get activeCount(): number {
    return this.active;
  }

  /** Number of child runs persisted for a given parent thread. */
  async childRunCount(parentThreadId: string): Promise<number> {
    return (await this.store.list(parentThreadId)).length;
  }

  /** Diagnostics snapshot: live state + persisted runs + per-label:model aggregates. */
  async diagnostics(parentThreadId?: string): Promise<DelegationDiagnostics> {
    const childRuns = await this.store.list(parentThreadId);
    return {
      enabled: this.options.config.enabled,
      active: this.active,
      childRuns,
      aggregates: aggregateChildRuns(childRuns),
    };
  }

  /**
   * Emit a child lifecycle event onto the parent thread's stream. Maps the child
   * status onto the turn_* event kind and attaches the child envelope so the UI /
   * SSE consumers can distinguish delegated-run events from the parent turn.
   */
  private async recordChildEvent(record: ChildRunRecord): Promise<void> {
    if (!this.options.events) return;
    const kind =
      record.status === "completed"
        ? "turn_completed"
        : record.status === "failed"
          ? "turn_failed"
          : record.status === "aborted"
            ? "turn_aborted"
            : "turn_started";
    // Faithful to the original: always set `text` (summary ?? error) and
    // `childLabel` (record.label) — both may be undefined, and downstream event
    // validation drops undefined keys.
    await this.options.events.record({
      kind,
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      status: record.status,
      text: record.summary ?? record.error,
      child: {
        parentThreadId: record.parentThreadId,
        parentTurnId: record.parentTurnId,
        childId: record.id,
        childLabel: record.label,
        childStatus: record.status,
        childSeq: ++this.childSeq,
      },
    } as RuntimeEventInput);
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }
}

/** Project a usage snapshot into the persisted child-run usage shape. */
function toChildRunUsage(usage: UsageSnapshot): ChildRunUsage {
  return {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cachedTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheHitTokens !== undefined ? { cacheHitTokens: usage.cacheHitTokens } : {}),
    ...(usage.cacheMissTokens !== undefined ? { cacheMissTokens: usage.cacheMissTokens } : {}),
    ...(usage.cacheHitRate !== undefined ? { cacheHitRate: usage.cacheHitRate } : {}),
    ...(usage.turns !== undefined ? { turns: usage.turns } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  };
}

/**
 * Bucket child runs by `${label}:${model}` and accumulate run counts, status
 * counts, token totals, and cost. Buckets are sorted by run count desc, then
 * total tokens desc, then key for stability.
 */
export function aggregateChildRuns(records: ChildRunRecord[]): ChildRunAggregate[] {
  const buckets = new Map<string, ChildRunAggregate>();
  for (const record of records) {
    const label = record.label?.trim() || undefined;
    const model = record.model?.trim() || undefined;
    const key = `${label ?? "unlabeled"}:${model ?? "default"}`;
    const bucket: ChildRunAggregate =
      buckets.get(key) ??
      {
        key,
        ...(label ? { label } : {}),
        ...(model ? { model } : {}),
        runs: 0,
        completed: 0,
        failed: 0,
        aborted: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        averageTotalTokens: 0,
      };
    bucket.runs += 1;
    if (record.status === "completed") bucket.completed += 1;
    else if (record.status === "failed") bucket.failed += 1;
    else if (record.status === "aborted") bucket.aborted += 1;
    bucket.promptTokens += record.usage.promptTokens;
    bucket.completionTokens += record.usage.completionTokens;
    bucket.totalTokens += record.usage.totalTokens;
    if (record.usage.costUsd !== undefined) bucket.costUsd = (bucket.costUsd ?? 0) + record.usage.costUsd;
    bucket.averageTotalTokens = bucket.runs > 0 ? bucket.totalTokens / bucket.runs : 0;
    bucket.averageCostUsd = bucket.costUsd !== undefined && bucket.runs > 0 ? bucket.costUsd / bucket.runs : undefined;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort(
    (a, b) => b.runs - a.runs || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
