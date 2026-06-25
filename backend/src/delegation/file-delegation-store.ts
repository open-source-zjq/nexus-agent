// Ported faithfully from the original `delegation/delegation-runtime` store
// section. Persists each child (delegated) agent run as a single JSON file under
// `rootDir` (`${id}.json`), and lists them back filtered by parent thread and
// ordered by creation time. CNY pricing fields are intentionally dropped (this
// fork has no CNY pricing).

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Aggregated token / cost usage carried by a persisted child run. */
export const ChildRunUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheHitTokens: z.number().int().nonnegative().optional(),
  cacheMissTokens: z.number().int().nonnegative().optional(),
  cacheHitRate: z.number().min(0).max(1).nullable().optional(),
  turns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  cacheSavingsUsd: z.number().nonnegative().optional(),
  tokenEconomySavingsTokens: z.number().int().nonnegative().optional(),
  tokenEconomySavingsUsd: z.number().nonnegative().optional(),
});
export type ChildRunUsage = z.infer<typeof ChildRunUsageSchema>;

/** Status lifecycle of a child run. */
export const ChildRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "aborted"]);
export type ChildRunStatus = z.infer<typeof ChildRunStatusSchema>;

/** A single persisted child (delegated) agent run record. */
export const ChildRunRecordSchema = z
  .object({
    id: z.string().min(1),
    parentThreadId: z.string().min(1),
    parentTurnId: z.string().min(1),
    label: z.string().optional(),
    prompt: z.string().min(1),
    workspace: z.string().optional(),
    model: z.string().optional(),
    status: ChildRunStatusSchema,
    summary: z.string().optional(),
    error: z.string().optional(),
    usage: ChildRunUsageSchema.default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ChildRunRecord = z.infer<typeof ChildRunRecordSchema>;

/** Persistence port for child-run records. */
export interface DelegationStore {
  upsert(record: ChildRunRecord): Promise<void>;
  list(parentThreadId?: string): Promise<ChildRunRecord[]>;
}

/**
 * File-backed delegation store: one `${id}.json` per child run under `rootDir`.
 * Reads are tolerant — unreadable / malformed files are skipped rather than
 * failing the whole list.
 */
export class FileDelegationStore implements DelegationStore {
  constructor(private readonly rootDir: string) {}

  async upsert(record: ChildRunRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(join(this.rootDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
  }

  async list(parentThreadId?: string): Promise<ChildRunRecord[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readFile(join(this.rootDir, entry), "utf8")
            .then((text) => ChildRunRecordSchema.parse(JSON.parse(text)))
            .catch(() => null),
        ),
    );
    return records
      .filter((record): record is ChildRunRecord => Boolean(record))
      .filter((record) => !parentThreadId || record.parentThreadId === parentThreadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** An in-memory delegation store (default when no persistence dir is configured). */
export class InMemoryDelegationStore implements DelegationStore {
  private readonly records = new Map<string, ChildRunRecord>();

  async upsert(record: ChildRunRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async list(parentThreadId?: string): Promise<ChildRunRecord[]> {
    return [...this.records.values()]
      .filter((record) => !parentThreadId || record.parentThreadId === parentThreadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
