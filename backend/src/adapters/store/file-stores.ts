import { readFile, readdir, rm, stat, mkdir, appendFile, open, rename } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Thread, ThreadSummary } from "../../contracts/threads.js";
import { ThreadSchema } from "../../contracts/threads.js";
import type { Turn } from "../../contracts/turns.js";
import type { TurnItem } from "../../contracts/items.js";
import type { RuntimeEvent } from "../../contracts/events.js";
import type { SessionStore, ThreadStore, ListThreadsOptions, SessionRecord } from "./types.js";
import { atomicWriteFile } from "./atomic-write.js";
import { toThreadSummary, matchesThreadFilter, searchTextForThread } from "./summary.js";

const DEFAULT_USAGE_EVENT_COMPACTION_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_USAGE_EVENT_RETENTION_DAYS = 365;
const MS_PER_DAY = 864e5;
const METADATA_COMPACT_MIN_BYTES = 1e6;

interface UsageEventCompactionOptions {
  maxBytes?: number;
  retentionDays?: number;
  nowIso?: () => string;
}

interface ResolvedUsageEventCompaction {
  maxBytes: number;
  retentionDays: number;
  nowIso: () => string;
}

function threadsRoot(dataDir: string): string {
  return resolve(dataDir, "threads");
}

function threadDir(root: string, threadId: string): string {
  return join(root, threadId);
}

function stripThreadItemBodies(thread: Thread): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) => ({ ...turn, prompt: "", items: [] })),
  };
}

interface HydrateOptions {
  /**
   * When there are no file items, keep the snapshot's own items instead of
   * stripping them. Used by the legacy `thread.json` migration path (and by the
   * thread-service hydrate, which already holds a fully-formed snapshot).
   */
  preserveExistingItemsWhenNoFileItems?: boolean;
}

/**
 * Reassign persisted items to their turns and recover prompt/attachmentIds.
 * Items whose turnId is missing from the snapshot synthesize a recovered turn.
 * Faithfully ported from the original hybrid-thread-store `hydrateThreadItems`.
 *
 * The store read paths pass explicit options. When called without options (e.g.
 * the thread-service, which already holds a fully-formed snapshot), an empty item
 * set preserves the snapshot's own items instead of stripping them.
 */
export function hydrateThreadItems(thread: Thread, items: TurnItem[], options?: HydrateOptions): Thread {
  if (items.length === 0) {
    const preserve = options ? Boolean(options.preserveExistingItemsWhenNoFileItems) : true;
    return preserve ? thread : stripThreadItemBodies(thread);
  }
  const itemsByTurn = new Map<string, TurnItem[]>();
  for (const item of items) {
    const list = itemsByTurn.get(item.turnId) ?? [];
    list.push(item);
    itemsByTurn.set(item.turnId, list);
  }
  const knownTurnIds = new Set(thread.turns.map((turn) => turn.id));
  const turns: Turn[] = thread.turns.map((turn) => {
    const turnItems = itemsByTurn.get(turn.id) ?? [];
    const attachmentIds = turn.attachmentIds.length > 0 ? turn.attachmentIds : attachmentIdsFromItems(turnItems);
    return {
      ...turn,
      prompt: promptFromItems(turnItems) || turn.prompt,
      attachmentIds,
      items: turnItems,
    };
  });
  for (const [turnId, turnItems] of itemsByTurn) {
    if (knownTurnIds.has(turnId)) continue;
    turns.push(turnFromItems(thread.id, turnId, turnItems, thread.updatedAt));
  }
  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ...thread, turns };
}

function turnFromItems(threadId: string, turnId: string, items: TurnItem[], fallbackTime: string): Turn {
  const prompt = promptFromItems(items) || `Turn ${turnId}`;
  const createdAt = items[0]?.createdAt ?? fallbackTime;
  const hasOpenItem = items.some((item) => item.status === "pending" || item.status === "running");
  const hasFailedItem = items.some((item) => item.status === "failed" || item.status === "aborted");
  return {
    id: turnId,
    threadId,
    status: hasOpenItem ? "running" : hasFailedItem ? "failed" : "completed",
    prompt,
    steering: [],
    attachmentIds: attachmentIdsFromItems(items),
    activeSkillIds: [],
    injectedMemoryIds: [],
    createdAt,
    ...(hasOpenItem ? {} : { finishedAt: items[items.length - 1]?.finishedAt ?? fallbackTime }),
    items,
  };
}

