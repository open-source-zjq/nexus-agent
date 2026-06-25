import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { ZodError } from "zod";
import { patchPlanTodoStatus } from "../shared/todos.js";
import { systemClock } from "../ports/clock.js";
import { randomIds } from "../ports/id-generator.js";
import {
  loadConfig,
  saveConfig,
  defaultDataDir,
  configPath,
  NexusConfigSchema,
  type NexusConfig,
  type McpCapabilityConfig,
  type McpServerConfig,
} from "../config/config.js";
import { ApprovalPolicySchema, SandboxModeSchema, type ApprovalPolicy, type SandboxMode } from "../contracts/policy.js";
import { ConfigModelRegistry } from "../adapters/model/registry.js";
import { InMemoryEventBus } from "../adapters/event/event-bus.js";
import { InMemoryApprovalGate, InMemoryUserInputGate } from "../adapters/event/gates.js";
import { HybridThreadStore } from "../adapters/store/hybrid-thread-store.js";
import { HybridSessionStore } from "../adapters/store/hybrid-session-store.js";
import { SimpleFileThreadStore, FileSessionStore } from "../adapters/store/file-stores.js";
import { InMemoryThreadStore, InMemorySessionStore } from "../adapters/store/in-memory-stores.js";
import { AgentDirectoryStore } from "../adapters/store/agent-directory-store.js";
import { ConnectorStore } from "../adapters/store/connector-store.js";
import { PhoneStore } from "../adapters/store/phone-store.js";
import type { ThreadStore, SessionStore } from "../adapters/store/types.js";
import { RuntimeEventRecorder } from "../services/runtime-event-recorder.js";
import { UsageService } from "../services/usage-service.js";
import { ReviewService } from "../services/review-service.js";
import { LlmDebugRecorder } from "../services/llm-debug-recorder.js";
import { PlanService } from "../services/plan-service.js";
import { SpeechToTextService } from "../adapters/model/stt-client.js";
import { buildInsightEngine } from "../services/insight/insight-engine.js";
import { GroupWatcher } from "../services/insight/group-watcher.js";
import { InsightModelGateway } from "../services/insight/model-gateway.js";
import type { SuggestionEvent, InsightDecision } from "../services/insight/types.js";
import { ScheduleService, type ScheduleRunner } from "../services/schedule-service.js";
import { ConnectorService } from "../services/connector-service.js";
import { PhoneService } from "../services/phone-service.js";
import type { ReasoningEffort } from "../contracts/policy.js";
import { LocalWorkspaceInspector } from "../adapters/workspace/local-workspace-inspector.js";
import { ThreadService } from "../services/thread-service.js";
import { TurnService } from "../services/turn-service.js";
import { SteeringQueue } from "../loop/steering-queue.js";
import { ContextCompactor } from "../loop/context-compactor.js";
import { AgentLoop } from "../loop/agent-loop.js";
import type { ModelProfileConfigSource } from "../loop/model-context-profile.js";
import { AutoModelRouter, type ClassifierFn } from "../loop/auto-model-router.js";
import { HookEngine } from "../hooks/hook-engine.js";
import { LocalToolHost } from "../adapters/tool/local-tool-host.js";
import { CapabilityRegistry } from "../adapters/tool/capability-registry.js";
import { buildDefaultLocalTools } from "../adapters/tool/builtin-tools.js";
import { buildTodoLocalTools } from "../adapters/tool/todo-tools.js";
import { buildGoalLocalTools } from "../adapters/tool/goal-tools.js";
import { buildCreatePlanLocalTool } from "../adapters/tool/create-plan-tool.js";
import { buildWebToolProvider } from "../adapters/tool/web-tool-provider.js";
import { buildMemoryToolProvider } from "../adapters/tool/memory-tool-provider.js";
import { buildSkillToolProvider } from "../adapters/tool/skill-tool-provider.js";
import {
  buildMediaToolProvider,
  buildImageGenerationService,
} from "../adapters/tool/media-gen-tool-provider.js";
import { buildMcpToolProvider, type McpHub } from "../adapters/tool/mcp-tool-provider.js";
import { ChildAgentExecutor } from "../delegation/child-agent-executor.js";
import { DelegationRuntime } from "../delegation/delegation-runtime.js";
import { FileDelegationStore } from "../delegation/file-delegation-store.js";
import { buildDelegationToolProvider } from "../adapters/tool/delegation-tool-provider.js";
import { FileMemoryStore } from "../memory/memory-store.js";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { SkillRuntime } from "../skills/skill-runtime.js";
import { NEXUS_SYSTEM_PROMPT } from "../prompt/system-prompt.js";
import { buildRouter } from "../server/routes.js";
import { createNodeHttpServer } from "../server/node-server.js";
import type { Runtime } from "../server/runtime.js";

export const NEXUS_READY_PREFIX = "NEXUS_READY ";

/** Storage backend for the persistent thread/usage index (hybrid == file-backed here). */
export type StorageBackend = "hybrid" | "file";

export interface ServeOptions {
  host: string;
  port: number;
  dataDir: string;
  runtimeToken?: string;
  insecure?: boolean;
  storage: "file" | "memory";
  staticDir?: string;
  /** Explicit config-file path (--config / NEXUS_CONFIG). */
  configPath?: string;
  /** Override the config-level approval policy (--approval-policy). */
  approvalPolicy?: ApprovalPolicy;
  /** Override the config-level sandbox mode (--sandbox-mode). */
  sandboxMode?: SandboxMode;
  /** Force token-economy on/off regardless of config (--token-economy). */
  tokenEconomy?: boolean;
  /**
   * Persistent storage backend (--storage-backend, default hybrid). Both
   * `hybrid` and `file` resolve to the SQLite-backed hybrid store, which itself
   * degrades to a file-backed index when node:sqlite is unavailable, so the two
   * backends are observably identical here.
   */
  storageBackend?: StorageBackend;
  /** SQLite index path for hybrid storage (--sqlite-path). */
  sqlitePath?: string;
}

