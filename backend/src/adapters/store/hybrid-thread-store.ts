import { mkdir, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Thread, ThreadSummary } from "../../contracts/threads.js";
import type { RuntimeEvent } from "../../contracts/events.js";
import type { UsageSnapshot } from "../../contracts/usage.js";
import { UsageSnapshotSchema, emptyUsageSnapshot } from "../../contracts/usage.js";
import { diffUsage, hasUsage } from "../../services/usage-service.js";
import { FileThreadStore } from "./file-stores.js";
import type {
  IndexedUsageRecord,
  LatestUsageSnapshot,
  ListThreadsOptions,
  UsageIndex,
} from "./types.js";
import { searchTextForThread } from "./summary.js";

const USAGE_INSERT_CHUNK_SIZE = 200;

type UsageEvent = Extract<RuntimeEvent, { kind: "usage" }>;

interface UsageRow {
  thread_id: string;
  seq: number;
  timestamp: string;
  turn_id: string | null;
  model: string | null;
  usage_json: string;
}

/**
 * Minimal structural shape of the `node:sqlite` `DatabaseSync` we depend on.
 * Declared locally so the build does not require `@types/node` to ship the
 * `node:sqlite` typings.
 */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * SQLite-backed thread store. Extends the file-backed thread store (metadata.jsonl
 * snapshots + messages.jsonl hydration) with a SQLite index over a `threads` table
 * and a `usage_events` table, an event-seq high-water column, a prepared-statement
 * cache, and a chunked background backfill that yields to the event loop.
 *
 * Faithfully ported from the original `adapters/hybrid/hybrid-thread-store.js`.
 * Prefers the built-in `node:sqlite` module (Node >= 22). If it is unavailable
 * the store degrades to the pure file-backed behavior (all reads served from the
 * JSONL fallback), which preserves identical observable thread/usage results.
 */
export class HybridThreadStore extends FileThreadStore implements UsageIndex {
  private readonly sqlitePath: string;
  private readonly readyPromise: Promise<void>;
  private backfillPromise: Promise<void> | null = null;
  private db: SqliteDatabase | null = null;
  private readonly statementCache = new Map<string, SqliteStatement>();

