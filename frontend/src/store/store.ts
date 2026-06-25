import { create } from "zustand";
import { api } from "../api/client.js";
import { subscribeThreadEvents, type EventStreamHandle } from "../api/events.js";
import { shouldNotifyOnReplyComplete } from "./preferences.js";
import { isTauri, showTurnCompleteNotification } from "../lib/tauri.js";
import type {
  Thread,
  ThreadSummary,
  TurnItem,
  RuntimeEvent,
  RuntimeInfo,
  ModelInfo,
  NexusConfig,
  UsageReport,
  Suggestion,
  InsightDecision,
  ReviewResult,
  ReviewTarget,
  WorkspaceStatus,
  SkillInfo,
  SkillValidationError,
  AgentDefinition,
  MemoryRecord,
  McpStatus,
  ThreadTodoItem,
  DelegationDiagnostics,
} from "../api/types.js";

type Connection = "connecting" | "open" | "closed";
type RightPanel = "todos" | "activity" | "memory" | "skills" | "mcp" | "review";

/** A bounded, newest-first ring of recent runtime activity for the side panel. */
export interface ActivityEntry {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  at: string;
}

const ACTIVITY_MAX = 50;

interface AppState {
  threads: ThreadSummary[];
  currentThreadId: string | null;
  /**
   * Workspace the next lazily-created thread will belong to. Set by newThread()
   * from the active project so "New Agent" keeps the fresh thread in the project
   * the user is in, instead of always falling back to the runtime default (which
   * groups every new thread under the same first project).
   */
  pendingWorkspace: string | null;
  thread: Thread | null;
  items: TurnItem[];
  runtimeInfo: RuntimeInfo | null;
  config: NexusConfig | null;
  usage: UsageReport | null;
  connection: Connection;
  activeTurnId: string | null;
  running: boolean;
  banner: string | null;
  composerModel: string;
  composerMode: "agent" | "plan";
  reasoningEffort: string;

  // restored backend surface
  // Proactive insights — per-thread suggestion buckets + toast queue + dedupe,
  // faithful to the original Nexus insight-center store model.
  suggestionsByThread: Record<string, Suggestion[]>;
  dismissedTopicsByThread: Record<string, string[]>;
  insightToasts: string[];
  activeInsightId: string | null;
  insightDecisions: InsightDecision[];
  activity: ActivityEntry[];
  reviewResult: ReviewResult | null;
  reviewRunning: boolean;
  workspaceStatus: WorkspaceStatus | null;
  skills: SkillInfo[];
  /** Live skill discovery roots + validation errors from GET /v1/skills (T4.6). */
  skillsRoots: string[];
  skillsValidationErrors: SkillValidationError[];
  skillsEnabled: boolean;
  agents: AgentDefinition[];
  memory: MemoryRecord[];
  mcp: McpStatus | null;
  delegation: DelegationDiagnostics | null;
  rightPanel: RightPanel;
  /** Thread ids that finished in the background and haven't been opened since. */
  unread: Record<string, boolean>;
  /** Open workspace-file preview overlay (null = closed). */
  filePreview: { path: string; line?: number } | null;
  /** Messages typed while a turn was running, flushed one-per-turn on completion. */
  queuedMessages: string[];
  /**
   * Side conversation (并排分叉副线程, T3.2): a fork of the current thread shown
   * BESIDE the main chat without replacing it. `sidePanel.threadId` is the
   * forked thread; `sideThread`/`sideItems` hold its live snapshot, fed by a
   * second SSE subscription concurrent with the main stream.
   */
  sidePanel: { open: boolean; threadId: string | null };
  sideThread: Thread | null;
  sideItems: TurnItem[];

  init(): Promise<void>;
  refreshThreads(): Promise<void>;
  selectThread(id: string | null): Promise<void>;
  newThread(): void;
  newProject(workspace: string): Promise<void>;
  sendMessage(
    text: string,
    attachmentIds?: string[],
    atMembers?: Array<{ id: string; name?: string }>,
  ): Promise<void>;
  interrupt(): Promise<void>;
  approve(approvalId: string, decision: "allow" | "deny"): Promise<void>;
  submitUserInput(inputId: string, answers: Record<string, string>, text?: string): Promise<void>;
  cancelUserInput(inputId: string): Promise<void>;
  saveConfig(config: NexusConfig): Promise<boolean>;
  setComposerModel(model: string): void;
  setComposerMode(mode: "agent" | "plan"): void;
  setReasoningEffort(effort: string): void;
  setBanner(message: string | null): void;
  applyEvent(event: RuntimeEvent): void;
  refreshUsage(): Promise<void>;