function promptFromItems(items: TurnItem[]): string {
  const userMessage = items.find((item) => item.kind === "user_message");
  return userMessage && userMessage.kind === "user_message" ? userMessage.text : "";
}

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

function previewFromItems(items: TurnItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user_message" || item.kind === "assistant_text") return item.text.slice(0, 500);
    if (item.kind === "error") return item.message.slice(0, 500);
    if (item.kind === "tool_call") return (item.summary ?? item.toolName).slice(0, 500);
  }
  return "";
}

function mergeStringArrays(first: string[], second: string[]): string[] {
  const values = new Set<string>();
  for (const value of [...first, ...second]) {
    const trimmed = value.trim();
    if (trimmed) values.add(trimmed);
  }
  return [...values];
}

interface RecoveredTurnMetadata {
  attachmentIds: string[];
  model?: string;
  mode?: Turn["mode"];
  guiPlan?: Turn["guiPlan"];
}

interface MetadataLine {
  kind: "thread_metadata";
  version: number;
  timestamp: string;
  thread: Thread;
}

function collectTurnMetadata(entries: unknown[], threadId: string): Map<string, RecoveredTurnMetadata> {
  const recovered = new Map<string, RecoveredTurnMetadata>();
  for (const entry of entries) {
    const line = entry as Partial<MetadataLine> | null;
    if (!line || line.kind !== "thread_metadata" || (line.thread as Thread | undefined)?.id !== threadId) continue;
    const parsed = ThreadSchema.safeParse(line.thread);
    if (!parsed.success) continue;
    for (const turn of parsed.data.turns) {
      const current = recovered.get(turn.id) ?? { attachmentIds: [] };
      recovered.set(turn.id, {
        attachmentIds: mergeStringArrays(current.attachmentIds, turn.attachmentIds),
        ...(turn.model ? { model: turn.model } : current.model ? { model: current.model } : {}),
        ...(turn.mode ? { mode: turn.mode } : current.mode ? { mode: current.mode } : {}),
        ...(turn.guiPlan ? { guiPlan: turn.guiPlan } : current.guiPlan ? { guiPlan: current.guiPlan } : {}),
      });
    }
  }
  return recovered;
}

