import type { LocalTool, ToolContext } from "./types.js";
import { defineTool } from "./types.js";
import type { ToolPolicy } from "../../contracts/policy.js";
import type { ToolProvider } from "./capability-registry.js";
import { McpStdioClient, type McpToolAnnotations, type McpToolDescriptor } from "./mcp-stdio-client.js";
import {
  buildSearchIndex,
  search,
  summarizeSchema,
  type Bm25Tuning,
  type SearchIndex,
  type SearchRecord,
  type SearchResult,
} from "./mcp-tool-search.js";

const MCP_SEARCH_TOOL_NAME = "mcp_search";
const MCP_DESCRIBE_TOOL_NAME = "mcp_describe";
const MCP_CALL_TOOL_NAME = "mcp_call";
const MCP_REFRESH_CATALOG_TOOL_NAME = "mcp_refresh_catalog";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
// Per-call budget for tools/call. Matches the original McpServerConfig.timeoutMs default (3e4).
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
// Search topK defaults match the original McpSearchConfig (topKDefault 5, topKMax 10)
// and are applied as the McpHub constructor fallbacks when no config overrides them.

/** Operator-supplied configuration for a single MCP stdio server. */
export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** When false (default), the server's tools are neither searchable nor callable. */
  trusted?: boolean;
  /** Trust scope ("user" | "workspace"); folded into the search index server token. */
  trustScope?: string;
  /** Workspace roots the server is trusted within (workspace-scoped trust). */
  trustedWorkspaceRoots?: string[];
  /** Per-server connect/list budget; defaults to 15s. */
  connectTimeoutMs?: number;
  /** Per-call budget for tools/call; defaults to 30s (matches the original timeoutMs). */
  callTimeoutMs?: number;
  /** Alias for callTimeoutMs (matches the original McpServerConfig.timeoutMs). */
  timeoutMs?: number;
}

/**
 * Tool-discovery mode (matches the original `McpToolDiscoveryMode`):
 *   - `direct`  — advertise one tool per connected MCP tool.
 *   - `search`  — advertise only the four search meta-tools.
 *   - `auto`    — direct when the connected MCP tool count is at or below
 *                 `autoThresholdToolCount`, otherwise search.
 */
export type McpToolDiscoveryMode = "direct" | "search" | "auto";

/** Default `auto` cutover: direct when total connected MCP tool count <= 24. */
const DEFAULT_AUTO_THRESHOLD_TOOL_COUNT = 24;

/**
 * Operator-tunable MCP search tuning. Mirrors the original `McpSearchConfig`:
 * a discovery `mode`, an `autoThresholdToolCount` cutover, a default/max `topK`
 * window, a `minScore` relevance floor, and BM25 `bm25.k1` term-frequency
 * saturation. Every knob is optional (defaults match the original).
 */
export interface McpSearchProviderConfig {
  /** Discovery mode: direct | search | auto. Default "auto". */
  mode?: McpToolDiscoveryMode;
  /** Auto-mode cutover: search once connected tool count exceeds this. Default 24. */
  autoThresholdToolCount?: number;
  /** Default number of search hits when topK is unspecified. Default 5. */
  topKDefault?: number;
  /** Upper bound for the model-supplied topK argument. Default 10. */
  topKMax?: number;
  /** BM25 relevance floor; results scoring below this are dropped. Default 0.15. */
  minScore?: number;
  /** BM25 saturation tuning. Defaults k1=1.2, b=0.75. */
  bm25?: Partial<Bm25Tuning>;
}

export interface McpToolProviderConfig {
  enabled?: boolean;
  servers?: McpServerConfig[];
  /** Optional BM25 search tuning forwarded to the hub. */
  search?: McpSearchProviderConfig;
}

const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_BM25: Bm25Tuning = { k1: 1.2, b: 0.75 };

/** A connected (or failed) server's runtime state. */
export interface McpServerState {
  config: McpServerConfig;
  trusted: boolean;
  client?: McpStdioClient;
  connected: boolean;
  /** Present when the server could not be connected — never throws to the caller. */
  unavailableReason?: string;
  descriptors: McpToolDescriptor[];
}

interface ServerRecord extends SearchRecord {
  server: McpServerState;
  client: McpStdioClient;
  /**
   * Faithful per-tool call policy derived from the tool's annotations
   * (`policyFromAnnotations`). The meta-tool `mcp_call` itself is always
   * "on-request"; this is the policy surfaced for the underlying MCP tool and
   * applied when the tool is advertised directly.
   */
  policy: ToolPolicy;
}