/** Build the fully-wired runtime (hexagonal dependency graph). */
export async function buildRuntime(options: ServeOptions): Promise<{ runtime: Runtime }> {
  const dataDir = options.dataDir;
  const startedAt = new Date().toISOString();
  // An explicit --config/NEXUS_CONFIG path takes precedence over the
  // {data-dir}/config.json default (faithful to the original loadServeConfig).
  let config = options.configPath ? loadConfigFromPath(options.configPath, dataDir) : loadConfig(dataDir);
  config = applyEnvApiKeys(config);
  config = {
    ...config,
    serve: {
      ...config.serve,
      host: options.host,
      port: options.port,
      runtimeToken: options.runtimeToken ?? config.serve.runtimeToken,
      insecure: options.insecure ?? config.serve.insecure,
    },
    // CLI overrides for approval policy / sandbox mode / token economy take
    // precedence over the persisted config (original DEFAULT_SERVE_OPTIONS merge).
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.tokenEconomy !== undefined
      ? { tokenEconomy: { ...(config.tokenEconomy ?? {}), enabled: options.tokenEconomy } }
      : {}),
  };

  const configRef = { current: config };
  const getConfig = (): NexusConfig => configRef.current;
  const updateConfig = (next: NexusConfig): NexusConfig => {
    configRef.current = saveConfig(dataDir, applyEnvApiKeys(next));
    return configRef.current;
  };

  const clock = systemClock;
  const ids = randomIds;
  const models = new ConfigModelRegistry(getConfig);
  const eventBus = new InMemoryEventBus();

  // Persistent storage selection. `memory` is the in-memory store (tests). The
  // `file` backend uses the simple per-thread `thread.json` store plus the
  // append-only FileSessionStore. The default `hybrid` backend uses the
  // SQLite-backed hybrid thread store (which also serves as the usage index for
  // the hybrid session store); when node:sqlite is unavailable the hybrid store
  // degrades to its pure file-backed behavior, so the observable thread/usage
  // results are identical either way.
  const useFileBackend = options.storage !== "memory" && options.storageBackend === "file";
  const hybridThreadStore =
    options.storage === "memory" || useFileBackend ? null : new HybridThreadStore(dataDir);
  let threadStore: ThreadStore;
  let sessionStore: SessionStore;
  if (options.storage === "memory") {
    threadStore = new InMemoryThreadStore();
    sessionStore = new InMemorySessionStore();
  } else if (useFileBackend) {
    threadStore = new SimpleFileThreadStore(dataDir);
    sessionStore = new FileSessionStore(dataDir);
  } else {
    threadStore = hybridThreadStore!;
    sessionStore = new HybridSessionStore({ dataDir, index: hybridThreadStore! });
  }

  const events = new RuntimeEventRecorder({
    sessionStore,
    eventBus,
    nowIso: clock.nowIso,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
  });
  const usageService = new UsageService();
  const approvalGate = new InMemoryApprovalGate();
  const userInputGate = new InMemoryUserInputGate();
  const steering = new SteeringQueue();

  // One-shot, non-streaming model call used by the auto-router classifier and the
  // model-mode context summarizer. Streams a request and concatenates assistant text.
  const oneShot = async (
    modelId: string,
    systemPrompt: string,
    userText: string,
    maxTokens: number,
    signal: AbortSignal | undefined,
    opts?: { responseFormat?: "json_object" },
  ): Promise<string> => {
    const resolved = models.resolve(modelId);
    let text = "";
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of resolved.client.stream({
        threadId: "_oneshot",
        turnId: `_oneshot_${Date.now()}`,
        model: resolved.wireModel,
        systemPrompt,
        history: [{ kind: "user_message", text: userText }],
        tools: [],
        maxTokens,
        temperature: 0,
        reasoningEffort: "off",
        // Force JSON-mode output for the auto-router classifier (the original
        // router issues the classifier call with responseFormat:"json_object").
        ...(opts?.responseFormat ? { responseFormat: opts.responseFormat } : {}),
        stream: true,
        abortSignal: controller.signal,
      })) {
        // Accumulate BOTH assistant text and reasoning deltas (faithful to the
        // original collectRouterText, which folds reasoning deltas into the
        // classifier text). Reasoning-off summarizer calls emit no reasoning.
        if (chunk.kind === "assistant_text_delta" || chunk.kind === "assistant_reasoning_delta") {
          text += chunk.text;
        } else if (chunk.kind === "error") throw new Error(chunk.message);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return text;
  };

  const summaryMaxTokens = config.contextCompaction.summaryMaxTokens;
  // Honor optional absolute soft/hard compaction thresholds (original
  // contextCompaction.defaultSoftThreshold/defaultHardThreshold). The replica
  // compactor works in window ratios, so convert the absolute thresholds against
  // the default 256K context window into the equivalent soft/hard ratios.
  const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
  const compactorConfig: { softRatio?: number; hardRatio?: number } = {};
  if (config.contextCompaction.defaultSoftThreshold !== undefined) {
    compactorConfig.softRatio = config.contextCompaction.defaultSoftThreshold / DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  if (config.contextCompaction.defaultHardThreshold !== undefined) {
    compactorConfig.hardRatio = config.contextCompaction.defaultHardThreshold / DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  const compactorDeps = {
    summaryMode: config.contextCompaction.summaryMode,
    summaryTimeoutMs: config.contextCompaction.summaryTimeoutMs,
    summarize:
      config.contextCompaction.summaryMode === "model"
        ? async ({ text, signal }: { text: string; signal?: AbortSignal }) =>
            oneShot(
              models.defaultModelId,
              "Rewrite the following conversation summary to be concise and faithful. Preserve all decisions, constraints, file paths, and identifiers. Return only the rewritten summary.",
              text,
              summaryMaxTokens,
              signal,
            )
        : undefined,
  };
  const compactor = new ContextCompactor(compactorConfig, compactorDeps);

  // Runtime config inherited by delegated child agents (C9-4): the original
  // builds the child ContextCompactor with the parent's contextCompaction +
  // models and threads tokenEconomy/toolStorm through. Mirror the main loop.
  const childToolStorm =
    config.toolStorm && config.toolStorm.enabled !== false
      ? {
          ...(config.toolStorm.windowSize ? { windowSize: config.toolStorm.windowSize } : {}),
          ...(config.toolStorm.threshold ? { threshold: config.toolStorm.threshold } : {}),
        }
      : undefined;

  const autoRouter = config.autoModel?.enabled
    ? new AutoModelRouter(
        ((modelId, prompt, abortSignal) =>
          oneShot(modelId, "", prompt, 96, abortSignal, { responseFormat: "json_object" })) as ClassifierFn,
        {
          ...(config.autoModel.flashModel ? { flashModelId: config.autoModel.flashModel } : {}),
          ...(config.autoModel.proModel ? { proModelId: config.autoModel.proModel } : {}),
        },
      )
    : undefined;

  const hookEngine = new HookEngine({ hooks: config.hooks, cwd: config.defaultWorkspace ?? process.cwd() });

  const defaultWorkspace = config.defaultWorkspace ?? process.cwd();

  const threadService = new ThreadService({
    threadStore,
    sessionStore,
    events,
    ids,
    clock,
    defaultModel: models.defaultModelId,
    defaultWorkspace,
    // Auto-title: summarize a thread's opening exchange into a short title over
    // the same one-shot completion helper the router/summarizer use.
    generateTitle: async ({ modelId, firstUserText, firstAssistantText, signal }) => {
      const system =
        "You label chat threads. Read the opening exchange and reply with a SHORT, specific title " +
        "(3–6 words, Title Case) describing the task. No surrounding quotes, no trailing punctuation, " +
        "no preamble — reply with ONLY the title.";
      const user = firstAssistantText
        ? `User:\n${firstUserText}\n\nAssistant:\n${firstAssistantText}`
        : `User:\n${firstUserText}`;
      return oneShot(modelId || models.defaultModelId, system, user.slice(0, 4000), 24, signal);
    },
  });
  const turnService = new TurnService({ threadStore: threadService, sessionStore, events, ids, clock, steering, compactor });

  // Latest plan markdown persisted per thread by the create_plan tool. The
  // loop's onPlanWritten hook reads this to patch the saved plan file's
  // Markdown checkboxes back from the thread's todo statuses (and to keep the
  // raw plan markdown for re-derivations).
  const planMarkdownByThread = new Map<string, string>();

  // Builtin tools (always on): file/shell tools + todo/goal/create_plan.
  const builtinTools = [
    ...buildDefaultLocalTools(),
    ...buildTodoLocalTools({
      getTodos: (threadId) => threadService.getTodos(threadId),
      setTodos: (threadId, todos) => threadService.setTodos(threadId, todos),
    }),
    ...buildGoalLocalTools({
      getGoal: (threadId) => threadService.getGoal(threadId),
      setGoal: (threadId, request) => threadService.setGoal(threadId, request),
    }),
    buildCreatePlanLocalTool({
      getTodos: (threadId) => threadService.getTodos(threadId),
      setTodos: async (threadId, todos) => {
        await threadService.setTodos(threadId, todos);
      },
      // Persist the raw plan markdown for the thread so the loop's
      // afterToolResultPersisted/onPlanWritten hook can patch its checkboxes.
      setPlan: (threadId, planMarkdown) => {
        planMarkdownByThread.set(threadId, planMarkdown);
      },
    }),
  ];

  // Optional leaf capability providers. Each is gated by config.capabilities;
  // when a block is absent/disabled the provider reports available=false so the
  // registry hides its tools and the default catalog is unchanged.
  const capabilities = config.capabilities;

  const memoryEnabled = Boolean(capabilities?.memory?.enabled);
  const memoryStore = new FileMemoryStore({ dataDir, config: { enabled: memoryEnabled } });
  const attachmentStore = new AttachmentStore({ dataDir });

  const skillRoots = (capabilities?.skills?.roots ?? []).map((root) => {
    // Expand a leading "~" (the GUI/Settings stores roots like "~/.nexus-agent/skills")
    // BEFORE the absolute check — otherwise a tilde path is treated as relative and
    // resolved to a bogus "<workspace>/~/…" dir, so no skills are ever discovered.
    const expanded = expandTilde(root) ?? root;
    return isAbsolute(expanded) ? expanded : resolve(defaultWorkspace, expanded);
  });
  const skillRuntime = await SkillRuntime.create({
    enabled: Boolean(capabilities?.skills?.enabled),
    roots: skillRoots,
    legacySkillMd: capabilities?.skills?.legacySkillMd ?? true,
  });

  const registry = CapabilityRegistry.fromLocalTools(builtinTools);
  registry.registerProvider(
    buildWebToolProvider({
      enabled: Boolean(capabilities?.web?.enabled),
      fetchEnabled: Boolean(capabilities?.web?.fetchEnabled),
      searchEnabled: Boolean(capabilities?.web?.searchEnabled),
      ...(capabilities?.web?.allowDomains ? { allowDomains: capabilities.web.allowDomains } : {}),
      ...(capabilities?.web?.denyDomains ? { denyDomains: capabilities.web.denyDomains } : {}),
      ...(capabilities?.web?.maxBytes ? { maxBytes: capabilities.web.maxBytes } : {}),
      ...(capabilities?.web?.timeoutMs ? { timeoutMs: capabilities.web.timeoutMs } : {}),
      ...(capabilities?.web?.search ? { search: capabilities.web.search } : {}),
    }),
  );
  registry.registerProvider(buildMemoryToolProvider(memoryStore, { enabled: memoryEnabled }));
  registry.registerProvider(
    buildSkillToolProvider(skillRuntime, {
      enabled: Boolean(capabilities?.skills?.enabled),
      roots: skillRoots,
    }),
  );
  registry.registerProvider(
    buildMediaToolProvider({
      enabled: Boolean(capabilities?.media?.enabled),
      outputDir: dataDir,
      attachmentStore,
      ...(capabilities?.media?.image ? { image: capabilities.media.image } : {}),
      ...(capabilities?.media?.speech ? { speech: capabilities.media.speech } : {}),
      ...(capabilities?.media?.music ? { music: capabilities.media.music } : {}),
      ...(capabilities?.media?.video ? { video: capabilities.media.video } : {}),
    }),
  );

  // Multi-agent delegation: build a child-agent executor that reuses the parent
  // singletons (models/prompt/clock/ids) but allocates an isolated runtime per
  // child run. The delegation runtime enforces the budget gates and rolls child
  // usage back into the parent thread. OFF by default (delegate_task hidden).
  const childExecutor = new ChildAgentExecutor({
    models,
    systemPrompt: NEXUS_SYSTEM_PROMPT,
    clock,
    ids,
    contextCompaction: compactorDeps,
    ...(config.tokenEconomy ? { tokenEconomy: config.tokenEconomy } : {}),
    ...(childToolStorm ? { toolStorm: childToolStorm } : {}),
  });
  const delegationRuntime = new DelegationRuntime({
    // Read the delegation gates LIVE from the current config (via getConfig)
    // rather than a startup snapshot, so toggling delegation in Settings →
    // Capabilities takes effect (diagnostics + the runtime gate) immediately,
    // without restarting the backend. DelegationRuntime reads these on every
    // runChild/diagnostics call, so getters are sufficient.
    config: {
      get enabled() {
        return Boolean(getConfig().capabilities?.delegation?.enabled);
      },
      get maxParallel() {
        return getConfig().capabilities?.delegation?.maxParallel ?? 2;
      },
      get maxChildRuns() {
        return getConfig().capabilities?.delegation?.maxChildRuns ?? 8;
      },
    },
    executor: childExecutor,
    store: new FileDelegationStore(join(dataDir, "delegation")),
    events: { record: (event) => events.record(event) },
    onChildUsage: (parentThreadId, usage) => usageService.record(parentThreadId, usage),
  });
  registry.registerProvider(
    buildDelegationToolProvider(delegationRuntime, { enabled: Boolean(capabilities?.delegation?.enabled) }),
  );

  // MCP meta-tool provider. Building it dials configured+enabled servers during
  // boot, so wrap in try/catch: a bad/missing MCP server must never break
  // startup. OFF by default (no servers spawned, all 4 meta-tools hidden).
  // When MCP is enabled, inject the built-in first-party sidecars: the
  // `nexus-schedule` control-plane bridge (always), plus the `nexus-gitlab` /
  // `nexus-k8s` integration sidecars when their credentials are present in the
  // environment — so the seed scenario agents' gitlab_*/k8s_*/ks_*/nacos_* tool
  // whitelists resolve. Faithful to the original sidecar architecture.
  const mcpConfig = withBuiltinMcpSidecars(capabilities?.mcp, {
    host: options.host,
    port: options.port,
    secret: config.serve.runtimeToken,
  });
  let mcpHub: McpHub | undefined;
  try {
    const { provider: mcpProvider, hub } = await buildMcpToolProvider(mcpConfig ?? { enabled: false });
    mcpHub = hub;
    registry.registerProvider(mcpProvider);
  } catch (error) {
    console.error(`[nexus] MCP provider failed to initialize, continuing without it:`, (error as Error).message);
  }

  const toolHost = new LocalToolHost({
    registry,
    readTracker: true,
    hooks: hookEngine,
  });

  // --- Wave-4a services -----------------------------------------------------
  // Provider-agnostic completion adapter over the existing positional oneShot.
  // Forwards the caller's token budget (insight classifications cap at 1024 via
  // INSIGHT_MAX_TOKENS; the review service uses the 4096 default) and the
  // json_object response format so provider-side JSON mode is honored.
  const complete = ({
    system,
    prompt,
    model,
    maxTokens,
    responseFormat,
    signal,
  }: {
    system?: string;
    prompt: string;
    model?: string;
    maxTokens?: number;
    responseFormat?: "json_object";
    signal?: AbortSignal;
  }): Promise<string> =>
    oneShot(
      model ?? models.defaultModelId,
      system ?? "",
      prompt,
      maxTokens ?? 4096,
      signal,
      responseFormat ? { responseFormat } : undefined,
    );

  // Isolated code-review service. Faithful to the original `runIsolatedReviewer`:
  // the diff prompt runs inside a fresh in-memory AgentLoop wired with read-only
  // builtin file tools + the review system prompt and a pinned read-only
  // constraint, so the reviewer can inspect files beyond the diff. The service
  // OWNS that construction (see review-service.ts); we thread it the runtime
  // building blocks (model catalog, context compactor, token-economy/tool-storm
  // policy, default workspace) plus the diff->model `complete` last-resort
  // fallback. Each review gets its own throwaway runtime so it never pollutes
  // persistent thread state.
  const reviewService = new ReviewService({
    complete,
    clock,
    ids,
    runtime: {
      models,
      compactor,
      defaultWorkspace,
      ...(config.tokenEconomy ? { tokenEconomy: config.tokenEconomy } : {}),
      ...(childToolStorm ? { toolStorm: childToolStorm } : {}),
    },
  });

  // SDD plan service (`/v1/plan/*`). `verifyPlan` is a PURE local spec-coverage
  // port (no model call); `draftPlan`/`refinePlan`/`replanPlan` are model-backed
  // through the SAME provider-agnostic `complete` seam as the review/insight
  // services — the service never imports a model client. `buildPlan` is a pure
  // todo extraction over the plan checklist.
  const planService = new PlanService({ complete });

  // Speech-to-text (语音转写, T10.4): a generic OpenAI-compatible transcription
  // client. Reads the live `capabilities.speechToText` block per call (so a
  // Settings change takes effect without a restart) and is gated by the route
  // on `enabled` + a configured endpoint/apiKey/model. It is provider-agnostic
  // over config only — it POSTs audio to the configured transcription endpoint
  // directly and never imports a model client or uses the `complete` seam.
  const speechToText = new SpeechToTextService({
    getConfig: () => getConfig().capabilities?.speechToText,
  });

  // Git-aware, stateless workspace inspector (no deps to inject).
  const workspaceInspector = new LocalWorkspaceInspector();

  // Persisted agent directory (智能体目录), seeded with the original preset catalog.
  const agentDirectory = new AgentDirectoryStore({ dataDir });

  // ConnectorHub (连接中心, T4.5): credential profiles, project spaces, external
  // links, and an activity stream, persisted to `<dataDir>/connectors`. The store
  // owns the secret masking / merge-mask discipline; the service is the thin seam
  // the `/v1/connectors/*` routes read from. Eagerly ensure the root at boot so a
  // first read does not race the lazy seed; best-effort so a failure never blocks
  // startup.
  const connectorStore = new ConnectorStore({ dataDir, nowIso: clock.nowIso });
  await connectorStore.ensureRoot().catch((error) => {
    console.error(`[nexus] connector store failed to initialize:`, (error as Error).message);
  });
  const connectorService = new ConnectorService({ store: connectorStore });

  // In-memory LLM debug ring buffer (sizes/counts only; no PII/secrets).
  // (phoneService is constructed below, after threadService/turnService/agentLoop
  // exist, since the relay's inbound mirror drives real thread turns.)
  const llmDebug = new LlmDebugRecorder();

  // Proactive insight engine + group watcher. OFF by default; emit through events.record.
  const insightConfig = capabilities?.insight;

  // Shared suggestion sink: map a published suggestion onto the contract event,
  // PRESERVING topic + draftPayload so the GUI can act on the detector's draft
  // (create doc / create sheet / schedule meeting). Both the turn-end insight
  // engine and the group watcher publish through this single seam.
  const recordSuggestion = (ev: SuggestionEvent): void => {
    void events.record({
      kind: "suggestion",
      threadId: ev.threadId,
      ...(ev.turnId ? { turnId: ev.turnId } : {}),
      suggestionId: ev.suggestionId,
      detector: ev.detector,
      title: ev.title,
      confidence: ev.confidence,
      topic: ev.topic,
      draftPayload: ev.draftPayload,
    });
  };
  // Best-effort decision sink: every detector decision (published / skipped /
  // cooldown / model_error / …) becomes an `insight_decision` event for the
  // observability panel. `detail` is required on the contract, default to "".
  const recordInsightDecision = (decision: InsightDecision): void => {
    void events.record({
      kind: "insight_decision",
      threadId: decision.threadId,
      ...(decision.turnId ? { turnId: decision.turnId } : {}),
      detector: decision.detector,
      reason: decision.reason,
      detail: decision.detail ?? "",
      ...(decision.topic !== undefined ? { topic: decision.topic } : {}),
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
    });
  };

  const insightEngine = insightConfig?.enabled
    ? buildInsightEngine({
        complete,
        emit: recordSuggestion,
        logger: recordInsightDecision,
        clock: { nowMs: () => Date.now() },
        config: {
          enabled: true,
          sensitivity: insightConfig.sensitivity,
          ...(insightConfig.minConfidence !== undefined ? { minConfidence: insightConfig.minConfidence } : {}),
          ...(insightConfig.detectors ? { detectors: insightConfig.detectors } : {}),
        },
        ...(insightConfig.model ? { model: insightConfig.model } : {}),
      })
    : undefined;

  // Group-chat watcher: buffers + debounces messages pushed via POST
  // /v1/feishu/observe and may publish ONE meeting-alignment / knowledge-capture
  // suggestion. Shares the suggestion sink so its drafts are also actionable. No
  // transport is wired here (pluggable), so it stays dormant until observed.
  const groupWatcher = insightConfig?.enabled
    ? new GroupWatcher({
        gateway: new InsightModelGateway({
          complete,
          ...(insightConfig.model ? { model: insightConfig.model } : {}),
        }),
        emit: recordSuggestion,
        clock: { nowMs: () => Date.now() },
        config: {
          enabled: true,
          sensitivity: insightConfig.sensitivity,
          ...(insightConfig.minConfidence !== undefined ? { minConfidence: insightConfig.minConfidence } : {}),
        },
        logger: (line) => console.error(line),
      })
    : undefined;

  // Config-driven per-model context-compaction profiles (largeWindow flag +
  // per-model window/thresholds + contextCompaction.modelProfiles), threaded
  // into resolveModelContextProfile so config overrides actually take effect.
  // Normal models back-compute to the default 0.86/0.94 ratios, so this is
  // behavior-preserving unless a model is explicitly overridden.
  const modelProfileConfig: ModelProfileConfigSource = {
    models: config.models.map((m) => ({
      id: m.id,
      contextWindowTokens: m.contextWindowTokens,
      supportsToolCalling: m.supportsToolCalling,
      ...(m.largeWindow !== undefined ? { largeWindow: m.largeWindow } : {}),
      ...(m.compaction ? { compaction: m.compaction } : {}),
    })),
    ...(config.contextCompaction.modelProfiles
      ? { contextCompaction: { modelProfiles: config.contextCompaction.modelProfiles } }
      : {}),
  };

  // Resident "## Skills" catalog: when skills are enabled and at least one is
  // loaded, fold the always-on catalog (skill names/ids/descriptions + how to
  // invoke them) once into the stable system prefix at session start. Returns
  // undefined when skills are disabled / none loaded, so the prefix stays
  // byte-identical to the no-skills case. Faithful to SkillRuntime.catalogInstruction.
  const skillCatalog = skillRuntime.catalogInstruction();
  const systemPrompt = skillCatalog
    ? `${NEXUS_SYSTEM_PROMPT}\n\n${skillCatalog}`
    : NEXUS_SYSTEM_PROMPT;

  const agentLoop = new AgentLoop({
    models,
    toolHost,
    turns: turnService,
    threadStore: threadService,
    sessionStore,
    events,
    usage: usageService,
    steering,
    approvalGate,
    userInputGate,
    compactor,
    ids,
    clock,
    systemPrompt,
    memoryStore,
    skillRuntime,
    ...(autoRouter ? { autoRouter } : {}),
    ...(insightEngine ? { insight: insightEngine } : {}),
    llmDebug,
    attachmentStore,
    // After a successful create_plan persists, sync the thread's todo statuses
    // back into the saved plan file's Markdown checkboxes. Reads the thread's
    // current plan-linked todos, patches each checkbox via patchPlanTodoStatus,
    // and rewrites the workspace plan file (and the per-thread markdown cache)
    // only when the markdown actually changed. A throw here is non-fatal: the
    // loop records a todo_plan_sync_failed warning event and continues.
    onPlanWritten: async ({ threadId, relativePath, markdown }) => {
      const thread = await threadService.get(threadId);
      const workspace = thread?.workspace ?? defaultWorkspace;
      const todos = (await threadService.getTodos(threadId))?.items ?? [];
      let next = planMarkdownByThread.get(threadId) ?? markdown;
      let changed = false;
      for (const todo of todos) {
        if (todo.source?.kind !== "plan" || todo.source.relativePath !== relativePath) continue;
        const patched = patchPlanTodoStatus(next, todo);
        if (patched.changed) {
          next = patched.markdown;
          changed = true;
        }
      }
      planMarkdownByThread.set(threadId, next);
      if (!changed) return;
      const absolutePath = isAbsolute(relativePath) ? relativePath : resolve(workspace, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, next, "utf8");
    },
    config: {
      ...(config.toolStorm && config.toolStorm.enabled !== false
        ? {
            toolStorm: {
              ...(config.toolStorm.windowSize ? { windowSize: config.toolStorm.windowSize } : {}),
              ...(config.toolStorm.threshold ? { threshold: config.toolStorm.threshold } : {}),
            },
          }
        : {}),
      ...(config.tokenEconomy ? { tokenEconomy: config.tokenEconomy } : {}),
      modelProfileConfig,
    },
  });

  // Scheduled tasks: a file-backed task store + a recurring runner that executes
  // each due task as a fresh agent thread. The runner reuses the same loop the
  // HTTP/CLI paths drive, awaiting the turn's terminal event over the event bus.
  const scheduleRunner: ScheduleRunner = {
    async run(input) {
      const thread = await threadService.create({
        title: input.title,
        ...(input.workspaceRoot ? { workspace: input.workspaceRoot } : {}),
        ...(input.model ? { model: input.model } : {}),
        mode: input.mode,
      });
      const turn = await turnService.startTurn({
        threadId: thread.id,
        request: {
          prompt: input.prompt,
          mode: input.mode,
          attachmentIds: [],
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort as ReasoningEffort } : {}),
        },
      });
      const status = await new Promise<string>((resolve) => {
        const unsubscribe = eventBus.subscribe(thread.id, (event) => {
          if (event.turnId && event.turnId !== turn.turnId) return;
          if (event.kind === "turn_completed" || event.kind === "turn_failed" || event.kind === "turn_aborted") {
            unsubscribe();
            resolve(event.kind === "turn_completed" ? "completed" : event.kind === "turn_failed" ? "failed" : "aborted");
          }
        });
        agentLoop.run(thread.id, turn.turnId);
      });
      const items = await sessionStore.loadItems(thread.id);
      const text = items
        .filter((item): item is typeof item & { kind: "assistant_text"; text: string } => item.kind === "assistant_text")
        .map((item) => item.text)
        .join("\n");
      return { threadId: thread.id, status, text };
    },
  };
  const scheduleService = new ScheduleService({
    dataDir,
    runner: scheduleRunner,
    ids: () => ids.next("schedule"),
    nowIso: clock.nowIso,
    nowMs: clock.nowMs,
    logger: (line) => console.error(line),
  });

  // Connect Phone (连接手机, T-phone): the de-branded IM relay. A file-backed
  // provider/channel/binding store + a pluggable IM-provider transport (Feishu is
  // the one reference impl driving `feishu-bridge.mjs`) + a 127.0.0.1-only inbound
  // webhook + the inbound→thread-turn / reply→IM mirror. Eagerly ensure the store
  // root at boot (best-effort). The relay's background `start()` is driven by
  // `startServer`, so building the runtime never spawns a bridge.
  const phoneStore = new PhoneStore({ dataDir, nowIso: clock.nowIso });
  await phoneStore.ensureRoot().catch((error) => {
    console.error(`[nexus] phone store failed to initialize:`, (error as Error).message);
  });
  const phoneSidecarDir = resolveSidecarDir();
  const phoneService = new PhoneService({
    store: phoneStore,
    threadService,
    turnService,
    eventBus,
    sessionStore,
    runTurn: (threadId, turnId) => agentLoop.run(threadId, turnId),
    sidecarDir: phoneSidecarDir,
    // T8.5: forward inbound Feishu group messages into the proactive-insight
    // group watcher (source: "feishu_group"). Decoupled via a plain callback so
    // the phone service never imports the insight subsystem; inert when insight
    // is disabled (no watcher constructed).
    ...(groupWatcher ? { observeGroupMessage: (obs) => groupWatcher.observe(obs) } : {}),
    logger: (line) => console.error(line),
  });

  const runtime: Runtime = {
    turnService,
    threadService,
    usageService,
    sessionStore,
    eventBus,
    events,
    approvalGate,
    userInputGate,
    models,
    runTurn: (threadId, turnId) => agentLoop.run(threadId, turnId),
    runtimeToken: config.serve.runtimeToken,
    insecure: config.serve.insecure,
    nowIso: clock.nowIso,
    dataDir,
    defaultWorkspace,
    getConfig,
    updateConfig,
    info: () => ({
      host: getConfig().serve.host,
      port: getConfig().serve.port,
      dataDir,
      startedAt,
      configPath: configPath(dataDir),
      pid: process.pid,
    }),
    memoryStore,
    attachmentStore,
    delegation: delegationRuntime,
    ...(mcpHub ? { mcpHub } : {}),
    reviewService,
    workspaceInspector,
    llmDebug,
    toolHost,
    skillRuntime,
    agentDirectory,
    scheduleService,
    connectorService,
    phoneService,
    planService,
    speechToText,
    ...(insightEngine ? { insightEngine } : {}),
    ...(groupWatcher ? { groupWatcher } : {}),
  };

  return { runtime };
}

