import type { LocalTool, ToolContext, ToolCall, ToolExecuteResult, ToolResult, ToolUpdate, ToolKind } from "./types.js";
import { GUI_GATE_TOOL_NAMES } from "./types.js";
import type { ToolSpec } from "../../ports/model-client.js";
import { sandboxBlockForTool } from "./sandbox.js";
import { ReadTracker } from "./read-tracker.js";
import { makeToolResultItem, makeApprovalItem } from "../../domain/item.js";
import type { ToolResultTurnItem } from "../../contracts/items.js";
import type { HookEngine } from "../../hooks/hook-engine.js";
import { normalizeRateLimitedToolOutput } from "./tool-rate-limit.js";
import { CapabilityRegistry, type ToolProvider, type ProviderDiagnostic } from "./capability-registry.js";

interface LocalToolHostBaseOptions {
  /** Tool names auto-approved under the "untrusted" approval policy. */
  allowList?: Set<string>;
  readTracker?: boolean;
  /** Optional lifecycle hooks engine (PreToolUse / PostToolUse). */
  hooks?: HookEngine;
}

/** Provide the tool catalog as a flat list, a prebuilt registry, or raw providers. */
export type LocalToolHostOptions = LocalToolHostBaseOptions &
  (
    | { tools: LocalTool[]; registry?: undefined; providers?: undefined }
    | { registry: CapabilityRegistry; tools?: undefined; providers?: undefined }
    | { providers: ToolProvider[]; tools?: undefined; registry?: undefined }
  );

/**
 * The single entry point for every tool call. Runs the policy/sandbox/approval/
 * read-tracker pipeline, then the tool, then normalizes the result into a
 * persisted tool_result item.
 */
export class LocalToolHost {
  readonly id = "local";
  private readonly registry: CapabilityRegistry;
  private readonly readTracker: ReadTracker;
  private readonly hooks: HookEngine | undefined;
  /** Tool names auto-approved under the "untrusted" approval policy. */
  private readonly allowList: Set<string>;

  constructor(options: LocalToolHostOptions) {
    if (options.registry) {
      this.registry = options.registry;
    } else if (options.providers) {
      this.registry = new CapabilityRegistry(options.providers);
    } else {
      this.registry = CapabilityRegistry.fromLocalTools(options.tools);
    }
    this.readTracker = new ReadTracker(options.readTracker ?? true);
    this.hooks = options.hooks;
    this.allowList = new Set(options.allowList ?? []);
  }

  /** Advertise tools to the model (respecting provider/policy gating + shouldAdvertise). */
  listTools(context: ToolContext): ToolSpec[] {
    return this.registry.listTools(context);
  }

  getToolKind(name: string): ToolKind {
    return this.registry.getToolKind(name);
  }

  /** Id of the provider that contributed `name`, if any. */
  getProviderId(name: string): string | undefined {
    return this.registry.getProviderId(name);
  }

  /** Kind of the provider that contributed `name`, if any. */
  getProviderKind(name: string): string | undefined {
    return this.registry.getProviderKind(name);
  }

  /** Per-provider policy snapshot for observability. */
  diagnostics(): ProviderDiagnostic[] {
    return this.registry.diagnostics();
  }

  clearReadTracker(threadId?: string): void {
    this.readTracker.clear(threadId);
  }