/**
 * Manages N configured MCP stdio servers. Connection is best-effort and
 * fail-soft: a server that cannot start (or whose handshake/listTools times
 * out) is marked unavailable with a human-readable reason and never throws.
 * Untrusted servers are connected for diagnostics but their tools are excluded
 * from the search index and call resolution.
 */
export class McpHub {
  readonly servers: McpServerState[] = [];
  private records: ServerRecord[] = [];
  private index: SearchIndex = buildSearchIndex([]);
  private lastRefreshedAt: string | undefined;
  private readonly minScore: number;
  private readonly bm25: Bm25Tuning;
  /** Operator-tunable topK window (matches the original McpSearchConfig). */
  readonly topKDefault: number;
  readonly topKMax: number;

  constructor(
    private readonly configs: McpServerConfig[],
    options: { minScore?: number; topKDefault?: number; topKMax?: number; bm25?: Partial<Bm25Tuning> } = {},
  ) {
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.topKDefault = options.topKDefault ?? 5;
    this.topKMax = options.topKMax ?? 10;
    this.bm25 = { k1: options.bm25?.k1 ?? DEFAULT_BM25.k1, b: options.bm25?.b ?? DEFAULT_BM25.b };
    for (const config of configs) {
      this.servers.push({
        config,
        trusted: Boolean(config.trusted),
        connected: false,
        descriptors: [],
      });
    }
  }

  /** Connect to every configured server in parallel (best-effort) and index. */
  async connectAll(): Promise<void> {
    await Promise.all(this.servers.map((server) => this.connectServer(server)));
    this.rebuildIndex();
  }

  /** Whether at least one trusted server is connected with usable tools. */
  hasTrustedConnection(): boolean {
    return this.servers.some((server) => server.trusted && server.connected);
  }

  /** A faithful trust filter: only trusted, connected servers are usable. */
  isServerTrusted(server: McpServerState): boolean {
    return server.trusted && server.connected;
  }

  /** Re-list tools from connected servers and rebuild the search index. */
  async refreshCatalog(options: { signal?: AbortSignal } = {}): Promise<ServerRecord[]> {
    await Promise.all(
      this.servers.map(async (server) => {
        if (!server.connected || !server.client) return;
        try {
          server.descriptors = await server.client.listTools({
            timeoutMs: server.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
            signal: options.signal,
          });
        } catch (error) {
          server.descriptors = [];
          server.connected = false;
          server.unavailableReason = `tools/list failed: ${describeError(error)}`;
        }
      }),
    );
    this.rebuildIndex();
    return this.records;
  }

  /** Trusted, indexed records visible in the current context. */
  trustedRecords(): ServerRecord[] {
    return this.records.filter((record) => this.isServerTrusted(record.server));
  }

  searchTools(query: string, topK: number, serverId?: string): SearchResult[] {
    const records = this.trustedRecords().filter(
      (record) => !serverId || record.serverId === serverId,
    );
    if (records.length === 0) return [];
    // Re-index against just the visible subset so DF/scores reflect what is callable.
    const index = serverId ? buildSearchIndex(records) : this.index;
    return search(index, query, topK, this.minScore, this.bm25);
  }

  resolveTrustedRecord(toolId: string): ServerRecord | undefined {
    if (!toolId) return undefined;
    return this.trustedRecords().find((record) => record.toolId === toolId);
  }

  get refreshedAt(): string | undefined {
    return this.lastRefreshedAt;
  }

  get indexedToolCount(): number {
    return this.records.length;
  }

  /** Tear down every connected server. Safe to call multiple times. */
  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        if (server.client) await server.client.close();
        server.connected = false;
      }),
    );
  }

  private async connectServer(server: McpServerState): Promise<void> {
    const timeoutMs = server.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const client = new McpStdioClient({
      command: server.config.command,
      args: server.config.args,
      env: server.config.env,
      initTimeoutMs: timeoutMs,
    });
    try {
      await client.connect();
      server.descriptors = await client.listTools({ timeoutMs });
      server.client = client;
      server.connected = true;
      server.unavailableReason = undefined;
    } catch (error) {
      server.connected = false;
      server.unavailableReason = describeError(error);
      try {
        await client.close();
      } catch {
        /* ignore teardown errors on a failed server */
      }
    }
  }

  private rebuildIndex(): void {
    const records: ServerRecord[] = [];
    for (const server of this.servers) {
      if (!server.connected || !server.client) continue;
      for (const descriptor of server.descriptors) {
        const normalizedName = normalizeName(descriptor.name);
        records.push({
          toolId: `${server.config.id}/${descriptor.name}`,
          serverId: server.config.id,
          normalizedName,
          descriptor,
          // stdio is the only runtime transport; fold trustScope into the index
          // server token (faithful to the original indexRecord server field).
          serverTransport: "stdio",
          ...(server.config.trustScope ? { serverTrustScope: server.config.trustScope } : {}),
          server,
          client: server.client,
          policy: policyFromAnnotations(descriptor.annotations),
        });
      }
    }
    this.records = records;
    // Index every connected record; trust filtering happens at query time.
    this.index = buildSearchIndex(records);
    this.lastRefreshedAt = new Date().toISOString();
  }
}

