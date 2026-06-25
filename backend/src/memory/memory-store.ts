import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../adapters/store/atomic-write.js";
import {
  MemoryRecord,
  type MemoryDiagnostics,
  type MemoryScope,
  type MemoryUpdateRequest,
} from "../contracts/memory.js";

/** Caller-facing input for {@link FileMemoryStore.create}; defaults applied in the store. */
export interface MemoryCreateInput {
  content: string;
  scope?: MemoryScope;
  workspace?: string;
  project?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  tags?: string[];
  confidence?: number;
}

export interface MemoryStoreConfig {
  /** Whether the operator has turned long-term memory on. */
  enabled: boolean;
}

export interface MemoryListFilter {
  workspace?: string;
  includeDeleted?: boolean;
}

export interface MemoryRetrieveInput {
  query: string;
  workspace?: string;
  limit?: number;
}

export interface FileMemoryStoreOptions {
  /** The data directory; records live under `<dataDir>/memory/`. */
  dataDir: string;
  config: MemoryStoreConfig;
  /** Optional id generator (injectable for tests). */
  idGenerator?: () => string;
  /** Optional clock (injectable for tests). */
  nowIso?: () => string;
}

/**
 * Durable long-term memory persisted as one JSON file per record under
 * `<dataDir>/memory/`. Deletes and disables write soft tombstones
 * (`deletedAt` / `disabledAt`) so nothing is physically removed from disk and
 * history stays auditable. Retrieval is gated on `config.enabled` and scoped by
 * workspace authorization.
 */
export class FileMemoryStore {
  readonly rootDir: string;
  private readonly options: FileMemoryStoreOptions;
  private lastInjectedIds: string[] = [];

  constructor(options: FileMemoryStoreOptions) {
    this.options = options;
    this.rootDir = join(options.dataDir, "memory");
  }

  async create(input: MemoryCreateInput): Promise<MemoryRecord> {
    await mkdir(this.rootDir, { recursive: true });
    const now = this.now();
    const parsed = MemoryRecord.parse({
      id: this.options.idGenerator?.() ?? defaultId(),
      content: input.content,
      scope: input.scope ?? "workspace",
      workspace: input.workspace,
      project: input.project,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      tags: input.tags ?? [],
      confidence: input.confidence ?? 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.persist(parsed);
    return parsed;
  }

  async update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
    const current = await this.mustGet(id);
    const now = this.now();
    const next = MemoryRecord.parse({
      ...current,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.disabled === true ? { disabledAt: current.disabledAt ?? now } : {}),
      ...(patch.disabled === false ? { disabledAt: undefined } : {}),
      updatedAt: now,
    });
    await this.persist(next);
    return next;
  }

  async delete(id: string): Promise<MemoryRecord> {
    const current = await this.mustGet(id);
    const now = this.now();
    const next = MemoryRecord.parse({
      ...current,
      deletedAt: current.deletedAt ?? now,
      updatedAt: now,
    });
    await this.persist(next);
    return next;
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    const records = await this.readAll();
    return records
      .filter((record) => filter.includeDeleted || !record.deletedAt)
      .filter((record) => inScope(record, filter.workspace))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Word-overlap * confidence retrieval, gated on enabled + scope + active. */
  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRecord[]> {
    if (!this.options.config.enabled) return [];
    const active = (await this.list({ workspace: input.workspace })).filter(
      (record) => !record.disabledAt,
    );
    return active
      .map((record) => ({ record, score: scoreMemory(record, input.query) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt),
      )
      .slice(0, input.limit)
      .map((entry) => entry.record);
  }

  async diagnostics(): Promise<MemoryDiagnostics> {
    const records = await this.readAll();
    return {
      enabled: this.options.config.enabled,
      rootDir: this.rootDir,
      activeCount: records.filter((record) => !record.deletedAt && !record.disabledAt)
        .length,
      tombstoneCount: records.filter((record) => Boolean(record.deletedAt)).length,
      lastInjectedIds: [...this.lastInjectedIds],
    };
  }

  setLastInjected(ids: string[]): void {
    this.lastInjectedIds = [...ids];
  }

  private async mustGet(id: string): Promise<MemoryRecord> {
    const record = (await this.readAll()).find((candidate) => candidate.id === id);
    if (!record) throw new Error(`memory not found: ${id}`);
    return record;
  }

  private async readAll(): Promise<MemoryRecord[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readFile(join(this.rootDir, entry), "utf8")
            .then((text) => MemoryRecord.parse(JSON.parse(text)))
            .catch(() => null),
        ),
    );
    return records.filter((record): record is MemoryRecord => Boolean(record));
  }

  private persist(record: MemoryRecord): Promise<void> {
    return atomicWriteFile(
      join(this.rootDir, `${record.id}.json`),
      JSON.stringify(record, null, 2),
    );
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }
}

function defaultId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function inScope(record: MemoryRecord, workspace: string | undefined): boolean {
  if (record.scope === "user") return true;
  if (record.scope === "workspace") {
    return Boolean(workspace && record.workspace === workspace);
  }
  return true;
}

function scoreMemory(record: MemoryRecord, query: string): number {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 2),
  );
  let score = 0;
  const text = `${record.content} ${record.tags.join(" ")}`.toLowerCase();
  for (const word of words) {
    if (text.includes(word)) score += 1;
  }
  return score * record.confidence;
}
