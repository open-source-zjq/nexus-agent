import type {
  Thread,
  ThreadSummary,
  Turn,
  RuntimeInfo,
  NexusConfig,
  UsageReport,
  DailyUsageReport,
  ModelUsageReport,
  ReviewResult,
  ReviewTarget,
  WorkspaceStatus,
  WorkspaceFileDiff,
  FileRetrieval,
  SkillInfo,
  SkillValidationError,
  MemoryRecord,
  MemoryCreateRequest,
  MemoryUpdateRequest,
  MemoryDiagnostics,
  LlmRound,
  McpStatus,
  ToolDiagnostics,
  ThreadGoal,
  DelegationDiagnostics,
  AgentDefinition,
  AgentCreateRequest,
  AgentUpdateRequest,
  Attachment,
  AttachmentUploadRequest,
  ScheduleTask,
  ScheduleCreateRequest,
  ScheduleUpdateRequest,
  ConnectorVendor,
  BindableVendor,
  ConnectorProfile,
  ConnectorProfileCreateRequest,
  ConnectorProfileUpdateRequest,
  ProjectSpace,
  ProjectSpaceCreateRequest,
  ProjectSpaceUpdateRequest,
  ExternalLink,
  ExternalLinkCreateRequest,
  ActivityEvent,
  ActivityEventCreateRequest,
  EventStatus,
  EventStatusFilter,
  HealthCheckResult,
  ProviderKind,
  ImProvider,
  ImProviderCreateRequest,
  ImProviderUpdateRequest,
  ImChannel,
  ImChannelCreateRequest,
  ImChannelUpdateRequest,
  ImMember,
  ThreadChannelBinding,
  ThreadChannelBindRequest,
  ProviderKindSpec,
  PhoneConnectionTestResult,
  PhoneStatus,
  PhoneWebhookStatus,
  VerifyPlanResult,
  DraftPlanResult,
  RefinePlanResult,
  BuildPlanResult,
  WriteWorkspaceFileResult,
} from "./types.js";

/** Outcome returned by POST /v1/threads/:id/review (result + metadata). */
export interface ReviewOutcome {
  id: string;
  title?: string;
  result: ReviewResult;
  createdAt: string;
  finishedAt?: string;
  reviewItemId?: string;
}

