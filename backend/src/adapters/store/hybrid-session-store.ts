import type { TurnItem } from "../../contracts/items.js";
import type { RuntimeEvent } from "../../contracts/events.js";
import { FileSessionStore } from "./file-stores.js";
import type {
  IndexedUsageRecord,
  LatestUsageSnapshot,
  SessionRecord,
  SessionStore,
  UsageIndex,
} from "./types.js";

interface HybridSessionStoreOptions {
  dataDir: string;
  index: UsageIndex;
  usageEventCompaction?: {
    maxBytes?: number;
    retentionDays?: number;
    nowIso?: () => string;
  };
}

/**
 * Session store that delegates JSONL persistence to a {@link FileSessionStore}
 * while feeding each event into the SQLite usage index and serving the indexed
 * fast paths (highestSeq high-water, usage records, latest snapshots).
 *
 * Faithfully ported from the original `adapters/hybrid/hybrid-session-store.js`.
 */
export class HybridSessionStore implements SessionStore {
  private readonly delegate: FileSessionStore;
  private readonly index: UsageIndex;

  constructor(options: HybridSessionStoreOptions) {
    this.delegate = new FileSessionStore(options.dataDir, options.usageEventCompaction);
    this.index = options.index;
  }

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    await this.delegate.appendEvent(threadId, event);
    await this.index.noteEvent(event);
  }

  async appendItem(threadId: string, item: TurnItem): Promise<void> {
    await this.delegate.appendItem(threadId, item);
  }

  async rewriteItems(threadId: string, items: TurnItem[]): Promise<void> {
    await this.delegate.rewriteItems(threadId, items);
  }

  async updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null> {
    return this.delegate.updateItem(threadId, itemId, patch);
  }

  async loadEventsSince(threadId: string, sinceSeq: number): Promise<RuntimeEvent[]> {
    return this.delegate.loadEventsSince(threadId, sinceSeq);
  }

  async loadItems(threadId: string): Promise<TurnItem[]> {
    return this.delegate.loadItems(threadId);
  }

  async loadSession(threadId: string): Promise<SessionRecord | null> {
    return this.delegate.loadSession(threadId);
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    await this.delegate.upsertSession(session);
  }

  async highestSeq(threadId: string): Promise<number> {
    const indexed = await this.index.getEventSeqHighWater(threadId);
    if (indexed !== null) return indexed;
    return this.delegate.highestSeq(threadId);
  }

  async loadUsageRecords(options?: { threadId?: string }): Promise<IndexedUsageRecord[]> {
    return this.index.loadUsageRecords(options);
  }

  async loadLatestUsageSnapshots(options?: { threadIds?: string[] }): Promise<LatestUsageSnapshot[]> {
    return this.index.loadLatestUsageSnapshots(options);
  }

  async resetMemory(): Promise<void> {
    await this.delegate.resetMemory();
  }

  /** Used by the loop during shutdown to verify the file actually exists. */
  async exists(threadId: string): Promise<boolean> {
    return this.delegate.exists(threadId);
  }
}
