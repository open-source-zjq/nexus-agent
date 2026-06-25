import type { ModelRegistry } from "../ports/model-client.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ApprovalPolicy, SandboxMode } from "../contracts/policy.js";
import type { UsageSnapshot } from "../contracts/usage.js";
import type { TurnItem } from "../contracts/items.js";
import type { RuntimeEvent } from "../contracts/events.js";
import { InMemoryThreadStore, InMemorySessionStore } from "../adapters/store/in-memory-stores.js";
import { InMemoryEventBus } from "../adapters/event/event-bus.js";
import { InMemoryApprovalGate, InMemoryUserInputGate } from "../adapters/event/gates.js";
import { RuntimeEventRecorder } from "../services/runtime-event-recorder.js";
import { UsageService } from "../services/usage-service.js";
import { ThreadService } from "../services/thread-service.js";
import { TurnService } from "../services/turn-service.js";
import { SteeringQueue } from "../loop/steering-queue.js";
import { InflightTracker } from "../loop/inflight-tracker.js";
import { ContextCompactor, type ContextCompactorDeps } from "../loop/context-compactor.js";
import { AgentLoop } from "../loop/agent-loop.js";
import type { ToolStormBreakerConfig } from "../loop/tool-storm-breaker.js";
import type { TokenEconomyConfig } from "../loop/token-economy.js";
import { LocalToolHost } from "../adapters/tool/local-tool-host.js";
import { buildDefaultLocalTools } from "../adapters/tool/builtin-tools.js";

/** Shared deps the parent runtime injects into every isolated child run. */
export interface ChildAgentExecutorDeps {
  /** Reused from the parent — children resolve the same model catalog. */
  models: ModelRegistry;
  /** Reused from the parent so prompt-cache prefixes stay identical. */
  systemPrompt: string;
  clock: Clock;
  ids: IdGenerator;
  /**
   * Parent context-compaction tuning threaded into the child's ContextCompactor
   * so children fold history with the same summarizer/thresholds as the parent.
   * Faithful to the original `ContextCompactor({ contextCompaction, models })`.
   */
  contextCompaction?: ContextCompactorDeps;
  /** Parent token-economy config inherited by the child AgentLoop (when enabled). */
  tokenEconomy?: TokenEconomyConfig;
  /** Parent tool-storm breaker config inherited by the child AgentLoop. */
  toolStorm?: ToolStormBreakerConfig;
  /** Default approval policy applied to the child thread (defaults to "auto"). */
  approvalPolicy?: ApprovalPolicy;
  /** Optional sandbox mode threaded into the child thread create. */
  sandboxMode?: SandboxMode;
}

export interface ChildRunInput {
  task: string;
  workspace: string;
  model?: string;
  /** Optional human-readable label used to title the child thread + bucket runs. */
  label?: string;
  parentThreadId: string;
  parentTurnId: string;
  abortSignal: AbortSignal;
  /**
   * Optional id used to seed the isolated child thread so the in-memory child
   * thread id ties back to the persisted ChildRunRecord.id. Faithful to the
   * original `threads.create(spec, { id: input.childId, title })`.
   */
  childId?: string;
}

export interface ChildRunResult {
  output: string;
  usage?: UsageSnapshot;
}

/**
 * Runs a single bounded child agent task inside a fully ISOLATED in-memory
 * runtime (its own stores, event bus, services, tool host, and agent loop),
 * reusing only the parent's model registry, system prompt, clock, and ids.
 *
 * The child shares nothing mutable with the parent thread: it gets a fresh
 * thread seeded with the task and runs one turn to completion. Faithful to the
 * original child executor, the run is FAIL-FAST: after the turn it inspects the
 * child's error events and throws if one was recorded, then throws if the turn
 * did not reach the "completed" status — so a failed/aborted child surfaces as a
 * thrown error to the delegation runtime (which records it as failed/aborted).
 */
export class ChildAgentExecutor {
  constructor(private readonly deps: ChildAgentExecutorDeps) {}