  // restored backend surface actions
  runReview(target?: ReviewTarget): Promise<void>;
  /** Dismiss a suggestion AND remember its detector:topic so it never re-appears. */
  dismissSuggestion(threadId: string, suggestionId: string): void;
  /** Hide just the floating toast for a suggestion (keeps it in the list). */
  dismissInsightToast(suggestionId: string): void;
  /** Open a suggestion's detail editor (and clear its toast). */
  openInsight(suggestionId: string): void;
  closeInsight(): void;
  /** Drop a whole thread's suggestion bucket + its toasts. */
  clearSuggestions(threadId: string): void;
  loadWorkspaceStatus(): Promise<void>;
  loadSkills(): Promise<void>;
  loadAgents(): Promise<void>;
  loadMemory(query?: string, limit?: number): Promise<void>;
  loadMcp(): Promise<void>;
  loadDelegation(): Promise<void>;
  setGoal(goal: { objective?: string; status?: string; tokenBudget?: number | null }): Promise<void>;
  clearGoal(): Promise<void>;
  editTodos(todos: Array<{ id?: string; content: string; status: string }>): Promise<void>;
  clearTodos(): Promise<void>;
  forkThread(title?: string): Promise<void>;
  /** Fork the current thread into a SIDE thread shown beside the main chat. */
  forkToSide(): Promise<void>;
  /** Close the side panel and clear its thread/items + stream. */
  closeSidePanel(): void;
  /** Open the side thread as the main thread, then close the side panel. */
  promoteSideToMain(): Promise<void>;
  /** Reload the side thread snapshot (manual refresh fallback). */
  refreshSidePanel(): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  /**
   * If the current thread still has the default "New thread" title, ask the
   * runtime to summarize its opening exchange into a title. Best-effort, runs
   * once per thread per session; the resulting `thread_updated` keeps every view
   * in sync. Called after the first turn completes.
   */
  maybeAutoTitle(): Promise<void>;
  archiveThread(id: string): Promise<void>;
  compactThread(id: string): Promise<void>;
  removeThread(id: string): Promise<void>;
  setRightPanel(panel: RightPanel): void;
  /** Poll thread summaries (background) to detect non-active threads finishing. */
  pollThreads(): Promise<void>;
  markThreadRead(id: string): void;
  openFilePreview(path: string, line?: number): void;
  closeFilePreview(): void;
  removeQueuedMessage(index: number): void;
  /** Edit a past user message and resend from that point (truncates later turns). */
  rewindAndResend(turnId: string, prompt: string): Promise<void>;
}

let streamHandle: EventStreamHandle | null = null;
/** Second SSE subscription for the side conversation, independent of the main one. */
let sideStreamHandle: EventStreamHandle | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Last seen status per thread, used to detect running→idle transitions. */
const threadStatuses = new Map<string, string>();
/** Threads we've already attempted to auto-title this session (dedupe guard). */
const autoTitledThreads = new Set<string>();

/** Best-effort desktop notification (no-op without permission/support). */
function notify(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission();
    }
  } catch {
    /* ignore */
  }
}

function flattenItems(thread: Thread): TurnItem[] {
  return thread.turns.flatMap((turn) => turn.items);
}

/**
 * Minimal event applier for the SIDE conversation's own SSE stream (T3.2). It
 * mirrors the item upsert/goal/todo handling of the main `applyEvent` but writes
 * to `sideItems`/`sideThread` so the side panel streams concurrently with the
 * main chat, without disturbing the main timeline.
 */
function applySideEvent(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  event: RuntimeEvent,
): void {
  const state = get();
  switch (event.kind) {
    case "item_created":
    case "item_updated":
    case "item_completed":
    case "assistant_text_delta":
    case "assistant_reasoning_delta":
    case "tool_call_started":
    case "tool_call_finished": {
      if (!event.item) break;
      const item = event.item;
      const index = state.sideItems.findIndex((existing) => existing.id === item.id);
      const items = state.sideItems.slice();
      if (index === -1) items.push(item);
      else items[index] = item;
      set({ sideItems: items });
      break;
    }
    case "goal_updated":
      if (state.sideThread) set({ sideThread: { ...state.sideThread, goal: event.goal ?? undefined } });
      break;
    case "goal_cleared":
      if (state.sideThread) set({ sideThread: { ...state.sideThread, goal: undefined } });
      break;
    case "todos_updated":
      if (state.sideThread) set({ sideThread: { ...state.sideThread, todos: event.todos ?? undefined } });
      break;
    case "todos_cleared":
      if (state.sideThread) set({ sideThread: { ...state.sideThread, todos: undefined } });
      break;
    default:
      break;
  }
}

