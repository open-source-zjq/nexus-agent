// Wire types mirroring the backend contracts (the SSE/REST protocol).

export type TurnItemStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export type ToolKind = "tool_call" | "command_execution" | "file_change";

export interface BaseItem {
  id: string;
  turnId: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  status: TurnItemStatus;
  createdAt: string;
  finishedAt?: string;
}

export type TurnItem =
  | (BaseItem & { kind: "user_message"; text: string; displayText?: string })
  | (BaseItem & { kind: "assistant_text"; text: string })
  | (BaseItem & { kind: "assistant_reasoning"; text: string })
  | (BaseItem & {
      kind: "tool_call";
      toolName: string;
      callId: string;
      toolKind: ToolKind;
      arguments: Record<string, unknown>;
      summary?: string;
    })
  | (BaseItem & {
      kind: "tool_result";
      toolName: string;
      callId: string;
      toolKind: ToolKind;
      output: unknown;
      isError: boolean;
    })
  | (BaseItem & { kind: "approval"; approvalId: string; toolName: string; summary: string; status: "pending" | "allowed" | "denied" | "expired" })
  | (BaseItem & {
      kind: "user_input";
      inputId: string;
      prompt: string;
      questions: UserInputQuestion[];
      status: "pending" | "submitted" | "cancelled";
    })
  | (BaseItem & { kind: "compaction"; summary: string; replacedTokens: number })
  | (BaseItem & { kind: "error"; message: string; code?: string; severity?: string });

export interface UserInputQuestion {
  header: string;
  id: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

export type ThreadMode = "agent" | "plan";
export type ApprovalPolicy = "auto" | "on-request" | "never" | "untrusted" | "suggest";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access" | "external-sandbox";

export interface Turn {
  id: string;
  threadId: string;
  status: TurnItemStatus | "queued";
  prompt: string;
  model?: string;
  items: TurnItem[];
  createdAt: string;
}

export interface ThreadTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ThreadGoal {
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed: number;
}

export interface Thread {
  id: string;
  title: string;
  workspace: string;
  model: string;
  mode: ThreadMode;
  status: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  costBudgetUsd?: number;
  goal?: ThreadGoal;
  todos?: { items: ThreadTodoItem[] };
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
  latestSeq?: number;
}

export type ThreadSummary = Omit<Thread, "turns">;

/**
 * Discriminated runtime event kinds carried over the SSE stream. Mirrors
 * backend/src/contracts/events.ts. We keep `kind` a string literal union for
 * narrowing while leaving the payload fields optional (the wire is loose).
 */
export type RuntimeEventKind =
  | "item_created"
  | "item_updated"
  | "item_completed"
  | "assistant_text_delta"
  | "assistant_reasoning_delta"
  | "tool_call_started"
  | "tool_call_finished"
  | "thread_created"
  | "thread_updated"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_aborted"
  | "turn_steered"
  | "approval_requested"
  | "approval_resolved"
  | "user_input_requested"
  | "user_input_resolved"
  | "tool_call_ready"
  | "tool_storm_suppressed"
  | "tool_catalog_changed"
  | "compaction_started"
  | "compaction_completed"
  | "goal_updated"
  | "goal_cleared"
  | "todos_updated"
  | "todos_cleared"
  | "pipeline_stage"
  | "usage"
  | "suggestion"
  | "insight_decision"
  | "tool_result_upload_wait"
  | "error"
  | "heartbeat";

export interface RuntimeEvent {
  seq: number;
  timestamp: string;
  kind: RuntimeEventKind | string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  item?: TurnItem;
  delta?: string;
  message?: string;
  code?: string;
  severity?: string;
  status?: string;
  stage?: string;
  label?: string;
  usage?: UsageSnapshot;
  goal?: ThreadGoal | null;
  todos?: { items: ThreadTodoItem[] } | null;
  model?: string;
  // suggestion
  suggestionId?: string;
  detector?: string;
  title?: string;
  detail?: string;
  source?: string;
  confidence?: number;
  topic?: string;
  draftPayload?: Record<string, unknown>;
  // insight_decision
  decision?: string;
  reason?: string;
  // tool_storm_suppressed / tool_catalog_changed / tool_result_upload_wait
  toolName?: string;
  callId?: string;
  fingerprint?: string;
  toolCount?: number;
  changeKind?: "additive" | "breaking";
  toolNames?: string[];
  // compaction
  summary?: string;
  replacedTokens?: number;
}

export interface UsageSnapshot {
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  supportsImages: boolean;
  reasoning: boolean;
  configured: boolean;
}

export interface RuntimeInfo {
  models: ModelInfo[];
  defaultModel: string;
  defaultWorkspace: string;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultSandboxMode: SandboxMode;
  providersConfigured: Record<string, boolean>;
}

export interface ProviderConfig {
  kind: "openai" | "anthropic";
  apiKey: string;
  baseUrl?: string;
  endpointFormat?: "chat_completions" | "messages" | "responses" | "custom_endpoint";
  headers?: Record<string, string>;
}

export interface ModelConfig {
  id: string;
  label?: string;
  provider: string;
  wireModel?: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  supportsToolCalling: boolean;
  supportsImages: boolean;
}

// --- capabilities (mirror backend/src/config/config.ts) --------------------

export interface WebSearchConfig {
  endpoint?: string;
  apiKey?: string;
  provider?: string;
}

export interface WebCapabilityConfig {
  enabled: boolean;
  allowDomains?: string[];
  denyDomains?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  search?: WebSearchConfig;
}

export interface MemoryCapabilityConfig {
  enabled: boolean;
}

export interface SkillsCapabilityConfig {
  enabled: boolean;
  roots?: string[];
  legacySkillMd?: boolean;
}

export interface MediaEndpointConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  /** Vendor wire-shape selector; empty/omitted/unknown => OpenAI-compatible. */
  protocol?: string;
  /** Image: fallback WxH size. */
  defaultSize?: string;
  /** Speech: default provider voice. */
  voice?: string;
  /** Speech/Music: default audio container format. */
  format?: string;
  /** Video: default clip duration (seconds). */
  defaultDuration?: number;
  /** Video: default resolution tier. */
  defaultResolution?: string;
  /** Per-modality request timeout budget in ms. */
  timeoutMs?: number;
  /** Image: max reference images for image-to-image. */
  maxReferenceImages?: number;
}

