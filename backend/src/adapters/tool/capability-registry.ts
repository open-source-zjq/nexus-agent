import type { LocalTool, ToolContext, ToolKind } from "./types.js";
import type { ToolSpec } from "../../ports/model-client.js";
import { isToolAdvertisedInSandbox } from "./sandbox.js";

/**
 * Tools visible while a turn is running in plan mode (or a GUI plan is pending).
 * Everything else is hidden from the model so it cannot mutate state before the
 * plan is accepted.
 */
const PLAN_MODE_ALLOWED_TOOL_NAMES = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
  "create_plan",
  "user_input",
  "request_user_input",
]);

/**
 * A source of tools. The registry composes many providers (built-in tools, MCP
 * servers, web, memory, skills, delegation, media, ...) into a single namespace.
 */
export interface ToolProvider {
  id: string;
  kind:
    | "built-in"
    | "mcp"
    | "web"
    | "memory"
    | "skill"
    | "delegation"
    | "media"
    | string;
  /** Whether the operator has turned this provider on. */
  enabled: boolean;
  /** Whether the provider is currently reachable/usable. */
  available: boolean;
  tools: LocalTool[];
  /** Human-readable explanation when disabled/unavailable. */
  reason?: string;
}

interface ToolRecord {
  provider: ToolProvider;
  tool: LocalTool;
}

/**
 * A model-facing tool spec carrying the per-spec routing metadata the original
 * registry emits: `toolKind` plus the contributing provider's id/kind. The agent
 * loop reads these off the list (toolProviderMetadata / toolProviderKinds maps)
 * to attribute tool calls to their provider and to gate parallel-safe execution.
 * Assignable to ToolSpec[] so existing callers are unaffected.
 */
export interface RegistryToolSpec extends ToolSpec {
  toolKind?: ToolKind;
  providerId: string;
  providerKind: string;
}

/** A diagnostic snapshot of a provider's policy state. */
export interface ProviderDiagnostic {
  id: string;
  kind: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
  /** Number of tools advertised by this provider's catalog. */
  toolCount?: number;
  /** Names of the tools this provider contributes (its advertised catalog). */
  toolNames?: string[];
}

/**
 * Composes tool providers into one namespace and enforces visibility/gating so
 * the model only ever sees tools that the active policy, provider state, and
 * turn context allow.
 */
export class CapabilityRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly tools = new Map<string, ToolRecord>();

  /** Build a registry from a flat list of local tools under one "builtin" provider. */
  static fromLocalTools(tools: LocalTool[]): CapabilityRegistry {
    return new CapabilityRegistry([
      {
        id: "builtin",
        kind: "built-in",
        enabled: true,
        available: true,
        tools,
      },
    ]);
  }

  constructor(providers: ToolProvider[] = []) {
    for (const provider of providers) {
      this.registerProvider(provider);
    }
  }

  registerProvider(provider: ToolProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate tool provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    for (const tool of provider.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, { provider, tool });
    }
  }

  /** Model-facing tool specs visible under the given turn context. */
  listTools(context: ToolContext): RegistryToolSpec[] {
    const specs: RegistryToolSpec[] = [];
    for (const record of this.tools.values()) {
      if (!this.canUseProvider(record.provider, context)) continue;
      if (!this.canUseTool(record.tool.name, context)) continue;
      if (!isToolAdvertisedInSandbox(record.tool, context)) continue;
      if (record.tool.shouldAdvertise && !record.tool.shouldAdvertise(context)) {
        continue;
      }
      specs.push({
        name: record.tool.name,
        description: record.tool.description,
        inputSchema: record.tool.inputSchema,
        toolKind: record.tool.toolKind,
        providerId: record.provider.id,
        providerKind: record.provider.kind,
      });
    }
    return specs;
  }

  /**
   * Resolve a tool by name, enforcing the same gating as listTools().
   *
   * The optional `providerId` is the provider the caller expects to own this
   * tool (sourced from a tool call's provider attribution in the original). When
   * supplied and it does not match the registered provider, the resolve is
   * rejected with `tool X is not provided by Y` — restoring the original's
   * provider-mismatch guard. Existing two-argument callers are unaffected.
   */
  resolveTool(
    toolName: string,
    context: ToolContext,
    providerId?: string,
  ): { provider: ToolProvider; tool: LocalTool } {
    const record = this.tools.get(toolName);
    if (!record) {
      throw new Error(`unknown tool: ${toolName}`);
    }
    if (providerId && providerId !== record.provider.id) {
      throw new Error(`tool ${toolName} is not provided by ${providerId}`);
    }
    if (!this.canUseProvider(record.provider, context)) {
      throw new Error(
        `tool ${toolName} is not advertised by provider ${record.provider.id}`,
      );
    }
    if (!this.canUseTool(toolName, context)) {
      throw new Error(
        `tool ${toolName} is not advertised by active tool policy`,
      );
    }
    if (record.tool.shouldAdvertise && !record.tool.shouldAdvertise(context)) {
      throw new Error(`tool ${toolName} is not advertised in this turn context`);
    }
    return record;
  }

  /** The kind of a tool, defaulting to "tool_call" when unknown. */
  getToolKind(name: string): ToolKind {
    return this.tools.get(name)?.tool.toolKind ?? "tool_call";
  }

  /** Id of the provider that contributed `name`, if registered. */
  getProviderId(name: string): string | undefined {
    return this.tools.get(name)?.provider.id;
  }

  /** Kind of the provider that contributed `name`, if registered. */
  getProviderKind(name: string): string | undefined {
    return this.tools.get(name)?.provider.kind;
  }

  /** Per-provider policy snapshot for observability. */
  diagnostics(): ProviderDiagnostic[] {
    return [...this.providers.values()].map(providerPolicy);
  }

  /** All registered tool names. */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  private canUseProvider(provider: ToolProvider, context: ToolContext): boolean {
    if (!provider.enabled || !provider.available) return false;
    const allowed = context.allowedProviderIds;
    if (allowed && !allowed.includes(provider.id)) return false;
    return true;
  }

  private canUseTool(toolName: string, context: ToolContext): boolean {
    if (isPlanModeContext(context) && !PLAN_MODE_ALLOWED_TOOL_NAMES.has(toolName)) {
      return false;
    }
    const allowed = context.allowedToolNames;
    return !allowed || allowed.includes(toolName);
  }
}

function isPlanModeContext(context: ToolContext): boolean {
  return context.threadMode === "plan" || Boolean(context.guiPlan);
}

function providerPolicy(provider: ToolProvider): ProviderDiagnostic {
  const toolNames = provider.tools.map((tool) => tool.name);
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    available: provider.available,
    ...(provider.reason ? { reason: provider.reason } : {}),
    toolCount: toolNames.length,
    toolNames,
  };
}