const TOKEN_KEY = "nexus.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const json = await response.json();
      detail = json.message ?? JSON.stringify(json);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new ApiError(response.status, detail || `request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const api = {
  health: () => request<{ status: string }>("GET", "/health"),
  runtimeInfo: () => request<RuntimeInfo>("GET", "/v1/runtime/info"),

  getConfig: () => request<NexusConfig>("GET", "/v1/config"),
  putConfig: (config: NexusConfig) => request<NexusConfig>("PUT", "/v1/config", config),

  listThreads: () => request<{ threads: ThreadSummary[] }>("GET", "/v1/threads"),
  createThread: (input: { title?: string; workspace?: string; model?: string; mode?: string; approvalPolicy?: string; sandboxMode?: string }) =>
    request<Thread>("POST", "/v1/threads", input),
  getThread: (id: string) => request<Thread>("GET", `/v1/threads/${id}`),
  updateThread: (id: string, patch: Record<string, unknown>) => request<Thread>("PATCH", `/v1/threads/${id}`, patch),
  // Summarize the opening exchange into a concise title (server-side, best-effort
  // and idempotent — only replaces a still-default "New thread" title).
  autoTitleThread: (id: string) => request<Thread>("POST", `/v1/threads/${id}/autotitle`, {}),
  deleteThread: (id: string) => request<{ deleted: boolean }>("DELETE", `/v1/threads/${id}`),

  startTurn: (
    threadId: string,
    input: {
      prompt: string;
      model?: string;
      mode?: string;
      reasoningEffort?: string;
      attachmentIds?: string[];
      // @-mentioned IM channel members (T2.8); folded into the turn context.
      atMembers?: Array<{ id: string; name?: string }>;
    },
  ) => request<{ threadId: string; turnId: string; userMessageItemId: string }>("POST", `/v1/threads/${threadId}/turns`, input),
  steerTurn: (threadId: string, turnId: string, text: string) =>
    request<{ ok: true }>("POST", `/v1/threads/${threadId}/turns/${turnId}/steer`, { text }),
  rewindTurn: (threadId: string, turnId: string, prompt: string) =>
    request<{ threadId: string; turnId: string; userMessageItemId: string }>("POST", `/v1/threads/${threadId}/rewind`, { turnId, prompt }),
  interruptTurn: (threadId: string, turnId: string, discard = false) =>
    request<{ status: string }>("POST", `/v1/threads/${threadId}/turns/${turnId}/interrupt`, { discard }),
  getTurn: (threadId: string, turnId: string) => request<Turn>("GET", `/v1/threads/${threadId}/turns/${turnId}`),
  compact: (threadId: string) => request<{ replacedTokens: number; summary: string }>("POST", `/v1/threads/${threadId}/compact`, {}),

  setTodos: (threadId: string, todos: Array<{ id?: string; content: string; status: string }>) =>
    request<{ todos: { items: unknown[] } }>("POST", `/v1/threads/${threadId}/todos`, { todos }),
  clearTodos: (threadId: string) => request<{ cleared: boolean }>("DELETE", `/v1/threads/${threadId}/todos`),

  decideApproval: (approvalId: string, decision: "allow" | "deny") =>
    request<{ decision: string }>("POST", `/v1/approvals/${approvalId}`, { decision }),
  resolveUserInput: (inputId: string, input: { status: "submitted" | "cancelled"; answers?: Record<string, string>; text?: string }) =>
    request<{ status: string }>("POST", `/v1/user-inputs/${inputId}`, input),

  usage: () => request<UsageReport>("GET", "/v1/usage"),
  usageReport: (opts?: { groupBy?: string; range?: string; tz?: string }) => {
    const params = new URLSearchParams();
    if (opts?.groupBy) params.set("group_by", opts.groupBy);
    if (opts?.range) params.set("range", opts.range);
    if (opts?.tz) params.set("tz", opts.tz);
    const query = params.toString();
    return request<UsageReport>("GET", query ? `/v1/usage?${query}` : "/v1/usage");
  },
  /**
   * Day-grouped usage for the calendar heatmap. The runtime requires a `window`
   * (today/week/month/all) or an explicit from/to, plus an IANA `timezone`.
   */
  usageDaily: (opts?: { window?: string; tz?: string }) => {
    const params = new URLSearchParams();
    params.set("group_by", "day");
    params.set("window", opts?.window ?? "month");
    if (opts?.tz) params.set("timezone", opts.tz);
    return request<DailyUsageReport>("GET", `/v1/usage?${params.toString()}`);
  },
  /** Token usage grouped by model over an explicit [from, to] window (≤370 days). */
  usageByModel: (opts: { from: string; to: string; tz?: string }) => {
    const params = new URLSearchParams();
    params.set("group_by", "model");
    params.set("from", opts.from);
    params.set("to", opts.to);
    if (opts.tz) params.set("timezone", opts.tz);
    return request<ModelUsageReport>("GET", `/v1/usage?${params.toString()}`);
  },

  // --- review ---------------------------------------------------------------
  runReview: (threadId: string, target?: ReviewTarget) =>
    request<ReviewOutcome>("POST", `/v1/threads/${threadId}/review`, target ? { target } : {}),

  // --- workspace ------------------------------------------------------------
  workspaceStatus: (workspace?: string) =>
    request<WorkspaceStatus>("GET", workspace ? `/v1/workspace/status?path=${encodeURIComponent(workspace)}` : "/v1/workspace/status"),
  workspaceDiff: (file: string, workspace?: string) => {
    const params = new URLSearchParams({ file });
    if (workspace) params.set("path", workspace);
    return request<WorkspaceFileDiff>("GET", `/v1/workspace/diff?${params.toString()}`);
  },
  retrieveFile: (path: string, workspace?: string) => {
    const params = new URLSearchParams({ path });
    if (workspace) params.set("workspace", workspace);
    return request<FileRetrieval>("GET", `/v1/files/retrieve?${params.toString()}`);
  },
  listWorkspaceFiles: (workspace?: string) =>
    request<{ files: string[] }>("GET", workspace ? `/v1/workspace/files?workspace=${encodeURIComponent(workspace)}` : "/v1/workspace/files"),
  writeWorkspaceFile: (body: { workspace?: string; path: string; content: string }) =>
    request<WriteWorkspaceFileResult>("POST", "/v1/files/write", body),

  // --- SDD plan (`/v1/plan/*`, T3.3) ----------------------------------------
  // verify is a pure local spec-coverage report; draft/refine/replan are
  // model-backed (503 when no model is configured); build is a pure todo
  // extraction over the plan checklist.
  verifyPlan: (body: {
    specMarkdown: string;
    planMarkdown?: string;
    planRelativePath?: string;
    threadTodos?: { items: Array<{ content: string; status: string; source?: unknown }> };
  }) => request<VerifyPlanResult>("POST", "/v1/plan/verify", body),
  draftPlan: (body: {
    spec: string;
    featureName?: string;
    existingPaths?: string[];
    workspaceRoot?: string;
    planRelativePath?: string;
    assistantContext?: string;
    model?: string;
  }) => request<DraftPlanResult>("POST", "/v1/plan/draft", body),
  refinePlan: (body: { planMarkdown: string; instruction: string; spec?: string; planRelativePath?: string; model?: string }) =>
    request<RefinePlanResult>("POST", "/v1/plan/refine", body),
  replanPlan: (body: { planMarkdown: string; spec: string; changedIds?: string[]; planRelativePath?: string; model?: string }) =>
    request<RefinePlanResult>("POST", "/v1/plan/replan", body),
  buildPlan: (body: { planMarkdown: string; threadId?: string; planRelativePath?: string; planId?: string }) =>
    request<BuildPlanResult>("POST", "/v1/plan/build", body),

  // --- attachments ----------------------------------------------------------
  uploadAttachment: (body: AttachmentUploadRequest) =>
    request<{ attachment: Attachment }>("POST", "/v1/attachments", body),

  // --- scheduled tasks ------------------------------------------------------
  listSchedule: () => request<{ tasks: ScheduleTask[] }>("GET", "/v1/schedule"),
  createSchedule: (body: ScheduleCreateRequest) => request<{ task: ScheduleTask }>("POST", "/v1/schedule", body),
  updateSchedule: (id: string, patch: ScheduleUpdateRequest) =>
    request<{ task: ScheduleTask }>("PATCH", `/v1/schedule/${id}`, patch),
  deleteSchedule: (id: string) => request<{ deleted: boolean }>("DELETE", `/v1/schedule/${id}`),
  runSchedule: (id: string) => request<{ task: ScheduleTask }>("POST", `/v1/schedule/${id}/run`, {}),

  // --- skills ---------------------------------------------------------------
  listSkills: () =>
    request<{ enabled: boolean; roots: string[]; skills: SkillInfo[]; validationErrors: SkillValidationError[] }>("GET", "/v1/skills"),

  // --- memory ---------------------------------------------------------------
  listMemory: (query?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (limit !== undefined) params.set("limit", String(limit));
    const q = params.toString();
    return request<{ memories: MemoryRecord[] }>("GET", q ? `/v1/memory?${q}` : "/v1/memory");
  },
  createMemory: (body: MemoryCreateRequest) => request<MemoryRecord>("POST", "/v1/memory", body),
  updateMemory: (id: string, patch: MemoryUpdateRequest) => request<MemoryRecord>("PATCH", `/v1/memory/${id}`, patch),
  deleteMemory: (id: string) => request<MemoryRecord>("DELETE", `/v1/memory/${id}`),
  memoryDiagnostics: () => request<MemoryDiagnostics>("GET", "/v1/memory/diagnostics"),

  // --- debug: llm rounds ----------------------------------------------------
  llmRounds: (threadId?: string) =>
    request<{ rounds: LlmRound[] }>("GET", threadId ? `/v1/debug/llm-rounds?threadId=${encodeURIComponent(threadId)}` : "/v1/debug/llm-rounds"),

  // --- mcp + tools ----------------------------------------------------------
  mcpStatus: () => request<McpStatus>("GET", "/v1/mcp"),
  toolDiagnostics: () => request<ToolDiagnostics>("GET", "/v1/runtime/tools"),

  // --- delegation (sub-agents) ----------------------------------------------
  delegationDiagnostics: (threadId?: string) =>
    request<DelegationDiagnostics>(
      "GET",
      threadId ? `/v1/delegation/diagnostics?threadId=${encodeURIComponent(threadId)}` : "/v1/delegation/diagnostics",
    ),

  // --- goal -----------------------------------------------------------------
  getGoal: (threadId: string) => request<{ goal: ThreadGoal | null }>("GET", `/v1/threads/${threadId}/goal`),
  setGoal: (threadId: string, goal: { objective?: string; status?: string; tokenBudget?: number | null }) =>
    request<{ goal: ThreadGoal }>("POST", `/v1/threads/${threadId}/goal`, goal),
  clearGoal: (threadId: string) => request<{ cleared: boolean }>("DELETE", `/v1/threads/${threadId}/goal`),

  // --- fork -----------------------------------------------------------------
  forkThread: (threadId: string, title?: string) =>
    request<Thread>("POST", `/v1/threads/${threadId}/fork`, title ? { title } : {}),

  // --- agents (智能体目录) ---------------------------------------------------
  listAgents: () => request<{ agents: AgentDefinition[] }>("GET", "/v1/agents"),
  createAgent: (body: AgentCreateRequest) => request<{ agent: AgentDefinition }>("POST", "/v1/agents", body),
  updateAgent: (id: string, patch: AgentUpdateRequest) => request<{ agent: AgentDefinition }>("PATCH", `/v1/agents/${id}`, patch),
  deleteAgent: (id: string) => request<{ agent: AgentDefinition }>("DELETE", `/v1/agents/${id}`),

  // --- connectors (连接中心 / ConnectorHub) ---------------------------------
  // All 18 /v1/connectors/* routes. Secret fields in a returned profile come
  // back MASKED (`MASKED_SECRET`); send the sentinel back unchanged on update to
  // preserve the stored secret. The "check" route is a lightweight field
  // validation, NOT a network probe.

  // profiles (credential sets, one default per vendor) ---------------------
  listConnectorProfiles: (vendor?: ConnectorVendor) =>
    request<{ profiles: ConnectorProfile[] }>(
      "GET",
      vendor ? `/v1/connectors/profiles?vendor=${encodeURIComponent(vendor)}` : "/v1/connectors/profiles",
    ),
  createConnectorProfile: (body: ConnectorProfileCreateRequest) =>
    request<{ profile: ConnectorProfile }>("POST", "/v1/connectors/profiles", body),
  updateConnectorProfile: (id: string, patch: ConnectorProfileUpdateRequest) =>
    request<{ profile: ConnectorProfile }>("PATCH", `/v1/connectors/profiles/${id}`, patch),
  deleteConnectorProfile: (id: string) =>
    request<{ profile: ConnectorProfile }>("DELETE", `/v1/connectors/profiles/${id}`),
  setDefaultConnectorProfile: (id: string) =>
    request<{ profile: ConnectorProfile }>("POST", `/v1/connectors/profiles/${id}/default`, {}),
  checkConnectorProfile: (id: string) =>
    request<HealthCheckResult>("POST", `/v1/connectors/profiles/${id}/check`, {}),

  // spaces (project spaces, bind one profile per bindable vendor) -----------
  listConnectorSpaces: () => request<{ spaces: ProjectSpace[] }>("GET", "/v1/connectors/spaces"),
  createConnectorSpace: (body: ProjectSpaceCreateRequest) =>
    request<{ space: ProjectSpace }>("POST", "/v1/connectors/spaces", body),
  updateConnectorSpace: (id: string, patch: ProjectSpaceUpdateRequest) =>
    request<{ space: ProjectSpace }>("PATCH", `/v1/connectors/spaces/${id}`, patch),
  deleteConnectorSpace: (id: string) =>
    request<{ space: ProjectSpace }>("DELETE", `/v1/connectors/spaces/${id}`),
  bindConnectorProfile: (spaceId: string, vendor: BindableVendor, profileId: string) =>
    request<{ space: ProjectSpace }>("POST", `/v1/connectors/spaces/${spaceId}/bind`, { vendor, profileId }),
  unbindConnectorProfile: (spaceId: string, vendor: BindableVendor) =>
    request<{ space: ProjectSpace }>("DELETE", `/v1/connectors/spaces/${spaceId}/bindings/${vendor}`),

  // links (per-space external resource references) -------------------------
  listConnectorLinks: (spaceId?: string) =>
    request<{ links: ExternalLink[] }>(
      "GET",
      spaceId ? `/v1/connectors/links?spaceId=${encodeURIComponent(spaceId)}` : "/v1/connectors/links",
    ),
  createConnectorLink: (body: ExternalLinkCreateRequest) =>
    request<{ link: ExternalLink }>("POST", "/v1/connectors/links", body),
  deleteConnectorLink: (id: string) =>
    request<{ link: ExternalLink }>("DELETE", `/v1/connectors/links/${id}`),

  // events (append-only activity stream per space) -------------------------
  listConnectorEvents: (opts?: { spaceId?: string; status?: EventStatusFilter }) => {
    const params = new URLSearchParams();
    if (opts?.spaceId) params.set("spaceId", opts.spaceId);
    if (opts?.status) params.set("status", opts.status);
    const query = params.toString();
    return request<{ events: ActivityEvent[] }>("GET", query ? `/v1/connectors/events?${query}` : "/v1/connectors/events");
  },
  createConnectorEvent: (body: ActivityEventCreateRequest) =>
    request<{ event: ActivityEvent }>("POST", "/v1/connectors/events", body),
  setConnectorEventStatus: (id: string, status: EventStatus) =>
    request<{ event: ActivityEvent }>("PATCH", `/v1/connectors/events/${id}/status`, { status }),

  // --- connect phone (连接手机 / IM relay) -----------------------------------
  // The /v1/phone/* IM relay. Provider credential secrets come back MASKED
  // (`MASKED_SECRET`); echo the sentinel back unchanged for untouched secret
  // fields on update (the backend merge-masks). Every route 503s with "connect
  // phone relay is unavailable" when the relay isn't running — callers surface
  // that. The QR install flow is intentionally absent (supportsQrInstall=false).

  // catalog + relay status -------------------------------------------------
  phoneCatalog: () =>
    request<{ kinds: ProviderKind[]; specs: ProviderKindSpec[] }>("GET", "/v1/phone/providers/catalog"),
  phoneStatus: () => request<PhoneStatus>("GET", "/v1/phone/status"),
  phoneWebhookStatus: () => request<PhoneWebhookStatus>("GET", "/v1/phone/webhook-status"),
  setPhoneBackgroundMode: (enabled: boolean) =>
    request<PhoneStatus>("POST", "/v1/phone/background-mode", { enabled }),

  // providers --------------------------------------------------------------
  listPhoneProviders: (kind?: ProviderKind) =>
    request<{ providers: ImProvider[] }>(
      "GET",
      kind ? `/v1/phone/providers?kind=${encodeURIComponent(kind)}` : "/v1/phone/providers",
    ),
  getPhoneProvider: (id: string) => request<{ provider: ImProvider }>("GET", `/v1/phone/providers/${id}`),
  createPhoneProvider: (body: ImProviderCreateRequest) =>
    request<{ provider: ImProvider }>("POST", "/v1/phone/providers", body),
  updatePhoneProvider: (id: string, patch: ImProviderUpdateRequest) =>
    request<{ provider: ImProvider }>("PATCH", `/v1/phone/providers/${id}`, patch),
  deletePhoneProvider: (id: string) => request<{ provider: ImProvider }>("DELETE", `/v1/phone/providers/${id}`),
  testPhoneProvider: (id: string) =>
    request<PhoneConnectionTestResult>("POST", `/v1/phone/providers/${id}/test`, {}),
  connectPhoneProvider: (id: string) =>
    request<{ provider: ImProvider }>("POST", `/v1/phone/providers/${id}/connect`, {}),
  disconnectPhoneProvider: (id: string) =>
    request<{ provider: ImProvider }>("POST", `/v1/phone/providers/${id}/disconnect`, {}),

  // channels ---------------------------------------------------------------
  listPhoneChannels: (providerId?: string) =>
    request<{ channels: ImChannel[] }>(
      "GET",
      providerId ? `/v1/phone/channels?providerId=${encodeURIComponent(providerId)}` : "/v1/phone/channels",
    ),
  getPhoneChannel: (id: string) => request<{ channel: ImChannel }>("GET", `/v1/phone/channels/${id}`),
  createPhoneChannel: (body: ImChannelCreateRequest) =>
    request<{ channel: ImChannel }>("POST", "/v1/phone/channels", body),
  updatePhoneChannel: (id: string, patch: ImChannelUpdateRequest) =>
    request<{ channel: ImChannel }>("PATCH", `/v1/phone/channels/${id}`, patch),
  deletePhoneChannel: (id: string) => request<{ channel: ImChannel }>("DELETE", `/v1/phone/channels/${id}`),

  // members (@-mention roster) ---------------------------------------------
  listPhoneMembers: (channelId: string) =>
    request<{ members: ImMember[] }>("GET", `/v1/phone/channels/${channelId}/members`),
  refreshPhoneMembers: (channelId: string, pageSize?: number) =>
    request<{ members: ImMember[] }>(
      "POST",
      `/v1/phone/channels/${channelId}/members/refresh`,
      pageSize !== undefined ? { pageSize } : {},
    ),

  // bindings ---------------------------------------------------------------
  listPhoneBindings: (opts?: { channelId?: string; threadId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.channelId) params.set("channelId", opts.channelId);
    if (opts?.threadId) params.set("threadId", opts.threadId);
    const query = params.toString();
    return request<{ bindings: ThreadChannelBinding[] }>("GET", query ? `/v1/phone/bindings?${query}` : "/v1/phone/bindings");
  },
  bindPhoneChannel: (body: ThreadChannelBindRequest) =>
    request<{ binding: ThreadChannelBinding }>("PUT", "/v1/phone/bindings", body),
  unbindPhoneChannel: (channelId: string) =>
    request<{ binding: ThreadChannelBinding }>("DELETE", `/v1/phone/bindings/${encodeURIComponent(channelId)}`),

  // --- speech-to-text (语音转写, T2.7 / T10.4) -------------------------------
  // POSTs base64 audio to the OpenAI-compatible STT route. STT is OFF by
  // default, so the route answers 503 (capability_unavailable) when the service
  // is absent / disabled / unconfigured — callers must handle that gracefully.
  transcribeAudio: (body: { audioBase64: string; mimeType: string; language?: string }) =>
    request<{ text: string }>("POST", "/v1/audio/transcribe", body),
};
