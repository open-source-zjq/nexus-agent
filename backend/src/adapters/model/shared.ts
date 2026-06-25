import type { UsageSnapshot } from "../../contracts/usage.js";
import type { ToolSpec } from "../../ports/model-client.js";

export class ModelStreamError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ModelStreamError";
    this.code = code;
  }
}

/**
 * A resolved image attachment for the current turn. Mirrors the original
 * `ModelAttachment` carried on `request.attachments`: the bytes plus enough
 * metadata to render a text fallback when a model cannot accept inline images.
 */
export interface ModelAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  byteSize: number;
  localFilePath?: string;
  width?: number;
  height?: number;
}

// --- Endpoint URL -----------------------------------------------------------

/**
 * Infer the wire protocol from a base URL's path suffix, faithful to Nexus's
 * `inferModelEndpointFormatFromUrl`. Returns null when the URL is a bare/version
 * base that carries no recognizable endpoint suffix.
 */
export function inferEndpointFormatFromUrl(
  baseUrl: string,
): "chat_completions" | "responses" | "messages" | null {
  const query = baseUrl.search(/[?#]/);
  const path = (query < 0 ? baseUrl : baseUrl.slice(0, query)).trim().replace(/\/+$/, "").toLowerCase();
  if (path.endsWith("/chat/completions") || path.endsWith("/completions")) return "chat_completions";
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/messages")) return "messages";
  return null;
}

/**
 * Build the request URL from a base URL + protocol path, mirroring Nexus's
 * version-aware suffixing so a base ending in `/v1`, `/beta`, or bare all work.
 * If the base URL is ALREADY a full endpoint URL (it ends in one of the known
 * endpoint paths), it is returned unchanged rather than re-suffixed.
 */
export function buildEndpointUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return `/v1/${path}`;
  if (inferEndpointFormatFromUrl(trimmed) !== null) return trimmed;
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
  if (lastSegment === "beta") return `${trimmed.slice(0, trimmed.lastIndexOf("/"))}/v1/${path}`;
  if (/^v\d+$/.test(lastSegment)) return `${trimmed}/${path}`;
  return `${trimmed}/v1/${path}`;
}

// --- Header overrides -------------------------------------------------------

/**
 * Merge user-configured headers over a client's defaults, case-insensitively.
 * An override with an empty-string value *removes* the matching default header,
 * so a strict third-party endpoint can drop e.g. `anthropic-version` or the
 * redundant `authorization` that first-party APIs tolerate but some gateways reject.
 */
export function applyHeaderOverrides(
  base: Record<string, string>,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  const lowerToActual = new Map<string, string>();
  for (const key of Object.keys(out)) lowerToActual.set(key.toLowerCase(), key);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const lower = key.toLowerCase();
    const existing = lowerToActual.get(lower);
    if (value === "") {
      if (existing) delete out[existing];
      continue;
    }
    if (existing && existing !== key) delete out[existing];
    out[key] = value;
    lowerToActual.set(lower, key);
  }
  return out;
}

// --- Tool schema canonicalization (stable cache keys) -----------------------

