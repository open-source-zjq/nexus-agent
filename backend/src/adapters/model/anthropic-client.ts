import type { ModelClient, ModelRequest, ModelStreamChunk, ModelHistoryItem } from "../../ports/model-client.js";
import type { UsageSnapshot } from "../../contracts/usage.js";
import {
  buildEndpointUrl,
  sortedToolSpecs,
  parseToolArguments,
  streamSseData,
  applyHeaderOverrides,
  ModelStreamError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  modelPayloadError,
  formatAttachmentTextFallback,
  requestAttachments,
  requestAttachmentTextFallbacks,
} from "./shared.js";
import { classifyModelHttpErrorWithProbe } from "./model-error-probe.js";

export interface AnthropicClientConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
  anthropicVersion?: string;
}

const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}
interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

/** Anthropic Messages streaming client. */
export class AnthropicClient implements ModelClient {
  readonly providerId: string;
  private readonly config: AnthropicClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly idleTimeoutMs: number;

  constructor(config: AnthropicClientConfig) {
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

    const url = buildEndpointUrl(this.config.baseUrl, "messages");
    const headers = applyHeaderOverrides(
      {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
        "x-api-key": this.config.apiKey,
        "anthropic-version": this.config.anthropicVersion ?? "2023-06-01",
      },
      this.config.headers,
    );

    const body = this.buildBody(request);
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
  }