export interface MediaCapabilityConfig {
  enabled: boolean;
  image?: MediaEndpointConfig;
  speech?: MediaEndpointConfig;
  music?: MediaEndpointConfig;
  video?: MediaEndpointConfig;
}

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  trusted?: boolean;
}

/**
 * Persisted MCP tool-search (BM25) tuning, mirroring the backend
 * `McpSearchTuningSchema` (config.ts). Only these numeric knobs round-trip via
 * PUT /v1/config; `enabled` is carried by `McpCapabilityConfig.enabled`.
 */
export interface McpSearchTuningConfig {
  topKDefault?: number;
  topKMax?: number;
  minScore?: number;
  bm25?: { k1?: number; b?: number };
}

export interface McpCapabilityConfig {
  enabled: boolean;
  servers?: McpServerConfig[];
  search?: McpSearchTuningConfig;
}

export interface DelegationCapabilityConfig {
  enabled: boolean;
  maxParallel?: number;
  maxChildRuns?: number;
}

export interface InsightCapabilityConfig {
  enabled: boolean;
  sensitivity?: "high" | "medium" | "low";
  minConfidence?: number;
  model?: string;
  detectors?: {
    knowledge_capture?: boolean;
    meeting_alignment?: boolean;
    data_to_sheet?: boolean;
  };
}

export interface CapabilitiesConfig {
  web?: WebCapabilityConfig;
  memory?: MemoryCapabilityConfig;
  skills?: SkillsCapabilityConfig;
  media?: MediaCapabilityConfig;
  mcp?: McpCapabilityConfig;
  delegation?: DelegationCapabilityConfig;
  insight?: InsightCapabilityConfig;
}

export interface NexusConfig {
  serve: { host: string; port: number; runtimeToken: string; insecure: boolean };
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
  defaultModel?: string;
  defaultWorkspace?: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  capabilities?: CapabilitiesConfig;
}

