import type { UsageSnapshot, UsageReport } from "../contracts/usage.js";
import { emptyUsageSnapshot } from "../contracts/usage.js";
import type {
  DailyUsageResponse,
  ThreadUsageResponse,
  ModelUsageResponse,
} from "../contracts/usage.js";
import type { ModelPricing } from "../ports/model-client.js";
import { UsageCounter, type UsageReportOptions, type UsageReportResult } from "../telemetry/usage-counter.js";
import { CacheTelemetry, type CacheTelemetrySnapshot } from "../telemetry/cache-telemetry.js";

interface Accumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costKnown: boolean;
  cacheSavingsUsd: number;
  tokenEconomySavingsTokens: number;
  tokenEconomySavingsUsd: number;
  requests: number;
  turns: number;
}

function emptyAcc(): Accumulator {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costKnown: false,
    cacheSavingsUsd: 0,
    tokenEconomySavingsTokens: 0,
    tokenEconomySavingsUsd: 0,
    requests: 0,
    turns: 0,
  };
}

function add(acc: Accumulator, usage: UsageSnapshot): void {
  acc.promptTokens += usage.promptTokens;
  acc.completionTokens += usage.completionTokens;
  acc.totalTokens += usage.totalTokens;
  acc.cacheReadTokens += usage.cacheReadTokens ?? 0;
  acc.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  acc.cacheSavingsUsd += usage.cacheSavingsUsd ?? 0;
  acc.tokenEconomySavingsTokens += usage.tokenEconomySavingsTokens ?? 0;
  acc.tokenEconomySavingsUsd += usage.tokenEconomySavingsUsd ?? 0;
  acc.requests += 1;
  acc.turns += usage.turns ?? 1;
  if (usage.costUsd != null) {
    acc.costUsd += usage.costUsd;
    acc.costKnown = true;
  }
}

/**
 * Project an accumulator into a full usage snapshot. `costUsd` is always present
 * as a number (0 when unknown) so existing in-process consumers (budget gate,
 * child usage rollup) keep their numeric contract.
 */
function accToSnapshot(acc: Accumulator): UsageSnapshot & { costUsd: number } {
  return {
    promptTokens: acc.promptTokens,
    completionTokens: acc.completionTokens,
    totalTokens: acc.totalTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    turns: acc.turns,
    costUsd: round(acc.costUsd),
    ...(acc.cacheSavingsUsd > 0 ? { cacheSavingsUsd: round(acc.cacheSavingsUsd) } : {}),
    ...(acc.tokenEconomySavingsTokens > 0
      ? { tokenEconomySavingsTokens: acc.tokenEconomySavingsTokens }
      : {}),
    ...(acc.tokenEconomySavingsUsd > 0
      ? { tokenEconomySavingsUsd: round(acc.tokenEconomySavingsUsd) }
      : {}),
  };
}

/** Resolve the per-MTok cache-read rate, falling back to the default multiplier. */
function cachedInputRate(pricing: ModelPricing): number {
  return pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd * 0.1;
}

/**
 * Estimate the USD cost of a usage snapshot from a model's pricing table.
 *
 * Also populates `usage.cacheSavingsUsd` in place as a side-effect — the USD
 * saved by serving prompt tokens from cache instead of as fresh input. Faithful
 * to the original Nexus model client, which produced both the cost and the cache
 * savings together from the same per-model pricing (estimateNexusCost +
 * estimateNexusCacheSavings) when building the usage snapshot. The cache-read
 * rate falls back to the default multiplier when the model omits an explicit
 * `cachedInputPerMTokUsd`.
 */
export function estimateCostUsd(usage: UsageSnapshot, pricing: ModelPricing): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const uncachedInput = Math.max(0, usage.promptTokens - cacheRead - cacheCreation);
  const cachedRate = cachedInputRate(pricing);
  const creationRate = pricing.inputPerMTokUsd * 1.25;
  usage.cacheSavingsUsd = estimateCacheSavingsUsd(usage, pricing);
  return (
    (uncachedInput * pricing.inputPerMTokUsd +
      cacheRead * cachedRate +
      cacheCreation * creationRate +
      usage.completionTokens * pricing.outputPerMTokUsd) /
    1_000_000
  );
}

