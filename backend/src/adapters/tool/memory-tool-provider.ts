import type { LocalTool } from "./types.js";
import { defineTool } from "./types.js";
import type { ToolProvider } from "./capability-registry.js";
import type { FileMemoryStore } from "../../memory/memory-store.js";

export interface MemoryToolConfig {
  /** Whether the operator has turned long-term memory on. */
  enabled?: boolean;
}

/**
 * Three long-term memory tools. All are policy "on-request": the model can only
 * mutate durable memory after the user explicitly approves the call. The
 * provider is presence-based: whenever a store exists it is available; there is
 * no config.enabled gate.
 */
export function buildMemoryToolProvider(
  store: FileMemoryStore,
  _config: MemoryToolConfig = {},
): ToolProvider {
  const createTool = defineTool({
    name: "memory_create",
    description: "Create a long-term memory after explicit user approval.",
    toolKind: "tool_call",
    policy: "on-request",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        scope: { type: "string", enum: ["user", "workspace", "project"] },
        workspace: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { output: { error: "content is required" }, isError: true };
      const memory = await store.create({
        content,
        scope:
          args.scope === "user" || args.scope === "project" ? args.scope : "workspace",
        workspace: typeof args.workspace === "string" ? args.workspace : context.workspace,
        sourceThreadId: context.threadId,
        sourceTurnId: context.turnId,
        tags: Array.isArray(args.tags)
          ? args.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      });
      return { output: { memory } };
    },
  });

  const updateTool = defineTool({
    name: "memory_update",
    description: "Update or disable an existing long-term memory.",
    toolKind: "tool_call",
    policy: "on-request",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        disabled: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args) {
      if (typeof args.id !== "string") {
        return { output: { error: "id is required" }, isError: true };
      }
      const memory = await store.update(args.id, {
        ...(typeof args.content === "string" ? { content: args.content } : {}),
        ...(typeof args.disabled === "boolean" ? { disabled: args.disabled } : {}),
      });
      return { output: { memory } };
    },
  });

  const deleteTool = defineTool({
    name: "memory_delete",
    description: "Delete a long-term memory by writing a tombstone.",
    toolKind: "tool_call",
    policy: "on-request",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args) {
      if (typeof args.id !== "string") {
        return { output: { error: "id is required" }, isError: true };
      }
      return { output: { memory: await store.delete(args.id) } };
    },
  });

  const tools: LocalTool[] = [createTool, updateTool, deleteTool];

  return {
    id: "memory",
    kind: "memory",
    enabled: true,
    available: true,
    tools,
  };
}