export interface UsageReport {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  requests: number;
  byModel: Record<string, { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null; requests: number }>;
}

/** Shared counters carried by every day bucket / total (GET /v1/usage?group_by=day). */
export interface DailyUsageCounters {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_miss_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
  token_economy_savings_tokens: number;
  token_economy_savings_usd: number;
  turns: number;
  thread_count: number;
  cache_hit_rate: number | null;
}

export interface DailyUsageBucket extends DailyUsageCounters {
  date: string;
}

/** Response for `group_by=day` — drives the usage calendar heatmap. */
export interface DailyUsageReport {
  group_by: "day";
  from: string;
  to: string;
  timezone: string;
  buckets: DailyUsageBucket[];
  totals: DailyUsageCounters & { days: number; active_days: number };
}

export interface ModelUsageBucket extends DailyUsageCounters {
  model: string;
}

/** Response for `group_by=model` — drives the Usage panel's per-model breakdown. */
export interface ModelUsageReport {
  group_by: "model";
  from: string;
  to: string;
  timezone: string;
  buckets: ModelUsageBucket[];
}

// --- review ----------------------------------------------------------------

export interface ReviewFinding {
  priority: number;
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  title?: string;
  overallCorrectness?: "patch is correct" | "patch is incorrect";
  overallConfidenceScore?: number;
}

/** Discriminated review target passed to POST /v1/threads/:id/review. */
export type ReviewTarget =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "baseBranch"; branch: string }
  | { kind: "commit"; sha: string }
  | { kind: "custom"; instructions: string };

// --- workspace -------------------------------------------------------------

export interface WorkspaceChangedFile {
  /** Repo-relative path (rename target for "R" entries). */
  path: string;
  /** Two-character git porcelain status code, e.g. " M", "??", "A ". */
  status: string;
}

/** Mirrors the GET /v1/workspace/status response (flat git status + file list). */
export interface WorkspaceStatus {
  path: string;
  exists: boolean;
  isGitRepository: boolean;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean | null;
  fileChangeCount: number | null;
  checkedAt: string;
  changedFiles: WorkspaceChangedFile[];
}

/** Mirrors the GET /v1/files/retrieve response (path-validated file content). */
export interface FileRetrieval {
  path: string;
  absolutePath: string;
  size: number;
  language: string;
  lineCount: number;
  truncated: boolean;
  content: string;
}

/** Mirrors the GET /v1/workspace/diff response (unified diff for one file). */
export interface WorkspaceFileDiff {
  file: string;
  /** Raw unified diff text (`git diff`), empty when there is no change. */
  diff: string;
  added: number;
  removed: number;
  untracked: boolean;
  binary: boolean;
}

// --- SDD plan (`/v1/plan/*`, T3.3) -----------------------------------------

/** A requirement's lifecycle status (rank-ordered: draft < … < verified). */
export type RequirementStatus = "draft" | "planned" | "building" | "done" | "verified";

/** A parsed requirement block (`### R-1: title {status}` + body + acceptance). */
export interface RequirementBlock {
  id: string;
  title: string;
  status: RequirementStatus;
  headingLevel: number;
  headingLineIndex: number;
  endLineIndex: number;
  acceptance: Array<{ text: string; checked: boolean; lineIndex: number }>;
  contentHash: string;
}

/** Per-requirement coverage rollup (how many covering steps, how many done). */
export interface RequirementCoverage {
  id: string;
  totalSteps: number;
  doneSteps: number;
}

/** Result of POST /v1/plan/verify — the full spec-coverage report. */
export interface VerifyPlanResult {
  blocks: RequirementBlock[];
  perRequirement: RequirementCoverage[];
  uncoveredIds: string[];
  derivedStatuses: Record<string, RequirementStatus>;
  changedIds: string[];
  addedIds: string[];
}

/** Result of POST /v1/plan/draft (full plan Markdown + reserved path). */
export interface DraftPlanResult {
  content: string;
  planRelativePath: string;
}

/** Result of POST /v1/plan/refine or /v1/plan/replan (revised plan Markdown). */
export interface RefinePlanResult {
  content: string;
}

/** A single plan-derived todo (POST /v1/plan/build). */
export interface BuildPlanTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  source?: {
    kind: "plan";
    planId: string;
    relativePath: string;
    ordinal: number;
    contentHash: string;
  };
}