/**
 * Estimate the USD saved by serving prompt tokens from cache, i.e. the delta
 * between the full input rate and the discounted cache-read rate applied to the
 * cache-read tokens. Uses the same per-model pricing lookup as `estimateCostUsd`
 * (cache-read rate falls back to the default multiplier when the model omits an
 * explicit `cachedInputPerMTokUsd`). Faithful to estimateNexusCacheSavings,
 * which computed `cacheHitTokens * max(0, inputCacheMiss - inputCacheHit)`.
 */
export function estimateCacheSavingsUsd(usage: UsageSnapshot, pricing: ModelPricing): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const savingsRate = Math.max(0, pricing.inputPerMTokUsd - cachedInputRate(pricing));
  return (cacheRead * savingsRate) / 1_000_000;
}

/** Accumulates token/cost usage per thread and per model for the process lifetime. */
export interface UsageServiceOptions {
  /** Injectable usd->cny rate forwarded to the UsageCounter for dual-currency output. */
  usdToCny?: () => number | undefined;
  /** Default IANA timezone for the grouped time-range report. */
  timezone?: string;
}

export class UsageService {
  private readonly threads = new Map<string, Accumulator>();
  private readonly models = new Map<string, Accumulator>();
  private readonly global = emptyAcc();
  /** Time-range/day/runtime grouping engine, fed the same records as the accumulators. */
  private readonly counter: UsageCounter;
  /** Per-thread prompt-cache telemetry. */
  private readonly cacheTelemetry = new CacheTelemetry();

