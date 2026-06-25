import type { TurnService } from "../services/turn-service.js";
import type { ThreadService } from "../services/thread-service.js";
import type { UsageService } from "../services/usage-service.js";
import type { RuntimeEventRecorder } from "../services/runtime-event-recorder.js";
import type { SessionStore } from "../adapters/store/types.js";
import type { EventBus } from "../adapters/event/event-bus.js";
import type { InMemoryApprovalGate, InMemoryUserInputGate } from "../adapters/event/gates.js";
import type { ModelRegistry } from "../ports/model-client.js";
import type { NexusConfig } from "../config/config.js";
import type { FileMemoryStore } from "../memory/memory-store.js";
import type { AttachmentStore } from "../attachments/attachment-store.js";
import type { DelegationRuntime } from "../delegation/delegation-runtime.js";
import type { McpHub } from "../adapters/tool/mcp-tool-provider.js";
import type { ReviewService } from "../services/review-service.js";
import type { InsightEngine } from "../services/insight/insight-engine.js";
import type { GroupWatcher } from "../services/insight/group-watcher.js";
import type { ScheduleService } from "../services/schedule-service.js";
import type { LocalWorkspaceInspector } from "../adapters/workspace/local-workspace-inspector.js";
import type { LlmDebugRecorder } from "../services/llm-debug-recorder.js";
import type { LocalToolHost } from "../adapters/tool/local-tool-host.js";
import type { SkillRuntime } from "../skills/skill-runtime.js";
import type { AgentDirectoryStore } from "../adapters/store/agent-directory-store.js";
import type { ConnectorService } from "../services/connector-service.js";
import type { PhoneService } from "../services/phone-service.js";
import type { PlanService } from "../services/plan-service.js";
import type { SpeechToTextService } from "../adapters/model/stt-client.js";

/** Live serving-process identity exposed by {@link Runtime.info}. */
export interface RuntimeInfo {
  host: string;
  port: number;
  dataDir: string;
  startedAt: string;
  configPath?: string;
  pid?: number;
}

/** The dependency bag the HTTP routes read from. */
export interface Runtime {
  turnService: TurnService;
  threadService: ThreadService;
  usageService: UsageService;
  sessionStore: SessionStore;
  eventBus: EventBus;
  events: RuntimeEventRecorder;
  approvalGate: InMemoryApprovalGate;
  userInputGate: InMemoryUserInputGate;
  models: ModelRegistry;

  runTurn: (threadId: string, turnId: string) => void;

  runtimeToken: string;
  insecure: boolean;
  nowIso: () => string;

  dataDir: string;
  defaultWorkspace: string;
  getConfig: () => NexusConfig;
  updateConfig: (config: NexusConfig) => NexusConfig;

  /**
   * Optional accessor exposing the live serving process's identity (bind
   * address, data dir, start time, and optional config path / pid). Lets a route
   * assemble the canonical {@link RuntimeInfoResponse} envelope. Optional so a
   * runtime that does not know its bind address still works.
   */
  info?: () => RuntimeInfo;

  /** Long-term memory store (present only when the memory capability is configured). */
  memoryStore?: FileMemoryStore;
  /** Content-addressed attachment store (present when attachments are wired). */
  attachmentStore?: AttachmentStore;
  /** Multi-agent child delegation runtime (present when the delegation capability is wired). */
  delegation?: DelegationRuntime;
  /** MCP hub owning spawned stdio child processes (present when the MCP capability is wired). */
  mcpHub?: McpHub;

  /** Isolated code-review service (Wave-4b routes). */
  reviewService?: ReviewService;
  /** Proactive insight engine (present when the insight capability is enabled). */
  insightEngine?: InsightEngine;
  /**
   * Proactive group-chat watcher (present when the insight capability is enabled).
   * Buffers + debounces observed group messages from POST /v1/feishu/observe and
   * may emit a suggestion. Pluggable transport: dormant until messages are pushed.
   */
  groupWatcher?: GroupWatcher;
  /** Git-aware workspace inspector (Wave-4b routes). */
  workspaceInspector?: LocalWorkspaceInspector;
  /** In-memory LLM debug ring buffer (Wave-4b debug route). */
  llmDebug?: LlmDebugRecorder;
  /** Local tool host (Wave-4b routes that introspect the tool catalog). */
  toolHost?: LocalToolHost;
  /** Skills runtime (Wave-4b routes that list/inspect skills). */
  skillRuntime?: SkillRuntime;
  /** Agent directory (智能体目录) — persisted scenario-agent catalog with CRUD. */
  agentDirectory?: AgentDirectoryStore;
  /** Scheduled-task service (file-backed tasks + recurring runner). */
  scheduleService?: ScheduleService;
  /**
   * ConnectorHub (连接中心) service — credential profiles, project spaces,
   * external links, and activity events over the file-backed connector store.
   * Present whenever the serve runtime is built; secrets are masked on read and
   * merge-masked on write by the underlying store.
   */
  connectorService?: ConnectorService;
  /**
   * Connect Phone (连接手机) IM-relay service (`/v1/phone/*`). De-branded port of
   * the original native IM relay: a pluggable IM-provider interface (Feishu is
   * the one reference impl, driving the `feishu-bridge.mjs` sidecar over its
   * NDJSON-over-stdio protocol) + channel/binding store + a 127.0.0.1-only
   * inbound webhook + the inbound→thread-turn / reply→IM message mirror. Provider
   * credential secrets are masked on read and merge-masked on write by the
   * underlying store. Present whenever the serve runtime is built; the relay's
   * `start()`/`stop()` background hook is driven by `startServer`.
   */
  phoneService?: PhoneService;
  /**
   * SDD plan service (`/v1/plan/*`). `verifyPlan` is a pure local spec-coverage
   * port (no model); `draftPlan`/`refinePlan`/`replanPlan` are model-backed via
   * the same provider-agnostic completion seam as the write/review services;
   * `buildPlan` extracts tracked todos from a plan checklist. Present whenever
   * the serve runtime is built.
   */
  planService?: PlanService;
  /**
   * Speech-to-text (语音转写) transcription client (T10.4). Present whenever the
   * serve runtime is built; the POST /v1/audio/transcribe route gates each call
   * on the live `capabilities.speechToText.enabled` flag + a configured
   * endpoint/apiKey/model, so it is dormant until STT is enabled in Settings.
   * Provider-agnostic over config only — it does NOT use the completion seam.
   */
  speechToText?: SpeechToTextService;
}