/**
 * Append the built-in first-party MCP sidecars to the MCP server list when MCP
 * is enabled. Mirrors the original desktop host, which spawned these as Tauri
 * `externalBin`s with credentials injected from the connector config.
 *
 *  - `nexus-schedule` — always injected; a stdio MCP server that POSTs back to
 *    this runtime's bearer-guarded `/schedule/internal/*` control-plane.
 *  - `nexus-gitlab` / `nexus-k8s` — integration sidecars injected only when
 *    their credentials are present in the serve process environment (the
 *    credential source until the ConnectorHub profile store lands, T4.5). Their
 *    `gitlab_*` / `k8s_*` / `ks_*` / `nacos_*` tools are what the seed scenario
 *    agents whitelist, so injecting them here is what makes those agents real.
 *
 * The feishu bridge is NOT an MCP server (it speaks NDJSON RPC over stdio) and
 * is spawned by the insight/feishu subsystem, not the MCP hub.
 */
function withBuiltinMcpSidecars(
  mcp: McpCapabilityConfig | undefined,
  opts: { host: string; port: number; secret?: string },
): McpCapabilityConfig | undefined {
  if (!mcp?.enabled) return mcp;
  const sidecarDir = resolveSidecarDir();
  const existing = new Set((mcp.servers ?? []).map((server) => server.id));
  const additions: McpServerConfig[] = [];

  // schedule — always available; the sidecar calls back over loopback, so map a
  // wildcard bind host to 127.0.0.1.
  if (!existing.has("nexus-schedule")) {
    const host = !opts.host || opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
    const args = [
      join(sidecarDir, "schedule-mcp.mjs"),
      "--gui-schedule-mcp-server",
      "--base-url",
      `http://${host}:${opts.port}`,
    ];
    if (opts.secret) args.push("--secret", opts.secret);
    additions.push({ id: "nexus-schedule", command: process.execPath, args, trusted: true, trustScope: "user", timeoutMs: 30_000 });
  }

  // gitlab — only when GITLAB_URL + GITLAB_TOKEN are configured (the sidecar
  // reads them from its environment via the PRIVATE-TOKEN auth header).
  const gitlabUrl = (process.env.GITLAB_URL ?? "").trim();
  const gitlabToken = (process.env.GITLAB_TOKEN ?? "").trim();
  if (!existing.has("nexus-gitlab") && gitlabUrl && gitlabToken) {
    additions.push({
      id: "nexus-gitlab",
      command: process.execPath,
      args: [join(sidecarDir, "gitlab-mcp.mjs"), "--gui-gitlab-mcp-server"],
      env: { GITLAB_URL: gitlabUrl, GITLAB_TOKEN: gitlabToken },
      trusted: true,
      trustScope: "user",
      timeoutMs: 30_000,
    });
  }

  // k8s/KubeSphere/Nacos — only when an integration signal is present. The
  // sidecar inherits the serve environment (KUBESPHERE_*/K8S_*/NACOS_*) and
  // falls back from kubectl to the KubeSphere REST API at call time.
  const k8sConfigured = ["KUBESPHERE_URL", "K8S_USERNAME", "K8S_CONTEXT", "NACOS_URL"].some(
    (key) => (process.env[key] ?? "").trim(),
  );
  if (!existing.has("nexus-k8s") && k8sConfigured) {
    additions.push({
      id: "nexus-k8s",
      command: process.execPath,
      args: [join(sidecarDir, "k8s-mcp.mjs"), "--gui-k8s-mcp-server"],
      trusted: true,
      trustScope: "user",
      timeoutMs: 30_000,
    });
  }

  if (additions.length === 0) return mcp;
  return { ...mcp, servers: [...(mcp.servers ?? []), ...additions] };
}