/** Prepend a compact diagnostic entry onto the bounded, newest-first ring. */
function pushActivity(
  set: (partial: Partial<AppState>) => void,
  state: AppState,
  event: RuntimeEvent,
  kind: string,
  label: string,
  detail?: string,
): void {
  const entry: ActivityEntry = {
    id: `act_${event.seq}_${kind}`,
    kind,
    label,
    detail: detail || undefined,
    at: event.timestamp,
  };
  set({ activity: [entry, ...state.activity].slice(0, ACTIVITY_MAX) });
}

/** Show a transient banner that auto-clears after `ms` (unless replaced meanwhile). */
function flashBanner(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  message: string,
  ms = 3000,
): void {
  set({ banner: message });
  setTimeout(() => {
    if (get().banner === message) set({ banner: null });
  }, ms);
}

/**
 * Derive the UI's runtime view-model (models, default model/workspace/policies,
 * which providers have API keys) from GET /v1/config.
 *
 * The backend's GET /v1/runtime/info is intentionally faithful to the original
 * Nexus shape ({ host, port, capabilities, ... }) and does NOT carry these
 * fields, so the UI reads them from the config instead — keeping the frontend a
 * correct client of the faithful backend.
 */
export function deriveRuntimeInfo(config: NexusConfig): RuntimeInfo {
  const providersConfigured: Record<string, boolean> = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([key, provider]) => [key, Boolean(provider?.apiKey)]),
  );
  const models: ModelInfo[] = (config.models ?? []).map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
    provider: model.provider,
    supportsImages: model.supportsImages,
    reasoning: false,
    configured: Boolean(config.providers?.[model.provider]?.apiKey),
  }));
  return {
    models,
    defaultModel: config.defaultModel ?? config.models?.[0]?.id ?? "",
    defaultWorkspace: config.defaultWorkspace ?? "",
    defaultApprovalPolicy: config.approvalPolicy,
    defaultSandboxMode: config.sandboxMode,
    providersConfigured,
  };
}

/**
 * Adapt the backend's GET /v1/usage response into the UI's flat UsageReport.
 *
 * The backend is faithful to the original Nexus shape — the default (runtime)
 * view returns `{ total: UsageSnapshot, perThread: [...] }` where the snapshot
 * counts `turns` (not `requests`). Map `total` onto the flat view-model the
 * panel renders, defensively tolerating a already-flat payload too.
 *
 * `total` is the process-lifetime aggregate, which is empty right after a
 * restart even though each thread's usage was restored from its persisted
 * snapshot (`seedThread` reseeds the per-thread accumulators but not the
 * global one). When that happens the headline cards would read 0 next to a
 * fully-populated Activity graph — so fall back to summing `perThread`, which
 * always reflects the real current cross-thread total.
 */
export function toUsageReport(raw: unknown): UsageReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  const total = (r.total ?? r) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  let promptTokens = num(total.promptTokens);
  let completionTokens = num(total.completionTokens);
  let totalTokens = num(total.totalTokens);
  let cacheReadTokens = num(total.cacheReadTokens);
  let costUsd = typeof total.costUsd === "number" ? total.costUsd : null;
  let requests = num(total.requests ?? total.turns);

  if (totalTokens === 0 && Array.isArray(r.perThread)) {
    for (const entry of r.perThread as Array<{ usage?: Record<string, unknown> }>) {
      const u = entry?.usage ?? {};
      promptTokens += num(u.promptTokens);
      completionTokens += num(u.completionTokens);
      totalTokens += num(u.totalTokens);
      cacheReadTokens += num(u.cacheReadTokens);
      requests += num(u.requests ?? u.turns);
      if (typeof u.costUsd === "number") costUsd = (costUsd ?? 0) + u.costUsd;
    }
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    costUsd,
    requests,
    byModel: (total.byModel as UsageReport["byModel"]) ?? {},
  };
}

