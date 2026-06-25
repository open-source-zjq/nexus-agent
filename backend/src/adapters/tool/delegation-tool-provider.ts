import type { LocalTool } from "./types.js";
import { defineTool } from "./types.js";
import type { ToolProvider } from "./capability-registry.js";
import type { DelegationRuntime } from "../../delegation/delegation-runtime.js";

export interface DelegationToolProviderConfig {
  enabled?: boolean;
}

/**
 * Build the "delegation" tool provider exposing a single `delegate_task` tool.
 *
 * The tool runs a bounded child agent — inheriting the parent turn's thread id,
 * turn id, and abort signal from the tool context — and returns the child's
 * lifecycle record: `{ childId, status, summary, error, usage }`.
 *
 * Faithfully ported from the original delegation tool provider:
 *   - the model-facing param is `prompt` (required), with an optional `workspace`
 *     override and an optional `model` override; policy is `auto`;
 *   - an optional human-readable `label` that titles the child thread and
 *     buckets diagnostics aggregates;
 *   - a `spawnIndex` cost warning ("child agent spawn #N") emitted once more
 *     than one child has run for the thread, reminding the model that each
 *     spawn re-pays the prefix/cache cost;
 *   - `isError` set when the child failed or was aborted.
 *
 * The provider is available whenever a runtime exists (the original applied no
 * config gate); `enabled` reflects the config flag for diagnostics.
 */
export function buildDelegationToolProvider(
  runtime: DelegationRuntime,
  _config: DelegationToolProviderConfig,
): ToolProvider {
  const tool: LocalTool = defineTool({
    name: "delegate_task",
    description: "Run a bounded child agent task and return its summary.",
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string" },
        prompt: { type: "string" },
        workspace: { type: "string" },
        model: { type: "string" },
      },
      required: ["prompt"],
    },
    async execute(args, context) {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return { output: { error: "prompt is required" }, isError: true };
      const label = typeof args.label === "string" && args.label.trim() ? args.label.trim() : undefined;

      // spawnIndex: how many children have already run for this thread + 1.
      // Snapshot the pre-run child ids so we can identify the run we create.
      const before = await runtime.diagnostics(context.threadId);
      const spawnIndex = before.childRuns.length + 1;
      const knownIds = new Set(before.childRuns.map((run) => run.id));

      try {
        const result = await runtime.runChild({
          task: prompt,
          ...(label ? { label } : {}),
          ...(typeof args.model === "string" && args.model.trim() ? { model: args.model.trim() } : {}),
          workspace: typeof args.workspace === "string" && args.workspace.trim() ? args.workspace : context.workspace,
          parentThreadId: context.threadId,
          parentTurnId: context.turnId,
          abortSignal: context.abortSignal,
        });

        // Recover the persisted child record (status/summary/error/childId)
        // produced by this run by diffing against the pre-run snapshot.
        const after = await runtime.diagnostics(context.threadId);
        const record = after.childRuns.find((run) => !knownIds.has(run.id));
        const status = record?.status ?? "completed";
        const summary = record?.summary ?? result.output;

        return {
          output: {
            ...(record ? { childId: record.id } : {}),
            status,
            summary,
            ...(record?.error ? { error: record.error } : {}),
            usage: result.usage ?? record?.usage,
            ...(spawnIndex > 1
              ? {
                  warning: `This is child agent spawn #${spawnIndex} for the thread. Spawn only when the extra prefix/cache cost is worth it.`,
                }
              : {}),
          },
          isError: status === "failed" || status === "aborted",
        };
      } catch (error) {
        return { output: { error: errorMessage(error) }, isError: true };
      }
    },
  });

  // Original gate: a delegation provider is built (enabled/available true)
  // whenever a runtime exists; there is no config-flag availability gate.
  return {
    id: "delegation",
    kind: "delegation",
    enabled: true,
    available: true,
    tools: [tool],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