/**
 * Decides whether the MCP provider advertises the four search meta-tools
 * ("search" path) instead of one tool per connected MCP tool ("direct" path).
 *
 * Faithful to the original `shouldUseMcpSearch`:
 *   - `direct` → never use search (advertise each tool directly).
 *   - `search` → always use search.
 *   - `auto`   → use search once the connected tool count reaches the
 *                `autoThresholdToolCount` (i.e. direct when count <= threshold).
 */
export function shouldUseMcpSearch(
  mode: McpToolDiscoveryMode,
  toolCount: number,
  threshold: number = DEFAULT_AUTO_THRESHOLD_TOOL_COUNT,
): boolean {
  if (mode === "direct") return false;
  if (mode === "search") return true;
  return toolCount >= threshold;
}

/**
 * Builds the `mcp` tool provider. Discovery follows the configured mode
 * (`direct` | `search` | `auto`, default `auto`):
 *
 *   - search path — exposes exactly four meta-tools (NOT one tool per MCP
 *     tool). The model first discovers tools with `mcp_search`, inspects them
 *     with `mcp_describe`, and only then invokes one with `mcp_call`.
 *   - direct path — advertises each connected MCP tool as its own tool
 *     (name `mcp_<server>_<tool>`, per-tool policy from annotations), so the
 *     model can call it without the search/describe round-trip.
 *
 * `auto` advertises directly while the connected MCP tool count stays at or
 * below `autoThresholdToolCount` (24 by default) and switches to search once it
 * exceeds that. The provider is `available` only when MCP is enabled and at
 * least one trusted server is connected; otherwise it reports a reason and the
 * registry hides it, keeping the default catalog unchanged.
 */
export async function buildMcpToolProvider(
  config: McpToolProviderConfig,
): Promise<{ provider: ToolProvider; hub: McpHub }> {
  const enabled = Boolean(config.enabled);
  const servers = config.servers ?? [];
  const hub = new McpHub(servers, {
    ...(config.search?.minScore !== undefined ? { minScore: config.search.minScore } : {}),
    ...(config.search?.topKDefault !== undefined ? { topKDefault: config.search.topKDefault } : {}),
    ...(config.search?.topKMax !== undefined ? { topKMax: config.search.topKMax } : {}),
    ...(config.search?.bm25 ? { bm25: config.search.bm25 } : {}),
  });

  // Connecting to zero servers is safe and fast; only dial out when enabled and
  // at least one server is configured.
  if (enabled && servers.length > 0) {
    await hub.connectAll();
  }

  const hasTrusted = hub.hasTrustedConnection();
  const available = enabled && hasTrusted;
  const reason = !enabled
    ? "MCP is disabled in config"
    : servers.length === 0
      ? "no MCP servers configured"
      : !hasTrusted
        ? "no trusted MCP server connected"
        : undefined;

  // Faithful mode switch. Count only the trusted, indexed tools that are
  // actually advertisable/callable — the same set the meta-tools expose and the
  // direct path materializes. Default mode "auto", threshold 24.
  const mode: McpToolDiscoveryMode = config.search?.mode ?? "auto";
  const threshold = config.search?.autoThresholdToolCount ?? DEFAULT_AUTO_THRESHOLD_TOOL_COUNT;
  const toolCount = hub.trustedRecords().length;
  const useSearch = shouldUseMcpSearch(mode, toolCount, threshold);

  const provider: ToolProvider = {
    id: "mcp",
    kind: "mcp",
    enabled,
    available,
    ...(reason ? { reason } : {}),
    tools: useSearch ? createMetaTools(hub) : createDirectTools(hub),
  };

  return { provider, hub };
}