  constructor(options: UsageServiceOptions = {}) {
    this.counter = new UsageCounter({
      ...(options.usdToCny ? { usdToCny: options.usdToCny } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
    });
  }

  record(threadId: string, usage: UsageSnapshot, meta?: { runtimeId?: string; completedAt?: string }): Accumulator {
    const thread = this.threads.get(threadId) ?? emptyAcc();
    add(thread, usage);
    this.threads.set(threadId, thread);
    const modelId = usage.model ?? "unknown";
    const model = this.models.get(modelId) ?? emptyAcc();
    add(model, usage);
    this.models.set(modelId, model);
    add(this.global, usage);
    this.counter.record({
      threadId,
      ...(meta?.runtimeId ? { runtimeId: meta.runtimeId } : {}),
      completedAt: meta?.completedAt ?? new Date().toISOString(),
      usage,
    });
    this.cacheTelemetry.ingest(threadId, usage);
    return thread;
  }

  /**
   * Live, in-memory remainder for a thread as a full usage snapshot. This is the
   * delta the grouped reports reconcile against the last persisted usage event
   * so a process restart does not double-count.
   */
  forThread(threadId: string): UsageSnapshot & { costUsd: number } {
    const acc = this.threads.get(threadId);
    return acc ? accToSnapshot(acc) : accToSnapshot(emptyAcc());
  }

  /** Process-lifetime aggregate snapshot across every thread. */
  total(): UsageSnapshot & { costUsd: number } {
    return accToSnapshot(this.global);
  }

  /**
   * Seed a thread's live accumulator from a persisted snapshot (e.g. after a
   * resume), so subsequent live deltas are computed relative to it.
   */
  seedThread(threadId: string, usage: UsageSnapshot): UsageSnapshot {
    const acc = emptyAcc();
    add(acc, { ...usage, turns: usage.turns ?? 0 });
    // Re-seeding overwrites prior live accumulation; requests stay at the
    // single seed observation so the remainder math is stable.
    this.threads.set(threadId, acc);
    this.cacheTelemetry.reset(threadId);
    this.cacheTelemetry.ingest(threadId, usage);
    return accToSnapshot(acc);
  }

  /**
   * Fold a token-economy savings delta into a thread's live accumulator and
   * return the updated per-thread snapshot. Faithful to the original
   * `UsageService.recordTokenEconomySavings`, which the agent loop calls to
   * account for request-compression savings and then re-emits as a usage event.
   * (The CNY savings field is intentionally dropped per the fork's no-CNY policy.)
   */
  recordTokenEconomySavings(
    threadId: string,
    savings: {
      tokenEconomySavingsTokens?: number;
      tokenEconomySavingsUsd?: number;
    },
  ): UsageSnapshot & { costUsd: number } {
    const thread = this.threads.get(threadId) ?? emptyAcc();
    thread.tokenEconomySavingsTokens += savings.tokenEconomySavingsTokens ?? 0;
    thread.tokenEconomySavingsUsd += savings.tokenEconomySavingsUsd ?? 0;
    this.threads.set(threadId, thread);
    this.global.tokenEconomySavingsTokens += savings.tokenEconomySavingsTokens ?? 0;
    this.global.tokenEconomySavingsUsd += savings.tokenEconomySavingsUsd ?? 0;
    return accToSnapshot(thread);
  }

  /** Per-thread prompt-cache telemetry snapshot. */
  cacheSnapshot(threadId: string): CacheTelemetrySnapshot {
    return this.cacheTelemetry.snapshot(threadId);
  }

  /** Reset accumulators + telemetry; per-thread when `threadId` is supplied. */
  reset(threadId?: string): void {
    if (threadId) {
      this.threads.delete(threadId);
    } else {
      this.threads.clear();
      this.models.clear();
      Object.assign(this.global, emptyAcc());
    }
    this.counter.reset(threadId);
    this.cacheTelemetry.reset(threadId);
  }

  /** No-arg: legacy aggregate shape. With options: grouped time-range report. */
  report(): UsageReport;
  report(options: UsageReportOptions): UsageReportResult;
  report(options?: UsageReportOptions): UsageReport | UsageReportResult {
    if (options) return this.counter.report(options);
    const byModel: UsageReport["byModel"] = {};
    for (const [model, acc] of this.models) {
      byModel[model] = {
        promptTokens: acc.promptTokens,
        completionTokens: acc.completionTokens,
        totalTokens: acc.totalTokens,
        costUsd: acc.costKnown ? round(acc.costUsd) : null,
        requests: acc.requests,
      };
    }
    return {
      promptTokens: this.global.promptTokens,
      completionTokens: this.global.completionTokens,
      totalTokens: this.global.totalTokens,
      cacheReadTokens: this.global.cacheReadTokens,
      cacheCreationTokens: this.global.cacheCreationTokens,
      costUsd: this.global.costKnown ? round(this.global.costUsd) : null,
      requests: this.global.requests,
      byModel,
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ===========================================================================
// Grouped usage reconciliation + reports
// ===========================================================================
//
// Ported faithfully from the original Nexus usage-service / usage route, minus
// the intentionally removed CNY pricing fields. Per-thread usage is
// reconstructed by diffing persisted usage events against the live counter
// remainder so a restart does not drop or double-count usage.

const MAX_DAILY_USAGE_DAYS = 370;
const MS_PER_DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A reconstructed usage record fed into the grouped report builders. */
export interface ReconstructedUsageRecord {
  threadId: string;
  model?: string;
  completedAt: string;
  usage: UsageSnapshot;
}

/** Validation error carrying the canonical `validation_error` code. */
export class UsageValidationError extends Error {
  readonly code = "validation_error";
  constructor(message: string) {
    super(message);
    this.name = "UsageValidationError";
  }
}

export function defaultUsageTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new UsageValidationError(`invalid timezone: ${timezone}`);
  }
}

function parseDateString(value: string, field: string): Date {
  if (!DATE_RE.test(value)) throw new UsageValidationError(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new UsageValidationError(`${field} must be a valid calendar date`);
  }
  return date;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(from: string, to: string): number {
  const start = parseDateString(from, "from");
  const end = parseDateString(to, "to");
  const days = Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (days <= 0) throw new UsageValidationError("from must be on or before to");
  if (days > MAX_DAILY_USAGE_DAYS) {
    throw new UsageValidationError(`daily usage range must be ${MAX_DAILY_USAGE_DAYS} days or less`);
  }
  return days;
}

function stringParam(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.trim() ? first.trim() : undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatDateInTimezone(isoTimestamp: string, timezone: string): string | null {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function resolveUsageWindow(
  input: Record<string, unknown>,
  timezone: string,
  now: Date,
  label: string,
): { from: string; to: string } {
  const from = stringParam(input, "from");
  const to = stringParam(input, "to");
  if (from && to) return { from, to };
  if (from || to) throw new UsageValidationError(`${label} requires both from and to`);
  const window = stringParam(input, "window")?.toLowerCase().replace(/-/g, "_");
  if (!window) throw new UsageValidationError(`${label} requires from and to`);
  const toDate = formatDateInTimezone(now.toISOString(), timezone);
  if (!toDate) throw new UsageValidationError("invalid usage window date");
  const days = (() => {
    switch (window) {
      case "today":
        return 1;
      case "week":
        return 7;
      case "month":
        return 30;
      case "all":
      case "all_time":
      case "alltime":
        return MAX_DAILY_USAGE_DAYS;
      default:
        throw new UsageValidationError(`unsupported usage window: ${window}`);
    }
  })();
  return {
    from: dateString(addUtcDays(parseDateString(toDate, "to"), -(days - 1))),
    to: toDate,
  };
}

export interface DailyUsageQuery {
  groupBy: "day";
  from: string;
  to: string;
  timezone: string;
}

export interface ModelUsageQuery {
  groupBy: "model";
  from: string;
  to: string;
  timezone: string;
}

export function parseDailyUsageQuery(
  input: Record<string, unknown>,
  runtimeDefaultTimezone = defaultUsageTimezone(),
  now = new Date(),
): DailyUsageQuery {
  const groupBy = stringParam(input, "group_by") ?? "runtime";
  if (groupBy !== "day") throw new UsageValidationError(`unsupported usage grouping: ${groupBy}`);
  const timezone = stringParam(input, "timezone") ?? runtimeDefaultTimezone;
  assertValidTimezone(timezone);
  const { from, to } = resolveUsageWindow(input, timezone, now, "daily usage");
  inclusiveDayCount(from, to);
  return { groupBy: "day", from, to, timezone };
}

export function parseModelUsageQuery(
  input: Record<string, unknown>,
  runtimeDefaultTimezone = defaultUsageTimezone(),
  now = new Date(),
): ModelUsageQuery {
  const groupBy = stringParam(input, "group_by") ?? "runtime";
  if (groupBy !== "model") throw new UsageValidationError(`unsupported usage grouping: ${groupBy}`);
  const timezone = stringParam(input, "timezone") ?? runtimeDefaultTimezone;
  assertValidTimezone(timezone);
  const { from, to } = resolveUsageWindow(input, timezone, now, "model usage");
  inclusiveDayCount(from, to);
  return { groupBy: "model", from, to, timezone };
}

// --- counters --------------------------------------------------------------

interface BucketCounters {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_miss_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
  token_economy_savings_tokens: number;
  token_economy_savings_usd: number;
  turns: number;
  thread_count: number;
  cache_hit_rate: number | null;
}

function emptyCounters(): BucketCounters {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_miss_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    cache_savings_usd: 0,
    token_economy_savings_tokens: 0,
    token_economy_savings_usd: 0,
    turns: 0,
    thread_count: 0,
    cache_hit_rate: null,
  };
}

function usageCacheHit(usage: UsageSnapshot): number {
  if (typeof usage.cacheHitTokens === "number") return usage.cacheHitTokens;
  if (typeof usage.cacheReadTokens === "number") return usage.cacheReadTokens;
  return 0;
}

function usageCacheMiss(usage: UsageSnapshot): number {
  if (typeof usage.cacheMissTokens === "number") return usage.cacheMissTokens;
  return 0;
}

function hasCacheTelemetry(usage: UsageSnapshot): boolean {
  return (
    typeof usage.cacheHitTokens === "number" ||
    typeof usage.cacheMissTokens === "number" ||
    typeof usage.cacheReadTokens === "number"
  );
}

function addUsageCounters(target: BucketCounters, usage: UsageSnapshot): { hasCacheTelemetry: boolean } {
  const cached = usageCacheHit(usage);
  const miss = usageCacheMiss(usage);
  target.input_tokens += usage.promptTokens;
  target.output_tokens += usage.completionTokens;
  target.reasoning_tokens += usage.reasoningTokens ?? 0;
  target.cached_tokens += cached;
  target.cache_miss_tokens += miss;
  target.total_tokens += usage.totalTokens;
  target.cost_usd += usage.costUsd ?? 0;
  target.cache_savings_usd += usage.cacheSavingsUsd ?? 0;
  target.token_economy_savings_tokens += usage.tokenEconomySavingsTokens ?? 0;
  target.token_economy_savings_usd += usage.tokenEconomySavingsUsd ?? 0;
  target.turns += usage.turns ?? 0;
  return { hasCacheTelemetry: hasCacheTelemetry(usage) };
}

function finalizeCacheRate(counters: BucketCounters, hasTelemetry: boolean): BucketCounters {
  const cacheTotal = counters.cached_tokens + counters.cache_miss_tokens;
  return {
    ...counters,
    cache_hit_rate: hasTelemetry && cacheTotal > 0 ? counters.cached_tokens / cacheTotal : null,
  };
}

interface DailyMutableBucket extends BucketCounters {
  date: string;
  threadIds: Set<string>;
  hasCacheTelemetry: boolean;
}

interface ThreadMutableBucket extends BucketCounters {
  thread_id: string;
  hasCacheTelemetry: boolean;
}

interface ModelMutableBucket extends BucketCounters {
  model: string;
  threadIds: Set<string>;
  hasCacheTelemetry: boolean;
}

function emptyDailyBucket(date: string): DailyMutableBucket {
  return { date, ...emptyCounters(), threadIds: new Set(), hasCacheTelemetry: false };
}

function emptyThreadBucket(threadId: string): ThreadMutableBucket {
  return { thread_id: threadId, ...emptyCounters(), hasCacheTelemetry: false };
}

function emptyModelBucket(model: string): ModelMutableBucket {
  return { model, ...emptyCounters(), threadIds: new Set(), hasCacheTelemetry: false };
}

function projectCounters(c: BucketCounters): Omit<BucketCounters, "thread_count"> & { thread_count?: number } {
  return {
    input_tokens: c.input_tokens,
    output_tokens: c.output_tokens,
    reasoning_tokens: c.reasoning_tokens,
    cached_tokens: c.cached_tokens,
    cache_miss_tokens: c.cache_miss_tokens,
    total_tokens: c.total_tokens,
    cost_usd: c.cost_usd,
    cache_savings_usd: c.cache_savings_usd,
    token_economy_savings_tokens: c.token_economy_savings_tokens,
    token_economy_savings_usd: c.token_economy_savings_usd,
    turns: c.turns,
    cache_hit_rate: c.cache_hit_rate,
  };
}

export function buildThreadUsageResponse(records: ReconstructedUsageRecord[]): ThreadUsageResponse {
  const buckets = new Map<string, ThreadMutableBucket>();
  for (const record of records) {
    const bucket = buckets.get(record.threadId) ?? emptyThreadBucket(record.threadId);
    const added = addUsageCounters(bucket, record.usage);
    bucket.hasCacheTelemetry = bucket.hasCacheTelemetry || added.hasCacheTelemetry;
    buckets.set(record.threadId, bucket);
  }
  const finalized = [...buckets.values()]
    .map((bucket) => {
      const f = finalizeCacheRate(bucket, bucket.hasCacheTelemetry);
      return { thread_id: bucket.thread_id, ...projectCounters(f) };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens || a.thread_id.localeCompare(b.thread_id));
  const totalsBase = finalized.reduce<BucketCounters>((acc, bucket) => {
    acc.input_tokens += bucket.input_tokens;
    acc.output_tokens += bucket.output_tokens;
    acc.reasoning_tokens += bucket.reasoning_tokens;
    acc.cached_tokens += bucket.cached_tokens;
    acc.cache_miss_tokens += bucket.cache_miss_tokens;
    acc.total_tokens += bucket.total_tokens;
    acc.cost_usd += bucket.cost_usd;
    acc.cache_savings_usd += bucket.cache_savings_usd;
    acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens;
    acc.token_economy_savings_usd += bucket.token_economy_savings_usd;
    acc.turns += bucket.turns;
    return acc;
  }, { ...emptyCounters(), thread_count: finalized.length });
  const totals = finalizeCacheRate(totalsBase, [...buckets.values()].some((b) => b.hasCacheTelemetry));
  return {
    group_by: "thread",
    buckets: finalized.map((b) => ({ ...b })) as ThreadUsageResponse["buckets"],
    totals: { ...projectCounters(totals), thread_count: finalized.length } as ThreadUsageResponse["totals"],
  };
}

export function buildDailyUsageResponse(
  records: ReconstructedUsageRecord[],
  query: DailyUsageQuery,
): DailyUsageResponse {
  const days = inclusiveDayCount(query.from, query.to);
  assertValidTimezone(query.timezone);
  const start = parseDateString(query.from, "from");
  const buckets = new Map<string, DailyMutableBucket>();
  for (let offset = 0; offset < days; offset += 1) {
    const day = dateString(addUtcDays(start, offset));
    buckets.set(day, emptyDailyBucket(day));
  }
  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone);
    if (!day) continue;
    const bucket = buckets.get(day);
    if (!bucket) continue;
    const added = addUsageCounters(bucket, record.usage);
    bucket.threadIds.add(record.threadId);
    bucket.thread_count = bucket.threadIds.size;
    bucket.hasCacheTelemetry = bucket.hasCacheTelemetry || added.hasCacheTelemetry;
  }
  const finalized = [...buckets.values()].map((bucket) => {
    const f = finalizeCacheRate(bucket, bucket.hasCacheTelemetry);
    return { date: bucket.date, ...projectCounters(f), thread_count: bucket.thread_count };
  });
  const threadIds = new Set<string>();
  let activeDays = 0;
  const totalsBase = finalized.reduce<BucketCounters>((acc, bucket) => {
    acc.input_tokens += bucket.input_tokens;
    acc.output_tokens += bucket.output_tokens;
    acc.reasoning_tokens += bucket.reasoning_tokens;
    acc.cached_tokens += bucket.cached_tokens;
    acc.cache_miss_tokens += bucket.cache_miss_tokens;
    acc.total_tokens += bucket.total_tokens;
    acc.cost_usd += bucket.cost_usd;
    acc.cache_savings_usd += bucket.cache_savings_usd;
    acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens;
    acc.token_economy_savings_usd += bucket.token_economy_savings_usd;
    acc.turns += bucket.turns;
    if (
      bucket.turns > 0 ||
      bucket.total_tokens > 0 ||
      bucket.cost_usd > 0 ||
      bucket.token_economy_savings_tokens > 0
    ) {
      activeDays += 1;
    }
    const accumulator = buckets.get(bucket.date);
    if (accumulator) for (const id of accumulator.threadIds) threadIds.add(id);
    return acc;
  }, emptyCounters());
  const totals = finalizeCacheRate(totalsBase, [...buckets.values()].some((b) => b.hasCacheTelemetry));
  return {
    group_by: "day",
    from: query.from,
    to: query.to,
    timezone: query.timezone,
    buckets: finalized.map(({ thread_count, ...rest }) => ({ ...rest, thread_count })) as DailyUsageResponse["buckets"],
    totals: { ...projectCounters(totals), thread_count: threadIds.size, days, active_days: activeDays } as DailyUsageResponse["totals"],
  };
}

export function buildModelUsageResponse(
  records: ReconstructedUsageRecord[],
  query: ModelUsageQuery,
): ModelUsageResponse {
  const days = inclusiveDayCount(query.from, query.to);
  assertValidTimezone(query.timezone);
  const start = parseDateString(query.from, "from");
  const dayBuckets = new Map<string, DailyMutableBucket>();
  const modelBuckets = new Map<string, ModelMutableBucket>();
  for (let offset = 0; offset < days; offset += 1) {
    const day = dateString(addUtcDays(start, offset));
    dayBuckets.set(day, emptyDailyBucket(day));
  }
  for (const record of records) {
    const day = formatDateInTimezone(record.completedAt, query.timezone);
    if (!day) continue;
    const dayBucket = dayBuckets.get(day);
    if (!dayBucket) continue;
    const model = record.model?.trim() || "unknown";
    const modelBucket = modelBuckets.get(model) ?? emptyModelBucket(model);
    const dayAdded = addUsageCounters(dayBucket, record.usage);
    const modelAdded = addUsageCounters(modelBucket, record.usage);
    dayBucket.threadIds.add(record.threadId);
    dayBucket.thread_count = dayBucket.threadIds.size;
    dayBucket.hasCacheTelemetry = dayBucket.hasCacheTelemetry || dayAdded.hasCacheTelemetry;
    modelBucket.threadIds.add(record.threadId);
    modelBucket.thread_count = modelBucket.threadIds.size;
    modelBucket.hasCacheTelemetry = modelBucket.hasCacheTelemetry || modelAdded.hasCacheTelemetry;
    modelBuckets.set(model, modelBucket);
  }
  const finalizedDays = [...dayBuckets.values()].map((bucket) => {
    const f = finalizeCacheRate(bucket, bucket.hasCacheTelemetry);
    return { date: bucket.date, ...projectCounters(f), thread_count: bucket.thread_count };
  });
  const finalizedModels = [...modelBuckets.values()]
    .map((bucket) => {
      const f = finalizeCacheRate(bucket, bucket.hasCacheTelemetry);
      return { model: bucket.model, ...projectCounters(f), thread_count: bucket.threadIds.size };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
  let activeDays = 0;
  const totalsBase = finalizedDays.reduce<BucketCounters>((acc, bucket) => {
    acc.input_tokens += bucket.input_tokens;
    acc.output_tokens += bucket.output_tokens;
    acc.reasoning_tokens += bucket.reasoning_tokens;
    acc.cached_tokens += bucket.cached_tokens;
    acc.cache_miss_tokens += bucket.cache_miss_tokens;
    acc.total_tokens += bucket.total_tokens;
    acc.cost_usd += bucket.cost_usd;
    acc.cache_savings_usd += bucket.cache_savings_usd;
    acc.token_economy_savings_tokens += bucket.token_economy_savings_tokens;
    acc.token_economy_savings_usd += bucket.token_economy_savings_usd;
    acc.turns += bucket.turns;
    if (
      bucket.turns > 0 ||
      bucket.total_tokens > 0 ||
      bucket.cost_usd > 0 ||
      bucket.token_economy_savings_tokens > 0
    ) {
      activeDays += 1;
    }
    return acc;
  }, emptyCounters());
  const threadIds = new Set<string>();
  for (const bucket of modelBuckets.values()) for (const id of bucket.threadIds) threadIds.add(id);
  const totals = finalizeCacheRate(totalsBase, [...modelBuckets.values()].some((b) => b.hasCacheTelemetry));
  return {
    group_by: "model",
    from: query.from,
    to: query.to,
    timezone: query.timezone,
    buckets: finalizedModels.map((b) => ({ ...b })) as ModelUsageResponse["buckets"],
    days: finalizedDays.map(({ thread_count, ...rest }) => ({ ...rest, thread_count })) as ModelUsageResponse["days"],
    totals: { ...projectCounters(totals), thread_count: threadIds.size, days, active_days: activeDays } as ModelUsageResponse["totals"],
  };
}

// --- per-thread reconstruction ---------------------------------------------

/** Resolve the model attributed to a usage event/record for a thread. */
function usageRecordModel(
  thread: { model?: string; turns?: Array<{ id: string; model?: string }> },
  event: { model?: string; turnId?: string },
): string {
  const eventModel = event.model?.trim();
  if (eventModel) return eventModel;
  const trimmedTurnId = event.turnId?.trim() ?? "";
  if (trimmedTurnId) {
    const turnModel = thread.turns?.find((turn) => turn.id === trimmedTurnId)?.model?.trim();
    if (turnModel) return turnModel;
  }
  const latestTurnModel = [...(thread.turns ?? [])].reverse().find((turn) => turn.model?.trim())?.model?.trim();
  return latestTurnModel || thread.model?.trim() || "unknown";
}

function diffNumber(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function diffOptionalNumber(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined && previous === undefined) return undefined;
  return Math.max(0, (current ?? 0) - (previous ?? 0));
}

/** Subtract a previous cumulative snapshot from the current cumulative snapshot. */
export function diffUsage(current: UsageSnapshot, previous: UsageSnapshot): UsageSnapshot {
  const promptTokens = diffNumber(current.promptTokens, previous.promptTokens);
  const completionTokens = diffNumber(current.completionTokens, previous.completionTokens);
  const reportedTotal = diffNumber(current.totalTokens, previous.totalTokens);
  const totalTokens = reportedTotal || promptTokens + completionTokens;
  const cacheReadTokens = diffOptionalNumber(current.cacheReadTokens, previous.cacheReadTokens);
  const cacheCreationTokens = diffOptionalNumber(current.cacheCreationTokens, previous.cacheCreationTokens);
  const cacheHitTokens = diffOptionalNumber(current.cacheHitTokens, previous.cacheHitTokens);
  const cacheMissTokens = diffOptionalNumber(current.cacheMissTokens, previous.cacheMissTokens);
  const hitBasis = cacheHitTokens ?? cacheReadTokens;
  const cacheTotal = (hitBasis ?? 0) + (cacheMissTokens ?? 0);
  const cacheHitRate = hitBasis !== undefined && cacheTotal > 0 ? hitBasis / cacheTotal : null;
  const cacheSavingsUsd = diffOptionalNumber(current.cacheSavingsUsd, previous.cacheSavingsUsd);
  const tokenEconomySavingsTokens = diffOptionalNumber(
    current.tokenEconomySavingsTokens,
    previous.tokenEconomySavingsTokens,
  );
  const tokenEconomySavingsUsd = diffOptionalNumber(
    current.tokenEconomySavingsUsd,
    previous.tokenEconomySavingsUsd,
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
    cacheHitRate,
    turns: diffNumber(current.turns ?? 0, previous.turns ?? 0),
    ...(current.costUsd !== undefined || previous.costUsd !== undefined
      ? { costUsd: diffNumber(current.costUsd ?? 0, previous.costUsd ?? 0) }
      : {}),
    ...(cacheSavingsUsd !== undefined ? { cacheSavingsUsd } : {}),
    ...(tokenEconomySavingsTokens !== undefined ? { tokenEconomySavingsTokens } : {}),
    ...(tokenEconomySavingsUsd !== undefined ? { tokenEconomySavingsUsd } : {}),
  };
}

/** Whether a usage delta carries any non-zero usage worth recording. */
export function hasUsage(usage: UsageSnapshot): boolean {
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.totalTokens > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheCreationTokens ?? 0) > 0 ||
    (usage.cacheHitTokens ?? 0) > 0 ||
    (usage.cacheMissTokens ?? 0) > 0 ||
    (usage.turns ?? 0) > 0 ||
    (usage.costUsd ?? 0) > 0 ||
    (usage.tokenEconomySavingsTokens ?? 0) > 0
  );
}

/** A persisted `usage` event used to reconstruct per-record deltas. */
export interface PersistedUsageEvent {
  seq: number;
  timestamp: string;
  turnId?: string;
  model?: string;
  usage: UsageSnapshot;
}

/** A thread snapshot (with model + turns) used to attribute reconstructed records. */
export interface UsageThreadSource {
  id: string;
  model?: string;
  updatedAt?: string;
  turns?: Array<{ id: string; model?: string }>;
}

/**
 * Reconstruct per-record usage for one thread by diffing the ordered persisted
 * usage events (each carrying a cumulative snapshot) against each other, then
 * appending the live in-memory remainder (current counter minus the last
 * persisted snapshot). Faithful to the original usage route fallback path.
 */
export function reconstructThreadUsageRecords(input: {
  thread: UsageThreadSource;
  usageEvents: PersistedUsageEvent[];
  liveRemainder: UsageSnapshot;
  nowIso: string;
}): ReconstructedUsageRecord[] {
  const records: ReconstructedUsageRecord[] = [];
  let latestPersisted = emptyUsageSnapshot();
  const ordered = [...input.usageEvents].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    const delta = diffUsage(event.usage, latestPersisted);
    latestPersisted = event.usage;
    if (hasUsage(delta)) {
      records.push({
        threadId: input.thread.id,
        model: usageRecordModel(input.thread, event),
        completedAt: event.timestamp,
        usage: delta,
      });
    }
  }
  const liveRemainder = diffUsage(input.liveRemainder, latestPersisted);
  if (hasUsage(liveRemainder)) {
    records.push({
      threadId: input.thread.id,
      model: usageRecordModel(input.thread, { turnId: input.thread.turns?.at(-1)?.id }),
      completedAt: input.thread.updatedAt || input.nowIso,
      usage: liveRemainder,
    });
  }
  return records;
}
