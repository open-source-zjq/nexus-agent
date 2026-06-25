import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  ApprovalPolicySchema,
  SandboxModeSchema,
  ReasoningEffortSchema,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
} from "../contracts/policy.js";
import { HookConfigSchema } from "../hooks/hook-config.js";

/**
 * Config is the clean, generic replacement for Nexus's Nexus model gateway.
 * Instead of a single first-party endpoint, we model named providers (OpenAI- or
 * Anthropic-shaped, identified by an API key + base URL) and a list of logical
 * models that map onto them.
 */

/** Sentinel written in place of secrets when config is sent to the UI. */
export const MASKED_SECRET = "********";

export const ProviderKind = z.enum(["openai", "anthropic"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Which wire protocol the provider speaks. */
export const ModelEndpointFormat = z.enum(["chat_completions", "responses", "messages", "custom_endpoint"]);
export type ModelEndpointFormat = z.infer<typeof ModelEndpointFormat>;

/**
 * Coerce the ~20 alias strings the original `contracts/model-endpoint-format.js`
 * `normalizeModelEndpointFormat` accepted (e.g. "v1/chat/completions",
 * "full-url", "response") onto the canonical enum. Returns the input unchanged
 * when it is not a recognizable alias so a genuinely-canonical value (or
 * `undefined`) passes through and an unknown garbage value still surfaces as a
 * zod enum error rather than being silently defaulted.
 */
export function normalizeModelEndpointFormat(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/^\/+/, "");
  switch (normalized) {
    case "chat":
    case "chat-completions":
    case "chat_completions":
    case "v1/chat/completions":
    case "chat/completions":
      return "chat_completions";
    case "custom":
    case "custom-endpoint":
    case "custom_endpoint":
    case "custom-full-path":
    case "custom_full_path":
    case "full-path":
    case "full_path":
    case "full-url":
    case "full_url":
      return "custom_endpoint";
    case "response":
    case "responses":
    case "v1/responses":
      return "responses";
    case "message":
    case "messages":
    case "v1/messages":
      return "messages";
    default:
      return value;
  }
}

/** Tolerant endpoint-format schema: coerces alias strings before enum validation. */
export const ModelEndpointFormatTolerant = z.preprocess(normalizeModelEndpointFormat, ModelEndpointFormat);

export const ProviderConfigSchema = z.object({
  kind: ProviderKind,
  apiKey: z.string().default(""),
  /** Base URL without the trailing `/chat/completions` or `/messages`. */
  baseUrl: z.string().optional(),
  endpointFormat: ModelEndpointFormatTolerant.optional(),
  /** Extra headers merged onto every request (override defaults). */
  headers: z.record(z.string(), z.string()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ModelPricingSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
  cachedInputPerMTokUsd: z.number().nonnegative().optional(),
});

export const ReasoningProfileSchema = z.object({
  supportedEfforts: z.array(ReasoningEffortSchema).min(1),
  defaultEffort: ReasoningEffortSchema,
});

/**
 * Per-model context-compaction override (fork extension of the original
 * `ModelContextProfileConfig`): an explicit context window and/or absolute
 * soft/hard thresholds or ratios, plus a `largeWindow` flag selecting the late
 * 0.98/0.99 reasoner ratios. Structurally a subset of the loop's
 * `ModelContextProfileConfig`, so it threads straight into
 * `resolveModelContextProfile`.
 */
export const ModelCompactionOverrideSchema = z.object({
  contextWindowTokens: z.number().int().positive().optional(),
  softThreshold: z.number().int().positive().optional(),
  hardThreshold: z.number().int().positive().optional(),
  softRatio: z.number().positive().optional(),
  hardRatio: z.number().positive().optional(),
  largeWindow: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  supportsToolCalling: z.boolean().optional(),
});
export type ModelCompactionOverride = z.infer<typeof ModelCompactionOverrideSchema>;

export const ModelConfigSchema = z.object({
  /** Logical id referenced by thread.model and the UI. */
  id: z.string().min(1),
  label: z.string().optional(),
  /** Key into the providers map. */
  provider: z.string().min(1),
  /** Actual model name sent on the wire; defaults to `id`. */
  wireModel: z.string().optional(),
  contextWindowTokens: z.number().int().positive().default(128000),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsToolCalling: z.boolean().default(true),
  supportsImages: z.boolean().default(false),
  reasoning: ReasoningProfileSchema.optional(),
  pricing: ModelPricingSchema.optional(),
  /**
   * Late-compaction flag: when true this (reasoner) model uses the large-window
   * ratios (0.98 soft / 0.99 hard) instead of the default 0.86/0.94. Restored
   * config knob in place of the removed `contextWindowTokens >= 400000` heuristic.
   */
  largeWindow: z.boolean().optional(),
  /** Optional per-model context-compaction overrides. */
  compaction: ModelCompactionOverrideSchema.optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ServeConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8910),
  /** Static bearer token. Empty + insecure=false => everything 401. */
  runtimeToken: z.string().default(""),
  /** Disable auth entirely (loopback dev convenience). */
  insecure: z.boolean().default(false),
});
export type ServeConfig = z.infer<typeof ServeConfigSchema>;

export const ContextCompactionConfigSchema = z.object({
  /** `heuristic` (deterministic) or `model` (LLM rewrite of the summary). */
  summaryMode: z.enum(["heuristic", "model"]).default("heuristic"),
  summaryTimeoutMs: z.number().int().positive().default(15000),
  summaryMaxTokens: z.number().int().positive().default(1200),
  /**
   * Optional absolute soft/hard compaction token thresholds for non-profiled
   * models. When set they override the default-window ratios (faithful to the
   * original contextCompaction.defaultSoftThreshold/defaultHardThreshold).
   */
  defaultSoftThreshold: z.number().int().positive().optional(),
  defaultHardThreshold: z.number().int().positive().optional(),
  /**
   * Per-model absolute compaction profile overrides keyed by model id (faithful
   * to the original `contextCompaction.modelProfiles`). Threaded into
   * `resolveModelContextProfile` so a specific model can compact later/earlier.
   */
  modelProfiles: z.record(z.string(), ModelCompactionOverrideSchema).optional(),
});

/** Two-tier auto-routing: pick a cheap/strong model per turn from the request. */
export const AutoModelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  flashModel: z.string().min(1).optional(),
  proModel: z.string().min(1).optional(),
});
export type AutoModelConfig = z.infer<typeof AutoModelConfigSchema>;

