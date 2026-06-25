import { z } from "zod";

/**
 * Scheduled task contracts. A task runs a fixed prompt as a fresh agent thread
 * on a recurring or one-off schedule. Faithful to the original schedule MCP's
 * task shape ({title,prompt,workspaceRoot,model,reasoningEffort,mode,enabled,
 * schedule:{kind,atTime,timeOfDay,everyMinutes}}).
 */

/**
 * Schedule kind vocabulary, faithful to the original schedule MCP:
 * - `manual`   : never auto-fires; only runs on explicit run-now.
 * - `at`       : one-off at an ISO timestamp (`atTime`).
 * - `daily`    : every day at `timeOfDay` ("HH:MM", 24h local).
 * - `interval` : every `everyMinutes` minutes.
 * `manual` is accepted on update (matching the original's update enum); create
 * accepts at/daily/interval.
 */
export const ScheduleKind = z.enum(["manual", "at", "daily", "interval"]);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

export const ScheduleSpec = z
  .object({
    kind: ScheduleKind,
    /** ISO timestamp for kind="at". */
    atTime: z.string().optional(),
    /** "HH:MM" (24h, local) for kind="daily". */
    timeOfDay: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
    /** Minutes between runs for kind="interval". */
    everyMinutes: z.number().int().positive().optional(),
  })
  .refine(
    (s) =>
      s.kind === "manual" ||
      (s.kind === "at" && Boolean(s.atTime)) ||
      (s.kind === "daily" && Boolean(s.timeOfDay)) ||
      (s.kind === "interval" && Boolean(s.everyMinutes)),
    { message: "schedule kind requires its matching field (atTime / timeOfDay / everyMinutes)" },
  );
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export const ScheduleRunStatus = z.enum(["idle", "running", "success", "error"]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatus>;

export const ScheduleTask = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(["agent", "plan"]).default("agent"),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  schedule: ScheduleSpec,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().optional(),
  lastStatus: ScheduleRunStatus.default("idle"),
  lastResult: z.string().optional(),
  lastThreadId: z.string().optional(),
  nextRunAt: z.string().optional(),
});
export type ScheduleTask = z.infer<typeof ScheduleTask>;

export const ScheduleCreateRequest = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  schedule: ScheduleSpec,
});
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequest>;

export const ScheduleUpdateRequest = z.object({
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  workspaceRoot: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  schedule: ScheduleSpec.optional(),
});
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequest>;