/**
 * Re-seed each thread's live in-memory usage accumulator from its latest persisted
 * cumulative usage snapshot at startup. FAITHFUL to the original: `createNexusServeRuntime`
 * calls `seedUsageCarryover` at boot (server/runtime-factory.dup2.js:107 → usageService.seedThread).
 *
 * This is required for correctness of the default `group_by=runtime` usage view:
 * `/v1/usage` builds `{ total: usageService.total(), perThread: forThread(id) }` purely
 * from the in-memory counters (NOT the SQLite index), so without this seed those read 0
 * after a restart and permanently undercount prior-run lifetime totals. The grouped
 * thread/day/model views are unaffected either way (they reconstruct from the SQLite
 * usage index and `diffUsage` clamps negatives, so a seeded snapshot diffs to 0).
 * Best-effort: a snapshot load failure must never block startup.
 */
async function seedUsageCarryover(runtime: Runtime): Promise<void> {
  const loadLatest = runtime.sessionStore.loadLatestUsageSnapshots;
  if (typeof loadLatest !== "function") return;
  try {
    const snapshots = await loadLatest.call(runtime.sessionStore, {});
    let seeded = 0;
    for (const snapshot of snapshots) {
      runtime.usageService.seedThread(snapshot.threadId, snapshot.usage);
      seeded += 1;
    }
    if (seeded > 0) console.log(`[nexus] restored usage for ${seeded} thread(s) from persisted snapshots`);
  } catch {
    /* best-effort: never block startup on a usage snapshot load failure */
  }
}