/** Result of POST /v1/plan/build (todos extracted from the plan checklist). */
export interface BuildPlanResult {
  todos: BuildPlanTodo[];
}

/** Result of POST /v1/files/write (path-safe workspace text write). */
export interface WriteWorkspaceFileResult {
  ok: true;
  path: string;
  byteSize: number;
}

// --- skills ----------------------------------------------------------------

export interface SkillTriggersInfo {
  commands: string[];
  promptPatterns: string[];
  fileTypes: string[];
}

/** Mirrors one entry of the GET /v1/skills `skills[]` diagnostics rollup. */
export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  root?: string;
  legacy?: boolean;
  triggers?: SkillTriggersInfo;
  allowedTools?: string[];
  /** @deprecated not sent by the backend; kept so existing readers compile. */
  priority?: number;
  /** @deprecated not sent by the backend; kept so existing readers compile. */
  source?: string;
}

/**
 * One entry of the GET /v1/skills `validationErrors[]` rollup. The backend sends
 * objects ({ root, message }), NOT strings — render `message` (never the object
 * directly, which would throw "Objects are not valid as a React child").
 */
export interface SkillValidationError {
  root: string;
  message: string;
}

// --- memory (mirror backend/src/contracts/memory.ts) -----------------------

export type MemoryScope = "user" | "workspace" | "project";

export interface MemoryRecord {
  id: string;
  content: string;
  scope: MemoryScope;
  workspace?: string;
  project?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
  deletedAt?: string;
}

export interface MemoryCreateRequest {
  content: string;
  scope?: MemoryScope;
  workspace?: string;
  project?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  tags?: string[];
  confidence?: number;
}

export interface MemoryUpdateRequest {
  content?: string;
  tags?: string[];
  confidence?: number;
  disabled?: boolean;
}

export interface MemoryDiagnostics {
  enabled: boolean;
  rootDir: string;
  activeCount: number;
  tombstoneCount: number;
  lastInjectedIds: string[];
}

// --- llm debug rounds (mirror llm-debug-recorder round shape) --------------

export interface LlmRequestSummary {
  systemPromptChars: number;
  historyItems: number;
  toolCount: number;
  reasoningEffort?: string;
}

export interface LlmRound {
  id: number;
  threadId: string;
  turnId: string;
  model: string;
  requestSummary: LlmRequestSummary;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stopReason?: "stop" | "tool_calls" | "length" | "error";
  usage?: UsageSnapshot;
  error?: string;
}

// --- mcp -------------------------------------------------------------------

export interface McpServerStatus {
  id: string;
  command: string;
  trusted: boolean;
  connected: boolean;
  toolCount: number;
  unavailableReason?: string;
}

export interface McpStatus {
  enabled: boolean;
  servers: McpServerStatus[];
  refreshedAt?: string;
  indexedToolCount?: number;
}

// --- tool diagnostics ------------------------------------------------------

export interface ToolProviderDiagnostic {
  id: string;
  kind: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

/**
 * MCP tool-search diagnostics from GET /v1/runtime/tools (T10.9). Mirrors the
 * backend `computeMcpSearchDiagnostics` shape: live hub index stats + the
 * resolved BM25 tuning (`mcp.search`). There is no `active`/`advertisedToolCount`
 * field — Status is derived from `enabled`, and "offered to model" falls back to
 * `indexedToolCount`.
 */
export interface McpSearchDiagnostics {
  enabled: boolean;
  indexedToolCount: number;
  refreshedAt?: string;
  tuning?: McpSearchTuningConfig | null;
}

export interface ToolDiagnostics {
  providers: ToolProviderDiagnostic[];
  mcpSearch?: McpSearchDiagnostics;
}

// --- delegation (sub-agent) diagnostics ------------------------------------
// Mirrors backend/src/delegation: GET /v1/delegation/diagnostics (read-only).

export type ChildRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";

export interface ChildRunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
  turns?: number;
}

