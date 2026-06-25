import { z } from "zod";

/**
 * A compact text rendering of an image, used when a model cannot accept the
 * binary content directly. Ported faithfully from the original Nexus contract.
 */
export const AttachmentTextFallbackSchema = z
  .object({
    dataBase64: z.string().min(1),
    mimeType: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    wasCompressed: z.boolean().optional(),
  })
  .strict();
export type AttachmentTextFallback = z.infer<typeof AttachmentTextFallbackSchema>;

/**
 * Content-addressed attachment metadata. The `id` is `att_` + the first 24 hex
 * chars of the sha256 of the stored bytes. Authorization is scoped by the set
 * of thread ids and workspaces that have referenced the attachment.
 */
export const AttachmentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    hash: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    textFallback: AttachmentTextFallbackSchema.optional(),
    threadIds: z.array(z.string().min(1)).default([]),
    workspaces: z.array(z.string().min(1)).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Payload accepted when uploading a new attachment. */
export const AttachmentUploadRequestSchema = z
  .object({
    name: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    dataBase64: z.string().min(1),
    textFallback: AttachmentTextFallbackSchema.optional(),
    threadId: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
  })
  .strict();
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const AttachmentUploadResponseSchema = z
  .object({
    attachment: AttachmentSchema,
  })
  .strict();
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponseSchema>;

export const AttachmentDiagnosticsSchema = z
  .object({
    enabled: z.boolean(),
    rootDir: z.string(),
    count: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentDiagnostics = z.infer<typeof AttachmentDiagnosticsSchema>;
