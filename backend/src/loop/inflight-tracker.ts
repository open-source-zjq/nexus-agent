/**
 * Registry of all active ("in-flight") agent operations — model turns, review
 * runs, and child-agent runs — keyed by a stable id. The runtime uses it to
 * enumerate active work, abort everything on shutdown, and ask whether a given
 * operation is still running.
 *
 * Faithful port of the original `loop/inflight-tracker.js`: `begin`/`end` are the
 * core register/deregister pair, `run` wraps a unit of work so the id is always
 * removed (even on throw/abort), and `abortAll` clears the registry and returns
 * an `id:reason` marker per cleared entry.
 */
export type InflightKind = "model" | "review" | "child" | string;

export interface InflightRecord {
  id: string;
  kind: InflightKind;
  threadId?: string;
  turnId?: string;
  /** Epoch ms when the operation began; defaulted on `begin`. */
  startedAt?: number;
}

export class InflightTracker {
  private readonly entries = new Map<string, InflightRecord>();

  begin(record: InflightRecord): InflightRecord {
    const full: InflightRecord = { ...record, startedAt: record.startedAt ?? Date.now() };
    this.entries.set(full.id, full);
    return full;
  }

  end(id: string): InflightRecord | undefined {
    const record = this.entries.get(id);
    if (!record) return undefined;
    this.entries.delete(id);
    return record;
  }

  /**
   * Registers an inflight id, runs `work`, and guarantees the id is removed even
   * when the work throws or the abort signal fires. Returns the work's result.
   */
  async run<T>(record: InflightRecord, work: () => Promise<T>): Promise<T> {
    this.begin(record);
    try {
      return await work();
    } finally {
      this.end(record.id);
    }
  }

  get(id: string): InflightRecord | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): InflightRecord[] {
    return [...this.entries.values()];
  }

  abortAll(reason = "aborted"): string[] {
    const ids = [...this.entries.keys()];
    this.entries.clear();
    return ids.map((id) => `${id}:${reason}`);
  }

  size(): number {
    return this.entries.size;
  }
}
