import type { UsageSnapshot } from "../contracts/usage.js";

export interface CacheTelemetrySnapshot {
  hits: number;
  misses: number;
  writes: number;
  invalidations: number;
  /** Hit rate over hit+miss prompt tokens; `null` when no telemetry recorded. */
  hitRate: number | null;
}

/**
 * Per-thread prompt-cache telemetry. Faithful to the original engine: hits and
 * misses are token counts, writes track cache-creation tokens, invalidations are
 * an event count, and `hitRate` is `null` until at least one hit/miss is seen.
 *
 * Adapted to the generic UsageSnapshot contract: a "hit" is `cacheReadTokens`,
 * the "miss" portion is the prompt tokens NOT served from cache, and a "write"
 * is `cacheCreationTokens`.
 */
export class CacheTelemetry {
  private readonly hits = new Map<string, number>();
  private readonly misses = new Map<string, number>();
  private readonly writes = new Map<string, number>();
  private readonly invalidations = new Map<string, number>();

  recordHit(threadId: string, tokens: number): void {
    this.hits.set(threadId, (this.hits.get(threadId) ?? 0) + tokens);
  }

  recordMiss(threadId: string, tokens: number): void {
    this.misses.set(threadId, (this.misses.get(threadId) ?? 0) + tokens);
  }

  recordWrite(threadId: string, tokens: number): void {
    this.writes.set(threadId, (this.writes.get(threadId) ?? 0) + tokens);
  }

  recordInvalidation(threadId: string): void {
    this.invalidations.set(threadId, (this.invalidations.get(threadId) ?? 0) + 1);
  }

  /**
   * Fold a usage snapshot's cache metrics into the per-thread counters.
   *
   * Faithful to the original `ingest`: a "hit" is the cached prompt tokens, a
   * "miss" is only recorded when the provider explicitly reports it (it is NOT
   * back-computed from promptTokens), and a "write" is the cache-creation
   * portion of the cached tokens (`cachedTokens - cacheHitTokens`, only when
   * that delta is positive). Adapted to the generic snapshot: `cacheHitTokens`
   * falls back to `cacheReadTokens`, and an explicit `cacheCreationTokens`
   * (Anthropic) is recorded as a write when present.
   */
  ingest(threadId: string, usage: UsageSnapshot): void {
    const hit = usage.cacheHitTokens ?? usage.cacheReadTokens;
    const cached = usage.cachedTokens ?? usage.cacheReadTokens;
    if (hit) this.recordHit(threadId, hit);
    if (usage.cacheMissTokens) this.recordMiss(threadId, usage.cacheMissTokens);
    if (usage.cacheCreationTokens) {
      this.recordWrite(threadId, usage.cacheCreationTokens);
    } else if (cached && cached > (hit ?? 0)) {
      this.recordWrite(threadId, cached - (hit ?? 0));
    }
  }

  snapshot(threadId: string): CacheTelemetrySnapshot {
    const hits = this.hits.get(threadId) ?? 0;
    const misses = this.misses.get(threadId) ?? 0;
    const total = hits + misses;
    return {
      hits,
      misses,
      writes: this.writes.get(threadId) ?? 0,
      invalidations: this.invalidations.get(threadId) ?? 0,
      hitRate: total === 0 ? null : hits / total,
    };
  }

  reset(threadId?: string): void {
    if (threadId === undefined) {
      this.hits.clear();
      this.misses.clear();
      this.writes.clear();
      this.invalidations.clear();
      return;
    }
    this.hits.delete(threadId);
    this.misses.delete(threadId);
    this.writes.delete(threadId);
    this.invalidations.delete(threadId);
  }
}