/**
 * Direct advertisement: one `LocalTool` per connected MCP tool (faithful to the
 * original direct-provider path). Each tool is named `mcp_<server>_<tool>`,
 * carries the per-tool policy derived from its annotations, passes the MCP
 * input schema straight through, and is gated by the same trust check the
 * meta-tools enforce — both for advertisement (`shouldAdvertise`) and at call
 * time. Tools are materialized once at build time from the connected catalog so
 * the registry can register them under stable names.
 */
function createDirectTools(hub: McpHub): LocalTool[] {
  const tools: LocalTool[] = [];
  const seen = new Set<string>();
  for (const record of hub.trustedRecords()) {
    const descriptor = record.descriptor;
    const name = normalizeMcpToolName(record.serverId, descriptor.name);
    // Two MCP tools could normalize to the same name; keep the first (faithful
    // to a flat tool namespace) and skip later collisions.
    if (seen.has(name)) continue;
    seen.add(name);
    tools.push(
      defineTool({
        name,
        description: descriptor.description ?? `MCP tool ${descriptor.name} from ${record.serverId}`,
        toolKind: "tool_call",
        policy: policyFromAnnotations(descriptor.annotations),
        inputSchema: descriptor.inputSchema ?? { type: "object" },
        shouldAdvertise: () => hub.isServerTrusted(record.server),
        execute: async (args, context: ToolContext) => {
          if (!hub.isServerTrusted(record.server)) {
            return {
              output: { error: `MCP server ${record.serverId} is not trusted for this workspace` },
              isError: true,
            };
          }
          let result: unknown;
          try {
            result = await record.client.callTool(
              { name: descriptor.name, arguments: objectArg(args) },
              {
                signal: context.abortSignal,
                timeoutMs:
                  record.server.config.callTimeoutMs ??
                  record.server.config.timeoutMs ??
                  DEFAULT_CALL_TIMEOUT_MS,
              },
            );
          } catch (error) {
            return {
              output: {
                serverId: record.serverId,
                toolId: record.toolId,
                error: describeError(error),
              },
              isError: true,
            };
          }
          return {
            output: {
              serverId: record.serverId,
              toolName: descriptor.name,
              result,
            },
            isError:
              typeof result === "object" &&
              result !== null &&
              (result as { isError?: unknown }).isError === true,
          };
        },
      }),
    );
  }
  return tools;
}