  async runOnce(input: ChildRunInput): Promise<ChildRunResult> {
    const { models, systemPrompt, clock, ids } = this.deps;

    // --- isolated runtime graph --------------------------------------------
    const threadStore = new InMemoryThreadStore();
    const sessionStore = new InMemorySessionStore();
    const eventBus = new InMemoryEventBus();
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
    // Registry of the child's in-flight operations (original child runtime: `new
    // InflightTracker()`), threaded into the child TurnService so each model turn
    // is registered/deregistered.
    const inflight = new InflightTracker();
    // Inherit the parent's context-compaction summarizer/thresholds so children
    // fold history identically (original: ContextCompactor({ contextCompaction, models })).
    const compactor = new ContextCompactor({}, this.deps.contextCompaction ?? {});

    const defaultModel = (input.model?.trim() || models.defaultModelId);
    const workspace = input.workspace?.trim() || process.cwd();

    const threadService = new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids,
      clock,
      defaultModel,
      defaultWorkspace: workspace,
    });
    const turnService = new TurnService({
      threadStore: threadService,
      sessionStore,
      events,
      ids,
      clock,
      steering,
      compactor,
      inflight,
    });

    // Children get the read/write builtin tool surface only — no delegation,
    // so a child cannot recursively spawn more children.
    const toolHost = new LocalToolHost({
      tools: buildDefaultLocalTools(),
      readTracker: true,
    });

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
      // Inherit the parent's token-economy + tool-storm protections so children
      // run under the same compression/storm-breaker policy as the parent loop.
      ...(this.deps.tokenEconomy || this.deps.toolStorm
        ? {
            config: {
              ...(this.deps.toolStorm ? { toolStorm: this.deps.toolStorm } : {}),
              ...(this.deps.tokenEconomy ? { tokenEconomy: this.deps.tokenEconomy } : {}),
            },
          }
        : {}),
    });

    if (input.abortSignal.aborted) {
      return { output: "child agent aborted before start" };
    }

    // --- seed thread + run one turn ----------------------------------------
    const thread = await threadService.create(
      {
        title: childThreadTitle(input.childId, input.label),
        workspace,
        model: defaultModel,
        mode: "agent",
        approvalPolicy: this.deps.approvalPolicy ?? "auto",
        ...(this.deps.sandboxMode ? { sandboxMode: this.deps.sandboxMode } : {}),
      },
      // Seed the in-memory child thread id from the child-run record id so the
      // two correlate (original: threads.create(spec, { id: input.childId, title })).
      input.childId ? { id: input.childId } : undefined,
    );

    const started = await turnService.startTurn({
      threadId: thread.id,
      request: { prompt: input.task, model: defaultModel, mode: "agent", attachmentIds: [] },
    });

    // Propagate parent abort into the child's turn so cancellation cascades.
    const controller = turnService.getAbortController(started.turnId);
    const onAbort = (): void => controller?.abort();
    if (controller) {
      if (input.abortSignal.aborted) controller.abort();
      else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let status: string;
    try {
      status = await agentLoop.runTurn(thread.id, started.turnId);
    } finally {
      input.abortSignal.removeEventListener("abort", onAbort);
    }

    // --- fail-fast on runtime errors / non-completed status ----------------
    // Faithful to the original: surface any error event the loop recorded for
    // this turn, then refuse to return a non-completed turn — both throw so the
    // delegation runtime records the child as failed/aborted.
    const turnEvents = await sessionStore.loadEventsSince(thread.id, 0);
    const runtimeError = turnEvents.find(
      (event): event is Extract<RuntimeEvent, { kind: "error" }> =>
        event.kind === "error" && event.turnId === started.turnId,
    );
    if (runtimeError) {
      throw new Error(runtimeError.message);
    }

    const items = await sessionStore.loadItems(thread.id);
    const output = summarizeChildTurn(items, started.turnId, status);
    if (status !== "completed") {
      throw new Error(output || `child agent ${status}`);
    }

    const usage = aggregateChildUsage(usageService, thread.id);
    return usage ? { output, usage } : { output };
  }
}

/**
 * Title for the isolated child thread. Faithful to the original: falls back to
 * the childId when no label is supplied so the title always carries a suffix
 * (`Child agent: <label-or-childId>`).
 */
function childThreadTitle(childId: string | undefined, label?: string): string {
  const suffix = label?.trim() || childId;
  return suffix ? `Child agent: ${suffix}` : "Child agent";
}

/**
 * Build the child's textual output: prefer concatenated assistant text, then
 * error messages, then the last tool result, then a status fallback.
 */
function summarizeChildTurn(items: TurnItem[], turnId: string, status: string): string {
  const turnItems = items.filter((item) => item.turnId === turnId);

  const assistantText = turnItems
    .filter((item): item is Extract<TurnItem, { kind: "assistant_text" }> => item.kind === "assistant_text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (assistantText) return assistantText;

  const errors = turnItems
    .filter((item): item is Extract<TurnItem, { kind: "error" }> => item.kind === "error")
    .map((item) => item.message.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (errors) return errors;

  const toolResult = [...turnItems]
    .reverse()
    .find((item): item is Extract<TurnItem, { kind: "tool_result" }> => item.kind === "tool_result");
  if (toolResult) return stringifySummary(toolResult.output);

  return status === "completed" ? "Child agent completed without a text response." : `Child agent ${status}.`;
}

function stringifySummary(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Roll the child's per-thread usage up into a single snapshot for the parent.
 *
 * Faithful to the original `usage: usage.forThread(thread.id)`: returns the FULL
 * per-thread counter snapshot (prompt/completion/total tokens, cache read/creation
 * tokens, turns, costUsd, and any token-economy savings) so cache + turn metrics
 * are carried into the persisted child-run record and rolled up to the parent.
 */
function aggregateChildUsage(usage: UsageService, threadId: string): UsageSnapshot | undefined {
  const acc = usage.forThread(threadId);
  const totalTokens = acc.totalTokens || acc.promptTokens + acc.completionTokens;
  if (totalTokens <= 0 && acc.costUsd <= 0) return undefined;
  return { ...acc, totalTokens };
}
