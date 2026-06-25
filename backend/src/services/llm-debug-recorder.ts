import { z } from "zod";
import { UsageSnapshotSchema } from "../contracts/usage.js";

/**
 * Default number of rounds retained by the ring buffer. Faithful to the
 * original recorder's `CAPACITY = 25`. Sized for "recent activity" debugging,
 * not long-term history — old rounds are dropped silently.
 */
const DEFAULT_CAPACITY = 25;

/** Why the model stopped, mirroring ModelStopReason from the model port. */
export const LlmStopReasonSchema = z.enum(["stop", "tool_calls", "length", "error"]);
export type LlmStopReason = z.infer<typeof LlmStopReasonSchema>;

/** One tool call captured from the model output (callId/toolName/arguments). */
export const LlmDebugToolCallSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  arguments: z.unknown(),
});
export type LlmDebugToolCall = z.infer<typeof LlmDebugToolCallSchema>;

/**
 * Raw accumulated model output for a round, faithful to the original recorder's
 * `output` shape: assistant text, reasoning text, and completed tool calls plus
 * optional usage/stopReason/error captured from the stream.
 */
export const LlmDebugOutputSchema = z.object({
  text: z.string().default(""),
  reasoning: z.string().default(""),
  toolCalls: z.array(LlmDebugToolCallSchema).default([]),
  usage: UsageSnapshotSchema.optional(),
  stopReason: LlmStopReasonSchema.optional(),
  error: z.string().optional(),
});
export type LlmDebugOutput = z.infer<typeof LlmDebugOutputSchema>;

/**
 * One recorded LLM round. `id` is assigned by the recorder; everything else is
 * supplied by the caller. `finishedAt`/`durationMs`/`stopReason`/`usage`/`error`
 * are filled in once the round completes (via finish/update helpers).
 */
export const LlmDebugRoundSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string(),
  turnId: z.string(),
  /**
   * Provider label for the round, faithful to the original recorder's
   * `provider` field. Optional because the model-gateway transport is swapped
   * (the original sourced this from the nexus meta, which no longer exists).
   */
  provider: z.string().optional(),
  model: z.string(),
  /**
   * Request URL, faithful to the original recorder's `url` field. The original
   * always emitted an empty string here, so it defaults to "".
   */
  url: z.string().default(""),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  stopReason: LlmStopReasonSchema.optional(),
  usage: UsageSnapshotSchema.optional(),
  /** Short error message (no stack/secrets) when the round failed. */
  error: z.string().optional(),
  /**
   * Literal request body sent to the model, captured for the troubleshooting
   * view. `null` until the request is assembled. Faithful to the original
   * recorder's `requestBody` field.
   */
  requestBody: z.unknown().optional(),
  /**
   * Accumulated raw model output (text/reasoning/toolCalls). Faithful to the
   * original recorder's `output` field.
   */
  output: LlmDebugOutputSchema.optional(),
});
export type LlmDebugRound = z.infer<typeof LlmDebugRoundSchema>;

/**
 * Caller-supplied fields when starting/recording a round (id is assigned).
 * Derived from the schema's *input* type so defaulted fields (`url`) stay
 * optional for callers; the recorder fills them in via `parse`.
 *
 * `requestSummary` is accepted but ignored: the original recorder had no such
 * field, so it is stripped by the round schema rather than stored. Tolerating
 * the key here keeps existing callers that still pass it compiling while the
 * stored round shape matches the original (provider/url, no requestSummary).
 */
export type LlmDebugRoundInput = Omit<z.input<typeof LlmDebugRoundSchema>, "id" | "durationMs"> & {
  requestSummary?: unknown;
};

/** Fields that may be patched onto an in-flight round when it finishes. */
export interface LlmDebugRoundUpdate {
  finishedAt?: string;
  stopReason?: LlmStopReason;
  usage?: z.input<typeof UsageSnapshotSchema>;
  error?: string;
  /** Literal request body captured for the round. */
  requestBody?: unknown;
  /** Accumulated raw model output (text/reasoning/toolCalls/usage/...). */
  output?: z.input<typeof LlmDebugOutputSchema>;
}