  /** Materialize a non-streaming Anthropic Messages JSON body into completion chunks. */
  private *materializeNonStreaming(payload: unknown, model: string): Iterable<ModelStreamChunk> {
    const payloadError = modelPayloadError(payload);
    if (payloadError) {
      yield { kind: "error", message: payloadError.message, ...(payloadError.code ? { code: payloadError.code } : {}) };
      return;
    }
    const root = (payload ?? {}) as any;
    let sawToolCall = false;
    for (const block of Array.isArray(root.content) ? root.content : []) {
      const type = block?.type;
      if (type === "text") {
        if (typeof block.text === "string" && block.text) yield { kind: "assistant_text_delta", text: block.text };
      } else if (type === "thinking") {
        if (typeof block.thinking === "string" && block.thinking) yield { kind: "assistant_reasoning_delta", text: block.thinking };
      } else if (type === "tool_use") {
        const callId = typeof block.id === "string" ? block.id : "";
        const toolName = typeof block.name === "string" ? block.name : "";
        if (callId && toolName) {
          sawToolCall = true;
          yield {
            kind: "tool_call_complete",
            callId,
            toolName,
            arguments: block.input && typeof block.input === "object" ? block.input : {},
          };
        }
      }
    }
    if (root.usage) {
      yield {
        kind: "usage",
        usage: mergeAnthropicUsage({ model, promptTokens: 0, completionTokens: 0, totalTokens: 0 }, root.usage, model),
      };
    }
    const mapped = mapAnthropicStopReason(typeof root.stop_reason === "string" ? root.stop_reason : undefined);
    yield { kind: "completed", stopReason: mapped === "stop" && sawToolCall ? "tool_calls" : mapped };
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const stream = request.stream ?? true;
    const { system, messages } = assembleAnthropicMessages(request);
    applyAnthropicCacheControl(messages);
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const body: Record<string, unknown> = { model: request.model, stream, max_tokens: maxTokens, messages };
    // Anthropic has no native JSON mode; under responseFormat === "json_object"
    // the original appends "Return a valid JSON object only." to the system text.
    const systemText =
      request.responseFormat === "json_object"
        ? [system, "Return a valid JSON object only."].filter((item) => item.trim().length > 0).join("\n\n")
        : system;
    if (systemText.trim().length > 0) {
      body.system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
    }
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;

    // Thinking is enabled ONLY under the anthropic-thinking request protocol, and
    // emits `{ type: "adaptive" }` (or "disabled" for effort off) with NO
    // budget_tokens and no max_tokens change. Faithful port of
    // applyAnthropicReasoningEffort.
    if (request.reasoningProtocol === "anthropic-thinking") {
      const resolved = normalizeReasoningEffortValue(request.reasoningEffort);
      if (resolved) {
        body.thinking = { type: resolved === "off" ? "disabled" : "adaptive" };
      }
    }

    if (request.tools.length > 0) {
      body.tools = sortedToolSpecs(request.tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      if (request.requiredToolName) body.tool_choice = { type: "tool", name: request.requiredToolName };
    }
    return body;
  }

  private async *parseStream(body: ReadableStream<Uint8Array>, request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const pendingByIndex = new Map<number, { id: string; name: string; args: string }>();
    let usage: UsageSnapshot = { model: request.model, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let sawUsage = false;
    let finishReason: string | undefined;

    try {
      for await (const data of streamSseData(body, request.abortSignal, this.idleTimeoutMs)) {
        let payload: any;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        // Some gateways tunnel a provider error inside an otherwise-200 SSE frame
        // using non-Anthropic shapes (base_resp / top-level code+message). The
        // native `type: "error"` frame is still handled by the switch below.
        if (payload.type !== "error") {
          const payloadError = modelPayloadError(payload);
          if (payloadError) {
            yield { kind: "error", message: payloadError.message, code: payloadError.code ?? "provider_error" };
            finishReason = "error";
            continue;
          }
        }
        switch (payload.type) {
          case "message_start": {
            const u = payload.message?.usage;
            if (u) {
              usage = mergeAnthropicUsage(usage, u, request.model);
              sawUsage = true;
            }
            break;
          }
          case "content_block_start": {
            const block = payload.content_block;
            if (block?.type === "tool_use") {
              pendingByIndex.set(payload.index, {
                id: block.id,
                name: block.name,
                args: block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const delta = payload.delta;
            if (delta?.type === "text_delta" && delta.text) {
              yield { kind: "assistant_text_delta", text: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { kind: "assistant_reasoning_delta", text: delta.thinking };
            } else if (delta?.type === "input_json_delta") {
              const entry = pendingByIndex.get(payload.index);
              if (entry) {
                entry.args += delta.partial_json ?? "";
                yield {
                  kind: "tool_call_delta",
                  callId: entry.id,
                  toolName: entry.name,
                  argumentsDelta: delta.partial_json ?? "",
                };
              }
            }
            break;
          }
          case "content_block_stop": {
            const entry = pendingByIndex.get(payload.index);
            if (entry && entry.name) {
              yield {
                kind: "tool_call_complete",
                callId: entry.id,
                toolName: entry.name,
                arguments: parseToolArguments(entry.args || "{}"),
              };
              pendingByIndex.delete(payload.index);
            }
            break;
          }
          case "message_delta": {
            if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
            if (payload.usage?.output_tokens != null) {
              usage = { ...usage, completionTokens: payload.usage.output_tokens };
              usage.totalTokens = usage.promptTokens + usage.completionTokens;
              sawUsage = true;
            }
            break;
          }
          case "message_stop": {
            finishReason = finishReason ?? "end_turn";
            break;
          }
          case "error": {
            yield {
              kind: "error",
              message: payload.error?.message ?? "anthropic stream error",
              code: "messages_stream_error",
            };
            finishReason = "error";
            break;
          }
          default:
            break;
        }
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
    if (sawUsage) yield { kind: "usage", usage };
    yield { kind: "completed", stopReason: mapAnthropicStopReason(finishReason) };
  }
}

/**
 * Normalize a reasoning-effort string to its canonical bucket, faithful to the
 * original normalizeReasoningEffortValue. Returns undefined for unrecognized
 * values (so the caller emits no thinking field).
 */
function normalizeReasoningEffortValue(
  effort: string | undefined,
): "auto" | "off" | "low" | "medium" | "high" | "max" | undefined {
  switch (effort?.trim().toLowerCase()) {
    case "auto":
    case "adaptive":
      return "auto";
    case "off":
    case "disabled":
    case "none":
    case "false":
      return "off";
    case "low":
    case "minimal":
      return "low";
    case "medium":
    case "mid":
      return "medium";
    case "high":
      return "high";
    case "max":
    case "maximum":
    case "xhigh":
      return "max";
    default:
      return undefined;
  }
}

function mapAnthropicStopReason(reason: string | undefined): "stop" | "tool_calls" | "length" | "error" {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "error") return "error";
  return "stop";
}

function mergeAnthropicUsage(current: UsageSnapshot, raw: any, model: string): UsageSnapshot {
  const cacheRead = Number(raw.cache_read_input_tokens ?? 0) || 0;
  const cacheCreation = Number(raw.cache_creation_input_tokens ?? 0) || 0;
  const input = (Number(raw.input_tokens ?? 0) || 0) + cacheRead + cacheCreation;
  const completion = Number(raw.output_tokens ?? current.completionTokens) || 0;
  const promptTokens = input || current.promptTokens;
  // Cache hit/miss derivation, faithful to the original mapUsage(): cached
  // (read) prompt tokens are the hit, the remainder of the prompt is the miss,
  // and the hit rate is the cached fraction of the prompt.
  const cacheHit = cacheRead || current.cacheHitTokens || 0;
  const cacheMiss = Math.max(promptTokens - cacheHit, 0);
  const cacheTotal = cacheHit + cacheMiss;
  const cacheHitRate = cacheTotal === 0 ? null : cacheHit / cacheTotal;
  return {
    model,
    promptTokens,
    completionTokens: completion,
    totalTokens: promptTokens + completion,
    cacheReadTokens: cacheRead || current.cacheReadTokens,
    cacheCreationTokens: cacheCreation || current.cacheCreationTokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    cacheHitRate,
  };
}

function toolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Apply up to 2 ephemeral cache breakpoints on the most recent array-content messages. */
function applyAnthropicCacheControl(messages: AnthropicMessage[]): void {
  let applied = 0;
  for (let i = messages.length - 1; i >= 0 && applied < 2; i -= 1) {
    const content = messages[i].content;
    if (content.length === 0) continue;
    const last = content[content.length - 1];
    last.cache_control = { type: "ephemeral" };
    applied += 1;
  }
}

export function assembleAnthropicMessages(request: ModelRequest): { system: string; messages: AnthropicMessage[] } {
  // Only the leading system messages (systemPrompt / modeInstruction, emitted
  // before any history message) go into the Anthropic top-level `system`. Per-turn
  // contextInstructions arrive after the history, so they are folded as a trailing
  // text block on the last user message below (faithful to messagesToAnthropic's
  // appendTrailingInstruction branch when out.length > 0).
  const systemParts: string[] = [];
  if (request.systemPrompt) systemParts.push(request.systemPrompt);
  if (request.modeInstruction) systemParts.push(request.modeInstruction);

  // Reasoning round-trip: under the anthropic-thinking protocol the stored
  // reasoning replays as a leading {type:'thinking'} block on the following
  // same-turn assistant message. Faithful port of `messagesToAnthropic`'s
  // `includeThinkingBlocks` branch.
  const includeThinkingBlocks = request.reasoningProtocol === "anthropic-thinking";

  const results = new Map<string, ModelHistoryItem & { kind: "tool_result" }>();
  for (const item of request.history) {
    if (item.kind === "tool_result") results.set(item.callId, item);
  }

  const raw: AnthropicMessage[] = [];
  const history = request.history;
  // Holds a reasoning text waiting to be prepended to the next assistant message.
  let pendingThinking: string | undefined;
  const thinkingBlocks = (): AnthropicBlock[] => {
    if (!includeThinkingBlocks) {
      pendingThinking = undefined;
      return [];
    }
    const thinking = pendingThinking?.trim();
    pendingThinking = undefined;
    return thinking ? [{ type: "thinking", thinking }] : [];
  };

  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (item.kind === "tool_call") {
      const lead = thinkingBlocks();
      const run: Array<ModelHistoryItem & { kind: "tool_call" }> = [];
      while (i < history.length && history[i].kind === "tool_call") {
        run.push(history[i] as ModelHistoryItem & { kind: "tool_call" });
        i += 1;
      }
      i -= 1;
      raw.push({
        role: "assistant",
        content: [
          ...lead,
          ...run.map((call) => ({ type: "tool_use", id: call.callId, name: call.toolName, input: call.arguments })),
        ],
      });
      raw.push({
        role: "user",
        content: run.map((call) => {
          const result = results.get(call.callId);
          return {
            type: "tool_result",
            tool_use_id: call.callId,
            content: result ? toolResultText(result.output) : "",
            ...(result?.isError ? { is_error: true } : {}),
          };
        }),
      });
      continue;
    }
    if (item.kind === "tool_result") continue;
    if (item.kind === "assistant_reasoning") {
      // Stash the reasoning text; it is replayed as a thinking block on the next
      // assistant message. Without the thinking protocol, reasoning is dropped.
      if (includeThinkingBlocks && item.text.trim()) pendingThinking = item.text;
      continue;
    }
    if (item.kind === "compaction") {
      raw.push({ role: "user", content: [{ type: "text", text: `Conversation summary from earlier turns:\n${item.summary}` }] });
      continue;
    }
    if (item.kind === "review") {
      // A completed review from an earlier turn re-injected into the model
      // context. Faithful to the original itemToMessage "review" case.
      raw.push({ role: "user", content: [{ type: "text", text: `Code review result from an earlier turn:\n${item.reviewText}` }] });
      continue;
    }
    if (item.kind === "user_message") {
      const blocks: AnthropicBlock[] = [];
      if (item.text.length > 0) blocks.push({ type: "text", text: item.text });
      for (const image of item.images ?? []) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 } });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      raw.push({ role: "user", content: blocks });
      continue;
    }
    if (item.kind === "assistant_text") {
      raw.push({ role: "assistant", content: [...thinkingBlocks(), { type: "text", text: item.text }] });
      continue;
    }
  }

  // Per-turn context instructions land AFTER the history. When history exists
  // they fold as trailing {type:'text'} blocks on the last user message
  // (appendTrailingInstruction); with no history they extend the top-level system.
  const systemTexts = [...systemParts];
  for (const instruction of request.contextInstructions ?? []) {
    const text = instruction.trim();
    if (!text) continue;
    if (raw.length > 0) appendTrailingInstruction(raw, text);
    else systemTexts.push(text);
  }
  const finalSystem = systemTexts.join("\n\n");

  // Multimodal: attach this turn's resolved images / text fallbacks to the latest
  // user message. Faithful to attachImagesToLatestUserMessage / attachTextFallbacks,
  // emitting Anthropic image blocks (base64 source) and a trailing text block.
  attachAnthropicAttachments(raw, request);

  // No coalescing or leading-assistant removal: the original messagesToAnthropic
  // emits the message sequence as-built and relies on healToolMessagePairs for
  // pair integrity.
  return { system: finalSystem, messages: raw };
}

/**
 * Fold a trailing instruction onto the last user message as a {type:'text'}
 * block (or open a new trailing user message). Faithful port of
 * appendTrailingInstruction.
 */
function appendTrailingInstruction(out: AnthropicMessage[], text: string): void {
  const block: AnthropicBlock = { type: "text", text };
  const last = out[out.length - 1];
  if (last && last.role === "user") {
    last.content.push(block);
    return;
  }
  out.push({ role: "user", content: [block] });
}

/** Append the current turn's image attachments (and text fallbacks) to the latest user message. */
function attachAnthropicAttachments(messages: AnthropicMessage[], request: ModelRequest): void {
  const attachments = requestAttachments(request);
  const textFallbacks = requestAttachmentTextFallbacks(request);
  if (attachments.length === 0 && textFallbacks.length === 0) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    for (const attachment of attachments) {
      message.content.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.dataBase64 },
      });
    }
    if (textFallbacks.length > 0) {
      message.content.push({ type: "text", text: textFallbacks.map(formatAttachmentTextFallback).join("\n\n") });
    }
    return;
  }
}