/** Tool-storm breaker tuning (repeated identical tool calls in a short window). */
export const ToolStormConfigSchema = z.object({
  enabled: z.boolean().optional(),
  windowSize: z.number().int().positive().optional(),
  threshold: z.number().int().positive().optional(),
});
export type ToolStormConfig = z.infer<typeof ToolStormConfigSchema>;

/**
 * Request-level token-economy tuning. Mirrors {@link TokenEconomyConfig} from
 * `loop/token-economy`. When `enabled`, the assembled model request is compressed
 * (tool descriptions/results + concise-response instruction) per the per-gate
 * flags. OFF by default when absent.
 */
export const TokenEconomyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  compressToolDescriptions: z.boolean().optional(),
  compressToolResults: z.boolean().optional(),
  conciseResponses: z.boolean().optional(),
  historyHygiene: z.record(z.string(), z.unknown()).optional(),
});
export type TokenEconomyConfigInput = z.infer<typeof TokenEconomyConfigSchema>;

// --- Optional capability providers (web / memory / skills / media) ----------
// Every capability is OFF by default: when `capabilities` is absent (or a
// sub-block's `enabled` is false) the corresponding provider reports
// available=false and the default builtin tool catalog is unchanged.

/** Web search endpoint hint for the `web_search` tool. */
export const WebSearchConfigSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  /** Provider hint: "tavily" (default/generic POST), "brave"/"searxng" (GET). */
  provider: z.string().optional(),
});

