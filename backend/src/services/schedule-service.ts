import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../adapters/store/atomic-write.js";
import {
  ScheduleTask,
  type ScheduleCreateRequest,
  type ScheduleUpdateRequest,
  type ScheduleSpec,
} from "../contracts/schedule.js";

/** A one-off prompt run the scheduler drives (a fresh thread + turn). */
export interface ScheduleRunner {
  run(input: {
    prompt: string;
    workspaceRoot?: string;
    model?: string;
    reasoningEffort?: string;
    mode: "agent" | "plan";
    title: string;
  }): Promise<{ threadId: string; status: string; text: string }>;
}

export interface ScheduleServiceOptions {
  dataDir: string;
  runner: ScheduleRunner;
  ids: () => string;
  nowMs?: () => number;
  nowIso?: () => string;
  logger?: (line: string) => void;
  /** Tick cadence; defaults to 30s. */
  tickMs?: number;
}

const RESULT_MAX = 4000;

/**
 * File-backed scheduled-task store + scheduler. Each task persists as one JSON
 * file under `<dataDir>/schedule/`. A timer ticks every `tickMs` and runs every
 * due+enabled task as a fresh agent thread, recording the outcome. Faithful to
 * the original schedule control-plane (create/list/update/delete + run).
 */
export class ScheduleService {
  readonly rootDir: string;
  private readonly options: ScheduleServiceOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: ScheduleServiceOptions) {
    this.options = options;
    this.rootDir = join(options.dataDir, "schedule");
  }

  async list(): Promise<ScheduleTask[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    const tasks = await Promise.all(
      entries
        .filter((e) => e.endsWith(".json"))
        .map((e) =>
          readFile(join(this.rootDir, e), "utf8")
            .then((text) => ScheduleTask.parse(JSON.parse(text)))
            .catch(() => null),
        ),
    );
    return tasks
      .filter((t): t is ScheduleTask => Boolean(t))
      .map((t) => ({ ...t, nextRunAt: isoOrUndef(this.computeNextRun(t, this.nowMs())) }))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<ScheduleTask | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }

  async create(req: ScheduleCreateRequest): Promise<ScheduleTask> {
    const now = this.nowIso();
    const task = ScheduleTask.parse({
      id: this.options.ids(),
      title: req.title,
      prompt: req.prompt,
      workspaceRoot: req.workspaceRoot,
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      mode: req.mode ?? "agent",
      enabled: req.enabled ?? true,
      priority: req.priority ?? 0,
      schedule: req.schedule,
      createdAt: now,
      updatedAt: now,
      lastStatus: "idle",
    });
    await this.persist(task);
    return { ...task, nextRunAt: isoOrUndef(this.computeNextRun(task, this.nowMs())) };
  }

  async update(id: string, patch: ScheduleUpdateRequest): Promise<ScheduleTask> {
    const current = await this.mustGet(id);
    const next = ScheduleTask.parse({
      ...current,
      ...stripUndefined(patch),
      updatedAt: this.nowIso(),
    });
    await this.persist(next);
    return { ...next, nextRunAt: isoOrUndef(this.computeNextRun(next, this.nowMs())) };
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    await mkdir(this.rootDir, { recursive: true });
    await unlink(join(this.rootDir, `${id}.json`)).catch(() => undefined);
    return { deleted: true };
  }

  /** Run a task immediately (out of schedule); returns the updated task. */
  async runNow(id: string): Promise<ScheduleTask> {
    const task = await this.mustGet(id);
    await this.runTask(task);
    return this.mustGet(id);
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.options.tickMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), tickMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run every due+enabled task once. Best-effort; never throws to the timer. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.nowMs();
      const tasks = await this.list();
      for (const task of tasks) {
        if (!task.enabled || task.lastStatus === "running") continue;
        if (this.isDue(task, now)) {
          await this.runTask(task).catch((error) => this.log(`task ${task.id} failed: ${errorMessage(error)}`));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runTask(task: ScheduleTask): Promise<void> {
    await this.persist({ ...task, lastStatus: "running", updatedAt: this.nowIso() });
    this.log(`running scheduled task "${task.title}" (${task.id})`);
    try {
      const result = await this.options.runner.run({
        prompt: task.prompt,
        title: task.title,
        mode: task.mode,
        ...(task.workspaceRoot ? { workspaceRoot: task.workspaceRoot } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
      });
      const fresh = (await this.get(task.id)) ?? task;
      await this.persist({
        ...fresh,
        lastStatus: result.status === "completed" ? "success" : "error",
        lastRunAt: this.nowIso(),
        lastResult: result.text.slice(0, RESULT_MAX),
        lastThreadId: result.threadId,
        // A one-off (`at`) task disables itself after it runs.
        enabled: task.schedule.kind === "at" ? false : fresh.enabled,
        updatedAt: this.nowIso(),
      });
    } catch (error) {
      const fresh = (await this.get(task.id)) ?? task;
      await this.persist({
        ...fresh,
        lastStatus: "error",
        lastRunAt: this.nowIso(),
        lastResult: errorMessage(error).slice(0, RESULT_MAX),
        updatedAt: this.nowIso(),
      });
    }
  }

  /** Whether a task should run at `nowMs` (without mutating state). */
  private isDue(task: ScheduleTask, nowMs: number): boolean {
    const next = this.computeNextRun(task, nowMs);
    return next !== undefined && nowMs >= next;
  }

  /** The next scheduled run (ms) for a task, or undefined if it will never run. */
  private computeNextRun(task: ScheduleTask, nowMs: number): number | undefined {
    const spec: ScheduleSpec = task.schedule;
    const lastRun = task.lastRunAt ? Date.parse(task.lastRunAt) : undefined;
    // `manual` never auto-fires (only run-now).
    if (spec.kind === "manual") return undefined;
    if (spec.kind === "at") {
      if (lastRun !== undefined) return undefined;
      const at = spec.atTime ? Date.parse(spec.atTime) : NaN;
      return Number.isNaN(at) ? undefined : at;
    }
    if (spec.kind === "interval") {
      const minutes = spec.everyMinutes ?? 0;
      if (minutes <= 0) return undefined;
      const base = lastRun ?? Date.parse(task.createdAt);
      return base + minutes * 60_000;
    }
    // daily: today's HH:MM slot, rolled to tomorrow once it has already run today.
    const [h, m] = (spec.timeOfDay ?? "0:0").split(":").map((n) => Number.parseInt(n, 10));
    const candidate = new Date(nowMs);
    candidate.setHours(h, m, 0, 0);
    let scheduled = candidate.getTime();
    if (lastRun !== undefined && lastRun >= scheduled) {
      scheduled += 24 * 60 * 60_000;
    }
    return scheduled;
  }

  private async mustGet(id: string): Promise<ScheduleTask> {
    const task = await this.get(id);
    if (!task) throw new Error(`scheduled task not found: ${id}`);
    return task;
  }

  private async persist(task: ScheduleTask): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await atomicWriteFile(join(this.rootDir, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  private log(line: string): void {
    this.options.logger?.(`[schedule] ${line}`);
  }
}

function isoOrUndef(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