export interface LlmDebugRecorderOptions {
  /** Max retained rounds (>= 1). Defaults to 25. */
  capacity?: number;
}

export interface LlmDebugListFilter {
  threadId?: string;
}

/**
 * Fixed-capacity (25 rounds), in-memory ring buffer of recent LLM rounds for
 * live debugging. Carries provider/model/url plus usage/timing, and — as a
 * debug-only sink — the literal request body and accumulated raw output
 * (assistant text/reasoning/tool calls) for the troubleshooting view. Because
 * it captures payloads it may hold user content; it is never persisted (the
 * buffer resets on restart) and stays gated behind the recorder's capacity.
 *
 * Faithful port of the original LlmDebugRecorder adapted to provider-agnostic
 * round metadata.
 */
export class LlmDebugRecorder {
  private readonly rounds: LlmDebugRound[] = [];
  private readonly byId = new Map<number, LlmDebugRound>();
  private readonly capacity: number;
  private nextId = 1;

  constructor(options: LlmDebugRecorderOptions = {}) {
    const requested = options.capacity ?? DEFAULT_CAPACITY;
    this.capacity = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_CAPACITY;
  }

  /**
   * Append a (typically in-flight) round and return it with its assigned `id`.
   * The returned object is the stored instance; use `update(id, ...)` to patch
   * completion fields. Validated through zod so malformed input is rejected at
   * the boundary rather than corrupting the buffer.
   */
  record(input: LlmDebugRoundInput): LlmDebugRound {
    const round = LlmDebugRoundSchema.parse({ ...input, id: this.nextId++ });
    if (round.finishedAt && round.durationMs === undefined) {
      round.durationMs = this.computeDuration(round.startedAt, round.finishedAt);
    }
    this.rounds.push(round);
    this.byId.set(round.id, round);
    while (this.rounds.length > this.capacity) {
      const evicted = this.rounds.shift();
      if (evicted) this.byId.delete(evicted.id);
    }
    return round;
  }

  /**
   * Patch completion fields onto a previously recorded round. `durationMs` is
   * derived from `finishedAt` when not already set. Returns the updated round,
   * or `undefined` if the id was already evicted from the buffer.
   */
  update(id: number, patch: LlmDebugRoundUpdate): LlmDebugRound | undefined {
    const round = this.byId.get(id);
    if (!round) return undefined;
    if (patch.finishedAt !== undefined) round.finishedAt = patch.finishedAt;
    if (patch.stopReason !== undefined) round.stopReason = patch.stopReason;
    if (patch.error !== undefined) round.error = patch.error;
    if (patch.usage !== undefined) round.usage = UsageSnapshotSchema.parse(patch.usage);
    if (patch.requestBody !== undefined) round.requestBody = patch.requestBody;
    if (patch.output !== undefined) round.output = LlmDebugOutputSchema.parse(patch.output);
    if (round.finishedAt) {
      round.durationMs = this.computeDuration(round.startedAt, round.finishedAt);
    }
    return round;
  }

  /**
   * Mark a round finished with the given completion metadata. Convenience over
   * `update` for the common "round just ended" path; defaults `finishedAt` to
   * now when the caller does not supply one.
   */
  finish(id: number, patch: LlmDebugRoundUpdate = {}): LlmDebugRound | undefined {
    return this.update(id, { finishedAt: new Date().toISOString(), ...patch });
  }

  /** Recent rounds, newest-first, optionally filtered by thread. Returns copies. */
  list(filter: LlmDebugListFilter = {}): LlmDebugRound[] {
    const out: LlmDebugRound[] = [];
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const round = this.rounds[i];
      if (filter.threadId !== undefined && round.threadId !== filter.threadId) continue;
      out.push({ ...round });
    }
    return out;
  }

  /** Empty the buffer (e.g. between debug sessions). */
  clear(): void {
    this.rounds.length = 0;
    this.byId.clear();
  }

  private computeDuration(startedAt: string, finishedAt: string): number {
    const start = Date.parse(startedAt);
    const end = Date.parse(finishedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return 0;
    return Math.max(0, end - start);
  }
}