/** web_fetch + web_search provider config. */
export const WebCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Each web tool is gated independently (faithful to the original
  // WebCapabilityConfig): web_fetch only advertised when fetchEnabled, web_search
  // only when searchEnabled. Both default false, so enabling web alone exposes
  // no web tools.
  fetchEnabled: z.boolean().default(false),
  searchEnabled: z.boolean().default(false),
  allowDomains: z.array(z.string()).optional(),
  denyDomains: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  search: WebSearchConfigSchema.optional(),
});
export type WebCapabilityConfig = z.infer<typeof WebCapabilityConfigSchema>;

/** Long-term memory provider config. */
export const MemoryCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type MemoryCapabilityConfig = z.infer<typeof MemoryCapabilityConfigSchema>;

/** Skills runtime provider config. */
export const SkillsCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  roots: z.array(z.string()).default([]),
  legacySkillMd: z.boolean().default(true),
});
export type SkillsCapabilityConfig = z.infer<typeof SkillsCapabilityConfigSchema>;

/**
 * Per-modality media endpoint.
 *
 * `protocol` selects the vendor wire-shape (faithful to the original
 * capabilities `*GenerationProtocol` enums). It is intentionally a free
 * `z.string().optional()` (not a hard enum) so that:
 *   - an empty / omitted protocol keeps the OpenAI-compatible default behavior,
 *     leaving every existing config unaffected; and
 *   - an unknown protocol value also falls through to the OpenAI-compatible path
 *     rather than failing config validation.
 *
 * The protocol values the original supports per modality are:
 *   - image:  "openai-images" (default) | "async-image"
 *   - speech: "openai-speech" (default) | "async-t2a" | "mimo-tts"
 *   - music:  "async-music" | "" (OpenAI-compatible default)
 *   - video:  "async-video" | "" (OpenAI-compatible default)
 */
export const MediaEndpointConfigSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  /** Vendor wire-shape selector; empty/omitted/unknown => OpenAI-compatible. */
  protocol: z.string().optional(),
  // Per-modality optional knobs (superset of all four modalities, faithful to
  // the original per-modality schemas). The unified schema accepts every field;
  // each modality reads only the ones it uses and ignores the rest. All
  // OPTIONAL with NO brand defaults — an existing config carrying only
  // endpoint/apiKey/model/protocol still validates unchanged.
  /** Image: fallback `WxH` size when no aspect_ratio/image_size is supplied. */
  defaultSize: z.string().optional(),
  /** Speech: default provider voice id/name when the tool-call omits one. */
  voice: z.string().optional(),
  /** Speech/Music: default audio container format when the tool-call omits one. */
  format: z.string().optional(),
  /** Video: default clip duration (seconds) when the tool-call omits one. */
  defaultDuration: z.number().int().positive().optional(),
  /** Video: default resolution tier (e.g. "1080P") when the tool-call omits one. */
  defaultResolution: z.string().optional(),
  /** Per-modality request timeout budget in ms. */
  timeoutMs: z.number().int().positive().optional(),
  /** Image: max reference images accepted for image-to-image. */
  maxReferenceImages: z.number().int().positive().optional(),
});

/** Media generation provider config (image/speech/music/video). */
export const MediaCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  image: MediaEndpointConfigSchema.optional(),
  speech: MediaEndpointConfigSchema.optional(),
  music: MediaEndpointConfigSchema.optional(),
  video: MediaEndpointConfigSchema.optional(),
});
export type MediaCapabilityConfig = z.infer<typeof MediaCapabilityConfigSchema>;

/**
 * Speech-to-text (语音转写) provider config (T10.4). OFF by default; generic
 * OpenAI-compatible (`{endpoint}/v1/audio/transcriptions`, multipart). Reuses
 * the same inline `{endpoint, apiKey, model}` shape as {@link MediaEndpointConfigSchema}
 * (the codebase uses `endpoint`, not `baseUrl`) so there are no new conventions.
 *
 * The `apiKey` string round-trips through the generic secret masking
 * ({@link maskConfigSecrets} / {@link restoreMaskedSecrets}) for free — its key
 * matches CONFIG_SECRET_KEY_PATTERN — and the numeric `timeoutMs` is never
 * touched (the masker only rewrites secret-looking *strings*). No bespoke
 * masking code is required.
 */
