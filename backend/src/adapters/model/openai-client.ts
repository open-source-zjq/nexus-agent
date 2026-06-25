import type { ModelClient, ModelRequest, ModelStreamChunk, ModelHistoryItem } from "../../ports/model-client.js";
import type { UsageSnapshot } from "../../contracts/usage.js";
import {
  buildEndpointUrl,
  sortedToolSpecs,
  parseToolArguments,
  mergeUsageSnapshots,
  streamSseData,
  applyHeaderOverrides,
  ModelStreamError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  modelPayloadError,
  attachImagesToLatestUserMessage,
  attachTextFallbacksToLatestUserMessage,
  requestAttachments,
  requestAttachmentTextFallbacks,
} from "./shared.js";
import { classifyModelHttpErrorWithProbe } from "./model-error-probe.js";

export interface OpenAiClientConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

/**
 * Optional request fields that OpenAI-compatible third-party gateways may reject
 * (DeepSeek/Qwen/GLM and friends). When a 400/422 names one of these we strip it
 * and retry, so an over-eager extra field never hard-fails an otherwise valid turn.
 */
interface DropFlags {
  streamUsage: boolean;
  reasoningEffort: boolean;
  sampling: boolean;
}

/** OpenAI Chat Completions streaming client. */
export class OpenAiClient implements ModelClient {
  readonly providerId: string;
  private readonly config: OpenAiClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly idleTimeoutMs: number;

