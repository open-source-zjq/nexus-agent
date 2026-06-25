import type { UsageSnapshot } from "../contracts/usage.js";

/**
 * One persisted usage record fed into the counter. The snapshot carries the raw
 * provider numbers; the surrounding metadata lets us group by runtime / thread /
 * calendar day / model. `costUsd` on the snapshot stays `undefined` when neither
 * the provider nor a pricing estimate produced a cost, so the report can keep the
 * UNKNOWN-vs-ZERO distinction (`costUsd: null` until any cost is known).
 */
export interface UsageRecord {
  /** Logical runtime/session id (the "runtime" grouping key). */
  runtimeId?: string;
  threadId: string;
  /** ISO timestamp the turn completed at; used for calendar-day bucketing. */
  completedAt: string;
  usage: UsageSnapshot;
}

export type UsageGroupBy = "runtime" | "thread" | "day" | "model";
export type UsageRange = "today" | "week" | "month" | "all";

export interface UsageReportOptions {
  groupBy?: UsageGroupBy;
  range?: UsageRange;
  /** IANA timezone for day bucketing + range windows. Defaults to runtime tz. */
  tz?: string;
  /** Fixed "now" for deterministic range windows (defaults to current time). */
  nowIso?: string;
}

/** Dual-currency money. `cny` is omitted unless a usd->cny rate is injected. */
export interface Money {
  /** USD amount, or `null` while no cost is known (UNKNOWN, not ZERO). */
  usd: number | null;
  /** CNY amount; only present when a `usdToCny` rate was supplied. */
  cny?: number | null;
}

export interface UsageBucketTotals {
  key: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: Money;
  /** Hit rate over cache-eligible prompt tokens; `null` when no telemetry. */
  cacheHitRate: number | null;
  requests: number;
  /** Distinct thread ids that contributed to this bucket. */
  threadCount: number;
  /** Distinct calendar days (in tz) with activity. Always present, == 1 for non-day groupings of a single day, but meaningful in totals. */
  activeDays: number;
}

export interface UsageReportResult {
  groupBy: UsageGroupBy;
  range: UsageRange;
  timezone: string;
  buckets: UsageBucketTotals[];
  totals: UsageBucketTotals;
}

const MAX_RANGE_DAYS = 370;
const MS_PER_DAY = 86_400_000;

/**
 * Accumulates {@link UsageRecord}s and produces grouped totals on demand.
 *
 * Faithful to the original telemetry engine: token/cost counters are summed with
 * the UNKNOWN-vs-ZERO cost distinction preserved (cost stays `null` until any
 * provider or estimate cost is observed), cache hit rate is `null` when no cache
 * telemetry was reported, and day grouping uses calendar dates resolved in the
 * caller's timezone. Adds dual-currency output via an injectable usd->cny rate.
 */
export class UsageCounter {
  private readonly records: UsageRecord[] = [];
  private readonly usdToCny?: () => number | undefined;
  private readonly defaultTz: string;

  constructor(options?: {
    /** Injectable usd->cny rate. When omitted (or returns undefined), `cny` is omitted. */
    usdToCny?: () => number | undefined;
    /** Default IANA timezone for day bucketing / ranges. */
    timezone?: string;
  }) {
    this.usdToCny = options?.usdToCny;
    this.defaultTz = options?.timezone ?? defaultTimezone();
  }

  /** Fold a single usage snapshot for a thread into the counter. */
  record(record: UsageRecord): void {
    this.records.push({
      runtimeId: record.runtimeId,
      threadId: record.threadId,
      completedAt: record.completedAt,
      usage: normalizeUsageSnapshot(record.usage),
    });
  }

  /** Drop all records, or only those for one thread. */
  reset(threadId?: string): void {
    if (threadId === undefined) {
      this.records.length = 0;
      return;
    }
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i]!.threadId === threadId) this.records.splice(i, 1);
    }
  }

  report(options: UsageReportOptions = {}): UsageReportResult {
    const groupBy = options.groupBy ?? "runtime";
    const range = options.range ?? "all";
    const timezone = options.tz ?? this.defaultTz;
    assertValidTimezone(timezone);
    const now = options.nowIso ? new Date(options.nowIso) : new Date();
    const window = resolveRangeWindow(range, timezone, now);

    const inRange = this.records.filter((rec) => {
      const day = formatDateInTimezone(rec.completedAt, timezone);
      if (!day) return false;
      return day >= window.from && day <= window.to;
    });

    const buckets = new Map<string, MutableBucket>();
    for (const rec of inRange) {
      const key = bucketKey(groupBy, rec, timezone);
      if (key === null) continue;
      const bucket = buckets.get(key) ?? emptyBucket(key);
      addUsage(bucket, rec, timezone);
      buckets.set(key, bucket);
    }

    const finalized = [...buckets.values()]
      .map((bucket) => this.finalizeBucket(bucket))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));

    const totalsBucket = emptyBucket("__total__");
    for (const rec of inRange) addUsage(totalsBucket, rec, timezone);
    const totals = this.finalizeBucket(totalsBucket);

    return { groupBy, range, timezone, buckets: finalized, totals };
  }

  private finalizeBucket(bucket: MutableBucket): UsageBucketTotals {
    const cacheEligible = bucket.cacheReadTokens + bucket.cacheCreationTokens;
    return {
      key: bucket.key,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      totalTokens: bucket.totalTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cost: this.money(bucket.costKnown ? bucket.costUsd : null),
      cacheHitRate:
        bucket.hasCacheTelemetry && cacheEligible > 0
          ? bucket.cacheReadTokens / cacheEligible
          : null,
      requests: bucket.requests,
      threadCount: bucket.threadIds.size,
      activeDays: bucket.activeDays.size,
    };
  }

  private money(usd: number | null): Money {
    if (usd === null) {
      const rate = this.usdToCny?.();
      return rate === undefined ? { usd: null } : { usd: null, cny: null };
    }
    const rounded = round(usd);
    const rate = this.usdToCny?.();
    if (rate === undefined) return { usd: rounded };
    return { usd: rounded, cny: round(rounded * rate) };
  }
}

