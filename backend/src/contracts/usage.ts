import { z } from "zod";

/**
 * A single usage/cost snapshot reported by the model client for one request.
 * Token counts that a provider does not report stay `undefined` so the usage
 * service can distinguish "zero" from "unknown".
 */
export const UsageSnapshotSchema = z.object({
  model: z.string().optional(),
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /**
   * Prompt tokens served from the provider prompt cache (the original core
   * field). Preserved so the original-shaped snapshot validates; the gateway
   * clients populate `cacheReadTokens` (alias) instead.
   */
  cachedTokens: z.number().int().nonnegative().optional(),
  /** Prompt tokens served from the provider prompt cache. */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** Prompt tokens written into the provider prompt cache (Anthropic). */
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** Prompt tokens served from the provider prompt cache. */
  cacheHitTokens: z.number().int().nonnegative().optional(),
  /** Prompt tokens that missed the provider prompt cache. */
  cacheMissTokens: z.number().int().nonnegative().optional(),
  /** Ratio of cached prompt tokens to total prompt tokens; null when unknown. */
  cacheHitRate: z.number().min(0).max(1).nullable().optional(),
  /** Number of model turns aggregated into this snapshot. */
  turns: z.number().int().nonnegative().optional(),
  /** Estimated USD saved by serving prompt tokens from cache. */
  cacheSavingsUsd: z.number().nonnegative().optional(),
  /** Input tokens elided by request-level token economy compression. */
  tokenEconomySavingsTokens: z.number().int().nonnegative().optional(),
  /** Estimated USD saved by token-economy compression. */
  tokenEconomySavingsUsd: z.number().nonnegative().optional(),
  /** Provider reported an unrecoverable error mid-stream. */
  hasError: z.boolean().optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/** Returns a zeroed usage snapshot suitable as an accumulator seed. */
export const emptyUsageSnapshot = (): UsageSnapshot => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cacheHitRate: null,
  turns: 0,
  cacheSavingsUsd: 0,
  tokenEconomySavingsTokens: 0,
  tokenEconomySavingsUsd: 0,
});

/** Aggregated usage returned by GET /v1/usage. */
export const UsageReportSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  requests: z.number().int().nonnegative(),
  byModel: z.record(
    z.string(),
    z.object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().nullable(),
      requests: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

// --- Grouped aggregation responses (GET /v1/usage?group_by=...) -------------
// Ported from the original `contracts/usage`, minus the intentionally removed
// CNY pricing fields.

/** `YYYY-MM-DD` calendar date string. */
export const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Shared counters carried by every aggregation bucket/total. */
export const DailyUsageCountersSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cache_miss_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  cache_savings_usd: z.number().nonnegative(),
  token_economy_savings_tokens: z.number().int().nonnegative(),
  token_economy_savings_usd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  thread_count: z.number().int().nonnegative(),
  cache_hit_rate: z.number().min(0).max(1).nullable(),
});
export type DailyUsageCounters = z.infer<typeof DailyUsageCountersSchema>;

export const DailyUsageBucketSchema = DailyUsageCountersSchema.extend({
  date: DateStringSchema,
});

export const DailyUsageTotalsSchema = DailyUsageCountersSchema.extend({
  days: z.number().int().nonnegative(),
  active_days: z.number().int().nonnegative(),
});

/** Response for `group_by=day`. */
export const DailyUsageResponseSchema = z.object({
  group_by: z.literal("day"),
  from: DateStringSchema,
  to: DateStringSchema,
  timezone: z.string().min(1),
  buckets: z.array(DailyUsageBucketSchema),
  totals: DailyUsageTotalsSchema,
});
export type DailyUsageResponse = z.infer<typeof DailyUsageResponseSchema>;

export const ThreadUsageBucketSchema = DailyUsageCountersSchema.omit({
  thread_count: true,
}).extend({
  thread_id: z.string().min(1),
});

export const ThreadUsageTotalsSchema = DailyUsageCountersSchema.omit({
  thread_count: true,
}).extend({
  thread_count: z.number().int().nonnegative(),
});

/** Response for `group_by=thread`. */
export const ThreadUsageResponseSchema = z.object({
  group_by: z.literal("thread"),
  buckets: z.array(ThreadUsageBucketSchema),
  totals: ThreadUsageTotalsSchema,
});
export type ThreadUsageResponse = z.infer<typeof ThreadUsageResponseSchema>;

export const ModelUsageBucketSchema = DailyUsageCountersSchema.extend({
  model: z.string().min(1),
});

export const ModelUsageDayBucketSchema = DailyUsageBucketSchema;

/** Response for `group_by=model`. */
export const ModelUsageResponseSchema = z.object({
  group_by: z.literal("model"),
  from: DateStringSchema,
  to: DateStringSchema,
  timezone: z.string().min(1),
  buckets: z.array(ModelUsageBucketSchema),
  days: z.array(ModelUsageDayBucketSchema),
  totals: DailyUsageTotalsSchema,
});
export type ModelUsageResponse = z.infer<typeof ModelUsageResponseSchema>;