export async function startServer(options: ServeOptions): Promise<void> {
  const { runtime } = await buildRuntime(options);
  const settled = await runtime.turnService.settleOrphanedRunningTurns("server restarted").catch(() => ({ threads: 0, turns: 0 }));
  if (settled.turns > 0) console.log(`[nexus] paused ${settled.turns} orphaned turn(s) from a previous run`);
  await seedUsageCarryover(runtime);
  // Begin the recurring scheduler (serve path only; CLI runs are ephemeral).
  runtime.scheduleService?.start();
  // Bring up the Connect Phone IM relay (background-automation mode): connects
  // enabled provider transports + the 127.0.0.1 inbound webhook so IM mirrors run
  // without the GUI. Best-effort: a relay start failure must never block serving.
  void runtime.phoneService?.start().catch((error) => {
    console.error(`[nexus] phone relay failed to start:`, (error as Error).message);
  });

  const staticDir = resolveStaticDir(options.staticDir);
  const router = buildRouter(runtime);
  const server = createNodeHttpServer(router, { staticDir });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      // Rich, machine-readable readiness handshake (faithful to the original
      // serve-entry startupInfo) so any launcher can JSON.parse the line after
      // the NEXUS_READY prefix. The human-readable [nexus] lines follow.
      const cfg = runtime.getConfig();
      const rt = runtime.info?.();
      const startupInfo = {
        // `service: "nexus"` matches the original readiness/health idiom (the
        // GET /health route also returns service:"nexus"), so a launcher keying
        // on service==="nexus" recognizes this runtime.
        service: "nexus",
        mode: "serve",
        host: options.host,
        port: options.port,
        configPath: rt?.configPath ?? configPath(options.dataDir),
        dataDir: options.dataDir,
        model: cfg.defaultModel ?? cfg.models?.[0]?.id ?? null,
        approvalPolicy: options.approvalPolicy ?? cfg.approvalPolicy,
        sandboxMode: options.sandboxMode ?? cfg.sandboxMode,
        insecure: Boolean(runtime.insecure),
        startedAt: rt?.startedAt ?? new Date().toISOString(),
        pid: process.pid,
        message: `nexus runtime listening on http://${options.host}:${options.port}`,
      };
      console.log(`${NEXUS_READY_PREFIX}${JSON.stringify(startupInfo)}`);
      console.log(`[nexus] data dir: ${options.dataDir}`);
      console.log(`[nexus] auth: ${runtime.insecure ? "INSECURE (no token)" : "bearer token required"}`);
      if (staticDir) console.log(`[nexus] serving frontend from ${staticDir}`);
      const configured = Object.entries(runtime.getConfig().providers)
        .filter(([, p]) => p.apiKey)
        .map(([name]) => name);
      console.log(`[nexus] providers with keys: ${configured.length ? configured.join(", ") : "none — set one in Settings"}`);
      resolve();
    });
  });
}

