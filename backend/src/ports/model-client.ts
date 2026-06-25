import type { UsageSnapshot } from "../contracts/usage.js";
import type { ReasoningEffort } from "../contracts/policy.js";
import type { ModelAttachment } from "../adapters/model/shared.js";

export type { ModelAttachment };

/**
 * Canonical, provider-agnostic conversation history fed to a model client.
 * The agent loop derives these from persisted TurnItems; each provider client
 * maps them onto its own wire protocol (OpenAI chat messages / Anthropic blocks).
 */
export type ModelHistoryItem =
  | { kind: "user_message"; text: string; images?: ModelImage[] }
  | { kind: "assistant_text"; text: string }
  | { kind: "assistant_reasoning"; text: string }
  | { kind: "tool_call"; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; callId: string; toolName: string; output: unknown; isError: boolean }
  | { kind: "compaction"; summary: string; replacedTokens: number }
  /**
   * A completed code-review result from an earlier turn, re-injected into the
   * model context as a system note (`itemToMessage`'s "review" case). Faithful to
   * the original, which feeds prior review output back to the model.
   */
  | { kind: "review"; reviewText: string };

export interface ModelImage {
  mimeType: string;
  dataBase64: string;
}

/** A tool advertised to the model. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  threadId: string;
  turnId: string;
  /** Wire model id sent to the provider. */
  model: string;
  systemPrompt?: string;
  modeInstruction?: string;
  contextInstructions?: string[];
  history: ModelHistoryItem[];
  tools: ToolSpec[];
  /** When set, the model is forced to call this tool (used by plan mode). */
  requiredToolName?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: "json_object";
  reasoningEffort?: ReasoningEffort;
  /**
   * Current turn's resolved image attachments, attached to the most-recent user
   * message by image-capable clients. Read structurally via `requestAttachments`.
   */
  attachments?: ModelAttachment[];
  /**
   * Text-only base64 fallbacks for the current turn's attachments, appended to
   * the latest user message by clients whose model cannot accept inline images.
   * Read structurally via `requestAttachmentTextFallbacks`.
   */
  attachmentTextFallbacks?: ModelAttachment[];
  /**
   * Wire protocol family used to encode a reasoning/thinking round-trip. Mirrors
   * the `requestProtocol` hint emitted by resolveModelContextProfile so a client
   * can pick the right per-protocol reasoning field shape.
   */
  reasoningProtocol?:
    | "openai-chat"
    | "deepseek-chat-completions"
    | "glm-thinking"
    | "mimo-chat-completions"
    | "anthropic-thinking"
    | "openai-responses";
  stream?: boolean;
  abortSignal: AbortSignal;
}

export type ModelStopReason = "stop" | "tool_calls" | "length" | "error";

export type ModelStreamChunk =
  | { kind: "assistant_text_delta"; text: string }
  | { kind: "assistant_reasoning_delta"; text: string }
  | { kind: "tool_call_delta"; callId: string; toolName?: string; argumentsDelta: string }
  | { kind: "tool_call_complete"; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { kind: "usage"; usage: UsageSnapshot }
  | { kind: "completed"; stopReason: ModelStopReason }
  | { kind: "error"; message: string; code?: string };

/** A single provider client: turns a ModelRequest into a normalized chunk stream. */
export interface ModelClient {
  readonly providerId: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
}

export interface ReasoningProfile {
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
}

/** What the loop gets back when it resolves a logical model id. */
export interface ResolvedModel {
  /** Logical id (matches thread.model / config model id). */
  id: string;
  /** Model id sent on the wire. */
  wireModel: string;
  client: ModelClient;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  supportsToolCalling: boolean;
  supportsImages: boolean;
  reasoning?: ReasoningProfile;
  pricing?: ModelPricing;
  /** When true, use the large-window late-compaction ratios (0.98/0.99). */
  largeWindow?: boolean;
}

export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cachedInputPerMTokUsd?: number;
}

/** Resolves logical model ids to concrete clients. Backed by config. */
export interface ModelRegistry {
  readonly defaultModelId: string;
  resolve(modelId: string | undefined): ResolvedModel;
  list(): ResolvedModel[];
}