  constructor(config: OpenAiClientConfig) {
    this.providerId = config.providerId;
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    if (request.abortSignal.aborted) {
      yield { kind: "error", message: "request was aborted before start", code: "aborted" };
      return;
    }
    if (!this.config.apiKey) {
      yield { kind: "error", message: `no API key configured for provider "${this.providerId}"`, code: "no_api_key" };
      return;
    }

    const url = buildEndpointUrl(this.config.baseUrl, "chat/completions");
    const headers = applyHeaderOverrides(
      {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      this.config.headers,
    );

    const drop: DropFlags = { streamUsage: false, reasoningEffort: false, sampling: false };
    // One initial attempt + up to one retry per droppable field.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const body = this.buildBody(request, drop);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.abortSignal,
        });
      } catch (error) {
        yield { kind: "error", message: `model request failed: ${(error as Error).message}`, code: "request_failed" };
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if ((response.status === 400 || response.status === 422) && markDroppableParams(text, drop)) {
          continue;
        }
        const classified = await classifyModelHttpErrorWithProbe({
          status: response.status,
          body: text,
          providerId: this.providerId,
          baseUrl: this.config.baseUrl,
          fetchImpl: this.fetchImpl,
        });
        yield { kind: "error", message: classified.message, code: classified.code };
        return;
      }

      // Non-streaming materialization: a request that opted out of SSE, or a
      // provider that answered an application/json body, is materialized into the
      // same chunk sequence as the streaming path.
      const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
      if (request.stream === false || isJson) {
        let json: unknown;
        try {
          json = await response.json();
        } catch (error) {
          yield { kind: "error", message: `model response was not valid JSON: ${(error as Error).message}`, code: "bad_json" };
          return;
        }
        yield* this.materializeNonStreaming(json, request.model);
        return;
      }

      if (!response.body) {
        yield { kind: "error", message: "model response had no body", code: "no_body" };
        return;
      }
      yield* this.parseStream(response.body, request);
      return;
    }
  }

  /** Materialize a non-streaming chat-completions JSON body into completion chunks. */
  private *materializeNonStreaming(payload: unknown, model: string): Iterable<ModelStreamChunk> {
    const payloadError = modelPayloadError(payload);
    if (payloadError) {
      yield { kind: "error", message: payloadError.message, ...(payloadError.code ? { code: payloadError.code } : {}) };
      return;
    }
    const root = (payload ?? {}) as any;
    const choice = root.choices?.[0];
    if (!choice) {
      yield { kind: "error", message: "model response contained no choices", code: "no_choices" };
      return;
    }
    const message = choice.message ?? {};
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
    if (reasoning) yield { kind: "assistant_reasoning_delta", text: reasoning };
    const text = typeof message.content === "string" ? message.content : "";
    if (text) yield { kind: "assistant_text_delta", text };
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.function?.name) continue;
        yield {
          kind: "tool_call_complete",
          callId: call.id,
          toolName: call.function.name,
          arguments: parseToolArguments(call.function?.arguments ?? "{}"),
        };
      }
    }
    if (root.usage) yield { kind: "usage", usage: mapOpenAiUsage(root.usage, model) };
    yield { kind: "completed", stopReason: mapStopReason(choice.finish_reason) };
  }

  private buildBody(request: ModelRequest, drop: DropFlags): Record<string, unknown> {
    const stream = request.stream ?? true;
    const messages = assembleOpenAiMessages(request);
    const body: Record<string, unknown> = { model: request.model, stream, messages };
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (request.temperature != null && !drop.sampling) body.temperature = request.temperature;
    if (request.topP != null && !drop.sampling) body.top_p = request.topP;
    if (request.responseFormat === "json_object") body.response_format = { type: "json_object" };
    if (stream && !drop.streamUsage) body.stream_options = { include_usage: true };
    this.applyReasoningEffort(body, request, drop);
    if (request.tools.length > 0) {
      body.tools = sortedToolSpecs(request.tools).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
      if (request.requiredToolName) {
        body.tool_choice = { type: "function", function: { name: request.requiredToolName } };
      }
    }
    return body;
  }

  /**
   * Map the request's reasoning effort onto the chat-completions wire fields,
   * faithful to the original applyReasoningEffort / applyDeepSeekChatReasoningEffort /
   * applyGlmChatReasoningEffort / applyMimoChatReasoningEffort dispatch.
   *
   * The protocol family is carried structurally via `request.reasoningProtocol`
   * (resolveModelContextProfile's requestProtocol hint). `includeThinking` is
   * suppressed only on Azure OpenAI endpoints, which reject the `thinking`
   * companion. The `drop.reasoningEffort` flag still gates the `reasoning_effort`
   * field so an over-eager extra never hard-fails the retry path.
   */
  private applyReasoningEffort(body: Record<string, unknown>, request: ModelRequest, drop: DropFlags): void {
    const effort = request.reasoningEffort;
    const includeThinking = !isAzureOpenAiEndpoint(this.config.baseUrl);
    const setReasoningEffort = (value: string): void => {
      if (!drop.reasoningEffort) body.reasoning_effort = value;
    };
    const protocol = request.reasoningProtocol as string | undefined;
    if (protocol === "glm-thinking" || protocol === "glm-chat-completions") {
      // GLM speaks `thinking: { type: enabled|disabled, clear_thinking: true }`
      // instead of reasoning_effort. `auto`/unset emits nothing.
      if (!includeThinking || effort == null || effort === "auto") return;
      body.thinking = { type: effort === "off" ? "disabled" : "enabled", clear_thinking: true };
      return;
    }
    if (protocol === "mimo-chat-completions") {
      // MiMo speaks reasoning_effort low|medium|high plus thinking:{type}.
      if (effort === "off") {
        if (includeThinking) body.thinking = { type: "disabled" };
        return;
      }
      if (effort === "low" || effort === "medium" || effort === "high") {
        setReasoningEffort(effort);
        if (includeThinking) body.thinking = { type: "enabled" };
      }
      return;
    }
    if (protocol === "deepseek-chat-completions") {
      // DeepSeek: off -> disable thinking; max -> reasoning_effort "max"; any
      // other non-auto effort -> reasoning_effort "high". Thinking is enabled for
      // every non-auto effort.
      if (effort === "off") {
        if (includeThinking) body.thinking = { type: "disabled" };
        return;
      }
      if (effort === "max") setReasoningEffort("max");
      else if (effort != null && effort !== "auto") setReasoningEffort("high");
      if (includeThinking && effort != null && effort !== "auto") body.thinking = { type: "enabled" };
      return;
    }
    // Default (openai-chat / undefined profile): low|medium|high all send
    // reasoning_effort "high"; max sends "high" (the non-Nexus maxReasoningEffort);
    // off disables thinking. Thinking is enabled alongside the effort.
    switch (effort) {
      case "off":
        if (includeThinking) body.thinking = { type: "disabled" };
        break;
      case "low":
      case "medium":
      case "high":
        setReasoningEffort("high");
        if (includeThinking) body.thinking = { type: "enabled" };
        break;
      case "max":
        setReasoningEffort("high");
        if (includeThinking) body.thinking = { type: "enabled" };
        break;
      default:
        break;
    }
  }

  private async *parseStream(body: ReadableStream<Uint8Array>, request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const pending = new Map<string, { name: string; args: string }>();
    const byIndex = new Map<number, string>();
    let usage: UsageSnapshot | undefined;
    let finishReason: string | undefined;

    try {
      for await (const data of streamSseData(body, request.abortSignal, this.idleTimeoutMs)) {
        if (data === "[DONE]") {
          finishReason = finishReason ?? "stop";
          break;
        }
        let payload: any;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        const payloadError = modelPayloadError(payload);
        if (payloadError) {
          yield { kind: "error", message: payloadError.message, code: payloadError.code ?? "provider_error" };
          finishReason = "error";
          continue;
        }
        const choice = payload.choices?.[0];
        if (choice) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { kind: "assistant_text_delta", text: delta.content };
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            yield { kind: "assistant_reasoning_delta", text: reasoning };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const callId = resolveToolCallId(call, byIndex, pending);
              const entry = pending.get(callId)!;
              if (call.function?.name) entry.name = call.function.name;
              const argDelta = call.function?.arguments ?? "";
              if (argDelta) entry.args += argDelta;
              yield { kind: "tool_call_delta", callId, toolName: entry.name || undefined, argumentsDelta: argDelta };
            }
          }
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        }
        if (payload.usage) usage = mergeUsageSnapshots(usage, mapOpenAiUsage(payload.usage, request.model));
      }
    } catch (error) {
      if (error instanceof ModelStreamError) {
        yield { kind: "error", message: error.message, code: error.code };
        return;
      }
      throw error;
    }

    if (request.abortSignal.aborted) {
      yield { kind: "error", message: "request was aborted", code: "aborted" };
      return;
    }

    // Faithful to consumeStreamPayload: the chat path only materializes pending
    // tool calls when the finish frame reports finish_reason === "tool_calls".
    // A stream that dribbled partial/aborted tool-call deltas but finished with a
    // different reason ("stop"/"length") yields no tool calls.
    if (finishReason === "tool_calls") {
      for (const [callId, entry] of pending) {
        if (entry.name) {
          yield { kind: "tool_call_complete", callId, toolName: entry.name, arguments: parseToolArguments(entry.args) };
        }
      }
    }
    if (usage) yield { kind: "usage", usage };
    yield { kind: "completed", stopReason: mapStopReason(finishReason) };
  }
}