function mergeTurnItems(previous: TurnItem[], next: TurnItem[]): TurnItem[] {
  if (previous.length === 0) return next;
  if (next.length === 0) return previous;
  const byId = new Map<string, TurnItem>();
  for (const item of previous) byId.set(item.id, item);
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeTurnMetadata(previous: Turn, next: Turn): Turn {
  return {
    ...previous,
    ...next,
    prompt: next.prompt || previous.prompt,
    attachmentIds: mergeStringArrays(previous.attachmentIds, next.attachmentIds),
    activeSkillIds: mergeStringArrays(previous.activeSkillIds, next.activeSkillIds),
    injectedMemoryIds: mergeStringArrays(previous.injectedMemoryIds, next.injectedMemoryIds),
    items: mergeTurnItems(previous.items, next.items),
  };
}

function applyRecoveredTurnMetadata(turn: Turn, recovered: RecoveredTurnMetadata | undefined): Turn {
  if (!recovered) return turn;
  const attachmentIds = turn.attachmentIds.length > 0 ? turn.attachmentIds : recovered.attachmentIds;
  return {
    ...turn,
    attachmentIds,
    ...(turn.model || !recovered.model ? {} : { model: recovered.model }),
    ...(turn.mode || !recovered.mode ? {} : { mode: recovered.mode }),
    ...(turn.guiPlan || !recovered.guiPlan ? {} : { guiPlan: recovered.guiPlan }),
  };
}

/**
 * Merge per-turn metadata recovered from earlier metadata.jsonl snapshots back
 * into the latest snapshot, so older fork/model/attachment metadata survives a
 * snapshot that stripped it. Faithful to the original `normalizeThreadMetadata`.
 */
function normalizeThreadMetadata(thread: Thread, entries: unknown[]): Thread {
  const recovery = collectTurnMetadata(entries, thread.id);
  const mergedById = new Map<string, Turn>();
  const order: string[] = [];
  for (const turn of thread.turns) {
    if (!mergedById.has(turn.id)) order.push(turn.id);
    const existing = mergedById.get(turn.id);
    mergedById.set(turn.id, existing ? mergeTurnMetadata(existing, turn) : turn);
  }
  const turns = order.map((turnId) => applyRecoveredTurnMetadata(mergedById.get(turnId)!, recovery.get(turnId)));
  return turns.length === thread.turns.length && turns.every((turn, index) => turn === thread.turns[index])
    ? thread
    : { ...thread, turns };
}

/**
 * File-backed thread store. Persists threads as an append-only `metadata.jsonl`
 * of stripped snapshots (prompt + item bodies removed), compacting once the file
 * grows past the threshold, and reconstructs full turns from the session's
 * `messages.jsonl` on read (recovering prompt/attachmentIds and synthesizing
 * turns for orphaned items). Migrates a legacy `thread.json` on first read.
 *
 * This is the non-SQLite behavior of the original HybridThreadStore.
 */
export class FileThreadStore implements ThreadStore {
  protected readonly root: string;
  private readonly nowIso: () => string;
  private readonly metadataQueues = new Map<string, Promise<unknown>>();
  private readonly metadataCompactFloor = new Map<string, number>();

  constructor(dataDir: string, options: { nowIso?: () => string } = {}) {
    this.root = threadsRoot(dataDir);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  protected dir(threadId: string): string {
    return threadDir(this.root, threadId);
  }
  protected metadataPath(threadId: string): string {
    return join(this.dir(threadId), "metadata.jsonl");
  }
  protected legacyThreadPath(threadId: string): string {
    return join(this.dir(threadId), "thread.json");
  }
  protected messagesPath(threadId: string): string {
    return join(this.dir(threadId), "messages.jsonl");
  }
  protected eventsPath(threadId: string): string {
    return join(this.dir(threadId), "events.jsonl");
  }

  async get(id: string): Promise<Thread | null> {
    return this.readThreadFromDisk(id);
  }

  async upsert(thread: Thread): Promise<void> {
    await this.appendMetadata(thread);
  }

  async list(options?: ListThreadsOptions): Promise<ThreadSummary[]> {
    const threads: Thread[] = [];
    for (const threadId of await this.threadIdsFromFilesystem()) {
      const thread = await this.readThreadFromDisk(threadId);
      if (thread && thread.status !== "deleted") threads.push(thread);
    }
    return threads
      .filter((thread) => matchesThreadFilter(thread, options))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, options?.limit ?? threads.length)
      .map(toThreadSummary);
  }

  async delete(id: string): Promise<boolean> {
    const dir = this.dir(id);
    if (!existsSync(dir)) return false;
    await rm(dir, { recursive: true, force: true });
    this.metadataCompactFloor.delete(id);
    return true;
  }

  protected async threadIdsFromFilesystem(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  protected async readThreadFromDisk(threadId: string): Promise<Thread | null> {
    const metadata = await this.readLatestMetadata(threadId);
    const legacy = metadata ? null : await this.readLegacyThread(threadId);
    const source = metadata ?? legacy;
    if (!source) return null;
    const items = await this.loadMessagesItems(threadId);
    return hydrateThreadItems(source, items, { preserveExistingItemsWhenNoFileItems: Boolean(legacy) });
  }

  private async readLatestMetadata(threadId: string): Promise<Thread | null> {
    const entries = await readJsonl(this.metadataPath(threadId));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as Partial<MetadataLine> | null;
      if (!entry || entry.kind !== "thread_metadata" || (entry.thread as Thread | undefined)?.id !== threadId) continue;
      const parsed = ThreadSchema.safeParse(entry.thread);
      if (parsed.success) {
        return normalizeThreadMetadata(parsed.data, entries.slice(0, index + 1));
      }
    }
    return null;
  }

  private async readLegacyThread(threadId: string): Promise<Thread | null> {
    try {
      const raw = await readFile(this.legacyThreadPath(threadId), "utf-8");
      const parsed = ThreadSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Coalesce the append-only `messages.jsonl` to the latest record per item id. */
  private async loadMessagesItems(threadId: string): Promise<TurnItem[]> {
    const raw = (await readJsonl(this.messagesPath(threadId))) as TurnItem[];
    const latestById = new Map<string, TurnItem>();
    for (const item of raw) latestById.set(item.id, item);
    const seen = new Set<string>();
    const ordered: TurnItem[] = [];
    for (let index = raw.length - 1; index >= 0; index -= 1) {
      const item = raw[index];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.unshift(latestById.get(item.id)!);
    }
    return ordered;
  }

  protected async appendMetadata(thread: Thread): Promise<void> {
    const previous = this.metadataQueues.get(thread.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await mkdir(this.dir(thread.id), { recursive: true });
      const line: MetadataLine = {
        kind: "thread_metadata",
        version: 1,
        timestamp: this.nowIso(),
        thread: stripThreadItemBodies(thread),
      };
      await appendJsonlLine(this.metadataPath(thread.id), line);
      await this.maybeCompactMetadata(thread.id);
    });
    const guard = run.then(() => undefined, () => undefined);
    this.metadataQueues.set(thread.id, guard);
    try {
      await run;
    } finally {
      if (this.metadataQueues.get(thread.id) === guard) {
        this.metadataQueues.delete(thread.id);
      }
    }
  }

  /**
   * Every upsert appends a full snapshot, so metadata.jsonl grows quadratically
   * with turn activity. Once the file passes the threshold it is rewritten as a
   * single normalized snapshot. Runs inside the per-thread metadata queue.
   */
  private async maybeCompactMetadata(threadId: string): Promise<void> {
    const path = this.metadataPath(threadId);
    const tmpPath = `${path}.compact.tmp`;
    try {
      const stats = await stat(path);
      const floor = this.metadataCompactFloor.get(threadId) ?? METADATA_COMPACT_MIN_BYTES;
      if (stats.size < floor) return;
      const record = await this.readLatestMetadata(threadId);
      if (!record) return;
      const line: MetadataLine = {
        kind: "thread_metadata",
        version: 1,
        timestamp: this.nowIso(),
        thread: stripThreadItemBodies(record),
      };
      const handle = await open(tmpPath, "w");
      try {
        await handle.writeFile(`${JSON.stringify(line)}\n`, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, path);
      const compacted = await stat(path);
      this.metadataCompactFloor.set(threadId, Math.max(METADATA_COMPACT_MIN_BYTES, compacted.size * 4));
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      console.warn(
        `[nexus] metadata compaction skipped for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

interface ThreadIndex {
  order: string[];
  updatedAt: string;
}

/**
 * Simple file-backed thread store (the original `backend: "file"` store). Each
 * thread is persisted as `<dataDir>/threads/<id>/thread.json` (the source of
 * truth, written atomically), and a single global `<dataDir>/threads/index.json`
 * holds `{ order[], updatedAt }`. Index writes are serialized through a
 * single-writer `indexQueue` so concurrent upserts/deletes never interleave.
 *
 * `list()` reads each thread's `thread.json` (in index order) and re-sorts the
 * resulting summaries by `updatedAt` descending. Faithfully ported from the
 * original `FileThreadStore`.
 */
export class SimpleFileThreadStore implements ThreadStore {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: { now?: () => Date } = {}) {
    this.dataDir = threadsRoot(dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async list(_options?: ListThreadsOptions): Promise<ThreadSummary[]> {
    await this.ensureDir(this.dataDir);
    const index = await this.readIndex();
    const summaries: ThreadSummary[] = [];
    for (const threadId of index.order) {
      const path = this.threadFilePath(threadId);
      try {
        const raw = await readFile(path, "utf-8");
        const thread = JSON.parse(raw) as Thread;
        summaries.push(toThreadSummary(thread));
      } catch {
        // Skip threads whose thread.json is missing or unreadable.
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(threadId: string): Promise<Thread | null> {
    try {
      const raw = await readFile(this.threadFilePath(threadId), "utf-8");
      return JSON.parse(raw) as Thread;
    } catch {
      return null;
    }
  }

  async upsert(thread: Thread): Promise<void> {
    await this.ensureDir(this.threadDir(thread.id));
    const path = this.threadFilePath(thread.id);
    await this.atomicWrite(path, JSON.stringify(thread));
    await this.updateIndex((current) => {
      const next = new Set(current.order);
      next.add(thread.id);
      return { order: [...next], updatedAt: this.now().toISOString() };
    });
  }

  async delete(threadId: string): Promise<boolean> {
    const dir = this.threadDir(threadId);
    try {
      await stat(dir);
    } catch {
      return false;
    }
    await rm(dir, { recursive: true, force: true });
    await this.updateIndex((current) => {
      const order = current.order.filter((id) => id !== threadId);
      return { order, updatedAt: this.now().toISOString() };
    });
    return true;
  }

  private async readIndex(): Promise<ThreadIndex> {
    try {
      const raw = await readFile(this.indexPath(), "utf-8");
      const parsed = JSON.parse(raw) as Partial<ThreadIndex>;
      return {
        order: Array.isArray(parsed.order) ? parsed.order : [],
        updatedAt: parsed.updatedAt ?? this.now().toISOString(),
      };
    } catch {
      return { order: [], updatedAt: this.now().toISOString() };
    }
  }

  private async updateIndex(mutator: (current: ThreadIndex) => ThreadIndex): Promise<void> {
    const run = this.indexQueue.catch(() => undefined).then(async () => {
      const current = await this.readIndex();
      const next = mutator(current);
      await this.ensureDir(this.dataDir);
      await this.atomicWrite(this.indexPath(), JSON.stringify(next));
    });
    this.indexQueue = run.then(() => undefined, () => undefined);
    await run;
  }

  private threadDir(threadId: string): string {
    return threadDir(this.dataDir, threadId);
  }
  private threadFilePath(threadId: string): string {
    return join(this.threadDir(threadId), "thread.json");
  }
  private indexPath(): string {
    return join(this.dataDir, "index.json");
  }
  private async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  private async atomicWrite(path: string, contents: string): Promise<void> {
    await atomicWriteFile(path, contents);
  }
}

/**
 * File-backed session store: append-only `events.jsonl` + `messages.jsonl`, with
 * a `session.json` aggregate and usage-event compaction. Append paths are
 * unconditional (no per-seq dedup); `loadItems` coalesces by latest item id.
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string;
  private readonly usageEventCompaction: ResolvedUsageEventCompaction;

  constructor(dataDir: string, usageEventCompaction?: UsageEventCompactionOptions) {
    this.root = threadsRoot(dataDir);
    this.usageEventCompaction = {
      maxBytes: Math.max(1, Math.floor(usageEventCompaction?.maxBytes ?? DEFAULT_USAGE_EVENT_COMPACTION_MAX_BYTES)),
      retentionDays: Math.max(1, Math.floor(usageEventCompaction?.retentionDays ?? DEFAULT_USAGE_EVENT_RETENTION_DAYS)),
      nowIso: usageEventCompaction?.nowIso ?? (() => new Date().toISOString()),
    };
  }

  private threadDir(threadId: string): string {
    return threadDir(this.root, threadId);
  }
  private eventsPath(threadId: string): string {
    return join(this.threadDir(threadId), "events.jsonl");
  }
  private messagesPath(threadId: string): string {
    return join(this.threadDir(threadId), "messages.jsonl");
  }
  private sessionPath(threadId: string): string {
    return join(this.threadDir(threadId), "session.json");
  }
  private async ensureDir(threadId: string): Promise<void> {
    await mkdir(this.threadDir(threadId), { recursive: true });
  }

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    await this.ensureDir(threadId);
    await appendFile(this.eventsPath(threadId), `${JSON.stringify(event)}\n`, "utf-8");
    if (event.kind === "usage") {
      await this.compactUsageEventsIfLarge(threadId).catch((error) => warnUsageCompaction(threadId, error));
    }
  }

  async appendItem(threadId: string, item: TurnItem): Promise<void> {
    await this.ensureDir(threadId);
    await appendFile(this.messagesPath(threadId), `${JSON.stringify(item)}\n`, "utf-8");
  }

  async rewriteItems(threadId: string, items: TurnItem[]): Promise<void> {
    await this.ensureDir(threadId);
    const contents = items.map((item) => JSON.stringify(item)).join("\n");
    await atomicWriteFile(this.messagesPath(threadId), contents ? `${contents}\n` : "");
  }

  async updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null> {
    const items = await this.loadItems(threadId);
    const current = items.find((item) => item.id === itemId);
    if (!current) return null;
    const updated = { ...current, ...patch } as TurnItem;
    await this.ensureDir(threadId);
    await appendFile(this.messagesPath(threadId), `${JSON.stringify(updated)}\n`, "utf-8");
    return updated;
  }

  async loadItems(threadId: string): Promise<TurnItem[]> {
    const raw = (await readJsonl(this.messagesPath(threadId))) as TurnItem[];
    const latestById = new Map<string, TurnItem>();
    for (const item of raw) latestById.set(item.id, item);
    const seen = new Set<string>();
    const ordered: TurnItem[] = [];
    for (let index = raw.length - 1; index >= 0; index -= 1) {
      const item = raw[index];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.unshift(latestById.get(item.id)!);
    }
    return ordered;
  }

  async loadEventsSince(threadId: string, sinceSeq: number): Promise<RuntimeEvent[]> {
    const all = (await readJsonl(this.eventsPath(threadId))) as RuntimeEvent[];
    return all.filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async highestSeq(threadId: string): Promise<number> {
    const events = (await readJsonl(this.eventsPath(threadId))) as RuntimeEvent[];
    return events.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  async loadSession(threadId: string): Promise<SessionRecord | null> {
    try {
      const raw = await readFile(this.sessionPath(threadId), "utf-8");
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    await this.ensureDir(session.threadId);
    await atomicWriteFile(this.sessionPath(session.threadId), JSON.stringify(session));
  }

  async resetMemory(): Promise<void> {
    // The file session store keeps no in-memory caches; nothing to clear.
  }

  /** Used by the loop during shutdown to verify the file actually exists. */
  async exists(threadId: string): Promise<boolean> {
    try {
      await stat(this.threadDir(threadId));
      return true;
    } catch {
      return false;
    }
  }

  private async compactUsageEventsIfLarge(threadId: string): Promise<void> {
    const path = this.eventsPath(threadId);
    const info = await stat(path).catch(() => null);
    if (!info || info.size <= this.usageEventCompaction.maxBytes) return;
    const events = (await readJsonl(path)) as RuntimeEvent[];
    const compacted = compactUsageEvents(events, {
      nowIso: this.usageEventCompaction.nowIso(),
      retentionDays: this.usageEventCompaction.retentionDays,
    });
    if (compacted.length >= events.length) return;
    const contents = compacted.map((event) => JSON.stringify(event)).join("\n");
    await atomicWriteFile(path, contents ? `${contents}\n` : "");
  }
}

interface CompactUsageEventsOptions {
  nowIso: string;
  retentionDays: number;
}

interface UsageRetentionContext {
  cutoffMs: number;
  latestUsageIndex: number;
  latestBeforeCutoffIndex: number;
}

/**
 * Compact usage events: keep all non-usage events, drop usage events older than
 * the retention cutoff, and coalesce remaining usage events so only the latest
 * per (day:model) bucket survives. The most recent usage event and the latest
 * usage event before the cutoff are always retained.
 */
export function compactUsageEvents(events: RuntimeEvent[], options: CompactUsageEventsOptions): RuntimeEvent[] {
  const cutoffMs = Date.parse(options.nowIso) - options.retentionDays * MS_PER_DAY;
  if (!Number.isFinite(cutoffMs)) return events;
  let latestUsageIndex = -1;
  let latestBeforeCutoffIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.kind !== "usage") continue;
    latestUsageIndex = index;
    const timestamp = Date.parse(event.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoffMs) {
      latestBeforeCutoffIndex = index;
    }
  }
  if (latestUsageIndex < 0) return events;
  const keep = new Set<number>();
  const latestUsageIndexByBucket = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind !== "usage") {
      keep.add(index);
      continue;
    }
    if (!shouldRetainUsageEvent(event, index, { cutoffMs, latestUsageIndex, latestBeforeCutoffIndex })) {
      continue;
    }
    const bucket = usageCoalescingBucket(event);
    const previous = latestUsageIndexByBucket.get(bucket);
    if (previous !== undefined && previous !== latestBeforeCutoffIndex) {
      keep.delete(previous);
    }
    keep.add(index);
    latestUsageIndexByBucket.set(bucket, index);
  }
  return events.filter((_event, index) => keep.has(index));
}

function shouldRetainUsageEvent(event: RuntimeEvent, index: number, options: UsageRetentionContext): boolean {
  if (event.kind !== "usage") return true;
  if (index === options.latestUsageIndex || index === options.latestBeforeCutoffIndex) return true;
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= options.cutoffMs;
}

function usageCoalescingBucket(event: RuntimeEvent): string {
  if (event.kind !== "usage") return "";
  const day = Number.isFinite(Date.parse(event.timestamp))
    ? new Date(event.timestamp).toISOString().slice(0, 10)
    : event.timestamp;
  return `${day}:${event.model ?? ""}`;
}

function warnUsageCompaction(threadId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[nexus] usage event compaction failed for ${threadId}; keeping append-only log: ${message}`);
}

async function appendJsonlLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonl(path: string): Promise<unknown[]> {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}
