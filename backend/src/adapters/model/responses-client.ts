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
  formatAttachmentTextFallback,
  requestAttachments,
  requestAttachmentTextFallbacks,
} from "./shared.js";

export interface ResponsesClientConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
}

/** A Responses-protocol `input` item (system/developer/user/assistant message or function call / output). */
type ResponsesInputItem =
  | { role: "system" | "developer" | "user" | "assistant"; content: string | Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string; status: "completed" }
  | { type: "function_call_output"; call_id: string; output: string };

interface PendingCall {
  index: number | undefined;
  name: string | undefined;
  arguments: string;
}

/** OpenAI Responses-protocol streaming client. */
export class ResponsesClient implements ModelClient {
  readonly providerId: string;
  private readonly config: ResponsesClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly idleTimeoutMs: number;

  constructor(config: ResponsesClientConfig) {
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

    const url = buildEndpointUrl(this.config.baseUrl, "responses");
    const headers = applyHeaderOverrides(
      {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
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
      yield { kind: "error", message: this.httpErrorMessage(response.status, text), code: `http_${response.status}` };
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

  /** Materialize a non-streaming Responses JSON body into completion chunks. */
  private *materializeNonStreaming(payload: unknown, model: string): Iterable<ModelStreamChunk> {
    const payloadError = modelPayloadError(payload);
    if (payloadError) {
      yield { kind: "error", message: payloadError.message, ...(payloadError.code ? { code: payloadError.code } : {}) };
      return;
    }
    const root = (payload ?? {}) as Record<string, unknown>;
    // The final response object may be nested under `response` (mirrors the SSE
    // `response.completed` envelope) or be the top-level body itself.
    const response = (root.response && typeof root.response === "object" ? (root.response as Record<string, unknown>) : root);
    const outputText =
      typeof response.output_text === "string" ? response.output_text : responsesOutputText(response.output);
    if (outputText) yield { kind: "assistant_text_delta", text: outputText };
    yield* materializeResponse(response, new Set<string>(), new Map<string, PendingCall>(), model);
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const stream = request.stream ?? true;
    const body: Record<string, unknown> = {
      model: request.model,
      stream,
      input: assembleResponsesInput(request),
    };
    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.topP != null) body.top_p = request.topP;
    if (request.responseFormat === "json_object") body.text = { format: { type: "json_object" } };
    const effort = mapReasoningEffort(request.reasoningEffort);
    if (effort) body.reasoning = { effort };
    if (request.tools.length > 0) {
      body.tools = sortedToolSpecs(request.tools).map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
      if (request.requiredToolName) {
        body.tool_choice = { type: "function", name: request.requiredToolName };
      }
    }
    return body;
  }

  private async *parseStream(
    body: ReadableStream<Uint8Array>,
    request: ModelRequest,
  ): AsyncIterable<ModelStreamChunk> {
    const pending = new Map<string, PendingCall>();
    const byIndex = new Map<number, string>();
    const completed = new Set<string>();
    let usage: UsageSnapshot | undefined;
    let finishReason: string | undefined;
    // Track whether any text delta streamed during the turn. On the terminal
    // `response.completed` frame we re-materialize the response's output text
    // only when nothing streamed (faithful to materializeResponsesOutput's
    // `skipText: Boolean(text)` guard), so we never double-emit.
    let sawTextDelta = false;

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
        const type: string | undefined = typeof payload?.type === "string" ? payload.type : undefined;
        // Generic in-band error guard for non-Responses gateway shapes (base_resp /
        // top-level code+message). Native `response.failed` / `error` frames are
        // still handled by the typed branch below.
        if (type !== "response.failed" && type !== "error") {
          const payloadError = modelPayloadError(payload);
          if (payloadError) {
            yield { kind: "error", message: payloadError.message, code: payloadError.code ?? "response_stream_error" };
            finishReason = "error";
            continue;
          }
        }

        const item = payload?.item ?? payload?.output_item;
        if (item && typeof item === "object") {
          const itemType = item.type;
          if (itemType === "function_call" || itemType === "custom_tool_call") {
            const outputIndex = numericIndex(payload.output_index);
            const callId =
              strOf(item.call_id) || strOf(item.id) || indexFallbackCallId(outputIndex, pending);
            const entry = pending.get(callId) ?? { index: outputIndex, name: undefined, arguments: "" };
            if (outputIndex !== undefined) {
              entry.index = outputIndex;
              byIndex.set(outputIndex, callId);
            }
            const name = strOf(item.name);
            if (name) entry.name = name;
            const initialArgs = strOf(item.arguments) || strOf(item.input);
            if (initialArgs && !entry.arguments) entry.arguments = initialArgs;
            pending.set(callId, entry);
            if (type === "response.output_item.done" && entry.name && !completed.has(callId)) {
              completed.add(callId);
              pending.delete(callId);
              yield {
                kind: "tool_call_complete",
                callId,
                toolName: entry.name,
                arguments: parseToolArguments(entry.arguments || "{}"),
              };
            }
          }
        }

        if (type === "response.output_text.delta") {
          const delta = strOf(payload.delta);
          if (delta) {
            sawTextDelta = true;
            yield { kind: "assistant_text_delta", text: delta };
          }
        } else if (
          type === "response.reasoning_text.delta" ||
          type === "response.reasoning_summary_text.delta" ||
          type === "response.reasoning.delta"
        ) {
          const delta = strOf(payload.delta);
          if (delta) yield { kind: "assistant_reasoning_delta", text: delta };
        } else if (type === "response.function_call_arguments.delta") {
          const outputIndex = numericIndex(payload.output_index);
          const callId = streamCallId(payload, pending, byIndex, outputIndex);
          const entry = pending.get(callId) ?? { index: outputIndex, name: undefined, arguments: "" };
          if (outputIndex !== undefined) {
            entry.index = outputIndex;
            byIndex.set(outputIndex, callId);
          }
          const delta = strOf(payload.delta);
          if (delta) {
            entry.arguments += delta;
            yield { kind: "tool_call_delta", callId, toolName: entry.name, argumentsDelta: delta };
          }
          pending.set(callId, entry);
        } else if (type === "response.function_call_arguments.done") {
          const outputIndex = numericIndex(payload.output_index);
          const callId = streamCallId(payload, pending, byIndex, outputIndex);
          const entry = pending.get(callId) ?? { index: outputIndex, name: undefined, arguments: "" };
          const args = strOf(payload.arguments);
          if (args) entry.arguments = args;
          pending.set(callId, entry);
        } else if (type === "response.completed" || type === "response.incomplete") {
          const response = (payload.response ?? payload) as Record<string, unknown>;
          // Re-materialize the terminal assistant text only when no
          // output_text.delta streamed during the turn (skipText logic).
          if (!sawTextDelta) {
            const outputText =
              typeof response.output_text === "string"
                ? response.output_text
                : responsesOutputText(response.output);
            if (outputText) {
              sawTextDelta = true;
              yield { kind: "assistant_text_delta", text: outputText };
            }
          }
          for (const chunk of materializeResponse(response, completed, pending, request.model)) {
            if (chunk.kind === "usage") usage = mergeUsageSnapshots(usage, chunk.usage);
            else if (chunk.kind === "completed") finishReason = chunk.stopReason;
            else yield chunk;
          }
        } else if (type === "response.failed" || type === "error") {
          yield { kind: "error", message: responseErrorMessage(payload), code: "response_stream_error" };
          finishReason = "error";
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

    // Flush any tool calls that streamed args but never emitted a terminal item.done.
    for (const [callId, entry] of pending) {
      if (entry.name && !completed.has(callId)) {
        completed.add(callId);
        yield {
          kind: "tool_call_complete",
          callId,
          toolName: entry.name,
          arguments: parseToolArguments(entry.arguments || "{}"),
        };
      }
    }
    if (usage) yield { kind: "usage", usage };
    yield { kind: "completed", stopReason: mapStopReason(finishReason, completed.size > 0) };
  }

  private httpErrorMessage(status: number, text: string): string {
    if (status === 404) return "model endpoint returned 404 — check the provider Base URL and model id";
    if (status === 401) return "model request unauthorized — check the provider API key";
    if (status === 429) return "model provider rate limited the request";
    const detail = text.slice(0, 400);
    return `model request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`;
  }
}

/** Materialize a final `response` object into completion chunks (text/tool/usage + stop reason). */
function* materializeResponse(
  response: Record<string, unknown>,
  completed: Set<string>,
  pending: Map<string, PendingCall>,
  model: string,
): Iterable<ModelStreamChunk> {
  let sawToolCall = completed.size > 0;
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  for (const item of output) {
    const itemType = item.type;
    if (itemType !== "function_call" && itemType !== "custom_tool_call") continue;
    const callId = strOf(item.call_id) || strOf(item.id);
    const toolName = strOf(item.name);
    if (!callId || !toolName) continue;
    if (completed.has(callId)) continue;
    sawToolCall = true;
    completed.add(callId);
    pending.delete(callId);
    const argsRaw = strOf(item.arguments) || strOf(item.input) || "{}";
    yield { kind: "tool_call_complete", callId, toolName, arguments: parseToolArguments(argsRaw) };
  }

  if (response.usage && typeof response.usage === "object") {
    yield { kind: "usage", usage: mapResponsesUsage(response.usage as Record<string, unknown>, model) };
  }

  const status = strOf(response.status);
  let stopReason: "stop" | "tool_calls" | "length" | "error" = sawToolCall ? "tool_calls" : "stop";
  if (status === "incomplete") {
    const reason = strOf((response.incomplete_details as Record<string, unknown> | undefined)?.reason);
    stopReason = reason === "max_output_tokens" ? "length" : "error";
  } else if (status === "failed") {
    stopReason = "error";
  }
  yield { kind: "completed", stopReason };
}

/** Concatenate all `output_text`/`text` blocks from a final response's `output` array. */
function responsesOutputText(output: unknown): string {
  const parts: string[] = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== "object") continue;
    if (strOf((item as Record<string, unknown>).type) !== "message") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = strOf((block as Record<string, unknown>).type);
      if (type === "output_text" || type === "text") {
        const text = strOf((block as Record<string, unknown>).text);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join("");
}

/** Map Responses usage (`input_tokens` / `output_tokens` + cached input tokens) to a UsageSnapshot. */
export function mapResponsesUsage(raw: Record<string, unknown>, model: string): UsageSnapshot {
  const promptTokens = numOf(raw.input_tokens);
  const completionTokens = numOf(raw.output_tokens);
  const totalTokens = numOf(raw.total_tokens) || promptTokens + completionTokens;
  const inputDetails = raw.input_tokens_details as Record<string, unknown> | undefined;
  const cacheReadTokens = numOf(inputDetails?.cached_tokens);
  const outputDetails = raw.output_tokens_details as Record<string, unknown> | undefined;
  const reasoningTokens = numOf(outputDetails?.reasoning_tokens);
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: cacheReadTokens || undefined,
    reasoningTokens: reasoningTokens || undefined,
  };
}

function mapReasoningEffort(effort: ModelRequest["reasoningEffort"]): "low" | "medium" | "high" | undefined {
  if (!effort || effort === "auto" || effort === "off") return undefined;
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high"; // high | max
}

function mapStopReason(
  finishReason: string | undefined,
  sawToolCall: boolean,
): "stop" | "tool_calls" | "length" | "error" {
  if (finishReason === "tool_calls") return "tool_calls";
  if (finishReason === "length") return "length";
  if (finishReason === "error") return "error";
  if (finishReason === "stop") return sawToolCall ? "tool_calls" : "stop";
  return sawToolCall ? "tool_calls" : "stop";
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function numericIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function indexFallbackCallId(index: number | undefined, pending: Map<string, PendingCall>): string {
  return index === undefined ? `call_${pending.size + 1}` : `call_${index + 1}`;
}

/** Resolve the call id for a function_call_arguments delta/done frame. */
function streamCallId(
  payload: any,
  pending: Map<string, PendingCall>,
  byIndex: Map<number, string>,
  outputIndex: number | undefined,
): string {
  const explicit = strOf(payload.call_id);
  if (explicit) return explicit;
  const itemId = strOf(payload.item_id);
  if (itemId && pending.has(itemId)) return itemId;
  if (outputIndex !== undefined) {
    return byIndex.get(outputIndex) ?? indexFallbackCallId(outputIndex, pending);
  }
  if (pending.size === 1) return [...pending.keys()][0];
  return indexFallbackCallId(undefined, pending);
}

function responseErrorMessage(payload: any): string {
  const error = payload?.error ?? payload?.response?.error;
  const message = error && typeof error === "object" ? strOf(error.message) : "";
  return message || strOf(payload?.message) || "model stream reported an error";
}

function toolResultContent(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Assemble Responses `input` items from system prompt + canonical history. */
export function assembleResponsesInput(request: ModelRequest): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  if (request.systemPrompt) input.push({ role: "system", content: request.systemPrompt });
  if (request.modeInstruction) input.push({ role: "system", content: request.modeInstruction });

  const results = new Map<string, ModelHistoryItem & { kind: "tool_result" }>();
  for (const item of request.history) {
    if (item.kind === "tool_result") results.set(item.callId, item);
  }

  const history = request.history;
  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (item.kind === "tool_call") {
      const run: Array<ModelHistoryItem & { kind: "tool_call" }> = [];
      while (i < history.length && history[i].kind === "tool_call") {
        run.push(history[i] as ModelHistoryItem & { kind: "tool_call" });
        i += 1;
      }
      i -= 1;
      for (const call of run) {
        input.push({
          type: "function_call",
          call_id: call.callId,
          name: call.toolName,
          arguments: JSON.stringify(call.arguments),
          status: "completed",
        });
      }
      for (const call of run) {
        const result = results.get(call.callId);
        input.push({
          type: "function_call_output",
          call_id: call.callId,
          output: result ? toolResultContent(result.output) : "",
        });
      }
      continue;
    }
    if (item.kind === "tool_result") continue;
    if (item.kind === "assistant_reasoning") continue;
    if (item.kind === "compaction") {
      input.push({ role: "system", content: `Conversation summary from earlier turns:\n${item.summary}` });
      continue;
    }
    if (item.kind === "user_message") {
      if (item.images && item.images.length > 0) {
        const parts: Array<Record<string, unknown>> = [{ type: "input_text", text: item.text }];
        for (const image of item.images) {
          parts.push({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.dataBase64}` });
        }
        input.push({ role: "user", content: parts });
      } else {
        input.push({ role: "user", content: item.text });
      }
      continue;
    }
    if (item.kind === "assistant_text") {
      input.push({ role: "assistant", content: item.text });
      continue;
    }
  }

  for (const instruction of request.contextInstructions ?? []) {
    if (instruction.trim().length > 0) input.push({ role: "system", content: instruction });
  }

  // Multimodal: attach this turn's resolved images / text fallbacks to the latest
  // user input. Faithful to attachImagesToLatestUserMessage / attachTextFallbacks,
  // emitting Responses `input_image` / `input_text` parts.
  attachResponsesAttachments(input, request);

  return input;
}

/** Append the current turn's image attachments (and text fallbacks) to the latest user input. */
function attachResponsesAttachments(input: ResponsesInputItem[], request: ModelRequest): void {
  const attachments = requestAttachments(request);
  const textFallbacks = requestAttachmentTextFallbacks(request);
  if (attachments.length === 0 && textFallbacks.length === 0) return;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!("role" in item) || item.role !== "user") continue;
    const parts: Array<Record<string, unknown>> = [];
    if (typeof item.content === "string") {
      if (item.content) parts.push({ type: "input_text", text: item.content });
    } else if (Array.isArray(item.content)) {
      parts.push(...item.content);
    }
    for (const attachment of attachments) {
      parts.push({ type: "input_image", image_url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` });
    }
    if (textFallbacks.length > 0) {
      parts.push({ type: "input_text", text: textFallbacks.map(formatAttachmentTextFallback).join("\n\n") });
    }
    item.content = parts;
    return;
  }
}