interface MutableBucket {
  key: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costKnown: boolean;
  hasCacheTelemetry: boolean;
  requests: number;
  threadIds: Set<string>;
  activeDays: Set<string>;
}

function emptyBucket(key: string): MutableBucket {
  return {
    key,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costKnown: false,
    hasCacheTelemetry: false,
    requests: 0,
    threadIds: new Set(),
    activeDays: new Set(),
  };
}

function addUsage(bucket: MutableBucket, rec: UsageRecord, timezone: string): void {
  const usage = rec.usage;
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
  bucket.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  bucket.requests += 1;
  if (usage.costUsd !== undefined) {
    bucket.costUsd += usage.costUsd;
    bucket.costKnown = true;
  }
  if (hasCacheTelemetry(usage)) bucket.hasCacheTelemetry = true;
  bucket.threadIds.add(rec.threadId);
  const day = formatDateInTimezone(rec.completedAt, timezone);
  if (day) bucket.activeDays.add(day);
}

function bucketKey(
  groupBy: UsageGroupBy,
  rec: UsageRecord,
  timezone: string,
): string | null {
  switch (groupBy) {
    case "runtime":
      return rec.runtimeId?.trim() || "unknown";
    case "thread":
      return rec.threadId;
    case "model":
      return rec.usage.model?.trim() || "unknown";
    case "day": {
      const day = formatDateInTimezone(rec.completedAt, timezone);
      return day ?? null;
    }
    default:
      return null;
  }
}

function hasCacheTelemetry(usage: UsageSnapshot): boolean {
  return (
    typeof usage.cacheReadTokens === "number" ||
    typeof usage.cacheCreationTokens === "number"
  );
}

/** Clamp/normalize a snapshot the way the original did, preserving UNKNOWN fields. */
export function normalizeUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  const promptTokens = Math.max(0, Math.floor(snapshot.promptTokens));
  const completionTokens = Math.max(0, Math.floor(snapshot.completionTokens));
  const totalTokens = Math.max(
    0,
    Math.floor(snapshot.totalTokens || promptTokens + completionTokens),
  );
  const out: UsageSnapshot = { promptTokens, completionTokens, totalTokens };
  if (snapshot.model !== undefined) out.model = snapshot.model;
  if (snapshot.reasoningTokens !== undefined) {
    out.reasoningTokens = Math.max(0, Math.floor(snapshot.reasoningTokens));
  }
  if (snapshot.cacheReadTokens !== undefined) {
    out.cacheReadTokens = Math.max(0, Math.floor(snapshot.cacheReadTokens));
  }
  if (snapshot.cacheCreationTokens !== undefined) {
    out.cacheCreationTokens = Math.max(0, Math.floor(snapshot.cacheCreationTokens));
  }
  if (snapshot.cachedTokens !== undefined) {
    out.cachedTokens = Math.max(0, Math.floor(snapshot.cachedTokens));
  }
  if (snapshot.cacheHitTokens !== undefined) {
    out.cacheHitTokens = Math.max(0, Math.floor(snapshot.cacheHitTokens));
  }
  if (snapshot.cacheMissTokens !== undefined) {
    out.cacheMissTokens = Math.max(0, Math.floor(snapshot.cacheMissTokens));
  }
  if (snapshot.cacheHitRate !== undefined) out.cacheHitRate = snapshot.cacheHitRate;
  if (snapshot.costUsd !== undefined) out.costUsd = Math.max(0, snapshot.costUsd);
  if (snapshot.cacheSavingsUsd !== undefined) {
    out.cacheSavingsUsd = Math.max(0, snapshot.cacheSavingsUsd);
  }
  if (snapshot.tokenEconomySavingsTokens !== undefined) {
    out.tokenEconomySavingsTokens = Math.max(0, Math.floor(snapshot.tokenEconomySavingsTokens));
  }
  if (snapshot.tokenEconomySavingsUsd !== undefined) {
    out.tokenEconomySavingsUsd = Math.max(0, snapshot.tokenEconomySavingsUsd);
  }
  return out;
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid timezone: ${timezone}`);
  }
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

function parseDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveRangeWindow(
  range: UsageRange,
  timezone: string,
  now: Date,
): { from: string; to: string } {
  const to = formatDateInTimezone(now.toISOString(), timezone);
  if (!to) throw new Error("invalid usage window date");
  const days = (() => {
    switch (range) {
      case "today":
        return 1;
      case "week":
        return 7;
      case "month":
        return 30;
      case "all":
        return MAX_RANGE_DAYS;
      default:
        throw new Error(`unsupported usage range: ${range}`);
    }
  })();
  return {
    from: dateString(addUtcDays(parseDateString(to), -(days - 1))),
    to,
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