export interface ChildRunRecord {
  id: string;
  parentThreadId: string;
  parentTurnId: string;
  label?: string;
  prompt: string;
  workspace?: string;
  model?: string;
  status: ChildRunStatus;
  summary?: string;
  error?: string;
  usage: ChildRunUsage;
  createdAt: string;
  updatedAt: string;
}

export interface ChildRunAggregate {
  key: string;
  label?: string;
  model?: string;
  runs: number;
  completed: number;
  failed: number;
  aborted: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageTotalTokens: number;
  costUsd?: number;
  averageCostUsd?: number;
}

export interface DelegationDiagnostics {
  enabled: boolean;
  active: number;
  childRuns: ChildRunRecord[];
  aggregates: ChildRunAggregate[];
}

// --- agent directory (智能体目录) ------------------------------------------
// Mirrors backend/src/contracts/agents.ts.

export interface AgentTrigger {
  kind: "command" | "event" | "schedule";
  value: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  subtitle: string;
  category: string;
  description: string;
  tools: string[];
  triggers: AgentTrigger[];
  visible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCreateRequest {
  name: string;
  subtitle?: string;
  category?: string;
  description?: string;
  tools?: string[];
  triggers?: AgentTrigger[];
  visible?: boolean;
}

export type AgentUpdateRequest = Partial<AgentCreateRequest>;

// --- suggestions / proactive insights --------------------------------------

export type InsightDetector = "knowledge_capture" | "meeting_alignment" | "data_to_sheet" | string;

/** A published proactive suggestion, bucketed per thread in the store. */
export interface Suggestion {
  suggestionId: string;
  detector: InsightDetector;
  title: string;
  topic: string;
  confidence?: number;
  /** Detector-specific editable draft (doc markdown, sheet table, meeting agenda…). */
  draftPayload: Record<string, unknown>;
  threadId: string;
  createdAt?: string;
  detail?: string;
  source?: string;
}

/** Best-effort per-decision record surfaced for the observability panel. */
export interface InsightDecision {
  detector: string;
  reason: string;
  detail: string;
  topic?: string;
  confidence?: number;
  threadId?: string;
}

/** Transient post-action toast shown after accepting / writing a suggestion. */
export interface InsightFeedbackToast {
  id: string;
  ok: boolean;
  message: string;
  url?: string;
  createdAt: string;
}

// --- scheduled tasks (mirror backend/src/contracts/schedule.ts) ------------

export type ScheduleKind = "manual" | "at" | "daily" | "interval";
export type ScheduleRunStatus = "idle" | "running" | "success" | "error";

export interface ScheduleSpec {
  kind: ScheduleKind;
  atTime?: string;
  timeOfDay?: string;
  everyMinutes?: number;
}

export interface ScheduleTask {
  id: string;
  title: string;
  prompt: string;
  workspaceRoot?: string;
  model?: string;
  reasoningEffort?: string;
  mode: "agent" | "plan";
  enabled: boolean;
  priority: number;
  schedule: ScheduleSpec;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus: ScheduleRunStatus;
  lastResult?: string;
  lastThreadId?: string;
  nextRunAt?: string;
}

export interface ScheduleCreateRequest {
  title: string;
  prompt: string;
  workspaceRoot?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: "agent" | "plan";
  enabled?: boolean;
  priority?: number;
  schedule: ScheduleSpec;
}

export type ScheduleUpdateRequest = Partial<Omit<ScheduleCreateRequest, "schedule">> & { schedule?: ScheduleSpec };

// --- attachments (mirror backend/src/contracts/attachments.ts) -------------

export interface AttachmentTextFallback {
  dataBase64: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  wasCompressed?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  hash: string;
  width?: number;
  height?: number;
  textFallback?: AttachmentTextFallback;
  threadIds: string[];
  workspaces: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentUploadRequest {
  name: string;
  mimeType?: string;
  dataBase64: string;
  textFallback?: AttachmentTextFallback;
  threadId?: string;
  workspace?: string;
}

// --- connectors (连接中心 / ConnectorHub) ----------------------------------
// Mirrors backend/src/contracts/connectors.ts. Three axes persisted side by
// side in `<dataDir>/connectors/connectors.json`: credential profiles (per
// vendor, one default each), project spaces (bind one profile per bindable
// vendor), external resource links (per space), and an append-only activity
// stream. Secret fields are masked on read and merge-masked on write: send the
// `MASKED_SECRET` sentinel back unchanged to preserve the stored secret.

/** Known connector vendors (kept as generic tool ids, not company-bound). */
export const CONNECTOR_VENDORS = ["gitlab", "k8s", "nacos", "feishu"] as const;
export type ConnectorVendor = (typeof CONNECTOR_VENDORS)[number];

/** Vendors that participate in per-vendor space bindings. */
export const BINDABLE_VENDORS = ["gitlab", "k8s", "nacos"] as const;
export type BindableVendor = (typeof BINDABLE_VENDORS)[number];

/**
 * Sentinel echoed by the backend for a stored secret field on read. Send it
 * back UNCHANGED on update to preserve the stored secret (the store
 * merge-masks). Never display this as a real value or require re-entry.
 */
export const MASKED_SECRET = "********";

/** Secret field key(s) per vendor (masked on read, merge-masked on write). */
export const SECRET_FIELDS_BY_VENDOR: Readonly<Record<ConnectorVendor, readonly string[]>> = {
  gitlab: ["token"],
  k8s: ["encrypt"],
  nacos: ["password"],
  feishu: ["appSecret"],
};

/**
 * A vendor credential profile. The per-vendor credential fields are flattened
 * onto the object; only the keys relevant to `vendor` are meaningful. Secret
 * fields come back masked (`MASKED_SECRET`).
 */
export interface ConnectorProfile {
  id: string;
  vendor: ConnectorVendor;
  name: string;
  isDefault: boolean;
  // gitlab
  url: string;
  token: string;
  // k8s
  username: string;
  encrypt: string;
  context: string;
  namespace: string;
  ksUrl: string;
  // nacos (reuses url + username)
  password: string;
  // feishu
  appId: string;
  appSecret: string;
  useSharedCredentials: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /v1/connectors/profiles (create). */
export interface ConnectorProfileCreateRequest {
  vendor: ConnectorVendor;
  name: string;
  isDefault?: boolean;
  url?: string;
  token?: string;
  username?: string;
  encrypt?: string;
  context?: string;
  namespace?: string;
  ksUrl?: string;
  password?: string;
  appId?: string;
  appSecret?: string;
  useSharedCredentials?: boolean;
  expiresAt?: string;
}

/** Request body for PATCH /v1/connectors/profiles/:id (partial; `vendor` immutable). */
export type ConnectorProfileUpdateRequest = Partial<Omit<ConnectorProfileCreateRequest, "vendor">>;

export const PROJECT_TYPES = ["generic", "mr", "diagnose", "k8s"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** A project space binding local repo metadata to one profile per bindable vendor. */
export interface ProjectSpace {
  id: string;
  name: string;
  displayName: string;
  localRepoPath: string;
  projectType: ProjectType;
  branch: string;
  shipCommand: string;
  commitMsgFlag: string;
  /** Env vars as a JSON-object string. */
  envVars: string;
  /** Extra repo paths as a JSON-array string. */
  extraRepoPaths: string;
  systemPrompt: string;
  /** Space → profile bindings, keyed by bindable vendor. */
  bindings: Partial<Record<BindableVendor, string>>;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /v1/connectors/spaces (create). */
export interface ProjectSpaceCreateRequest {
  name: string;
  displayName?: string;
  localRepoPath?: string;
  projectType?: ProjectType;
  branch?: string;
  shipCommand?: string;
  commitMsgFlag?: string;
  envVars?: string;
  extraRepoPaths?: string;
  systemPrompt?: string;
  bindings?: Partial<Record<BindableVendor, string>>;
}

/** Request body for PATCH /v1/connectors/spaces/:id (partial update). */
export type ProjectSpaceUpdateRequest = Partial<ProjectSpaceCreateRequest>;

export const LINK_KINDS = ["gitlab_project", "k8s_workload", "feishu_chat", "feishu_bitable", "nacos_config"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Default `ref` JSON payload (as a string) per link kind. */
export const DEFAULT_LINK_REF: Readonly<Record<LinkKind, string>> = {
  gitlab_project: JSON.stringify({ projectId: "", path: "" }),
  k8s_workload: JSON.stringify({ context: "", namespace: "", workload: "", pipeline: "" }),
  feishu_chat: JSON.stringify({ chatId: "", chatName: "" }),
  feishu_bitable: JSON.stringify({ appToken: "", tableId: "" }),
  nacos_config: JSON.stringify({ dataId: "", group: "" }),
};

/** An external resource link belonging to a space. `ref` is a JSON-string payload. */
export interface ExternalLink {
  id: string;
  spaceId: string;
  kind: LinkKind;
  ref: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /v1/connectors/links (create). */
export interface ExternalLinkCreateRequest {
  spaceId: string;
  kind: LinkKind;
  ref?: string;
}

/** Request body for PATCH /v1/connectors/links/:id (partial update). */
export interface ExternalLinkUpdateRequest {
  kind?: LinkKind;
  ref?: string;
}

/** Event lifecycle statuses. */
export const EVENT_STATUSES = ["new", "seen", "actioned", "dismissed"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Filter value for listing events: a real status or `all` (filter-only). */
export const EVENT_STATUS_FILTERS = ["all", ...EVENT_STATUSES] as const;
export type EventStatusFilter = (typeof EVENT_STATUS_FILTERS)[number];

/** An activity-stream event. `payload` is a JSON string; UI extracts `.title`/`.message`. */
export interface ActivityEvent {
  id: string;
  spaceId: string;
  kind: string;
  source: string;
  type: string;
  payload: string;
  status: EventStatus;
  createdAt: string;
}

/** Request body for POST /v1/connectors/events (append). */
export interface ActivityEventCreateRequest {
  spaceId?: string;
  kind?: string;
  source?: string;
  type?: string;
  payload?: string;
  status?: EventStatus;
}

/**
 * Lightweight health-check ("检测") result from POST
 * /v1/connectors/profiles/:id/check. Validates required fields present + URL
 * well-formed only — NOT a real network probe (real connectivity is delegated
 * to the corresponding MCP).
 */
export interface HealthCheckResult {
  ok: boolean;
  missingFields: string[];
  message: string;
}

/** A vendor credential field spec (label + requiredness + secret flag). */
export interface VendorFieldSpec {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}

/**
 * Required credential fields per vendor, with the label used in the
 * health-check "缺少：…" message. De-branded (no URL presets). Mirrors the
 * backend `VENDOR_FIELD_SPECS`; the `name` field is included so a UI form can
 * render it uniformly.
 */
export const VENDOR_FIELD_SPECS: Readonly<Record<ConnectorVendor, readonly VendorFieldSpec[]>> = {
  gitlab: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "url", label: "URL", required: true, secret: false },
    { key: "token", label: "Token", required: true, secret: true },
  ],
  k8s: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "username", label: "用户名", required: true, secret: false },
    { key: "encrypt", label: "加密凭据", required: true, secret: true },
    { key: "context", label: "Context", required: true, secret: false },
    { key: "namespace", label: "Namespace", required: true, secret: false },
    { key: "ksUrl", label: "KubeSphere URL", required: false, secret: false },
  ],
  nacos: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "url", label: "URL", required: true, secret: false },
    { key: "username", label: "用户名", required: false, secret: false },
    { key: "password", label: "密码", required: false, secret: true },
  ],
  feishu: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "appId", label: "App ID", required: true, secret: false },
    { key: "appSecret", label: "App Secret", required: true, secret: true },
  ],
};

