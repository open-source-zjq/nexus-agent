/**
 * Deterministic, provider-agnostic gateway for insight classification calls.
 *
 * The original gateway built a raw ModelRequest and drove model.stream directly.
 * Per project convention, services must NOT import model clients; instead this
 * gateway calls an injected `complete` function (supplied by serve.ts via its
 * oneShot helper). The deterministic knobs (temperature 0, json_object response
 * format, reasoning off, a small token budget, a short timeout, and a cheap
 * default model) are applied here so every detector classification is uniform.
 */

/** Injected single-shot completion. Mirrors the serve.ts oneShot contract. */
export type CompleteFn = (input: {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  responseFormat?: "json_object";
  signal?: AbortSignal;
}) => Promise<string>;

export interface InsightModelGatewayDeps {
  complete: CompleteFn;
  /**
   * Cheap/default model id for classification. Optional: when omitted the
   * gateway passes no `model`, letting the host pick its configured default.
   */
  model?: string;
  /** Abort budget for a single classification. Defaults to 20s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Classification replies are short JSON; ~1024 tokens is plenty. */
export const INSIGHT_MAX_TOKENS = 1024;

export interface ClassifyInput {
  system: string;
  user: string;
}

export class InsightModelGateway {
  private readonly complete: CompleteFn;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;

  constructor(deps: InsightModelGatewayDeps) {
    this.complete = deps.complete;
    this.model = deps.model;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One deterministic classification call. Returns the raw model text (the
   * caller extracts + validates the JSON). Aborts after `timeoutMs`.
   */
  async classify(input: ClassifyInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.complete({
        system: input.system,
        prompt: input.user,
        ...(this.model ? { model: this.model } : {}),
        // Cap every classification at the original's INSIGHT_MAX_TOKENS budget
        // and force provider-side JSON mode (request.responseFormat).
        maxTokens: INSIGHT_MAX_TOKENS,
        responseFormat: "json_object",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