export const SpeechToTextConfigSchema = z.object({
  /** Master switch. OFF by default so transcription never fires unconfigured. */
  enabled: z.boolean().default(false),
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 (apiUrl-normalized). */
  endpoint: z.string().optional(),
  /** Provider bearer key. Auto-masked via the generic secret key-pattern. */
  apiKey: z.string().optional(),
  /** Transcription model id, e.g. "whisper-1" / "gpt-4o-transcribe". */
  model: z.string().optional(),
  /** Optional default ISO-639-1 language hint; the request body may override it. */
  language: z.string().optional(),
  /** Per-request transcription timeout budget in ms (default 60000). */
  timeoutMs: z.number().int().positive().optional(),
});
export type SpeechToTextConfig = z.infer<typeof SpeechToTextConfigSchema>;

/** Single MCP (Model Context Protocol) stdio server entry. */
export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** When false (default), the server's tools are neither searchable nor callable. */
  trusted: z.boolean().optional(),
  /**
   * Trust scope for the server (matches the original McpServerConfig.trustScope).
   * "user" trusts the server everywhere; "workspace" only inside
   * `trustedWorkspaceRoots`.
   */
  trustScope: z.enum(["user", "workspace"]).optional(),
  /** Workspace roots the server is trusted within when trustScope === "workspace". */
  trustedWorkspaceRoots: z.array(z.string()).optional(),
  /** Per-call tools/call budget in ms (default 30000; matches the original McpServerConfig.timeoutMs). */
  timeoutMs: z.number().int().positive().default(30_000),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * BM25 lexical-search tuning for the MCP meta-tools (mcp_search). Mirrors the
 * original `McpSearchConfig`: a `bm25.k1` term-frequency saturation knob, a
 * default/max `topK` window, and a relevance `minScore` floor. Every field has
 * the original's default so an operator can override individual knobs.
 */
export const McpSearchTuningSchema = z
  .object({
    /** Default number of search hits returned when topK is unspecified. */
    topKDefault: z.number().int().positive().default(5),
    /** Upper bound for the model-supplied topK argument. */
    topKMax: z.number().int().positive().default(10),
    /** Relevance floor; results scoring below this are dropped. */
    minScore: z.number().nonnegative().default(0.15),
    bm25: z
      .object({
        k1: z.number().positive().default(1.2),
        b: z.number().min(0).max(1).default(0.75),
      })
      .default(() => ({ k1: 1.2, b: 0.75 })),
  })
  // Faithful to the original McpSearchConfig refine: topKDefault must not exceed topKMax.
  .superRefine((search, ctx) => {
    if (search.topKDefault > search.topKMax) {
      ctx.addIssue({
        code: "custom",
        path: ["topKDefault"],
        message: "topKDefault must be less than or equal to topKMax",
      });
    }
  });
export type McpSearchTuning = z.infer<typeof McpSearchTuningSchema>;

/** MCP meta-tool provider config. OFF by default with no servers. */
export const McpCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.array(McpServerConfigSchema).default([]),
  /** Optional BM25 search tuning (matches the original McpSearchConfig knobs). */
  search: McpSearchTuningSchema.optional(),
});
export type McpCapabilityConfig = z.infer<typeof McpCapabilityConfigSchema>;

/** Multi-agent child delegation provider config. OFF by default. */
export const DelegationCapabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxParallel: z.number().int().positive().optional(),
  maxChildRuns: z.number().int().positive().optional(),
});
export type DelegationCapabilityConfig = z.infer<typeof DelegationCapabilityConfigSchema>;