function createMetaTools(hub: McpHub): LocalTool[] {
  return [
    defineTool({
      name: MCP_SEARCH_TOOL_NAME,
      description:
        "Search connected MCP tools by natural-language intent, server, action, and parameter names.",
      toolKind: "tool_call",
      policy: "auto",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The user intent or task to find MCP tools for." },
          topK: { type: "number", description: "Maximum number of matching tools to return." },
          serverId: { type: "string", description: "Optional MCP server id to search within." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const query = stringArg(args.query);
        if (!query) return { output: { error: "query is required" }, isError: true };
        const serverId = stringArg(args.serverId) || undefined;
        const topK = clampPositiveInt(numberArg(args.topK), hub.topKDefault, hub.topKMax);
        const visible = hub.trustedRecords();
        const results = hub.searchTools(query, topK, serverId);
        return {
          output: {
            query,
            totalIndexed: hub.indexedToolCount,
            searchedTools: serverId
              ? visible.filter((record) => record.serverId === serverId).length
              : visible.length,
            results: results.map(formatSearchResult),
          },
        };
      },
    }),
    defineTool({
      name: MCP_DESCRIBE_TOOL_NAME,
      description:
        "Return the full schema and metadata for a connected MCP tool found by mcp_search.",
      toolKind: "tool_call",
      policy: "auto",
      inputSchema: {
        type: "object",
        properties: {
          toolId: {
            type: "string",
            description: "Canonical MCP tool id in the form serverId/toolName.",
          },
        },
        required: ["toolId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const toolId = stringArg(args.toolId);
        const record = hub.resolveTrustedRecord(toolId);
        if (!record) return { output: { error: `unknown MCP tool: ${toolId}` }, isError: true };
        return { output: describeRecord(record) };
      },
    }),
    defineTool({
      name: MCP_CALL_TOOL_NAME,
      description: "Call a connected MCP tool by canonical tool id with JSON arguments.",
      toolKind: "tool_call",
      // Faithful policy: external side effects always require explicit approval.
      policy: "on-request",
      inputSchema: {
        type: "object",
        properties: {
          toolId: {
            type: "string",
            description: "Canonical MCP tool id in the form serverId/toolName.",
          },
          arguments: {
            type: "object",
            description: "Arguments matching the MCP tool input schema.",
          },
        },
        required: ["toolId", "arguments"],
        additionalProperties: false,
      },
      execute: async (args, context: ToolContext) => {
        const toolId = stringArg(args.toolId);
        const record = hub.resolveTrustedRecord(toolId);
        if (!record) return { output: { error: `unknown MCP tool: ${toolId}` }, isError: true };
        const callArgs = objectArg(args.arguments);
        let result: unknown;
        try {
          result = await record.client.callTool(
            { name: record.descriptor.name, arguments: callArgs },
            {
              signal: context.abortSignal,
              timeoutMs:
                record.server.config.callTimeoutMs ??
                record.server.config.timeoutMs ??
                DEFAULT_CALL_TIMEOUT_MS,
            },
          );
        } catch (error) {
          return {
            output: {
              serverId: record.serverId,
              toolId: record.toolId,
              error: describeError(error),
            },
            isError: true,
          };
        }
        return {
          output: {
            serverId: record.serverId,
            toolName: record.descriptor.name,
            toolId: record.toolId,
            result,
          },
          isError:
            typeof result === "object" &&
            result !== null &&
            (result as { isError?: unknown }).isError === true,
        };
      },
    }),
    defineTool({
      name: MCP_REFRESH_CATALOG_TOOL_NAME,
      description: "Refresh the MCP tool catalog and rebuild the local search index.",
      toolKind: "tool_call",
      policy: "auto",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async (_args, context: ToolContext) => {
        const records = await hub.refreshCatalog({ signal: context.abortSignal });
        return {
          output: {
            refreshedAt: hub.refreshedAt,
            totalIndexed: records.length,
          },
        };
      },
    }),
  ];
}

function formatSearchResult(result: SearchResult): Record<string, unknown> {
  const descriptor = result.record.descriptor;
  // Records are ServerRecords at runtime; surface the per-tool call policy
  // (faithful to the original formatSearchResult which included `policy`).
  const policy = (result.record as Partial<ServerRecord>).policy ?? "on-request";
  return {
    toolId: result.record.toolId,
    serverId: result.record.serverId,
    toolName: descriptor.name,
    title: descriptor.title ?? descriptor.annotations?.title,
    description: descriptor.description ?? "",
    score: Number(result.score.toFixed(3)),
    matchedKeywords: result.keywords,
    inputSummary: summarizeSchema(descriptor.inputSchema),
    policy,
    risk: {
      readOnly: descriptor.annotations?.readOnlyHint === true,
      destructive: descriptor.annotations?.destructiveHint === true,
      openWorld: descriptor.annotations?.openWorldHint === true,
    },
  };
}

function describeRecord(record: ServerRecord): Record<string, unknown> {
  const descriptor = record.descriptor;
  return {
    toolId: record.toolId,
    serverId: record.serverId,
    toolName: descriptor.name,
    normalizedName: record.normalizedName,
    title: descriptor.title ?? descriptor.annotations?.title,
    description: descriptor.description ?? "",
    inputSchema: descriptor.inputSchema ?? { type: "object" },
    ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
    ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
    ...(descriptor.execution ? { execution: descriptor.execution } : {}),
    ...(descriptor.icons ? { icons: descriptor.icons } : {}),
    ...(descriptor._meta ? { meta: descriptor._meta } : {}),
    policy: record.policy,
  };
}

function normalizeName(name: string): string {
  return String(name || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Direct-advertisement tool name, faithful to the original
 * `normalizeMcpToolName`: `mcp_<slug(serverId)>_<slug(toolName)>`.
 */
function normalizeMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`;
}

/**
 * Faithful port of the original `slug`: lower-case, collapse any run of
 * characters outside `[a-z0-9_]` to a single underscore, strip leading/trailing
 * underscores, and fall back to "tool" when the result is empty.
 */
function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool"
  );
}

/**
 * Faithful port of the original `policyFromAnnotations`: read-only + closed
 * world + non-destructive runs automatically; destructive tools require an
 * explicit request; open-world tools are untrusted; everything else defaults to
 * "on-request".
 */
function policyFromAnnotations(annotation: McpToolAnnotations | undefined): ToolPolicy {
  if (annotation?.readOnlyHint && !annotation.openWorldHint && !annotation.destructiveHint) {
    return "auto";
  }
  if (annotation?.destructiveHint) return "on-request";
  if (annotation?.openWorldHint) return "untrusted";
  return "on-request";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!value || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