export function canonicalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeSchema);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeSchema((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sortedToolSpecs(tools: ToolSpec[]): ToolSpec[] {
  return [...tools]
    .map((tool) => ({ ...tool, inputSchema: canonicalizeSchema(tool.inputSchema) as Record<string, unknown> }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Tool argument repair ---------------------------------------------------

function extractFirstBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function valueToArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (Array.isArray(value)) return { value };
  return { value };
}

/** Parse possibly-malformed tool-call argument JSON into an object. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const text = raw.trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return valueToArguments(parsed);
  } catch {
    // fall through to repair candidates
  }
  const fence = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const fenceStripped = fence?.[1]?.trim() ?? text;
  for (const candidate of [extractFirstBalanced(fenceStripped, "{", "}"), extractFirstBalanced(fenceStripped, "[", "]")]) {
    if (!candidate) continue;
    try {
      return valueToArguments(JSON.parse(candidate));
    } catch {
      // try next
    }
  }
  return { __raw: raw };
}

// --- Usage ------------------------------------------------------------------

export function emptyUsage(model?: string): UsageSnapshot {
  return { model, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function mergeUsageSnapshots(current: UsageSnapshot | undefined, next: UsageSnapshot): UsageSnapshot {
  if (!current) return next;
  const promptTokens = next.promptTokens || current.promptTokens;
  const completionTokens = Math.max(next.completionTokens, current.completionTokens);
  const totalTokens =
    next.totalTokens > 0 && next.promptTokens > 0 ? next.totalTokens : promptTokens + completionTokens;
  return {
    model: next.model ?? current.model,
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
    cacheReadTokens: Math.max(next.cacheReadTokens ?? 0, current.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(next.cacheCreationTokens ?? 0, current.cacheCreationTokens ?? 0) || undefined,
    costUsd: next.costUsd ?? current.costUsd,
  };
}

// --- SSE reader with idle timeout -------------------------------------------

type ReadOutcome =
  | { type: "chunk"; value: Uint8Array; done: false }
  | { type: "done" }
  | { type: "aborted" }
  | { type: "timeout" }
  | { type: "error"; error: unknown };

function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<ReadOutcome> {
  return new Promise<ReadOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => settle({ type: "aborted" });
    const settle = (outcome: ReadOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // clear the idle timer so it never piles up across reads
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    if (signal.aborted) return settle({ type: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (idleTimeoutMs > 0) timer = setTimeout(() => settle({ type: "timeout" }), idleTimeoutMs);
    reader
      .read()
      .then((r) => settle(r.done ? { type: "done" } : { type: "chunk", value: r.value, done: false }))
      .catch((error) => settle({ type: "error", error }));
  });
}

/**
 * Read an SSE stream, yielding the joined `data:` payload of each frame.
 * Throws ModelStreamError on idle timeout. Returns silently on abort.
 */
export async function* streamSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const emitFrame = (frame: string): string | null => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    return dataLines.length > 0 ? dataLines.join("") : null;
  };
  // SSE frames are separated by a blank line, which may be LF (\n\n) or CRLF
  // (\r\n\r\n) depending on the server/proxy. Detect the earliest of either.
  const nextFrameBoundary = (): { index: number; length: number } | null => {
    const lf = buffer.indexOf("\n\n");
    const crlf = buffer.indexOf("\r\n\r\n");
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    if (lf !== -1) return { index: lf, length: 2 };
    return null;
  };
  try {
    for (;;) {
      const outcome = await readWithIdle(reader, signal, idleTimeoutMs);
      if (outcome.type === "timeout") {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new ModelStreamError(`model stream stalled for ${idleTimeoutMs}ms without data`, "stream_idle_timeout");
      }
      if (outcome.type === "aborted") return;
      if (outcome.type === "error") throw new ModelStreamError("model stream read failed", "stream_read_error");
      if (outcome.type === "done") break;
      buffer += decoder.decode(outcome.value, { stream: true });
      let boundary: { index: number; length: number } | null;
      while ((boundary = nextFrameBoundary()) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = emitFrame(frame);
        if (data !== null) yield data;
      }
    }
    const rest = buffer.trim();
    if (rest.length > 0) {
      const data = emitFrame(rest);
      if (data !== null) yield data;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45000;

// --- Generic in-band payload-error decoding ---------------------------------

export interface ModelPayloadError {
  message: string;
  code?: string;
}

function recordValueOf(value: unknown, key?: string): Record<string, unknown> | null {
  const target = key === undefined ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
  return target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>) : null;
}

function recordStringOf(value: unknown, key: string): string {
  const target = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof target === "string" ? target : "";
}

function errorCodeString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function successErrorCode(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return normalized === "0" || normalized === "ok" || normalized === "success";
}

function modelErrorObject(error: Record<string, unknown> | null): ModelPayloadError | null {
  if (!error) return null;
  const message =
    recordStringOf(error, "message") ||
    recordStringOf(error, "msg") ||
    recordStringOf(error, "status_msg") ||
    recordStringOf(error, "error_msg");
  const code = errorCodeString(error.code ?? error.type ?? error.status ?? error.status_code ?? error.err_code);
  if (message) return { message, ...(code ? { code } : {}) };
  if (code && !successErrorCode(code)) return { message: `model provider error (${code})`, code };
  return null;
}

/**
 * Provider-agnostic guard that decodes an in-band error from a successfully
 * transported (HTTP 200) chat/SSE payload or a non-stream JSON body. Faithful
 * port of the original `modelPayloadError`: it inspects a string `error`, an
 * `error` object, a nested `response.error`, a Async-style `base_resp`/
 * `baseResp` (`status_code`/`status_msg`, filtering success codes), and a
 * top-level `code` + `message` pair. Returns null when the payload is clean.
 */
export function modelPayloadError(payload: unknown): ModelPayloadError | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const rawError = record.error;
  if (typeof rawError === "string" && rawError.trim()) {
    return { message: rawError.trim() };
  }

  const directError = modelErrorObject(recordValueOf(record, "error"));
  if (directError) return directError;

  const responseError = modelErrorObject(recordValueOf(recordValueOf(record, "response"), "error"));
  if (responseError) return responseError;

  const baseResp = recordValueOf(record, "base_resp") ?? recordValueOf(record, "baseResp");
  if (baseResp) {
    const code = errorCodeString(baseResp.status_code ?? baseResp.status ?? baseResp.code ?? baseResp.err_code);
    if (code && !successErrorCode(code)) {
      return {
        message:
          recordStringOf(baseResp, "status_msg") ||
          recordStringOf(baseResp, "message") ||
          recordStringOf(baseResp, "msg") ||
          `model provider error (${code})`,
        code,
      };
    }
  }

  const topLevelCode = errorCodeString(record.code ?? record.type ?? record.status_code ?? record.err_code);
  const topLevelMessage =
    recordStringOf(record, "message") || recordStringOf(record, "error_msg") || recordStringOf(record, "status_msg");
  if (topLevelCode && topLevelMessage && !successErrorCode(topLevelCode)) {
    return { message: topLevelMessage, code: topLevelCode };
  }

  return null;
}

// --- Image attachments ------------------------------------------------------

/** Wire image part shapes differ per protocol; the caller supplies a builder. */
export type ImagePartBuilder = (attachment: ModelAttachment) => Record<string, unknown>;

/**
 * Attach the current turn's resolved images to the most-recent user message,
 * converting a plain-text user message into a multi-part `content` array. Faithful
 * port of the original `attachImagesToLatestUserMessage`, generalized over the
 * per-protocol image part shape via `buildImagePart`.
 */
export function attachImagesToLatestUserMessage<
  M extends { role: string; content: string | Array<Record<string, unknown>> },
>(messages: M[], attachments: ModelAttachment[], buildImagePart: ImagePartBuilder): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const parts: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string" && message.content) {
      parts.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      parts.push(...message.content);
    }
    for (const attachment of attachments) {
      parts.push(buildImagePart(attachment));
    }
    message.content = parts;
    return;
  }
}