  constructor(dataDir: string, options: { sqlitePath?: string; nowIso?: () => string } = {}) {
    super(dataDir, options);
    this.sqlitePath = resolve(options.sqlitePath ?? join(dataDir, "index.sqlite3"));
    this.readyPromise = this.initialize();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = null;
    }
  }

  async waitForBackfill(): Promise<void> {
    await this.ready();
    await this.backfillPromise;
  }

  override async list(options: ListThreadsOptions = {}): Promise<ThreadSummary[]> {
    await this.ready();
    if (this.db) {
      try {
        const rows = this.queryThreadRows(options);
        const summaries: ThreadSummary[] = [];
        for (const row of rows) {
          if (await this.rowHasReadableJsonl(row)) {
            summaries.push(summaryFromRow(row));
          } else {
            this.deleteIndexRow(String(row.id));
          }
        }
        return summaries;
      } catch (error) {
        warnSqlite("list", error);
      }
    }
    return super.list(options);
  }

  override async get(threadId: string): Promise<Thread | null> {
    await this.ready();
    if (this.db) {
      const row = this.findRow(threadId);
      if (row && !(await this.rowHasReadableJsonl(row))) {
        this.deleteIndexRow(threadId);
      }
    }
    const thread = await super.get(threadId);
    if (thread && this.db) {
      this.upsertIndexBestEffort(thread);
    }
    return thread;
  }

  override async upsert(thread: Thread): Promise<void> {
    await this.ready();
    await super.upsert(thread);
    if (this.db) {
      this.upsertIndexBestEffort(thread);
    }
  }

  override async delete(threadId: string): Promise<boolean> {
    await this.ready();
    const deleted = await super.delete(threadId);
    this.deleteIndexRow(threadId);
    return deleted;
  }

  // --- UsageIndex port ------------------------------------------------------

  async noteEvent(event: RuntimeEvent): Promise<void> {
    await this.ready();
    if (!this.db) return;
    this.noteEventHighWaterSync(event.threadId, event.seq);
    if (event.kind !== "usage") return;
    try {
      this.cachedStatement(`
        INSERT INTO usage_events (
          thread_id, seq, timestamp, turn_id, model, usage_json
        )
        VALUES (
          @thread_id, @seq, @timestamp, @turn_id, @model, @usage_json
        )
        ON CONFLICT(thread_id, seq) DO UPDATE SET
          timestamp = excluded.timestamp,
          turn_id = excluded.turn_id,
          model = excluded.model,
          usage_json = excluded.usage_json
      `).run(usageRowFromEvent(event as UsageEvent));
    } catch (error) {
      warnSqlite("record usage event", error);
    }
  }

  async getEventSeqHighWater(threadId: string): Promise<number | null> {
    await this.ready();
    if (!this.db) return null;
    try {
      const row = this.db.prepare("SELECT event_seq_high_water FROM threads WHERE id = ?").get(threadId);
      const value = row?.event_seq_high_water;
      return typeof value === "number" ? value : null;
    } catch (error) {
      warnSqlite("read event high water", error);
      return null;
    }
  }

  async loadUsageRecords(options: { threadId?: string } = {}): Promise<IndexedUsageRecord[]> {
    await this.ready();
    if (!this.db) throw new Error("hybrid sqlite unavailable");
    try {
      const threadId = options.threadId?.trim();
      const rows = threadId
        ? this.db
            .prepare(
              `SELECT * FROM usage_events WHERE thread_id = @thread_id ORDER BY thread_id ASC, seq ASC`,
            )
            .all({ thread_id: threadId })
        : this.db.prepare("SELECT * FROM usage_events ORDER BY thread_id ASC, seq ASC").all();
      return usageRecordsFromRows(rows as unknown as UsageRow[]);
    } catch (error) {
      warnSqlite("load usage records", error);
      throw error;
    }
  }

  async loadLatestUsageSnapshots(options: { threadIds?: string[] } = {}): Promise<LatestUsageSnapshot[]> {
    await this.ready();
    if (!this.db) throw new Error("hybrid sqlite unavailable");
    try {
      const threadIds = [...new Set((options.threadIds ?? []).map((id) => id.trim()).filter(Boolean))];
      if (threadIds.length > 0) {
        const placeholders = threadIds.map((_id, index) => `@id${index}`).join(", ");
        const params = Object.fromEntries(threadIds.map((id, index) => [`id${index}`, id]));
        const rows = this.db
          .prepare(
            `SELECT u.* FROM usage_events u
             JOIN (
               SELECT thread_id, MAX(seq) AS seq FROM usage_events
               WHERE thread_id IN (${placeholders}) GROUP BY thread_id
             ) latest ON latest.thread_id = u.thread_id AND latest.seq = u.seq
             ORDER BY u.thread_id ASC`,
          )
          .all(params);
        return latestUsageSnapshotsFromRows(rows as unknown as UsageRow[]);
      }
      const rows = this.db
        .prepare(
          `SELECT u.* FROM usage_events u
           JOIN (
             SELECT thread_id, MAX(seq) AS seq FROM usage_events GROUP BY thread_id
           ) latest ON latest.thread_id = u.thread_id AND latest.seq = u.seq
           ORDER BY u.thread_id ASC`,
        )
        .all();
      return latestUsageSnapshotsFromRows(rows as unknown as UsageRow[]);
    } catch (error) {
      warnSqlite("load latest usage snapshots", error);
      throw error;
    }
  }

  // --- SQLite lifecycle -----------------------------------------------------

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(dirname(this.sqlitePath), { recursive: true });
    try {
      const sqlite = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => SqliteDatabase };
      this.db = new sqlite.DatabaseSync(this.sqlitePath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
      this.startBackfill();
    } catch (error) {
      warnSqlite("initialize", error);
      try {
        this.db?.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  private migrate(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL,
        cost_budget_usd REAL,
        cost_budget_warning_sent INTEGER,
        relation TEXT NOT NULL,
        parent_thread_id TEXT,
        forked_from_thread_id TEXT,
        forked_from_title TEXT,
        forked_at TEXT,
        forked_from_message_count INTEGER,
        forked_from_turn_count INTEGER,
        goal_json TEXT,
        todos_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        preview TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_seq_high_water INTEGER NOT NULL DEFAULT 0,
        metadata_path TEXT NOT NULL,
        messages_path TEXT NOT NULL,
        events_path TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_updated_idx
        ON threads(updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_workspace_updated_idx
        ON threads(workspace, updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_status_updated_idx
        ON threads(status, updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_relation_updated_idx
        ON threads(relation, updated_at_ms DESC, id DESC);
      CREATE TABLE IF NOT EXISTS usage_events (
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        turn_id TEXT,
        model TEXT,
        usage_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS usage_events_thread_seq_idx
        ON usage_events(thread_id, seq);
      CREATE INDEX IF NOT EXISTS usage_events_timestamp_idx
        ON usage_events(timestamp);
    `);
    this.addColumnIfMissing("threads", "todos_json TEXT");
    this.addColumnIfMissing("threads", "usage_backfilled INTEGER NOT NULL DEFAULT 0");
  }

  private addColumnIfMissing(table: string, columnSql: string): void {
    if (!this.db) return;
    const column = columnSql.trim().split(/\s+/)[0];
    if (!column) return;
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (rows.some((row) => row.name === column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
    } catch (error) {
      warnSqlite(`add column ${column}`, error);
    }
  }

  private cachedStatement(sql: string): SqliteStatement {
    if (!this.db) throw new Error("sqlite unavailable");
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }

  private startBackfill(): void {
    if (this.backfillPromise) return;
    this.backfillPromise = this.backfill().catch((error) => {
      warnSqlite("background backfill", error);
    });
  }

  private async backfill(): Promise<void> {
    if (!this.db) return;
    const rows = this.db.prepare("SELECT id, usage_backfilled FROM threads").all();
    const indexed = new Map(rows.map((row) => [String(row.id), row.usage_backfilled === 1] as const));
    for (const threadId of await this.threadIdsFromFilesystem()) {
      const usageBackfilled = indexed.get(threadId);
      if (usageBackfilled === true) continue;
      if (usageBackfilled === undefined) {
        const thread = await super.get(threadId);
        if (!thread) continue;
        const scan = await this.scanEventsForBackfill(threadId);
        this.upsertIndexBestEffort(thread, scan.highWater);
        await this.insertUsageEventsChunked(threadId, scan.usage);
      } else {
        const scan = await this.scanEventsForBackfill(threadId);
        this.noteEventHighWaterSync(threadId, scan.highWater);
        await this.insertUsageEventsChunked(threadId, scan.usage);
      }
      this.markUsageBackfilled(threadId);
      await yieldToEventLoop();
    }
    try {
      for (const row of rows) {
        if (!existsSync(this.dir(String(row.id)))) {
          this.deleteIndexRow(String(row.id));
        }
      }
    } catch (error) {
      warnSqlite("backfill cleanup", error);
    }
  }

  /** Single pass over events.jsonl: high-water mark plus usage events. */
  private async scanEventsForBackfill(threadId: string): Promise<{ highWater: number; usage: UsageEvent[] }> {
    let highWater = 0;
    const usage: UsageEvent[] = [];
    try {
      for (const event of await readJsonlEvents(this.eventsPath(threadId))) {
        if (event.seq > highWater) highWater = event.seq;
        if (event.kind === "usage") usage.push(event as UsageEvent);
      }
    } catch (error) {
      warnSqlite(`scan events for ${threadId}`, error);
    }
    return { highWater, usage };
  }

  /**
   * Inserts usage rows in small transactions, yielding between chunks so a large
   * history backfill never starves the event loop past the GUI startup timeout.
   */
  private async insertUsageEventsChunked(threadId: string, events: UsageEvent[]): Promise<void> {
    if (!this.db || events.length === 0) return;
    const insert = this.cachedStatement(`
      INSERT OR REPLACE INTO usage_events (
        thread_id, seq, timestamp, turn_id, model, usage_json
      )
      VALUES (
        @thread_id, @seq, @timestamp, @turn_id, @model, @usage_json
      )
    `);
    for (let start = 0; start < events.length; start += USAGE_INSERT_CHUNK_SIZE) {
      const chunk = events.slice(start, start + USAGE_INSERT_CHUNK_SIZE).map(usageRowFromEvent);
      try {
        this.db.exec("BEGIN");
        try {
          for (const row of chunk) insert.run(row);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        warnSqlite(`backfill usage events for ${threadId}`, error);
        return;
      }
      await yieldToEventLoop();
    }
  }

  private markUsageBackfilled(threadId: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("UPDATE threads SET usage_backfilled = 1 WHERE id = ?").run(threadId);
    } catch (error) {
      warnSqlite("mark usage backfilled", error);
    }
  }

  private queryThreadRows(options: ListThreadsOptions): Array<Record<string, unknown>> {
    if (!this.db) return [];
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.archivedOnly) {
      where.push("status = @archivedStatus");
      params.archivedStatus = "archived";
    } else if (!options.includeArchived) {
      where.push("status NOT IN ('archived', 'deleted')");
    }
    if (!options.includeSide) {
      where.push("relation != 'side'");
    }
    const search = options.search?.trim().toLowerCase();
    if (search) {
      where.push("search_text LIKE @search ESCAPE '\\'");
      params.search = `%${escapeLike(search)}%`;
    }
    const limit = typeof options.limit === "number" ? Math.max(1, Math.floor(options.limit)) : undefined;
    if (limit !== undefined) params.limit = limit;
    const sql = `
      SELECT * FROM threads
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at_ms DESC, id DESC
      ${limit !== undefined ? "LIMIT @limit" : ""}
    `;
    return this.db.prepare(sql).all(params);
  }

  private findRow(threadId: string): Record<string, unknown> | null {
    if (!this.db) return null;
    try {
      return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) ?? null;
    } catch (error) {
      warnSqlite("find row", error);
      return null;
    }
  }

  private upsertIndexBestEffort(thread: Thread, eventSeqHighWater = 0): void {
    if (!this.db) return;
    try {
      const row = rowFromThread(thread, {
        metadataPath: this.metadataPath(thread.id),
        messagesPath: this.messagesPath(thread.id),
        eventsPath: this.eventsPath(thread.id),
        eventSeqHighWater,
      });
      this.db
        .prepare(
          `INSERT INTO threads (
            id, title, workspace, model, mode, status, approval_policy, sandbox_mode,
            cost_budget_usd, cost_budget_warning_sent, relation, parent_thread_id,
            forked_from_thread_id, forked_from_title, forked_at, forked_from_message_count,
            forked_from_turn_count, goal_json, todos_json, created_at, updated_at, created_at_ms,
            updated_at_ms, preview, message_count, event_seq_high_water, metadata_path,
            messages_path, events_path, search_text
          )
          VALUES (
            @id, @title, @workspace, @model, @mode, @status, @approval_policy, @sandbox_mode,
            @cost_budget_usd, @cost_budget_warning_sent, @relation, @parent_thread_id,
            @forked_from_thread_id, @forked_from_title, @forked_at, @forked_from_message_count,
            @forked_from_turn_count, @goal_json, @todos_json, @created_at, @updated_at, @created_at_ms,
            @updated_at_ms, @preview, @message_count, @event_seq_high_water, @metadata_path,
            @messages_path, @events_path, @search_text
          )
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            workspace = excluded.workspace,
            model = excluded.model,
            mode = excluded.mode,
            status = excluded.status,
            approval_policy = excluded.approval_policy,
            sandbox_mode = excluded.sandbox_mode,
            cost_budget_usd = excluded.cost_budget_usd,
            cost_budget_warning_sent = excluded.cost_budget_warning_sent,
            relation = excluded.relation,
            parent_thread_id = excluded.parent_thread_id,
            forked_from_thread_id = excluded.forked_from_thread_id,
            forked_from_title = excluded.forked_from_title,
            forked_at = excluded.forked_at,
            forked_from_message_count = excluded.forked_from_message_count,
            forked_from_turn_count = excluded.forked_from_turn_count,
            goal_json = excluded.goal_json,
            todos_json = excluded.todos_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            preview = excluded.preview,
            message_count = excluded.message_count,
            event_seq_high_water = CASE
              WHEN threads.event_seq_high_water > excluded.event_seq_high_water
                THEN threads.event_seq_high_water
              ELSE excluded.event_seq_high_water
            END,
            metadata_path = excluded.metadata_path,
            messages_path = excluded.messages_path,
            events_path = excluded.events_path,
            search_text = excluded.search_text`,
        )
        .run(row);
    } catch (error) {
      warnSqlite("upsert index", error);
    }
  }

  private deleteIndexRow(threadId: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      this.db.prepare("DELETE FROM usage_events WHERE thread_id = ?").run(threadId);
    } catch (error) {
      warnSqlite("delete index row", error);
    }
  }

  private noteEventHighWaterSync(threadId: string, seq: number): void {
    if (!this.db) return;
    try {
      this.cachedStatement(`
        UPDATE threads
        SET event_seq_high_water = CASE
          WHEN event_seq_high_water > @seq THEN event_seq_high_water
          ELSE @seq
        END
        WHERE id = @id
      `).run({ id: threadId, seq });
    } catch (error) {
      warnSqlite("note event seq", error);
    }
  }

  private async rowHasReadableJsonl(row: Record<string, unknown>): Promise<boolean> {
    const id = String(row.id);
    if (row.metadata_path !== this.metadataPath(id)) return false;
    if (row.messages_path !== this.messagesPath(id)) return false;
    if (row.events_path !== this.eventsPath(id)) return false;
    if (!existsSync(this.dir(id))) return false;
    return existsSync(this.metadataPath(id)) || existsSync(this.legacyThreadPath(id));
  }
}

function rowFromThread(
  thread: Thread,
  paths: { metadataPath: string; messagesPath: string; eventsPath: string; eventSeqHighWater: number },
): Record<string, unknown> {
  const itemSource = thread.turns.flatMap((turn) => turn.items);
  const preview = previewFromItems(itemSource);
  return {
    id: thread.id,
    title: thread.title,
    workspace: thread.workspace,
    model: thread.model,
    mode: thread.mode,
    status: thread.status,
    approval_policy: thread.approvalPolicy,
    sandbox_mode: thread.sandboxMode,
    cost_budget_usd: thread.costBudgetUsd ?? null,
    cost_budget_warning_sent:
      thread.costBudgetWarningSent === undefined ? null : thread.costBudgetWarningSent ? 1 : 0,
    relation: thread.relation ?? "primary",
    parent_thread_id: thread.parentThreadId ?? null,
    forked_from_thread_id: thread.forkedFromThreadId ?? null,
    forked_from_title: thread.forkedFromTitle ?? null,
    forked_at: thread.forkedAt ?? null,
    forked_from_message_count: thread.forkedFromMessageCount ?? null,
    forked_from_turn_count: thread.forkedFromTurnCount ?? null,
    goal_json: thread.goal ? JSON.stringify(thread.goal) : null,
    todos_json: thread.todos ? JSON.stringify(thread.todos) : null,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    created_at_ms: isoToMillis(thread.createdAt),
    updated_at_ms: isoToMillis(thread.updatedAt),
    preview: preview || null,
    message_count: itemSource.length,
    event_seq_high_water: paths.eventSeqHighWater,
    metadata_path: paths.metadataPath,
    messages_path: paths.messagesPath,
    events_path: paths.eventsPath,
    search_text: searchTextForThread(thread),
  };
}

function summaryFromRow(row: Record<string, unknown>): ThreadSummary {
  const goal = parseJson(row.goal_json);
  const todos = parseJson(row.todos_json);
  return {
    id: String(row.id),
    title: String(row.title),
    workspace: String(row.workspace),
    model: String(row.model),
    mode: row.mode,
    status: row.status,
    approvalPolicy: row.approval_policy,
    sandboxMode: row.sandbox_mode,
    ...(row.cost_budget_usd !== null ? { costBudgetUsd: row.cost_budget_usd } : {}),
    ...(row.cost_budget_warning_sent !== null ? { costBudgetWarningSent: Boolean(row.cost_budget_warning_sent) } : {}),
    relation: row.relation,
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    ...(row.forked_from_thread_id ? { forkedFromThreadId: row.forked_from_thread_id } : {}),
    ...(row.forked_from_title ? { forkedFromTitle: row.forked_from_title } : {}),
    ...(row.forked_at ? { forkedAt: row.forked_at } : {}),
    ...(row.forked_from_message_count !== null ? { forkedFromMessageCount: row.forked_from_message_count } : {}),
    ...(row.forked_from_turn_count !== null ? { forkedFromTurnCount: row.forked_from_turn_count } : {}),
    ...(goal ? { goal } : {}),
    ...(todos ? { todos } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  } as unknown as ThreadSummary;
}

function parseJson(raw: unknown): unknown {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function previewFromItems(items: Thread["turns"][number]["items"]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user_message" || item.kind === "assistant_text") return item.text.slice(0, 500);
    if (item.kind === "error") return item.message.slice(0, 500);
    if (item.kind === "tool_call") return (item.summary ?? item.toolName).slice(0, 500);
  }
  return "";
}

function usageRowFromEvent(event: UsageEvent): UsageRow {
  return {
    thread_id: event.threadId,
    seq: event.seq,
    timestamp: event.timestamp,
    turn_id: event.turnId ?? null,
    model: event.model ?? null,
    usage_json: JSON.stringify(event.usage),
  };
}

function usageRecordsFromRows(rows: UsageRow[]): IndexedUsageRecord[] {
  const previousByThread = new Map<string, UsageSnapshot>();
  const records: IndexedUsageRecord[] = [];
  for (const row of rows) {
    const usage = parseUsageSnapshot(row.usage_json);
    if (!usage) continue;
    const previous = previousByThread.get(row.thread_id) ?? emptyUsageSnapshot();
    const delta = diffUsage(usage, previous);
    previousByThread.set(row.thread_id, usage);
    if (!hasUsage(delta)) continue;
    records.push({
      threadId: row.thread_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      completedAt: row.timestamp,
      usage: delta,
    });
  }
  return records;
}

function latestUsageSnapshotsFromRows(rows: UsageRow[]): LatestUsageSnapshot[] {
  return rows.flatMap((row) => {
    const usage = parseUsageSnapshot(row.usage_json);
    if (!usage) return [];
    return [{ threadId: row.thread_id, seq: row.seq, usage }];
  });
}

function parseUsageSnapshot(raw: string): UsageSnapshot | null {
  try {
    const parsed = UsageSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isoToMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

async function readJsonlEvents(path: string): Promise<RuntimeEvent[]> {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const out: RuntimeEvent[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RuntimeEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function warnSqlite(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[nexus] hybrid sqlite ${action} failed; using JSONL fallback: ${message}`);
}