/** Proactive insight engine config. OFF by default. */
export const InsightCapabilityConfigSchema = z.object({
  // Faithful to the original InsightConfigSchema: when an `insight` block is
  // present it is ON by default (T1.6 "默认开启选项"). The block itself stays
  // optional at the capabilities level, so a config that omits `insight`
  // entirely still runs no insight engine — only an explicitly-present block
  // opts in, and then defaults enabled.
  enabled: z.boolean().default(true),
  sensitivity: z.enum(["high", "medium", "low"]).default("medium"),
  minConfidence: z.number().min(0).max(1).optional(),
  /**
   * Cheap/lightweight classifier model id. Genericized: empty/omitted falls back
   * to the host's configured default model (the original fell back to a
   * hardcoded brand model id, which is intentionally NOT restored).
   */
  model: z.string().min(1).optional(),
  /**
   * Per-detector on/off switches, each ON by default (matching the original's
   * `default(true)`). A detector left undefined (or true) stays enabled; setting
   * it false makes the engine skip it in `onTurnEnd` (InsightEngine reads
   * `config.detectors[id] === false`).
   */
  detectors: z
    .object({
      knowledge_capture: z.boolean().default(true),
      meeting_alignment: z.boolean().default(true),
      data_to_sheet: z.boolean().default(true),
    })
    .optional(),
});
export type InsightCapabilityConfig = z.infer<typeof InsightCapabilityConfigSchema>;

export const CapabilitiesConfigSchema = z.object({
  web: WebCapabilityConfigSchema.optional(),
  memory: MemoryCapabilityConfigSchema.optional(),
  skills: SkillsCapabilityConfigSchema.optional(),
  media: MediaCapabilityConfigSchema.optional(),
  mcp: McpCapabilityConfigSchema.optional(),
  delegation: DelegationCapabilityConfigSchema.optional(),
  insight: InsightCapabilityConfigSchema.optional(),
  /** Speech-to-text (语音转写) provider; OFF by default when absent (T10.4). */
  speechToText: SpeechToTextConfigSchema.optional(),
});
export type CapabilitiesConfig = z.infer<typeof CapabilitiesConfigSchema>;

// --- Runtime capability-manifest config (platform-level contract) -----------
// The manifest aggregator in contracts/capabilities reads a faithful
// `NexusCapabilitiesConfig`. Surface those schemas here (re-exported, with the
// MCP server schema aliased to avoid colliding with the simpler stdio
// `McpServerConfig` above) plus a mapper that projects this repo's leaf
// capability config onto the manifest config — keeping everything OFF by default.
export {
  NexusCapabilitiesConfig,
  DEFAULT_NEXUS_CAPABILITIES_CONFIG,
  McpSearchConfig,
  McpToolDiscoveryMode,
  McpTransportKind,
  McpTrustScope,
  McpCapabilityConfig as McpManifestCapabilityConfig,
  WebCapabilityConfig as WebManifestCapabilityConfig,
  SkillsCapabilityConfig as SkillsManifestCapabilityConfig,
  SubagentsCapabilityConfig,
  AttachmentsCapabilityConfig,
  MemoryCapabilityConfig as MemoryManifestCapabilityConfig,
  McpServerConfig as McpServerCapabilityConfig,
} from "../contracts/capabilities.js";
export type {
  NexusCapabilitiesConfig as NexusCapabilitiesConfigType,
  RuntimeCapabilityManifest,
} from "../contracts/capabilities.js";

/**
 * Projects this repo's leaf `CapabilitiesConfig` onto the faithful
 * `NexusCapabilitiesConfig` shape that `buildRuntimeCapabilityManifest`
 * consumes. Returns a plain object the aggregator re-parses (it tolerates
 * partial input); everything stays OFF unless the leaf config enabled it.
 */
