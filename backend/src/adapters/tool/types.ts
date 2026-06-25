import type { ToolKind } from "../../contracts/items.js";
import type { ApprovalPolicy, SandboxMode, ToolPolicy, TurnMode } from "../../contracts/policy.js";
import type { TurnItem } from "../../contracts/items.js";
import type { Clock } from "../../ports/clock.js";

export type { ToolKind };

/** The context handed to every tool's execute(). */
export interface ToolContext {
  workspace: string;
  threadId: string;
  turnId: string;
  abortSignal: AbortSignal;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  threadMode?: TurnMode;
  clock: Clock;
  /** Resolve an approval. Returns "allow" to proceed. */
  awaitApproval: (request: ApprovalRequest) => Promise<"allow" | "deny">;
  /** Present a structured question to the user (GUI gate). */
  awaitUserInput?: (request: UserInputRequest) => Promise<UserInputResolution>;
  /** When set, only providers with these ids are usable (capability registry gate). */
  allowedProviderIds?: string[];
  /** When set, only tools with these names are usable (capability registry gate). */
  allowedToolNames?: string[];
  /**
   * Present when a GUI plan is active for this turn. Carries the plan's
   * operation/id/relative-path/title/source-request so the create_plan tool can
   * reuse them (and so the loop can synthesize the rich required-tool fallback).
   */
  guiPlan?: GuiPlanToolContext;
}

/** GUI-plan context surfaced on the tool context for plan ("draft"/"refine") turns. */
export interface GuiPlanToolContext {
  operation?: "draft" | "refine";
  planId?: string;
  relativePath?: string;
  workspaceRoot?: string;
  title?: string;
  sourceRequest?: string;
  /** Turn id the plan context belongs to (set by the loop). */
  turnId?: string;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  turnId: string;
  toolName: string;
  summary: string;
}

export interface UserInputQuestion {
  header: string;
  id: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

export interface UserInputRequest {
  id: string;
  itemId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  questions: UserInputQuestion[];
}

export interface UserInputResolution {
  status: "submitted" | "cancelled";
  answers?: Record<string, string>;
  text?: string;
}

/** What a tool returns. `output` is an arbitrary JSON-serializable value. */
export interface ToolResult {
  output: unknown;
  isError?: boolean;
}

export type ToolUpdate = (partial: ToolResult) => void;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolKind: ToolKind;
  policy: ToolPolicy;
  execute: (args: Record<string, unknown>, context: ToolContext, onUpdate?: ToolUpdate) => Promise<ToolResult>;
  /** Optional gate: when it returns false, the tool is hidden from the model. */
  shouldAdvertise?: (context: ToolContext) => boolean;
}

export type LocalToolDefinition = Partial<Pick<LocalTool, "toolKind" | "policy" | "shouldAdvertise">> &
  Pick<LocalTool, "name" | "description" | "inputSchema" | "execute">;

/** Fill defaults for a tool definition. */
export function defineTool(def: LocalToolDefinition): LocalTool {
  return {
    toolKind: def.toolKind ?? "tool_call",
    policy: def.policy ?? "on-request",
    shouldAdvertise: def.shouldAdvertise,
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    execute: def.execute,
  };
}

export interface ToolCall {
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
  toolKind?: ToolKind;
  /**
   * Optional id of the provider that contributed this tool. When set, the tool
   * host routes the call to that exact provider (and rejects a provider
   * mismatch), reproducing the original capability-registry routing.
   */
  providerId?: string;
}

export interface ToolExecuteResult {
  item: TurnItem;
  approved: boolean;
}

/** A tool that the GUI-gate (user_input) tools use to bypass sandbox/approval. */
export const GUI_GATE_TOOL_NAMES = new Set(["user_input", "request_user_input"]);
