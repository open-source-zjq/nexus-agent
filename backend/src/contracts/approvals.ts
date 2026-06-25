import { z } from "zod";

/**
 * Approval decision contracts for `POST /v1/approvals/:id`. Ported faithfully
 * from the original Nexus `contracts/approvals`.
 */

/** Request body to resolve a pending tool-call approval. */
export const ApprovalDecisionRequest = z.object({
  decision: z.enum(["allow", "deny"]),
  /** Optional human-readable reason stored alongside the resolution. */
  reason: z.string().optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

/** Response returned after applying an approval decision. */
export const ApprovalDecisionResponse = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  status: z.enum(["allowed", "denied", "expired"]),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponse>;