/**
 * A tool-call delta `index` is only valid when it is a non-negative integer.
 * Faithful port of the original `numericIndex`: a negative or fractional index
 * is treated as absent (returns undefined). Returning undefined makes callers
 * fall through to the id/synthetic-slot resolution rather than keying off a
 * bogus index slot.
 */
function numericIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function resolveToolCallId(
  call: any,
  byIndex: Map<number, string>,
  pending: Map<string, { name: string; args: string }>,
): string {
  const index = numericIndex(call.index);
  if (typeof call.id === "string" && call.id.length > 0) {
    const realId = call.id;
    if (index !== undefined && byIndex.has(index)) {
      const prevId = byIndex.get(index)!;
      if (prevId !== realId && pending.has(prevId)) {
        pending.set(realId, pending.get(prevId)!);
        pending.delete(prevId);
      }
    }
    if (!pending.has(realId)) pending.set(realId, { name: "", args: "" });
    if (index !== undefined) byIndex.set(index, realId);
    return realId;
  }
  if (index !== undefined) {
    const existing = byIndex.get(index);
    if (existing) return existing;
    const synthetic = `call_${index}`;
    byIndex.set(index, synthetic);
    if (!pending.has(synthetic)) pending.set(synthetic, { name: "", args: "" });
    return synthetic;
  }
  const fallback = `call_${pending.size}`;
  if (!pending.has(fallback)) pending.set(fallback, { name: "", args: "" });
  return fallback;
}

