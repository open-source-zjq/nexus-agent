import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ModelRegistry } from "../ports/model-client.js";
import { NEXUS_REVIEW_PROMPT } from "../review/review-prompt.js";
import { parseReviewOutput, renderReviewOutput } from "../review/review-output.js";
import type { ReviewOutput } from "../review/review-output.js";
import {
  resolveReviewTargetPrompt,
  isReviewWorkspaceNotGitError,
  REVIEW_WORKSPACE_NOT_GIT_MESSAGE,
} from "../review/git-review-target.js";
import type { ReviewTarget } from "../review/git-review-target.js";
import type { ReviewTarget as CanonicalReviewTarget } from "../contracts/review.js";
import type { SimpleReviewFinding, TurnItem } from "../contracts/items.js";
import type { RuntimeEvent } from "../contracts/events.js";
import { TurnService } from "./turn-service.js";
import { ThreadService } from "./thread-service.js";
import { RuntimeEventRecorder } from "./runtime-event-recorder.js";
import { UsageService } from "./usage-service.js";
import { InMemoryThreadStore, InMemorySessionStore } from "../adapters/store/in-memory-stores.js";
import { InMemoryEventBus } from "../adapters/event/event-bus.js";
import { InMemoryApprovalGate, InMemoryUserInputGate } from "../adapters/event/gates.js";
import { SteeringQueue } from "../loop/steering-queue.js";
import { ContextCompactor } from "../loop/context-compactor.js";
import { AgentLoop } from "../loop/agent-loop.js";
import type { ToolStormBreakerConfig } from "../loop/tool-storm-breaker.js";
import type { TokenEconomyConfig } from "../loop/token-economy.js";
import { LocalToolHost } from "../adapters/tool/local-tool-host.js";
import { buildReadOnlyBuiltinLocalTools } from "../adapters/tool/builtin-tools.js";

export type { ReviewOutput, ReviewFinding } from "../review/review-output.js";
export type { ReviewTarget } from "../review/git-review-target.js";

/**
 * Flatten the raw {@link ReviewOutput} findings into the backward-compatible
 * simplified shape (priority/title/detail/file/line) the GUI's ReviewTurnItem
 * mirrors alongside the structured `output`. `line` is the finding's start line.
 */
function flattenFindings(output: ReviewOutput): SimpleReviewFinding[] {
  return output.findings.map((finding) => {
    const file = finding.codeLocation.absoluteFilePath;
    const line = finding.codeLocation.lineRange.start;
    return {
      priority: finding.priority,
      title: finding.title,
      detail: finding.body,
      ...(file ? { file } : {}),
      ...(Number.isFinite(line) ? { line } : {}),
    };
  });
}

/**
 * Map a canonical {@link CanonicalReviewTarget} (the contracts/review.ts shape:
 * uncommittedChanges|baseBranch|commit|custom) onto the git-review-target kinds
 * the diff resolver understands (workingTree|staged|baseBranch|commit|custom).
 * `uncommittedChanges` maps to `workingTree`.
 */
export function toGitReviewTarget(target: CanonicalReviewTarget): ReviewTarget {
  switch (target.kind) {
    case "uncommittedChanges":
      return { kind: "workingTree" };
    case "baseBranch":
      return { kind: "baseBranch", branch: target.branch };
    case "commit":
      return { kind: "commit", sha: target.sha };
    case "custom":
      return { kind: "custom", instructions: target.instructions };
  }
}

/**
 * Provider-agnostic completion function injected by the integration layer
 * (serve.ts adapts its existing oneShot helper into this named-object shape).
 */
