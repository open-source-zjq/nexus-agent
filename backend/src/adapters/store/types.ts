import type { Thread, ThreadSummary } from "../../contracts/threads.js";
import type { TurnItem } from "../../contracts/items.js";
import type { RuntimeEvent } from "../../contracts/events.js";
import type { UsageSnapshot } from "../../contracts/usage.js";

export interface ListThreadsOptions {
  limit?: number;
  search?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  /**
   * Include side conversations (threads whose `relation` is `side`). Hidden by
   * default; set true to surface them. Honored by the store `list()` filter.
   */
  includeSide?: boolean;
}

/** Persists full thread snapshots. The source of truth for thread metadata. */
export interface ThreadStore {
  get(id: string): Promise<Thread | null>;
  upsert(thread: Thread): Promise<void>;
  list(options?: ListThreadsOptions): Promise<ThreadSummary[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * The session aggregate persisted by the file/in-memory session stores
 * (`session.json`). Mirrors the original `Session` record: the full ordered
 * event log and item list plus thread metadata.
 */
export interface SessionRecord {
  threadId: string;
  events: RuntimeEvent[];
  items: TurnItem[];
  createdAt?: string;
  updatedAt: string;
}

/** A reconstructed per-record usage delta loaded from the SQLite usage index. */
export interface IndexedUsageRecord {
  threadId: string;
  turnId?: string;
  model?: string;
  completedAt: string;
  usage: UsageSnapshot;
}

/** The latest cumulative usage snapshot persisted per thread in the SQLite index. */
export interface LatestUsageSnapshot {
  threadId: string;
  seq: number;
  usage: UsageSnapshot;
}

/** Persists per-thread items (message bodies) and the ordered event log. */
export interface SessionStore {
  appendEvent(threadId: string, event: RuntimeEvent): Promise<void>;
  appendItem(threadId: string, item: TurnItem): Promise<void>;
  updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null>;
  rewriteItems(threadId: string, items: TurnItem[]): Promise<void>;
  loadItems(threadId: string): Promise<TurnItem[]>;
  loadEventsSince(threadId: string, sinceSeq: number): Promise<RuntimeEvent[]>;
  highestSeq(threadId: string): Promise<number>;
  /** Load the persisted session aggregate (`session.json`), or null when absent. */
  loadSession(threadId: string): Promise<SessionRecord | null>;
  /** Persist the session aggregate, seeding the in-memory log when first seen. */
  upsertSession(session: SessionRecord): Promise<void>;
  /** Clear any in-memory caches (no-op for the file store). */
  resetMemory(): Promise<void>;
  /**
   * Optional SQLite-backed fast path (HybridSessionStore). When present, the
   * usage HTTP route reads reconstructed records straight from the index instead
   * of replaying every events.jsonl.
   */
  loadUsageRecords?(options?: { threadId?: string }): Promise<IndexedUsageRecord[]>;
  loadLatestUsageSnapshots?(options?: { threadIds?: string[] }): Promise<LatestUsageSnapshot[]>;
}

/** Optional usage-index port exposed by the hybrid SQLite thread store. */
export interface UsageIndex {
  noteEvent(event: RuntimeEvent): Promise<void>;
  getEventSeqHighWater(threadId: string): Promise<number | null>;
  loadUsageRecords(options?: { threadId?: string }): Promise<IndexedUsageRecord[]>;
  loadLatestUsageSnapshots(options?: { threadIds?: string[] }): Promise<LatestUsageSnapshot[]>;
}