/**
 * Append a text-only base64 fallback rendering of each attachment to the latest
 * user message. Faithful port of `attachTextFallbacksToLatestUserMessage` +
 * `formatAttachmentTextFallback`, for models that cannot accept inline images.
 */
export function attachTextFallbacksToLatestUserMessage<
  M extends { role: string; content: string | Array<Record<string, unknown>> },
>(messages: M[], attachments: ModelAttachment[]): void {
  const text = attachments.map(formatAttachmentTextFallback).join("\n\n");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = message.content ? `${message.content}\n\n${text}` : text;
      return;
    }
    if (Array.isArray(message.content)) {
      message.content.push({ type: "text", text });
      return;
    }
    message.content = text;
    return;
  }
}

export function formatAttachmentTextFallback(attachment: ModelAttachment): string {
  return [
    "[Attached image as base64 text]",
    `Name: ${attachment.name}`,
    `FilePath: ${attachment.localFilePath ?? "unknown"}`,
    `MIME: ${attachment.mimeType}`,
    `Dimensions: ${formatAttachmentDimensions(attachment)}`,
    `Bytes: ${attachment.byteSize}`,
    "Base64:",
    "```base64",
    attachment.dataBase64,
    "```",
    "[/Attached image]",
  ].join("\n");
}

function formatAttachmentDimensions(attachment: ModelAttachment): string {
  return attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : "unknown";
}

/**
 * Read the current turn's resolved image attachments off a request. These travel
 * on `ModelRequest.attachments` (image parts) and `ModelRequest.attachmentTextFallbacks`
 * (text fallbacks for non-vision models); both are optional so callers that never
 * populate them keep working. Declared structurally here so the model clients can
 * consume them ahead of the `ModelRequest` type change (see wiringNeeded).
 */
export function requestAttachments(request: unknown): ModelAttachment[] {
  const value = (request as { attachments?: unknown } | null)?.attachments;
  return Array.isArray(value) ? (value as ModelAttachment[]) : [];
}

export function requestAttachmentTextFallbacks(request: unknown): ModelAttachment[] {
  const value = (request as { attachmentTextFallbacks?: unknown } | null)?.attachmentTextFallbacks;
  return Array.isArray(value) ? (value as ModelAttachment[]) : [];
}