export type ReviewComplete = (input: {
  system?: string;
  prompt: string;
  model?: string;
  responseFormat?: "json_object";
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * Runs the diff prompt through a full isolated read-only agent runtime (the
 * original `runIsolatedReviewer`): a fresh in-memory AgentLoop with read-only
 * builtin file-exploration tools and the review system prompt, returning the
 * reviewer's raw assistant text. Injected by the integration layer (serve.ts),
 * which owns the runtime wiring. When absent, the service builds the isolated
 * loop itself from {@link ReviewServiceDeps.runtime}, and only as a final
 * fallback runs a single diff -> model -> parse pass via {@link ReviewComplete}.
 */
export type ReviewRunner = (input: {
  prompt: string;
  workspace: string;
  model?: string;
  signal: AbortSignal;
}) => Promise<string>;

/**
 * The runtime building blocks the {@link ReviewService} needs to construct its
 * OWN isolated read-only reviewer (faithful port of the original
 * `runIsolatedReviewer`), without depending on the integration layer to wire one
 * in. When present, every review runs inside a fresh in-memory AgentLoop with the
 * read-only builtin file tools + the review system prompt and a pinned read-only
 * constraint, so the reviewer can inspect files beyond the diff. Each review gets
 * its own throwaway runtime so it never pollutes persistent thread state.
 */
export interface ReviewRuntimeDeps {
  /** Reused from the parent — the reviewer resolves the same model catalog. */
  models: ModelRegistry;
  /**
   * Parent context-compactor (summarizer/thresholds) reused so the reviewer
   * folds history identically. Faithful to the original
   * `ContextCompactor({ contextCompaction, models })`.
   */
  compactor: ContextCompactor;
  /** Parent token-economy config inherited by the reviewer AgentLoop (when enabled). */
  tokenEconomy?: TokenEconomyConfig;
  /** Parent tool-storm breaker config inherited by the reviewer AgentLoop. */
  toolStorm?: ToolStormBreakerConfig;
  /** Default workspace used when a review target carries no workspace. */
  defaultWorkspace?: string;
}

export interface ReviewServiceDeps {
  complete: ReviewComplete;
  clock: Clock;
  ids: IdGenerator;
  /**
   * Isolated read-only agent reviewer injected by the integration layer
   * (faithful path). When set this takes precedence over {@link runtime}.
   * Optional.
   */
  runIsolatedReviewer?: ReviewRunner;
  /**
   * Runtime building blocks the service uses to construct its OWN isolated
   * read-only reviewer when {@link runIsolatedReviewer} is not injected. When
   * neither is set, the service degrades to a single diff -> model -> parse pass.
   */
  runtime?: ReviewRuntimeDeps;
}

export interface RunReviewInput {
  workspace: string;
  /** Defaults to reviewing the working tree when omitted. */
  target?: ReviewTarget;
  model?: string;
  abortSignal?: AbortSignal;
}

export interface RunReviewResult {
  id: string;
  title: string;
  createdAt: string;
  finishedAt: string;
  /** Raw structured review output (faithful to the original parseReviewOutput). */
  result: ReviewOutput;
}

/**
 * Isolated code-review service.
 *
 * Faithful port of the original `runIsolatedReviewer`: when the runtime building
 * blocks are wired (via {@link ReviewServiceDeps.runtime} or an injected
 * {@link ReviewServiceDeps.runIsolatedReviewer}), each review runs the diff
 * prompt inside a FULL isolated read-only agent runtime — its own in-memory
 * stores/event bus/services/tool host + a fresh AgentLoop wired with ONLY the
 * read-only builtin file tools (read/grep/find/ls), the review system prompt, and
 * a pinned read-only constraint — so the reviewer can inspect files beyond the
 * diff before emitting strict-JSON findings. As a last resort (no runtime wired)
 * it degrades to a single diff -> one-shot model -> robust JSON parse pass.
 */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * Produce the reviewer's raw output text. Prefers, in order:
   * 1. the injected isolated read-only agent runtime
   *    ({@link ReviewServiceDeps.runIsolatedReviewer}),
   * 2. the service's own isolated read-only AgentLoop built from
   *    {@link ReviewServiceDeps.runtime} (faithful to the original
   *    `runIsolatedReviewer`),
   * 3. a single diff -> model -> parse pass via {@link ReviewComplete}.
   */
  private generateReviewText(input: {
    prompt: string;
    workspace: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const signal = input.signal ?? new AbortController().signal;
    if (this.deps.runIsolatedReviewer) {
      return this.deps.runIsolatedReviewer({
        prompt: input.prompt,
        workspace: input.workspace,
        ...(input.model ? { model: input.model } : {}),
        signal,
      });
    }
    if (this.deps.runtime) {
      return this.runIsolatedReviewer({
        prompt: input.prompt,
        workspace: input.workspace,
        ...(input.model ? { model: input.model } : {}),
        signal,
      });
    }
    return this.deps.complete({
      system: NEXUS_REVIEW_PROMPT,
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      responseFormat: "json_object",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Faithful port of the original `runIsolatedReviewer`: builds a fully ISOLATED
   * in-memory runtime (its own stores, event bus, services, read-only tool host,
   * and agent loop), seeds a fresh "Review" child thread with the diff prompt,
   * and drives one turn to completion under the review system prompt.
   *
   * Read-only enforcement: the tool host advertises ONLY the read/grep/find/ls
   * builtin tools (no write/edit/bash), and a pinned constraint records that
   * "review mode is read-only and must output strict JSON".
   *
   * After the turn it FAILS FAST: it surfaces any error event the loop recorded
   * for this turn, then refuses to return a non-completed turn — both throw so
   * the caller (runReviewTurn/runReview) records the review as failed. Returns
   * the reviewer's summarized text (assistant text, faithful to the original
   * summarizeReviewTurn) for {@link parseReviewOutput} to consume.
   */
  private async runIsolatedReviewer(input: {
    prompt: string;
    workspace: string;
    model?: string;
    signal: AbortSignal;
  }): Promise<string> {
    const runtime = this.deps.runtime;
    if (!runtime) throw new Error("runIsolatedReviewer requires runtime deps");
    const { clock, ids } = this.deps;
    const { models, compactor } = runtime;

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
    const usage = new UsageService();
    const steering = new SteeringQueue();

    const defaultModel = input.model?.trim() || models.defaultModelId;
    const workspace = input.workspace?.trim() || runtime.defaultWorkspace || process.cwd();

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
    });

    // Read-only enforcement: ONLY the read/grep/find/ls builtin tools are
    // advertised — no write/edit/bash — so the reviewer cannot mutate the
    // workspace. Faithful to the original `buildReadOnlyBuiltinLocalTools()`.
    const toolHost = new LocalToolHost({
      tools: buildReadOnlyBuiltinLocalTools(),
      readTracker: true,
    });

    const loop = new AgentLoop({
      models,
      toolHost,
      turns: turnService,
      threadStore: threadService,
      sessionStore,
      events,
      usage,
      steering,
      approvalGate: new InMemoryApprovalGate(),
      userInputGate: new InMemoryUserInputGate(),
      compactor,
      ids,
      clock,
      systemPrompt: NEXUS_REVIEW_PROMPT,
      config: {
        pinnedConstraints: ["system: review mode is read-only and must output strict JSON"],
        ...(runtime.tokenEconomy ? { tokenEconomy: runtime.tokenEconomy } : {}),
        ...(runtime.toolStorm ? { toolStorm: runtime.toolStorm } : {}),
      },
    });

    // --- seed thread + run one turn ----------------------------------------
    const childThread = await threadService.create({
      title: "Review",
      workspace: input.workspace || "~",
      model: defaultModel,
      mode: "agent",
      approvalPolicy: "auto",
    });

    const started = await turnService.startTurn({
      threadId: childThread.id,
      request: {
        prompt: input.prompt,
        model: defaultModel,
        mode: "agent",
        attachmentIds: [],
      },
    });

    // Propagate the caller's abort into the reviewer turn so cancellation
    // cascades (faithful to the original `interruptTurn` on abort).
    const abortChild = (): void => {
      void turnService
        .interruptTurn({ threadId: childThread.id, turnId: started.turnId })
        .catch(() => undefined);
    };
    if (input.signal.aborted) abortChild();
    else input.signal.addEventListener("abort", abortChild, { once: true });

    try {
      const status = await loop.runTurn(childThread.id, started.turnId);

      // Fail-fast on any error event the loop recorded for this turn.
      const turnEvents = await sessionStore.loadEventsSince(childThread.id, 0);
      const runtimeError = turnEvents.find(
        (event): event is Extract<RuntimeEvent, { kind: "error" }> =>
          event.kind === "error" && event.turnId === started.turnId,
      );
      if (runtimeError) throw new Error(runtimeError.message);

      const items = await sessionStore.loadItems(childThread.id);
      const text = summarizeReviewTurn(items, started.turnId, status);
      if (status !== "completed") throw new Error(text || `reviewer ${status}`);
      return text;
    } finally {
      input.signal.removeEventListener("abort", abortChild);
    }
  }

  async runReview(input: RunReviewInput): Promise<RunReviewResult> {
    const id = this.deps.ids.next("review");
    const createdAt = this.deps.clock.nowIso();
    const target: ReviewTarget = input.target ?? { kind: "workingTree" };

    try {
      const resolved = await resolveReviewTargetPrompt({
        workspace: input.workspace,
        target,
      });

      this.throwIfAborted(input.abortSignal);

      const rawReviewText = await this.generateReviewText({
        prompt: resolved.prompt,
        workspace: input.workspace,
        ...(input.model ? { model: input.model } : {}),
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });

      this.throwIfAborted(input.abortSignal);

      const result = parseReviewOutput(rawReviewText);
      return {
        id,
        title: resolved.title,
        createdAt,
        finishedAt: this.deps.clock.nowIso(),
        result,
      };
    } catch (error) {
      if (isReviewWorkspaceNotGitError(error)) {
        throw new Error(REVIEW_WORKSPACE_NOT_GIT_MESSAGE);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Drive a review as a background agent turn. The route should already have
   * (1) created a `running` review item on the turn and (2) started the turn.
   * This resolves the diff, runs the one-shot model pass, updates the review
   * item with the structured output, and finalizes the turn — honoring the
   * turn's abort signal. Faithful to the original review-service control flow
   * (resolve -> run -> updateItem -> finishTurn) over the simplified runtime.
   */
  async runReviewTurn(input: {
    turns: TurnService;
    threadStore: ThreadService;
    threadId: string;
    turnId: string;
    reviewItemId: string;
    target: ReviewTarget;
    model?: string;
  }): Promise<"completed" | "failed" | "aborted"> {
    const { turns, threadStore } = input;
    const signal = turns.getAbortController(input.turnId)?.signal;
    if (signal?.aborted) {
      await this.abortReviewTurn(input);
      return "aborted";
    }
    try {
      const thread = await threadStore.get(input.threadId);
      if (!thread) throw new Error(`thread not found: ${input.threadId}`);
      const resolved = await resolveReviewTargetPrompt({
        workspace: thread.workspace ?? "",
        target: input.target,
      });
      if (signal?.aborted) {
        await this.abortReviewTurn(input);
        return "aborted";
      }
      const reviewModel = input.model?.trim() || thread.model;
      const rawReviewText = await this.generateReviewText({
        prompt: resolved.prompt,
        workspace: thread.workspace ?? "",
        ...(reviewModel ? { model: reviewModel } : {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) {
        await this.abortReviewTurn(input);
        return "aborted";
      }
      const output = parseReviewOutput(rawReviewText);
      // Faithful to the original review-service: the completed review item carries
      // BOTH the structured output (`output`) and the rendered review text
      // (renderReviewOutput), so consumers that read `reviewText` see the same
      // human-readable summary. The flattened summary/findings/correctness fields
      // are mirrored for backward-compatible GUI consumers.
      await turns.updateItem(input.threadId, input.reviewItemId, {
        status: "completed",
        title: resolved.title,
        output,
        summary: output.overallExplanation.trim() || output.overallCorrectness,
        overallExplanation: output.overallExplanation,
        findings: flattenFindings(output),
        overallCorrectness: output.overallCorrectness,
        overallConfidenceScore: output.overallConfidenceScore,
        reviewText: renderReviewOutput(output),
        finishedAt: this.deps.clock.nowIso(),
      } as never);
      await turns.finishTurn({ threadId: input.threadId, turnId: input.turnId, status: "completed" });
      return "completed";
    } catch (error) {
      if (signal?.aborted) {
        await this.abortReviewTurn(input);
        return "aborted";
      }
      const message = isReviewWorkspaceNotGitError(error)
        ? REVIEW_WORKSPACE_NOT_GIT_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error);
      await turns.updateItem(input.threadId, input.reviewItemId, {
        status: "failed",
        reviewText: message,
        finishedAt: this.deps.clock.nowIso(),
      } as never);
      await turns.finishTurn({ threadId: input.threadId, turnId: input.turnId, status: "failed", error: message });
      return "failed";
    }
  }

  private async abortReviewTurn(input: {
    turns: TurnService;
    threadId: string;
    turnId: string;
    reviewItemId: string;
  }): Promise<void> {
    await input.turns.updateItem(input.threadId, input.reviewItemId, {
      status: "aborted",
      reviewText: "Review aborted.",
      finishedAt: this.deps.clock.nowIso(),
    } as never);
    await input.turns.finishTurn({ threadId: input.threadId, turnId: input.turnId, status: "aborted" });
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new DOMException("Review aborted.", "AbortError");
    }
  }
}

/**
 * Build the reviewer turn's textual output. Faithful to the original
 * `summarizeReviewTurn`, the primary path is the concatenated non-empty
 * assistant text (the strict-JSON findings). When the turn produced no assistant
 * text (e.g. a tool-only or failed turn), it degrades — matching the child
 * executor's `summarizeChildTurn` — to the recorded error messages, then the
 * last tool result, then a status fallback, so a non-completed turn still throws
 * a meaningful message rather than an empty one.
 */
function summarizeReviewTurn(items: TurnItem[], turnId: string, status: string): string {
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
  if (toolResult) return stringifyReviewSummary(toolResult.output);

  return status === "completed" ? "Review completed without a text response." : `Review ${status}.`;
}

function stringifyReviewSummary(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