// ===========================================================================
// Connect phone (连接手机) — IM relay types. Mirrors backend/src/contracts/phone.ts.
// A pluggable IM-provider relay (feishu = the one reference bridge; custom =
// a loopback webhook provider). Provider credential secrets arrive MASKED
// (`MASKED_SECRET` sentinel); echo the sentinel back unchanged for untouched
// secret fields on update (the backend merge-masks). NO QR install flow:
// `supportsQrInstall` is always false — provider setup is the appId/appSecret
// (feishu) or verificationToken (custom) form only.
// ===========================================================================

/** Known IM provider kinds (from the catalog, never hardcoded WeChat/POPO/Lobster). */
export const PROVIDER_KINDS = ["feishu", "custom"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Transport a provider speaks: `bridge` = owned sidecar; `webhook` = loopback inbound. */
export type TransportKind = "bridge" | "webhook";

/** Secret credential field keys per provider kind (masked on read, merge-masked on write). */
export const SECRET_FIELDS_BY_PROVIDER_KIND: Readonly<Record<ProviderKind, readonly string[]>> = {
  feishu: ["appSecret"],
  custom: ["verificationToken", "encryptKey", "botToken"],
};

/** Flattened per-provider credentials. Secret fields come back masked. */
export interface ImCredentials {
  // feishu
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  // custom webhook provider
  verificationToken: string;
  encryptKey: string;
  botToken: string;
  baseUrl: string;
}

/** A configured IM provider instance. `kind` is immutable after creation. */
export interface ImProvider {
  id: string;
  kind: ProviderKind;
  displayName: string;
  transport: TransportKind;
  enabled: boolean;
  credentials: ImCredentials;
  /** Advisory transport lifecycle status (not user-set). */
  status: "idle" | "connecting" | "ready" | "error";
  statusMessage: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /v1/phone/providers (create). */
export interface ImProviderCreateRequest {
  kind: ProviderKind;
  displayName: string;
  transport?: TransportKind;
  enabled?: boolean;
  credentials?: Partial<ImCredentials>;
}

/** Request body for PATCH /v1/phone/providers/:id (partial; `kind` immutable). */
export interface ImProviderUpdateRequest {
  displayName?: string;
  transport?: TransportKind;
  enabled?: boolean;
  credentials?: Partial<ImCredentials>;
}

/** Whether a channel is a 1:1 (`p2p`) or a group/multi-user (`group`) chat. */
export const CHANNEL_KINDS = ["p2p", "group"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** An IM channel (a chat/group on a provider the relay watches). */
export interface ImChannel {
  id: string;
  providerId: string;
  /** Provider-native chat id (e.g. Feishu `oc_*`). */
  channelId: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Request body for POST /v1/phone/channels (create). */
export interface ImChannelCreateRequest {
  providerId: string;
  channelId: string;
  name?: string;
  kind?: ChannelKind;
  enabled?: boolean;
}

/** Request body for PATCH /v1/phone/channels/:id (partial update). */
export interface ImChannelUpdateRequest {
  name?: string;
  kind?: ChannelKind;
  enabled?: boolean;
}

/**
 * A binding from an agent thread to an IM channel. Observe-only (passive watch)
 * is `mirrorInbound: true, mirrorOutbound: false`. At most one per channel.
 */
export interface ThreadChannelBinding {
  id: string;
  threadId: string;
  channelId: string;
  providerId: string;
  label: string;
  mirrorInbound: boolean;
  mirrorOutbound: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Request body for PUT /v1/phone/bindings (upsert; idempotent on channelId). */
export interface ThreadChannelBindRequest {
  threadId: string;
  channelId: string;
  label?: string;
  mirrorInbound?: boolean;
  mirrorOutbound?: boolean;
}

/** A member of an IM channel, cached for the @-mention roster. */
export interface ImMember {
  id: string;
  channelId: string;
  name: string;
  /** Provider-native member id (e.g. Feishu `open_id`). */
  providerMemberId: string;
  avatar: string;
  updatedAt: string;
}

/** A per-kind capability/field descriptor (from the provider catalog). */
export interface ProviderFieldSpec {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}

export interface ProviderKindSpec {
  kind: ProviderKind;
  displayName: string;
  transport: TransportKind;
  /** QR device-code login is platform-coupled; never faked. Always false here. */
  supportsQrInstall: boolean;
  fields: ProviderFieldSpec[];
}

/** Connection-test ("检测") result: required-fields-present validation only. */
export interface PhoneConnectionTestResult {
  ok: boolean;
  missingFields: string[];
  message: string;
}

/** GET /v1/phone/status relay snapshot. */
export interface PhoneStatus {
  started: boolean;
  backgroundMode: boolean;
  webhook: { host: string; port: number } | null;
  liveTransports: number;
}

/** GET /v1/phone/webhook-status payload. */
export interface PhoneWebhookStatus {
  webhook: { host: string; port: number } | null;
}