/**
 * Load and validate a config file from an explicit path (--config /
 * NEXUS_CONFIG). On a read/parse failure, fall back to the data-dir default so
 * a bad path never breaks startup (faithful to the original tolerant loader).
 */
function loadConfigFromPath(path: string, dataDir: string): NexusConfig {
  try {
    return NexusConfigSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    console.error(`[nexus] failed to read config at ${path}, using data-dir config:`, (error as Error).message);
    return loadConfig(dataDir);
  }
}

function applyEnvApiKeys(config: NexusConfig): NexusConfig {
  const providers = { ...config.providers };
  const envFor: Record<string, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (!provider.apiKey && envFor[name]) providers[name] = { ...provider, apiKey: envFor[name]! };
  }
  return { ...config, providers };
}

function resolveStaticDir(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../frontend/dist");
  return existsSync(candidate) ? candidate : undefined;
}

// Resolve the directory holding the bundled sidecar scripts (schedule/gitlab/k8s/
// feishu/write-export). In a packaged desktop build the Rust host stages the
// sidecars beside the backend bundle and passes `NEXUS_SIDECAR_DIR`; in a dev /
// source run we fall back to `backend/sidecars` relative to this module. Mirrors
// the `NEXUS_STATIC_DIR` resolution so the same backend.mjs works both ways.
function resolveSidecarDir(): string {
  const fromEnv = process.env.NEXUS_SIDECAR_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sidecars");
}