/**
 * Inspect a 400/422 error body and flag any offending optional field so the next
 * attempt omits it. Returns true if a not-yet-dropped field was newly flagged
 * (i.e. a retry is worthwhile).
 */
function markDroppableParams(text: string, drop: DropFlags): boolean {
  let changed = false;
  if (!drop.streamUsage && /\b(stream_options|include_usage)\b/i.test(text)) {
    drop.streamUsage = true;
    changed = true;
  }
  if (!drop.reasoningEffort && /reasoning_effort/i.test(text)) {
    drop.reasoningEffort = true;
    changed = true;
  }
  if (!drop.sampling && /\b(temperature|top_p)\b/i.test(text)) {
    drop.sampling = true;
    changed = true;
  }
  return changed;
}

/**
 * True when the base URL points at an Azure OpenAI deployment. Faithful port of
 * the original isAzureOpenAiEndpoint: Azure endpoints reject the `thinking`
 * companion field, so the reasoning mapper suppresses it there.
 */
function isAzureOpenAiEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
  } catch {
    return /\.openai\.azure\.com\b|\.cognitiveservices\.azure\.com\b/i.test(baseUrl);
  }
}

function mapStopReason(finishReason: string | undefined): "stop" | "tool_calls" | "length" | "error" {
  if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_calls";
  if (finishReason === "length") return "length";
  if (finishReason === "error") return "error";
  return "stop";
}