export function toRuntimeCapabilitiesConfig(capabilities?: CapabilitiesConfig): Record<string, unknown> {
  if (!capabilities) return {};
  const web = capabilities.web;
  const skills = capabilities.skills;
  const memory = capabilities.memory;
  const mcp = capabilities.mcp;
  const delegation = capabilities.delegation;
  const media = capabilities.media;
  const stt = capabilities.speechToText;
  return {
    mcp: {
      enabled: Boolean(mcp?.enabled),
      ...(mcp?.search
        ? {
            search: {
              topKDefault: mcp.search.topKDefault,
              topKMax: mcp.search.topKMax,
              minScore: mcp.search.minScore,
              bm25: mcp.search.bm25,
            },
          }
        : {}),
    },
    web: {
      enabled: Boolean(web?.enabled),
      fetchEnabled: Boolean(web?.fetchEnabled),
      searchEnabled: Boolean(web?.searchEnabled),
      ...(web?.search?.provider ? { provider: web.search.provider } : {}),
      ...(web?.allowDomains ? { allowDomains: web.allowDomains } : {}),
      ...(web?.denyDomains ? { denyDomains: web.denyDomains } : {}),
      ...(web?.maxBytes ? { maxFetchBytes: web.maxBytes } : {}),
    },
    skills: {
      enabled: Boolean(skills?.enabled),
      roots: skills?.roots ?? [],
      legacySkillMd: skills?.legacySkillMd ?? true,
    },
    delegation: {
      enabled: Boolean(delegation?.enabled),
      maxParallel: delegation?.maxParallel ?? 0,
      maxChildRuns: delegation?.maxChildRuns ?? 0,
    },
    memory: {
      enabled: Boolean(memory?.enabled),
    },
    imageGen: {
      enabled: Boolean(media?.enabled && media?.image),
      ...(media?.image?.model ? { model: media.image.model } : {}),
    },
    speechGen: {
      enabled: Boolean(media?.enabled && media?.speech),
      ...(media?.speech?.model ? { model: media.speech.model } : {}),
    },
    musicGen: {
      enabled: Boolean(media?.enabled && media?.music),
      ...(media?.music?.model ? { model: media.music.model } : {}),
    },
    videoGen: {
      enabled: Boolean(media?.enabled && media?.video),
      ...(media?.video?.model ? { model: media.video.model } : {}),
    },
    speechToText: {
      enabled: Boolean(stt?.enabled && stt?.endpoint && stt?.apiKey && stt?.model),
      ...(stt?.model ? { model: stt.model } : {}),
    },
  };
}

export const NexusConfigSchema = z.object({
  serve: ServeConfigSchema.default(() => ServeConfigSchema.parse({})),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  models: z.array(ModelConfigSchema).default([]),
  defaultModel: z.string().optional(),
  defaultWorkspace: z.string().optional(),
  approvalPolicy: ApprovalPolicySchema.default(DEFAULT_APPROVAL_POLICY),
  sandboxMode: SandboxModeSchema.default(DEFAULT_SANDBOX_MODE),
  contextCompaction: ContextCompactionConfigSchema.default(() => ContextCompactionConfigSchema.parse({})),
  autoModel: AutoModelConfigSchema.optional(),
  hooks: HookConfigSchema.default([]),
  toolStorm: ToolStormConfigSchema.optional(),
  /** Optional request-level token-economy tuning; OFF by default when absent. */
  tokenEconomy: TokenEconomyConfigSchema.optional(),
  /** Optional leaf capability providers; all OFF by default when absent. */
  capabilities: CapabilitiesConfigSchema.optional(),
});
export type NexusConfig = z.infer<typeof NexusConfigSchema>;

// --- Default provider/model seed --------------------------------------------

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export function defaultBaseUrl(kind: ProviderKind): string {
  return DEFAULT_BASE_URLS[kind];
}

export function defaultEndpointFormat(kind: ProviderKind): ModelEndpointFormat {
  return kind === "anthropic" ? "messages" : "chat_completions";
}

/**
 * A sensible starter config. Users paste their API keys into Settings (which
 * PATCHes this file) and can edit/add models freely.
 */
