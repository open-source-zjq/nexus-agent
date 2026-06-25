import { z } from "zod";

/**
 * Scope controls which threads/workspaces a memory is authorized to be
 * retrieved into:
 * - `user`      : global to the user, surfaces everywhere.
 * - `workspace` : only surfaces when retrieving for the same workspace.
 * - `project`   : project-scoped (treated as surfaceable like user today).
 */
export const MemoryScope = z.enum(["user", "workspace", "project"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** A single durable long-term memory record persisted as one JSON file. */
export const MemoryRecord = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1),
    scope: MemoryScope,
    workspace: z.string().optional(),
    project: z.string().optional(),
    sourceThreadId: z.string().optional(),
    sourceTurnId: z.string().optional(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    // Soft tombstones: kept on disk so deletes/disables are auditable.
    disabledAt: z.string().optional(),
    deletedAt: z.string().optional(),
  })
  .strict();
export type MemoryRecord = z.infer<typeof MemoryRecord>;

export const MemoryCreateRequest = z
  .object({
    content: z.string().min(1),
    scope: MemoryScope.default("workspace"),
    workspace: z.string().optional(),
    project: z.string().optional(),
    sourceThreadId: z.string().optional(),
    sourceTurnId: z.string().optional(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();
export type MemoryCreateRequest = z.infer<typeof MemoryCreateRequest>;

export const MemoryUpdateRequest = z
  .object({
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type MemoryUpdateRequest = z.infer<typeof MemoryUpdateRequest>;

export const MemoryDiagnostics = z
  .object({
    enabled: z.boolean(),
    rootDir: z.string(),
    activeCount: z.number().int().nonnegative(),
    tombstoneCount: z.number().int().nonnegative(),
    lastInjectedIds: z.array(z.string()).default([]),
  })
  .strict();
export type MemoryDiagnostics = z.infer<typeof MemoryDiagnostics>;