export function mapOpenAiUsage(raw: any, model: string): UsageSnapshot {
  const promptTokens = Number(raw.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(raw.completion_tokens ?? 0) || 0;
  const cacheReadTokens = Number(raw.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const reasoningTokens = Number(raw.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  // Cache hit/miss derivation, faithful to the original mapUsage(): the cached
  // prompt fraction is the hit, the remainder of the prompt is the miss, and the
  // hit rate is the hit over the prompt total. A provider that reports native
  // hit/miss counts (prompt_cache_hit_tokens / prompt_cache_miss_tokens) wins.
  const nativeHit = Number(raw.prompt_cache_hit_tokens ?? 0) || 0;
  const nativeMiss = Number(raw.prompt_cache_miss_tokens ?? 0) || 0;
  const hasNativeCache = nativeHit > 0 || nativeMiss > 0;
  const cacheHit = hasNativeCache ? nativeHit : cacheReadTokens;
  const cacheMiss = hasNativeCache ? nativeMiss : Math.max(promptTokens - cacheHit, 0);
  const cacheTotal = cacheHit + cacheMiss;
  const cacheHitRate = cacheTotal === 0 ? null : cacheHit / cacheTotal;
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens: Number(raw.total_tokens ?? promptTokens + completionTokens) || 0,
    cacheReadTokens: cacheHit || undefined,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    cacheHitRate,
    reasoningTokens: reasoningTokens || undefined,
  };
}

function toolResultContent(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Some OpenAI-compatible reasoner gateways (DeepSeek reasoner, GLM thinking)
 * 400 any follow-up turn whose prior assistant messages drop `reasoning_content`
 * while thinking is active. When that protocol is in play and reasoning is on,
 * every assistant message must carry a non-empty reasoning_content (>= 1 space).
 */
function requiresReasoningRoundTrip(request: ModelRequest): boolean {
  const protocol = request.reasoningProtocol as string | undefined;
  if (
    protocol !== "deepseek-chat-completions" &&
    protocol !== "glm-thinking" &&
    protocol !== "mimo-chat-completions"
  ) {
    return false;
  }
  const effort = request.reasoningEffort;
  return effort != null && effort !== "off" && effort !== "auto";
}

/** Reasoning text falls back to a single space so the reasoner gateway never 400s an empty field. */
function reasoningContentOrSpace(text: string): string {
  return text.trim() ? text : " ";
}

/**
 * True when `history[index]` is an assistant_reasoning/assistant_text item that
 * is only a "bridge" leading into a following tool_call (with optional further
 * reasoning/text in between). Such items are hoisted into the tool_call assistant
 * message and must be skipped here so they are not emitted twice. Faithful port
 * of the original `isBridgeItemBeforeToolCall` (turnId checks collapse to
 * contiguity since the canonical history groups a turn's items contiguously).
 */
function isBridgeItemBeforeToolCall(history: ModelHistoryItem[], index: number): boolean {
  const item = history[index];
  if (!item || (item.kind !== "assistant_reasoning" && item.kind !== "assistant_text")) return false;
  let cursor = index + 1;
  while (cursor < history.length) {
    const next = history[cursor];
    if (!next) return false;
    if (next.kind === "assistant_reasoning" || next.kind === "assistant_text") {
      cursor += 1;
      continue;
    }
    return next.kind === "tool_call";
  }
  return false;
}

/**
 * In thinking mode, ensure every assistant message carries a non-empty
 * `reasoning_content`. Faithful port of `normalizeThinkingAssistantMessages`.
 */
function normalizeThinkingAssistantMessages(messages: OpenAiMessage[], thinkingMode: boolean): OpenAiMessage[] {
  if (!thinkingMode) return messages;
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const next = { ...message };
    if (next.content == null) next.content = "";
    if (
      next.reasoning_content == null ||
      typeof next.reasoning_content !== "string" ||
      !next.reasoning_content.trim()
    ) {
      next.reasoning_content = " ";
    }
    return next;
  });
}

/** Assemble OpenAI chat messages from system prompt + canonical history. */
export function assembleOpenAiMessages(request: ModelRequest): OpenAiMessage[] {
  const history = request.history;
  const historyHasReasoning = history.some(
    (item) => item.kind === "assistant_reasoning" && typeof item.text === "string" && item.text.trim() !== "",
  );
  const thinkingMode = historyHasReasoning || requiresReasoningRoundTrip(request);

  const messages: OpenAiMessage[] = [];
  if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
  if (request.modeInstruction) messages.push({ role: "system", content: request.modeInstruction });

  const results = new Map<string, ModelHistoryItem & { kind: "tool_result" }>();
  for (const item of history) {
    if (item.kind === "tool_result") results.set(item.callId, item);
  }

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (isBridgeItemBeforeToolCall(history, i)) continue;

    // Reasoning replay: pair stored reasoning with the following assistant_text and
    // emit the actual prior reasoning text as reasoning_content.
    if (thinkingMode && item.kind === "assistant_reasoning") {
      const next = history[i + 1];
      if (next && next.kind === "assistant_text") {
        messages.push({ role: "assistant", content: next.text, reasoning_content: reasoningContentOrSpace(item.text) });
        i += 1;
      }
      continue;
    }

    if (item.kind === "tool_call") {
      // Faithful port of toolCallBlockToMessages: hoist preceding bridge text,
      // collect the run of tool_calls, then walk forward over the interleaved
      // tool_results (and any pre-result bridge text), folding pre-result
      // assistant_text/reasoning into the assistant message. The block is dropped
      // entirely if not every tool_call has a matching tool_result.
      const assistantText: string[] = [];
      const reasoningText: string[] = [];
      let bridge = i - 1;
      while (bridge >= 0) {
        const prev = history[bridge];
        if (!prev || (prev.kind !== "assistant_reasoning" && prev.kind !== "assistant_text")) break;
        if (prev.kind === "assistant_text" && prev.text.trim()) assistantText.unshift(prev.text);
        else if (prev.kind === "assistant_reasoning" && prev.text.trim()) reasoningText.unshift(prev.text);
        bridge -= 1;
      }

      const run: Array<ModelHistoryItem & { kind: "tool_call" }> = [];
      let cursor = i;
      while (cursor < history.length && history[cursor].kind === "tool_call") {
        run.push(history[cursor] as ModelHistoryItem & { kind: "tool_call" });
        cursor += 1;
      }

      // Forward walk: consume tool_results for this block, and fold any
      // assistant_text/reasoning that appears before the first result (the
      // pre-result bridge) into the assistant message rather than re-emitting it.
      const expectedCallIds = new Set(run.map((call) => call.callId));
      const seenResultIds = new Set<string>();
      const resultMessages: OpenAiMessage[] = [];
      let sawResult = false;
      while (cursor < history.length) {
        const next = history[cursor];
        if (!next) break;
        if (next.kind === "tool_result") {
          sawResult = true;
          if (expectedCallIds.has(next.callId) && !seenResultIds.has(next.callId)) {
            seenResultIds.add(next.callId);
            resultMessages.push({ role: "tool", tool_call_id: next.callId, content: toolResultContent(next.output) });
          }
          cursor += 1;
          continue;
        }
        if (next.kind === "assistant_reasoning" || next.kind === "assistant_text") {
          // assistant_text is only a bridge before any result is seen; reasoning
          // is consumed in either case but only folded pre-result.
          if (next.kind === "assistant_text" && sawResult) break;
          if (!sawResult) {
            if (next.kind === "assistant_text" && next.text.trim()) assistantText.push(next.text);
            else if (next.kind === "assistant_reasoning" && next.text.trim()) reasoningText.push(next.text);
          }
          cursor += 1;
          continue;
        }
        break;
      }

      // Drop the whole block when a result is missing (the original returns null,
      // emitting no messages and re-processing the items individually). Upstream
      // repair normally prevents this, so it is a defensive fidelity guard.
      const allResultsPresent = [...expectedCallIds].every((callId) => seenResultIds.has(callId));
      if (!allResultsPresent) {
        // Skip past the consumed run only; leave bridge/result items for the
        // individual passes (matching the original's null-return semantics where
        // the for-loop advances one item at a time).
        continue;
      }

      i = cursor - 1;
      messages.push({
        role: "assistant",
        content: assistantText.length > 0 ? assistantText.join("\n") : "",
        ...(thinkingMode ? { reasoning_content: reasoningContentOrSpace(reasoningText.join("\n")) } : {}),
        tool_calls: run.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
        })),
      });
      messages.push(...resultMessages);
      continue;
    }
    if (item.kind === "tool_result") continue;
    if (item.kind === "assistant_reasoning") continue;
    if (item.kind === "compaction") {
      messages.push({ role: "system", content: `Conversation summary from earlier turns:\n${item.summary}` });
      continue;
    }
    if (item.kind === "review") {
      messages.push({ role: "system", content: `Code review result from an earlier turn:\n${item.reviewText}` });
      continue;
    }
    if (item.kind === "user_message") {
      if (item.images && item.images.length > 0) {
        const parts: Array<Record<string, unknown>> = [{ type: "text", text: item.text }];
        for (const image of item.images) {
          parts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } });
        }
        messages.push({ role: "user", content: parts });
      } else {
        messages.push({ role: "user", content: item.text });
      }
      continue;
    }
    if (item.kind === "assistant_text") {
      messages.push({
        role: "assistant",
        content: item.text,
        ...(thinkingMode ? { reasoning_content: " " } : {}),
      });
      continue;
    }
  }

  for (const instruction of request.contextInstructions ?? []) {
    if (instruction.trim().length > 0) messages.push({ role: "system", content: instruction });
  }

  // Multimodal: attach this turn's resolved images (or text fallbacks) to the
  // latest user message before normalizing thinking placeholders.
  const attachments = requestAttachments(request);
  if (attachments.length > 0) {
    attachImagesToLatestUserMessage(messages, attachments, (attachment) => ({
      type: "image_url",
      image_url: { url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` },
    }));
  }
  const textFallbacks = requestAttachmentTextFallbacks(request);
  if (textFallbacks.length > 0) {
    attachTextFallbacksToLatestUserMessage(messages, textFallbacks);
  }

  return normalizeThinkingAssistantMessages(messages, thinkingMode);
}
