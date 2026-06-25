import { z } from "zod";
import { TurnItem } from "./items.js";
import { ApprovalPolicySchema, SandboxModeSchema, TurnModeSchema, ReasoningEffortSchema } from "./policy.js";
import { isGuiPlanRelativePath } from "../shared/gui-plan.js";

export const TurnStatus = z.enum(["queued", "running", "completed", "failed", "aborted"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

/** GUI plan lifecycle operation: a first save (`draft`) or a revision (`refine`). */
export const GuiPlanOperationSchema = z.enum(["draft", "refine"]);
export type GuiPlanOperation = z.infer<typeof GuiPlanOperationSchema>;

/**
 * Context for a GUI ("draft"/"refine") plan turn. The `relativePath` must be a
 * direct Markdown file under the reserved plan dir (`.nexus-plan/plan`); Nexus
 * advertises `create_plan` for the turn and writes only to that reserved path.
 */
export const GuiPlanContextSchema = z.object({
  operation: GuiPlanOperationSchema,
  workspaceRoot: z.string().min(1),
  relativePath: z
    .string()
    .min(1)
    .refine(isGuiPlanRelativePath, {
      message: "relativePath must be a direct Markdown file under .nexus-plan/plan",
    }),
  planId: z.string().min(1),
  sourceRequest: z.string().optional(),
  title: z.string().optional(),
});
export type GuiPlanContext = z.infer<typeof GuiPlanContextSchema>;

export const TurnSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  status: TurnStatus,
  prompt: z.string(),
  model: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  /** Steered text queued by the user mid-turn. Cleared on completion. */
  steering: z.array(z.string()).default([]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  items: z.array(TurnItem).default([]),
  attachmentIds: z.array(z.string().min(1)).default([]),
  activeSkillIds: z.array(z.string().min(1)).default([]),
  injectedMemoryIds: z.array(z.string().min(1)).default([]),
  skillInjectionBytes: z.number().int().nonnegative().optional(),
  toolCatalogFingerprint: z.string().optional(),
  toolCatalogToolCount: z.number().int().nonnegative().optional(),
  toolCatalogDrift: z.boolean().optional(),
  /**
   * Optional GUI plan context. When set, Nexus advertises the `create_plan`
   * tool for the turn and writes only to the reserved path in the context.
   */
  guiPlan: GuiPlanContextSchema.optional(),
  /**
   * Optional per-turn mode override. When set, it takes precedence over the
   * thread mode for this turn (e.g. a Plan-mode turn inside an otherwise agent
   * thread, or a Build turn that runs as agent).
   */
  mode: TurnModeSchema.optional(),
  /**
   * True when no interactive user is attached to this turn (IM bridges,
   * headless runs). Nexus hides `user_input`/`request_user_input` and
   * rejects calls to them instead of blocking on a GUI answer.
   */
  disableUserInput: z.boolean().optional(),
  /**
   * When set, this session is bound to a Feishu group chat. Surfaced to the
   * agent as runtime context so it can read/summarize the group via the
   * feishu_read_* tools without the user pasting the chat_id.
   */
  feishuChatId: z.string().optional(),
  /**
   * Members @-mentioned in the inbound IM message that started this turn (T2.8).
   * Provider-agnostic: an IM bridge (Feishu being the reference provider) maps
   * its native mention list onto `{ id, name? }` refs, which the loop folds into
   * the per-turn context via `mentionsContextInstruction` so the agent knows who
   * addressed it. Not a tool; pure prompt context.
   */
  atMembers: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).optional(),
  error: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const StartTurnRequest = z.object({
  prompt: z.string().min(1),
  displayText: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  /**
   * Optional per-turn mode. Overrides the thread mode for this turn so the GUI
   * can toggle Plan/agent without recreating the thread. In Plan mode Nexus
   * advertises `create_plan` for the whole conversation.
   */
  mode: TurnModeSchema.optional(),
  attachments: z
    .array(
      z.object({
        path: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .optional(),
  attachmentIds: z.array(z.string().min(1)).default([]),
  /**
   * Optional GUI plan context. When set, Nexus advertises the `create_plan`
   * tool for the turn and writes only to the reserved path advertised in the
   * context.
   */
  guiPlan: GuiPlanContextSchema.optional(),
  /**
   * True when the caller cannot relay structured input prompts to a user
   * (IM bridges such as WeChat/Feishu, headless runs). The turn runs without
   * the `user_input`/`request_user_input` tools.
   */
  disableUserInput: z.boolean().optional(),
  /**
   * Feishu group chat_id the session is bound to (e.g. oc_xxxx). When present,
   * the agent is told it can read/summarize that group with the feishu_read_*
   * tools without the user pasting the id.
   */
  feishuChatId: z.string().optional(),
  /**
   * Members @-mentioned in the inbound IM message that started this turn (T2.8).
   * Provider-agnostic mention refs — an IM bridge (Feishu is the reference
   * provider) forwards its native mention list here, and the loop tells the
   * agent who addressed it via `mentionsContextInstruction`. Pure prompt
   * context, decoupled from any specific IM vendor.
   */
  atMembers: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).optional(),
});
export type StartTurnRequest = z.infer<typeof StartTurnRequest>;

export const StartTurnResponse = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  userMessageItemId: z.string().min(1),
});

export const SteerTurnRequest = z.object({ text: z.string().min(1) });

export const InterruptTurnRequest = z.object({ discard: z.boolean().optional() });
export const InterruptTurnResponse = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  status: TurnStatus,
});

export const CompactRequest = z.object({
  reason: z.string().optional(),
  budgetTokens: z.number().int().positive().optional(),
});
export const CompactResponse = z.object({
  threadId: z.string().min(1),
  replacedTokens: z.number().int().nonnegative(),
  summary: z.string(),
  pinnedConstraints: z.array(z.string()),
  sourceDigest: z.string().min(1).optional(),
  digestMarker: z.string().min(1).optional(),
  sourceItemIds: z.array(z.string().min(1)).optional(),
});
export type CompactResponse = z.infer<typeof CompactResponse>;