export const useStore = create<AppState>((set, get) => ({
  threads: [],
  currentThreadId: null,
  pendingWorkspace: null,
  thread: null,
  items: [],
  runtimeInfo: null,
  config: null,
  usage: null,
  connection: "closed",
  activeTurnId: null,
  running: false,
  banner: null,
  composerModel: "",
  composerMode: "agent",
  reasoningEffort: "auto",
  suggestionsByThread: {},
  dismissedTopicsByThread: {},
  insightToasts: [],
  activeInsightId: null,
  insightDecisions: [],
  activity: [],
  reviewResult: null,
  reviewRunning: false,
  workspaceStatus: null,
  skills: [],
  skillsRoots: [],
  skillsValidationErrors: [],
  skillsEnabled: false,
  agents: [],
  memory: [],
  mcp: null,
  delegation: null,
  rightPanel: "todos",
  unread: {},
  filePreview: null,
  queuedMessages: [],
  sidePanel: { open: false, threadId: null },
  sideThread: null,
  sideItems: [],

  async init() {
    try {
      const config = await api.getConfig();
      const runtimeInfo = deriveRuntimeInfo(config);
      set({ runtimeInfo, config, composerModel: runtimeInfo.defaultModel });
    } catch (error) {
      set({ banner: `Could not reach the runtime: ${(error as Error).message}` });
    }
    // Read-only catalogs the composer slash overlay needs; tolerate failure.
    void get().loadSkills();
    void get().loadAgents();
    await get().refreshThreads();
    // Background poll: detect non-active threads finishing (independent of SSE).
    if (!pollTimer) pollTimer = setInterval(() => void get().pollThreads(), 2500);
  },

  async refreshThreads() {
    try {
      const { threads } = await api.listThreads();
      set({ threads });
    } catch {
      /* ignore */
    }
  },

  async selectThread(id) {
    streamHandle?.close();
    streamHandle = null;
    if (!id) {
      set({
        currentThreadId: null,
        pendingWorkspace: null,
        thread: null,
        items: [],
        running: false,
        activeTurnId: null,
        connection: "closed",
        activity: [],
        reviewResult: null,
        workspaceStatus: null,
      });
      return;
    }
    get().markThreadRead(id);
    try {
      const thread = await api.getThread(id);
      const running = thread.status === "running";
      const activeTurn = thread.turns.find((turn) => turn.status === "running" || turn.status === "queued");
      set({
        currentThreadId: id,
        pendingWorkspace: null,
        thread,
        items: flattenItems(thread),
        running,
        activeTurnId: activeTurn?.id ?? null,
        composerModel: thread.model || get().composerModel,
        composerMode: thread.mode,
        activity: [],
        reviewResult: null,
        workspaceStatus: null,
      });
      streamHandle = subscribeThreadEvents(
        id,
        thread.latestSeq ?? 0,
        (event) => get().applyEvent(event),
        (status) => set({ connection: status }),
      );
      void get().loadWorkspaceStatus();
    } catch (error) {
      set({ banner: `Could not open thread: ${(error as Error).message}` });
    }
  },

  newThread() {
    // Keep the new (still-unsaved) thread in the project the user is currently
    // in — sendMessage()'s lazy create reads pendingWorkspace. Falls back to the
    // runtime default only when no thread is open.
    const pendingWorkspace = get().thread?.workspace ?? null;
    streamHandle?.close();
    streamHandle = null;
    set({ currentThreadId: null, thread: null, items: [], running: false, activeTurnId: null, connection: "closed", pendingWorkspace });
  },

  /**
   * Create a new project: a fresh thread rooted at an explicit workspace path.
   * Blank → the runtime fills it from its default (process.cwd()). The new
   * thread is created eagerly (so the project folder appears immediately) and
   * selected. The web shell has no native folder picker (that needs the Tauri
   * host), so the workspace is an absolute path the user types/pastes.
   */
  async newProject(workspace) {
    const state = get();
    try {
      const thread = await api.createThread({
        workspace: workspace.trim() || undefined,
        model: state.composerModel || state.runtimeInfo?.defaultModel || undefined,
        mode: state.composerMode,
      });
      await get().refreshThreads();
      await get().selectThread(thread.id);
    } catch (error) {
      set({ banner: `Create project failed: ${(error as Error).message}` });
    }
  },

  async sendMessage(text, attachmentIds, atMembers) {
    const trimmed = text.trim();
    const ids = attachmentIds ?? [];
    // @-mentioned IM channel members (T2.8); folded into the turn context.
    const mentions = (atMembers ?? []).filter((m) => m.id.trim());
    // Allow an attachment-only message (no text) — but never an empty send.
    if (!trimmed && ids.length === 0) return;
    const state = get();

    // While a turn is running, queue the message (a pill the user can remove);
    // it is flushed one-per-turn when the active turn completes.
    if (state.running && state.currentThreadId && state.activeTurnId) {
      if (!trimmed) return;
      set({ queuedMessages: [...state.queuedMessages, trimmed] });
      return;
    }

    let threadId = state.currentThreadId;
    try {
      if (!threadId) {
        const thread = await api.createThread({
          // Prefer the project the user is in (pendingWorkspace, set by
          // newThread) so a fresh thread lands in the active project rather than
          // always the runtime default. Send undefined (never "") for unset
          // defaults so the runtime fills them itself (workspace → process.cwd()).
          workspace: state.pendingWorkspace || state.runtimeInfo?.defaultWorkspace || undefined,
          model: state.composerModel || state.runtimeInfo?.defaultModel || undefined,
          mode: state.composerMode,
        });
        threadId = thread.id;
        set({ currentThreadId: thread.id, thread, items: [], pendingWorkspace: null });
        streamHandle?.close();
        streamHandle = subscribeThreadEvents(thread.id, 0, (event) => get().applyEvent(event), (status) => set({ connection: status }));
        await get().refreshThreads();
      }
      const response = await api.startTurn(threadId, {
        prompt: trimmed,
        model: state.composerModel || undefined,
        mode: state.composerMode,
        reasoningEffort: state.reasoningEffort,
        ...(ids.length ? { attachmentIds: ids } : {}),
        ...(mentions.length ? { atMembers: mentions } : {}),
      });
      set({ running: true, activeTurnId: response.turnId });
    } catch (error) {
      set({ banner: `Send failed: ${(error as Error).message}` });
    }
  },

  async interrupt() {
    const { currentThreadId, activeTurnId } = get();
    if (!currentThreadId || !activeTurnId) return;
    try {
      await api.interruptTurn(currentThreadId, activeTurnId);
      set({ running: false, activeTurnId: null });
    } catch (error) {
      set({ banner: `Interrupt failed: ${(error as Error).message}` });
    }
  },

  async approve(approvalId, decision) {
    try {
      await api.decideApproval(approvalId, decision);
    } catch (error) {
      set({ banner: `Approval failed: ${(error as Error).message}` });
    }
  },

  async submitUserInput(inputId, answers, text) {
    try {
      await api.resolveUserInput(inputId, { status: "submitted", answers, text });
    } catch (error) {
      set({ banner: `Submit failed: ${(error as Error).message}` });
    }
  },

  async cancelUserInput(inputId) {
    try {
      await api.resolveUserInput(inputId, { status: "cancelled" });
    } catch {
      /* ignore */
    }
  },

  async saveConfig(config) {
    try {
      const saved = await api.putConfig(config);
      const runtimeInfo = deriveRuntimeInfo(saved);
      set({ config: saved, runtimeInfo });
      flashBanner(set, get, "Settings saved.");
      return true;
    } catch (error) {
      set({ banner: `Save failed: ${(error as Error).message}` });
      return false;
    }
  },

  setComposerModel: (model) => set({ composerModel: model }),
  setComposerMode: (mode) => set({ composerMode: mode }),
  setReasoningEffort: (effort) => set({ reasoningEffort: effort }),
  setBanner: (message) => set({ banner: message }),

  applyEvent(event) {
    const state = get();
    switch (event.kind) {
      case "item_created":
      case "item_updated":
      case "item_completed":
      case "assistant_text_delta":
      case "assistant_reasoning_delta":
      case "tool_call_started":
      case "tool_call_finished": {
        if (!event.item) break;
        const item = event.item;
        const index = state.items.findIndex((existing) => existing.id === item.id);
        const items = state.items.slice();
        if (index === -1) items.push(item);
        else items[index] = item;
        set({ items });
        break;
      }
      case "turn_started":
        set({ running: true, activeTurnId: event.turnId ?? state.activeTurnId });
        break;
      case "turn_completed":
      case "turn_failed":
      case "turn_aborted":
        if (event.turnId === state.activeTurnId) {
          // Drop the transient "uploading tool result" wait blocks — they are
          // momentary progress hints for a turn that has now ended.
          set({ running: false, activeTurnId: null, activity: state.activity.filter((a) => a.kind !== "upload") });
          // Flush the next queued message as a fresh turn (one per completion).
          const queue = get().queuedMessages;
          if (queue.length > 0) {
            const [next, ...rest] = queue;
            set({ queuedMessages: rest });
            if (next) void get().sendMessage(next);
          }
        }
        void get().refreshUsage();
        // A finished turn means there's an exchange to summarize: give a still
        // "New thread" thread a real, content-derived title (best-effort).
        if (event.kind === "turn_completed") void get().maybeAutoTitle();
        break;
      case "goal_updated":
        if (state.thread) set({ thread: { ...state.thread, goal: event.goal ?? undefined } });
        break;
      case "goal_cleared":
        if (state.thread) set({ thread: { ...state.thread, goal: undefined } });
        break;
      case "todos_updated":
        if (state.thread) set({ thread: { ...state.thread, todos: event.todos ?? undefined } });
        break;
      case "todos_cleared":
        if (state.thread) set({ thread: { ...state.thread, todos: undefined } });
        break;
      case "suggestion": {
        if (!event.suggestionId) break;
        const tid = event.threadId || state.currentThreadId || "";
        if (!tid) break;
        const topic = event.topic ?? "";
        // Per-thread topic dedupe: a dismissed detector:topic never re-appears.
        const dedupeKey = `${event.detector ?? ""}:${topic}`;
        if ((state.dismissedTopicsByThread[tid] ?? []).includes(dedupeKey)) break;
        const existing = state.suggestionsByThread[tid] ?? [];
        if (existing.some((s) => s.suggestionId === event.suggestionId)) break;
        const suggestion: Suggestion = {
          suggestionId: event.suggestionId,
          detector: event.detector ?? "unknown",
          title: event.title ?? "",
          topic,
          confidence: event.confidence,
          draftPayload: event.draftPayload ?? {},
          threadId: tid,
          createdAt: event.timestamp,
          detail: event.detail,
          source: event.source,
        };
        // Keep the 3 most-recent per thread; surface up to 4 floating toasts.
        const bucket = [...existing, suggestion].slice(-3);
        const toasts = [event.suggestionId, ...state.insightToasts.filter((x) => x !== event.suggestionId)].slice(0, 4);
        set({
          suggestionsByThread: { ...state.suggestionsByThread, [tid]: bucket },
          insightToasts: toasts,
        });
        break;
      }
      case "pipeline_stage":
        pushActivity(set, state, event, "stage", event.label ?? event.stage ?? "stage", event.stage);
        // Once the model response arrives, the "uploading tool result · waiting"
        // blocks are stale — clear them so they don't linger as a permanent row.
        if (event.stage === "response_received") {
          set({ activity: get().activity.filter((a) => a.kind !== "upload") });
        }
        break;
      case "tool_storm_suppressed":
        pushActivity(set, state, event, "tool_storm", "tool storm suppressed", event.toolName ?? event.message);
        break;
      case "tool_catalog_changed":
        pushActivity(
          set,
          state,
          event,
          "tool_catalog",
          `tools ${event.changeKind ?? "changed"} (${event.toolCount ?? 0})`,
          event.message,
        );
        break;
      case "compaction_started":
        pushActivity(set, state, event, "compaction", "compaction started", event.summary);
        break;
      case "compaction_completed":
        pushActivity(
          set,
          state,
          event,
          "compaction",
          "compaction completed",
          event.replacedTokens !== undefined ? `${event.replacedTokens} tokens replaced` : event.summary,
        );
        flashBanner(set, get, "Conversation compacted.");
        break;
      case "insight_decision": {
        pushActivity(set, state, event, "insight", `insight: ${event.reason ?? ""}`.trim(), event.detail ?? event.detector);
        const decision: InsightDecision = {
          detector: event.detector ?? "",
          reason: event.reason ?? "",
          detail: event.detail ?? event.message ?? "",
          ...(event.topic !== undefined ? { topic: event.topic } : {}),
          ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
          ...(event.threadId ? { threadId: event.threadId } : {}),
        };
        set({ insightDecisions: [...state.insightDecisions, decision].slice(-200) });
        break;
      }
      case "tool_result_upload_wait":
        pushActivity(set, state, event, "upload", `upload: ${event.toolName ?? ""}`.trim(), event.status);
        break;
      case "usage":
        void get().refreshUsage();
        break;
      case "error":
        // Compaction summary fallback surfaces as a runtime-status timeline block
        // (T3.12) rather than a blocking banner — it is a non-fatal warning.
        if (event.code === "compaction_summary_fallback") {
          pushActivity(set, state, event, "compaction_fallback", "compaction summary fell back", event.message);
          break;
        }
        if (event.severity !== "info") set({ banner: event.message ?? "runtime error" });
        break;
      default:
        break;
    }
  },

  async refreshUsage() {
    try {
      set({ usage: toUsageReport(await api.usage()) });
    } catch {
      /* ignore */
    }
  },

  async runReview(target) {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    set({ reviewRunning: true, rightPanel: "review" });
    try {
      const outcome = await api.runReview(currentThreadId, target);
      set({ reviewResult: outcome.result, reviewRunning: false });
    } catch (error) {
      set({ reviewRunning: false, banner: `Review failed: ${(error as Error).message}` });
    }
  },

  dismissSuggestion(threadId, suggestionId) {
    const state = get();
    const bucket = state.suggestionsByThread[threadId] ?? [];
    const target = bucket.find((s) => s.suggestionId === suggestionId);
    const nextBucket = bucket.filter((s) => s.suggestionId !== suggestionId);
    // Remember detector:topic so the same insight never re-appears this session.
    const key = `${target?.detector ?? ""}:${target?.topic ?? ""}`;
    const dismissed = [...(state.dismissedTopicsByThread[threadId] ?? []), key].slice(-100);
    set({
      suggestionsByThread: { ...state.suggestionsByThread, [threadId]: nextBucket },
      dismissedTopicsByThread: { ...state.dismissedTopicsByThread, [threadId]: dismissed },
      insightToasts: state.insightToasts.filter((x) => x !== suggestionId),
      activeInsightId: state.activeInsightId === suggestionId ? null : state.activeInsightId,
    });
  },

  dismissInsightToast(suggestionId) {
    set({ insightToasts: get().insightToasts.filter((x) => x !== suggestionId) });
  },

  openInsight(suggestionId) {
    set({ activeInsightId: suggestionId, insightToasts: get().insightToasts.filter((x) => x !== suggestionId) });
  },

  closeInsight() {
    set({ activeInsightId: null });
  },

  clearSuggestions(threadId) {
    const state = get();
    const ids = new Set((state.suggestionsByThread[threadId] ?? []).map((s) => s.suggestionId));
    const nextByThread = { ...state.suggestionsByThread };
    delete nextByThread[threadId];
    set({
      suggestionsByThread: nextByThread,
      insightToasts: state.insightToasts.filter((x) => !ids.has(x)),
      activeInsightId: state.activeInsightId && ids.has(state.activeInsightId) ? null : state.activeInsightId,
    });
  },

  async loadWorkspaceStatus() {
    const workspace = get().thread?.workspace;
    try {
      set({ workspaceStatus: await api.workspaceStatus(workspace) });
    } catch {
      set({ workspaceStatus: null });
    }
  },

  async loadSkills() {
    try {
      const { skills, roots, validationErrors, enabled } = await api.listSkills();
      set({
        skills,
        skillsRoots: roots ?? [],
        skillsValidationErrors: validationErrors ?? [],
        skillsEnabled: Boolean(enabled),
      });
    } catch {
      /* ignore */
    }
  },

  async loadAgents() {
    try {
      const { agents } = await api.listAgents();
      set({ agents });
    } catch {
      /* ignore */
    }
  },

  async loadMemory(query, limit) {
    try {
      // The faithful backend returns { memories: [...] }; tolerate a { records }
      // shape too. Always store an array so the panel can read `.length`/`.map`.
      const res = (await api.listMemory(query, limit)) as {
        memories?: MemoryRecord[];
        records?: MemoryRecord[];
      };
      set({ memory: res.memories ?? res.records ?? [] });
    } catch {
      /* ignore */
    }
  },

  async loadMcp() {
    try {
      set({ mcp: await api.mcpStatus() });
    } catch {
      set({ mcp: null });
    }
  },

  async loadDelegation() {
    try {
      set({ delegation: await api.delegationDiagnostics() });
    } catch {
      set({ delegation: null });
    }
  },

  async setGoal(goal) {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      const { goal: saved } = await api.setGoal(currentThreadId, goal);
      const thread = get().thread;
      if (thread) set({ thread: { ...thread, goal: saved } });
    } catch (error) {
      set({ banner: `Set goal failed: ${(error as Error).message}` });
    }
  },

  async clearGoal() {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      await api.clearGoal(currentThreadId);
      const thread = get().thread;
      if (thread) set({ thread: { ...thread, goal: undefined } });
    } catch (error) {
      set({ banner: `Clear goal failed: ${(error as Error).message}` });
    }
  },

  async editTodos(todos) {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      await api.setTodos(currentThreadId, todos);
      const thread = get().thread;
      if (thread) {
        const items: ThreadTodoItem[] = todos.map((todo, index) => ({
          id: todo.id ?? `todo_${index}`,
          content: todo.content,
          status: todo.status as ThreadTodoItem["status"],
        }));
        set({ thread: { ...thread, todos: { items } } });
      }
    } catch (error) {
      set({ banner: `Update todos failed: ${(error as Error).message}` });
    }
  },

  async clearTodos() {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      await api.clearTodos(currentThreadId);
      const thread = get().thread;
      if (thread) set({ thread: { ...thread, todos: { items: [] } } });
    } catch (error) {
      set({ banner: `Clear todos failed: ${(error as Error).message}` });
    }
  },

  async forkThread(title) {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      const forked = await api.forkThread(currentThreadId, title);
      await get().refreshThreads();
      await get().selectThread(forked.id);
    } catch (error) {
      set({ banner: `Fork failed: ${(error as Error).message}` });
    }
  },

  async forkToSide() {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    try {
      const forked = await api.forkThread(currentThreadId);
      const sideThread = await api.getThread(forked.id);
      // Open the fork beside the main chat WITHOUT touching currentThreadId/
      // thread/items — the main conversation stays put.
      set({
        sidePanel: { open: true, threadId: forked.id },
        sideThread,
        sideItems: flattenItems(sideThread),
      });
      void get().refreshThreads();
      // Concurrent second SSE stream: streams the side thread live alongside the
      // main one, independent of the module-level `streamHandle`.
      sideStreamHandle?.close();
      sideStreamHandle = subscribeThreadEvents(
        forked.id,
        sideThread.latestSeq ?? 0,
        (event) => applySideEvent(set, get, event),
      );
    } catch (error) {
      set({ banner: `Fork to side failed: ${(error as Error).message}` });
    }
  },

  closeSidePanel() {
    sideStreamHandle?.close();
    sideStreamHandle = null;
    set({ sidePanel: { open: false, threadId: null }, sideThread: null, sideItems: [] });
  },

  async promoteSideToMain() {
    const { sidePanel } = get();
    const id = sidePanel.threadId;
    if (!id) return;
    await get().selectThread(id);
    get().closeSidePanel();
  },

  async refreshSidePanel() {
    const { sidePanel } = get();
    const id = sidePanel.threadId;
    if (!id) return;
    try {
      const sideThread = await api.getThread(id);
      set({ sideThread, sideItems: flattenItems(sideThread) });
    } catch (error) {
      set({ banner: `Refresh side conversation failed: ${(error as Error).message}` });
    }
  },

  async renameThread(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await api.updateThread(id, { title: trimmed });
      await get().refreshThreads();
      const thread = get().thread;
      if (thread && thread.id === id) set({ thread: { ...thread, title: trimmed } });
    } catch (error) {
      set({ banner: `Rename failed: ${(error as Error).message}` });
    }
  },

  async maybeAutoTitle() {
    const { thread, currentThreadId } = get();
    if (!thread || !currentThreadId) return;
    // Only title a still-default thread, and only once per thread per session.
    const current = (thread.title || "").trim();
    if (current && !/^new thread$/i.test(current)) return;
    if (autoTitledThreads.has(currentThreadId)) return;
    autoTitledThreads.add(currentThreadId);
    try {
      const updated = await api.autoTitleThread(currentThreadId);
      // Reflect immediately in the open thread + the sidebar list. (The runtime
      // also emits thread_updated, but updating here avoids a flash.)
      const open = get().thread;
      if (open && open.id === updated.id) set({ thread: { ...open, title: updated.title } });
      await get().refreshThreads();
    } catch {
      // Best-effort: allow a retry on the next completed turn.
      autoTitledThreads.delete(currentThreadId);
    }
  },

  async archiveThread(id) {
    try {
      await api.updateThread(id, { status: "archived" });
      if (get().currentThreadId === id) await get().selectThread(null);
      await get().refreshThreads();
    } catch (error) {
      set({ banner: `Archive failed: ${(error as Error).message}` });
    }
  },

  async compactThread(id) {
    try {
      await api.compact(id);
      set({ banner: "Conversation compacted." });
      if (get().currentThreadId === id) await get().selectThread(id);
    } catch (error) {
      set({ banner: `Compact failed: ${(error as Error).message}` });
    }
  },

  async removeThread(id) {
    try {
      await api.deleteThread(id);
      if (get().currentThreadId === id) await get().selectThread(null);
      await get().refreshThreads();
    } catch (error) {
      set({ banner: `Delete failed: ${(error as Error).message}` });
    }
  },

  async pollThreads() {
    try {
      const { threads } = await api.listThreads();
      const currentId = get().currentThreadId;
      const unread = { ...get().unread };
      let changed = false;
      for (const th of threads) {
        const prev = threadStatuses.get(th.id);
        if (prev === "running" && th.status !== "running" && th.id !== currentId) {
          if (!unread[th.id]) {
            unread[th.id] = true;
            changed = true;
            // Gated by the reply-completion notification preference (T10.6).
            if (shouldNotifyOnReplyComplete()) {
              const title = "Thread finished";
              const body = th.title || "A background thread finished";
              // Under the Tauri desktop shell, fire a native OS notification
              // through the Rust command layer (T9.3); on the plain web build
              // fall back to the Web Notification API.
              if (isTauri()) {
                void showTurnCompleteNotification({ title, body });
              } else {
                notify(title, body);
              }
            }
          }
        }
        threadStatuses.set(th.id, th.status);
      }
      set({ threads });
      if (changed) set({ unread });
    } catch {
      /* ignore */
    }
  },

  markThreadRead(id) {
    const unread = get().unread;
    if (!unread[id]) return;
    const next = { ...unread };
    delete next[id];
    set({ unread: next });
  },

  openFilePreview(path, line) {
    set({ filePreview: { path, ...(line !== undefined ? { line } : {}) } });
  },
  closeFilePreview() {
    set({ filePreview: null });
  },

  removeQueuedMessage(index) {
    set({ queuedMessages: get().queuedMessages.filter((_, i) => i !== index) });
  },

  async rewindAndResend(turnId, prompt) {
    const { currentThreadId } = get();
    if (!currentThreadId || !prompt.trim()) return;
    try {
      const response = await api.rewindTurn(currentThreadId, turnId, prompt.trim());
      set({ running: true, activeTurnId: response.turnId });
      // Reload the truncated thread so the timeline reflects the rewind.
      const thread = await api.getThread(currentThreadId);
      set({ thread, items: flattenItems(thread) });
    } catch (error) {
      set({ banner: `Rewind failed: ${(error as Error).message}` });
    }
  },

  setRightPanel: (panel) => set({ rightPanel: panel }),
}));