  async execute(call: ToolCall, context: ToolContext, onUpdate?: (item: ToolResultTurnItem) => void): Promise<ToolExecuteResult> {
    if (context.abortSignal.aborted) throw new Error("tool call aborted before start");

    const { tool } = this.registry.resolveTool(call.toolName, context, call.providerId);
    const toolKind = tool.toolKind;
    const now = (): string => context.clock.nowIso();
    const resultId = `item_result_${call.callId}`;

    const makeResult = (output: unknown, isError: boolean): ToolResultTurnItem =>
      makeToolResultItem({
        id: resultId,
        turnId: context.turnId,
        threadId: context.threadId,
        createdAt: now(),
        finishedAt: now(),
        status: isError ? "failed" : "completed",
        toolName: call.toolName,
        callId: call.callId,
        toolKind,
        output,
        isError,
      });

    const errorResult = (code: string, message: string): ToolExecuteResult => ({
      item: makeResult({ code, error: message }, true),
      approved: false,
    });

    // 1. static policy
    if (tool.policy === "never") throw new Error(`tool ${tool.name} is disabled by policy`);

    // 2. sandbox block
    const sandboxBlock = sandboxBlockForTool(tool, context);
    if (sandboxBlock) return errorResult(sandboxBlock.code, sandboxBlock.message);

    // 2b. PreToolUse hooks (failure => hook_failed; deny/block => error; allow =>
    //     skip approval; rewrite args)
    let hookAutoApproved = false;
    if (this.hooks && this.hooks.hasHooks("PreToolUse")) {
      let pre;
      try {
        pre = await this.hooks.run("PreToolUse", {
          phase: "PreToolUse",
          cwd: context.workspace,
          toolName: call.toolName,
          arguments: call.arguments,
        });
      } catch (error) {
        return errorResult("hook_failed", hookErrorMessage(error));
      }
      if (pre.failed) {
        return errorResult("hook_failed", pre.reason ?? "tool hook failed");
      }
      // Non-blocking hook warnings (non-zero exit / spawn failure): surface but
      // keep running — only a timeout (failed) aborts. Faithful to the original.
      if (pre.warnings?.length) {
        for (const w of pre.warnings) console.error(`[nexus] hook warning: ${w}`);
      }
      if (pre.blocked || pre.decision === "deny" || pre.decision === "block") {
        return errorResult("hook_denied", pre.reason ?? `tool ${call.toolName} was blocked by a hook`);
      }
      if (pre.arguments) call.arguments = pre.arguments;
      if (pre.decision === "allow") hookAutoApproved = true;
    }

    // 3. read-before-edit guard
    const readValidation = this.readTracker.validateBeforeTool({ context, call });
    if (!readValidation.ok) return errorResult("read_before_edit_required", readValidation.message);

    // 4. runtime policy block (approvalPolicy === "never")
    const runtimeBlock = this.runtimePolicyBlock(tool, call, context);
    if (runtimeBlock) return errorResult(runtimeBlock.code, runtimeBlock.message);

    // 5. approval
    const needsApproval = !hookAutoApproved && this.requiresApproval(tool, call, context);
    if (needsApproval) {
      const approvalId = `appr_${call.callId}`;
      const summary = summarizeCall(call);
      const decision = await context.awaitApproval({
        id: approvalId,
        threadId: context.threadId,
        turnId: context.turnId,
        toolName: call.toolName,
        summary,
      });
      if (decision !== "allow") {
        // On a denial the original emits a dedicated approval turn item
        // (kind "approval"), not a generic tool_result.
        const item = makeApprovalItem({
          id: `item_${approvalId}`,
          turnId: context.turnId,
          threadId: context.threadId,
          createdAt: now(),
          finishedAt: now(),
          approvalId,
          toolName: call.toolName,
          summary,
        });
        return { item, approved: false };
      }
    }

    if (context.abortSignal.aborted) throw new Error("tool call aborted after approval");

    // 6. execute
    const onUpdateWrapper: ToolUpdate | undefined = onUpdate
      ? (partial: ToolResult) => onUpdate(makeResult(partial.output, Boolean(partial.isError)))
      : undefined;

    let result: ToolResult;
    try {
      result = await tool.execute(call.arguments, context, onUpdateWrapper);
    } catch (error) {
      if (context.abortSignal.aborted) throw error;
      return { item: makeResult({ code: "tool_execution_failed", error: (error as Error).message }, true), approved: true };
    }

    // 7. PostToolUse hooks (failure => hook_failed; may rewrite output / override
    //    isError). Unlike PreToolUse, these run *after* the tool executed.
    let hookedOutput: unknown = result.output;
    let hookedIsError = Boolean(result.isError);
    if (this.hooks && this.hooks.hasHooks("PostToolUse")) {
      let post;
      try {
        post = await this.hooks.run("PostToolUse", {
          phase: "PostToolUse",
          cwd: context.workspace,
          toolName: call.toolName,
          arguments: call.arguments,
          output: result.output,
        });
      } catch (error) {
        return { item: makeResult({ code: "hook_failed", error: hookErrorMessage(error) }, true), approved: true };
      }
      if (post.failed) {
        return { item: makeResult({ code: "hook_failed", error: post.reason ?? "tool hook failed" }, true), approved: true };
      }
      if (post.warnings?.length) {
        for (const w of post.warnings) console.error(`[nexus] hook warning: ${w}`);
      }
      if (post.outputRewritten) hookedOutput = post.output;
      if (post.isError !== undefined) hookedIsError = post.isError;
    }

    // 8. Normalize provider rate-limit / quota signals into a stable envelope.
    const rateLimited = normalizeRateLimitedToolOutput(hookedOutput);
    const finalOutput = rateLimited.rateLimited ? rateLimited.output : hookedOutput;
    const finalIsError = hookedIsError || rateLimited.isError;

    // 9. read tracking (observes the final, normalized result)
    this.readTracker.observeToolResult({ context, call, output: finalOutput, isError: finalIsError });

    return { item: makeResult(finalOutput, finalIsError), approved: !needsApproval };
  }

  private requiresApproval(tool: LocalTool, call: ToolCall, context: ToolContext): boolean {
    if (GUI_GATE_TOOL_NAMES.has(call.toolName)) return false;
    if (tool.policy === "never" || context.approvalPolicy === "never") return false;
    switch (context.approvalPolicy) {
      case "auto":
        return false;
      case "on-request":
      case "suggest":
        return tool.policy !== "auto";
      case "untrusted":
        // Auto-policy tools are auto-approved only when allow-listed; otherwise
        // (and for any non-auto tool) approval is required.
        if (tool.policy === "auto") return !this.allowList.has(call.toolName);
        return true;
      default:
        return tool.policy !== "auto";
    }
  }

  private runtimePolicyBlock(tool: LocalTool, call: ToolCall, context: ToolContext): { code: string; message: string } | null {
    if (GUI_GATE_TOOL_NAMES.has(call.toolName)) return null;
    // Only the "never" runtime approval policy can block here; under any other
    // policy nothing is runtime-blocked.
    if (context.approvalPolicy !== "never") return null;
    // tool.policy === "never" tools are already rejected earlier (disabled by
    // policy); every remaining tool — including auto-policy tools — is blocked
    // when the runtime approval policy is "never".
    if (tool.policy === "never") return null;
    return {
      code: "approval_policy_blocked",
      message: `tool ${call.toolName} is disabled by runtime approval policy`,
    };
  }
}

function hookErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `tool hook failed: ${message}`;
}

function summarizeCall(call: ToolCall): string {
  const argText = Object.entries(call.arguments)
    .map(([key, value]) => `${key}=${compactValue(value)}`)
    .join(", ");
  return `Run ${call.toolName}(${argText})`;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.length > 60 ? `${JSON.stringify(value.slice(0, 60))}…` : JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  } catch {
    return String(value);
  }
}