export const DEFAULT_SERVE_PORT = 8910;
export const DEFAULT_STORAGE_BACKEND: StorageBackend = "hybrid";

/** Process exit codes for the serve CLI (faithful to the original ServeExitCode). */
export const ServeExitCode = {
  ok: 0,
  usage: 64,
  config: 78,
  runtime: 70,
} as const;

/** `nexus-agent serve` help text. */
export const SERVE_USAGE = `nexus-agent serve [options]

Options:
  --config <path>          JSON config file (default: {data-dir}/config.json when present)
  --host <host>            Bind address (default 127.0.0.1)
  --port <port>            HTTP port (default ${DEFAULT_SERVE_PORT})
  --data-dir <path>        Root directory for threads, events, and usage
  --token <token>          Bearer token for /v1/* requests
  --approval-policy <p>    on-request | untrusted | never | auto | suggest
  --sandbox-mode <mode>    read-only | workspace-write | danger-full-access | external-sandbox
  --token-economy          Compress safe tool context before model calls
  --insecure               Disable bearer token check (local dev only)
  --storage <backend>      file | memory (in-memory is for tests; default file)
  --storage-backend <b>    hybrid | file (default hybrid)
  --sqlite-path <path>     SQLite index path for hybrid storage
  --static <path>          Directory to serve a built frontend from
`;