export function seedConfig(): NexusConfig {
  return NexusConfigSchema.parse({
    serve: {},
    // Lean default: just the two canonical OpenAI- and Anthropic-shaped
    // endpoints. Add more providers (DeepSeek, Qwen, GLM, any
    // OpenAI/Anthropic-compatible gateway) from Settings → Providers.
    providers: {
      openai: { kind: "openai", apiKey: "", baseUrl: DEFAULT_BASE_URLS.openai, endpointFormat: "chat_completions" },
      anthropic: { kind: "anthropic", apiKey: "", baseUrl: DEFAULT_BASE_URLS.anthropic, endpointFormat: "messages" },
    },
    models: [
      {
        id: "gpt-4o",
        label: "GPT-4o",
        provider: "openai",
        contextWindowTokens: 128000,
        supportsImages: true,
        pricing: { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 1.25 },
      },
      {
        id: "gpt-4o-mini",
        label: "GPT-4o mini",
        provider: "openai",
        contextWindowTokens: 128000,
        supportsImages: true,
        pricing: { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
      },
      {
        id: "claude-3-5-sonnet-latest",
        label: "Claude 3.5 Sonnet",
        provider: "anthropic",
        contextWindowTokens: 200000,
        supportsImages: true,
        maxOutputTokens: 8192,
        pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cachedInputPerMTokUsd: 0.3 },
      },
      {
        id: "claude-3-5-haiku-latest",
        label: "Claude 3.5 Haiku",
        provider: "anthropic",
        contextWindowTokens: 200000,
        maxOutputTokens: 8192,
        pricing: { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 },
      },
    ],
    defaultModel: "gpt-4o",
  });
}

// --- Persistence ------------------------------------------------------------

export function defaultDataDir(): string {
  return process.env.NEXUS_DATA_DIR?.trim() || join(homedir(), ".nexus-agent");
}

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

export function loadConfig(dataDir: string): NexusConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) {
    const seeded = seedConfig();
    saveConfig(dataDir, seeded);
    return seeded;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const parsed = NexusConfigSchema.parse(raw);
    // Ensure the baseline providers always exist so the UI has something to fill.
    if (Object.keys(parsed.providers).length === 0) {
      return { ...seedConfig(), ...parsed, providers: seedConfig().providers };
    }
    return parsed;
  } catch (error) {
    console.error(`[nexus] failed to read config at ${path}, using defaults:`, (error as Error).message);
    return seedConfig();
  }
}

export function saveConfig(dataDir: string, config: NexusConfig): NexusConfig {
  const validated = NexusConfigSchema.parse(config);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath(dataDir), JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}

/** Keys whose *string* value is a secret to mask for the UI (round-trippable). */
const CONFIG_SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|client[-_]?secret|password|secret|token)/i;

/**
 * Deep-mask only secret-looking **string** values with the `MASKED_SECRET`
 * sentinel, leaving every non-string value untouched.
 *
 * This is deliberately narrower than the diagnostics-only `redactSecrets`
 * (which the original applied to `runtime-info`, never to the editable config):
 * because it never rewrites a number/object/boolean, typed fields whose key
 * merely *contains* a secret-looking word — `contextWindowTokens`,
 * `maxOutputTokens`, `summaryMaxTokens`, the whole `tokenEconomy` block — keep
 * their real values, so the config still validates when the UI PUTs it back.
 * Empty strings stay empty so a secret can be intentionally cleared.
 */
function maskConfigSecrets(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (value === "") return value;
    return CONFIG_SECRET_KEY_PATTERN.test(key) ? MASKED_SECRET : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskConfigSecrets(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = maskConfigSecrets(childValue, childKey);
    }
    return out;
  }
  return value;
}

/**
 * Mask secret fields for safe transmission to the UI.
 *
 * Masks every secret-looking *string* field — provider `apiKey`, the runtime
 * token, capability `apiKey`s (web search / media), provider `headers` carrying
 * an `Authorization` token, MCP server `env` secrets — with the `MASKED_SECRET`
 * sentinel, which the UI round-trips back unchanged and `mergeMaskedSecrets`
 * restores to the stored value on save. Non-string config (model token counts,
 * compaction thresholds, the token-economy block, …) is never touched.
 */
export function redactConfig(config: NexusConfig): NexusConfig {
  return maskConfigSecrets(config, "") as NexusConfig;
}