/** Parse `--flag value`, `--flag=value`, and bare `--flag` (=> "true"). */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(arg.slice(2), next);
        i += 1;
      } else {
        flags.set(arg.slice(2), "true");
      }
    }
  }
  return flags;
}

/** Expand a leading `~` / `~/` to the user's home directory (path inputs only). */
function expandTilde(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function boolFromValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") return false;
  return true;
}

export function parseServeOptions(argv: string[], env: NodeJS.ProcessEnv): ServeOptions {
  const flags = parseFlags(argv);
  const pick = (flag: string, envName: string): string | undefined => flags.get(flag) ?? env[envName];
  const str = (flag: string): string | undefined => {
    const value = flags.get(flag);
    return typeof value === "string" && value !== "true" ? value : undefined;
  };

  const approvalRaw = str("approval-policy") ?? env.NEXUS_APPROVAL_POLICY;
  const sandboxRaw = str("sandbox-mode") ?? env.NEXUS_SANDBOX_MODE;
  const tokenEconomy =
    boolFromValue(flags.get("token-economy")) ?? boolFromValue(env.NEXUS_TOKEN_ECONOMY_MODE);
  const storageBackendRaw = str("storage-backend") ?? env.NEXUS_STORAGE_BACKEND;
  const storageBackend: StorageBackend =
    storageBackendRaw === "file" || storageBackendRaw === "hybrid" ? storageBackendRaw : DEFAULT_STORAGE_BACKEND;
  const sqlitePath = expandTilde(str("sqlite-path") ?? env.NEXUS_SQLITE_PATH);
  const explicitConfig = expandTilde(str("config") ?? str("config-file") ?? env.NEXUS_CONFIG);

  const options: ServeOptions = {
    host: pick("host", "NEXUS_HOST") ?? "127.0.0.1",
    port: Number(pick("port", "NEXUS_PORT") ?? String(DEFAULT_SERVE_PORT)) || DEFAULT_SERVE_PORT,
    dataDir: expandTilde(pick("data-dir", "NEXUS_DATA_DIR")) ?? defaultDataDir(),
    runtimeToken: pick("token", "NEXUS_RUNTIME_TOKEN"),
    insecure: flags.get("insecure") === "true" || env.NEXUS_INSECURE === "true" ? true : undefined,
    storage: (pick("storage", "NEXUS_STORAGE") as "file" | "memory") === "memory" ? "memory" : "file",
    staticDir: expandTilde(pick("static", "NEXUS_STATIC_DIR")),
    storageBackend,
  };
  if (explicitConfig) options.configPath = explicitConfig;
  if (approvalRaw) options.approvalPolicy = ApprovalPolicySchema.parse(approvalRaw);
  if (sandboxRaw) options.sandboxMode = SandboxModeSchema.parse(sandboxRaw);
  if (tokenEconomy !== undefined) options.tokenEconomy = tokenEconomy;
  if (sqlitePath) options.sqlitePath = sqlitePath;
  return options;
}

export type ParseServeOptionsResult =
  | { ok: true; options: ServeOptions }
  | { ok: false; exitCode: number; message: string; issues?: unknown };

/**
 * Parse serve options, mapping validation/config failures to structured exit
 * codes instead of throwing. Faithful to the original parseServeOptionsSafe.
 */
export function parseServeOptionsSafe(argv: string[], env: NodeJS.ProcessEnv = {}): ParseServeOptionsResult {
  try {
    const options = parseServeOptions(argv, env);
    if (!options.dataDir) {
      return { ok: false, exitCode: ServeExitCode.config, message: "serve requires --data-dir <path>" };
    }
    return { ok: true, options };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, exitCode: ServeExitCode.config, message: "invalid serve options", issues: error.issues };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, exitCode: ServeExitCode.config, message };
  }
}
