import type { ResolvedModel } from "../ports/model-client.js";
import type { ReasoningEffort } from "../contracts/policy.js";

/**
 * Port of Nexus's per-model context profile table.
 *
 * The original (`backend/dist/loop/model-context-profile.js`) shipped a hard-coded
 * list of first-party model ids, each carrying a context window plus soft/hard
 * compaction thresholds and a reasoning capability (with a `requestProtocol` hint
 * such as `deepseek-chat-completions`). Large-window reasoners compacted very late
 * (~0.98/0.99 of the window) so long sessions were not shredded; everything else
 * used a conservative default (0.86/0.94 of a 256K window).
 *
 * Crucially, the original profile table was *config-driven*: a user could supply
 * per-model overrides (context window, soft/hard thresholds, soft/hard ratios,
 * reasoning capability, aliases) via `modelContextProfilesFromConfig` +
 * `mergeModelContextProfile`. This module restores that machinery, de-branded and
 * adapted to the fork's config shape (`config.models[]` array + a
 * `config.contextCompaction` block). There are no baked-in vendor model ids.
 *
 * Two surfaces:
 *  - {@link resolveModelContextProfile} (pure, takes a {@link ResolvedModel}, and an
 *    optional config) returns the compaction ratios + reasoning hint the agent loop
 *    consumes. This is the signature `agent-loop.ts` imports — preserved.
 *  - {@link modelContextProfilesFromConfig} / {@link mergeModelContextProfile} build
 *    the absolute-threshold profile records used to override the defaults, with the
 *    original's two validation throws preserved verbatim.
 */

/** Wire protocol family used to encode a reasoning/thinking round-trip. */
export type ReasoningRequestProtocol =
  | "openai-chat"
  | "deepseek-chat-completions"
  | "glm-thinking"
  | "mimo-chat-completions"
  | "anthropic-thinking"
  | "openai-responses";

export interface ContextProfileReasoning {
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  requestProtocol?: ReasoningRequestProtocol;
}

export interface ContextProfile {
  /** Effective context window in tokens used for compaction math. */
  contextWindowTokens: number;
  /** Fraction of the window that triggers a normal (soft) compaction. */
  softRatio: number;
  /** Fraction of the window that forces compaction. */
  hardRatio: number;
  /** Present when the model is a reasoner; carries the protocol hint. */
  reasoning?: ContextProfileReasoning;
}

// --- Ratio + window constants (faithful to the original) --------------------

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;

// Faithful to the original DEFAULT_CONTEXT_THRESHOLDS (floor(256000*0.86) /
// floor(256000*0.94)): an ordinary, non-large-window model compacts at 86%
// (soft) and force-compacts at 94% (hard) of its context window.
const DEFAULT_SOFT_RATIO = 0.86;
const DEFAULT_HARD_RATIO = 0.94;

// Faithful to the original NEXUS_V4_SOFT/HARD_THRESHOLD_RATIO: a "large-window"
// reasoner compacts very late (98% soft / 99% hard) so long sessions are not
// shredded. In the original this was a property of the explicit large-window
// profile, NOT a token cutoff; restored here as an explicit per-model/config
// flag rather than the invented `contextWindowTokens >= 400000` heuristic.
const LARGE_WINDOW_SOFT_RATIO = 0.98;
const LARGE_WINDOW_HARD_RATIO = 0.99;

const DEFAULT_MODEL_INPUT_MODALITIES = ["text"] as const;
const DEFAULT_MODEL_OUTPUT_MODALITIES = ["text"] as const;
const DEFAULT_MODEL_MESSAGE_PARTS = ["text"] as const;

// --- Config-driven profile records ------------------------------------------

/**
 * An absolute, fully-resolved per-model context profile (the original's
 * `MODEL_CONTEXT_PROFILES` entry shape, de-branded). Carries concrete
 * soft/hard token thresholds (not ratios) plus capability metadata.
 */
export interface ModelContextProfile {
  canonicalModel: string;
  modelIds: string[];
  contextWindowTokens: number;
  softThreshold: number;
  hardThreshold: number;
  inputModalities: string[];
  outputModalities: string[];
  supportsToolCalling: boolean;
  messageParts: string[];
  /**
   * Late-compaction flag: when true the model uses the large-window reasoner
   * ratios (0.98/0.99). Restored in place of the invented 400000-token cutoff.
   */
  largeWindow: boolean;
  reasoning?: ContextProfileReasoning;
}

/**
 * Raw per-model profile override as it can appear in user config. Mirrors the
 * original `ModelContextProfileConfigSchema`: a context window, optional
 * soft/hard thresholds OR soft/hard ratios (also accepted under a nested
 * `contextCompaction` block), aliases, capability metadata, a `largeWindow`
 * flag, and a reasoning capability.
 */
export interface ModelContextProfileConfig {
  aliases?: string[];
  contextWindowTokens?: number;
  contextCompaction?: {
    softRatio?: number;
    hardRatio?: number;
    softThreshold?: number;
    hardThreshold?: number;
  };
  softRatio?: number;
  hardRatio?: number;
  softThreshold?: number;
  hardThreshold?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportsToolCalling?: boolean;
  messageParts?: string[];
  /** Explicit large-window flag (late 0.98/0.99 ratios). */
  largeWindow?: boolean;
  reasoning?: ContextProfileReasoning;
}

/**
 * Minimal structural view of the fork's config that this module reads. Kept
 * intentionally loose (all-optional) so it tolerates a partial config and so a
 * `contextCompaction.modelProfiles` / per-model `compaction` block can be wired
 * in config.ts later without a type break here.
 */
export interface ModelProfileConfigSource {
  models?:
    | Array<{
        id?: string;
        contextWindowTokens?: number;
        supportsToolCalling?: boolean;
        supportsImages?: boolean;
        reasoning?: ContextProfileReasoning;
        /** Optional per-model compaction overrides (fork extension). */
        compaction?: ModelContextProfileConfig;
        largeWindow?: boolean;
      }>
    // Back-compat with the original `config.models.profiles` record shape.
    | { profiles?: Record<string, ModelContextProfileConfig> };
  contextCompaction?: {
    defaultSoftThreshold?: number;
    defaultHardThreshold?: number;
    modelProfiles?: Record<string, ModelContextProfileConfig>;
  };
  // Back-compat with the original top-level `profiles` / `modelProfiles` shapes.
  profiles?: Record<string, ModelContextProfileConfig>;
  modelProfiles?: Record<string, ModelContextProfileConfig>;
}

// --- Public: compaction profile consumed by the agent loop ------------------

/**
 * Resolve the compaction + reasoning profile for a resolved model.
 *
 * Pure mapping. When `config` is supplied, per-model config overrides
 * (context window, soft/hard thresholds, ratios, large-window flag) are honored;
 * otherwise sensible defaults preserve current behavior. The returned shape
 * (`contextWindowTokens` / `softRatio` / `hardRatio` / `reasoning?`) is the one
 * `agent-loop.ts` consumes — do not change it without updating that caller.
 */
export function resolveModelContextProfile(
  resolved: ResolvedModel,
  config?: ModelProfileConfigSource,
): ContextProfile {
  const fallbackWindow =
    resolved.contextWindowTokens > 0 ? resolved.contextWindowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;

  const reasoning = resolveReasoningProfile(resolved);

  // A config-driven profile, if any, wins for thresholds/window. Otherwise we
  // derive the ratios from the (explicit) large-window flag.
  const configured = config ? resolveConfiguredProfile(resolved, config) : undefined;

  if (configured) {
    const contextWindowTokens = configured.contextWindowTokens || fallbackWindow;
    return {
      contextWindowTokens,
      // Convert the absolute thresholds back into ratios for the compactor,
      // which multiplies window*ratio. Guard against a zero window.
      softRatio: contextWindowTokens > 0 ? configured.softThreshold / contextWindowTokens : DEFAULT_SOFT_RATIO,
      hardRatio: contextWindowTokens > 0 ? configured.hardThreshold / contextWindowTokens : DEFAULT_HARD_RATIO,
      ...(configured.reasoning ? { reasoning: configured.reasoning } : reasoning ? { reasoning } : {}),
    };
  }

  // No config profile: choose ratios from the explicit large-window flag (read
  // structurally off the resolved model — it is provider-agnostic metadata and
  // not part of the core ResolvedModel type) rather than a hardcoded token cutoff.
  const isLargeWindow = isLargeWindowResolved(resolved, reasoning);
  const softRatio = isLargeWindow ? LARGE_WINDOW_SOFT_RATIO : DEFAULT_SOFT_RATIO;
  const hardRatio = isLargeWindow ? LARGE_WINDOW_HARD_RATIO : DEFAULT_HARD_RATIO;

  return {
    contextWindowTokens: fallbackWindow,
    softRatio,
    hardRatio,
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Whether the resolved model should use the late large-window ratios. Reads an
 * explicit `largeWindow` flag off the resolved model (provider-agnostic metadata,
 * config-overridable) — never a hardcoded token threshold. A model is only ever
 * "large window" when it is a reasoner (matching the original, whose large-window
 * ratios only ever rode on reasoner profiles).
 */
function isLargeWindowResolved(
  resolved: ResolvedModel,
  reasoning: ContextProfileReasoning | undefined,
): boolean {
  if (!reasoning) return false;
  const flag = (resolved as { largeWindow?: unknown }).largeWindow;
  return flag === true;
}

// --- Config-driven profile table (restored) ---------------------------------

/**
 * Build the absolute-threshold profile records from config. Returns one
 * {@link ModelContextProfile} per configured model that carries a context window
 * or compaction override, merging the fork's `models[]` entries and any
 * `contextCompaction.modelProfiles` / legacy `profiles` records. Profiles with
 * neither a window nor thresholds are skipped (they fall back to ratio defaults).
 */
export function modelContextProfilesFromConfig(config?: ModelProfileConfigSource): ModelContextProfile[] {
  const byCanonical = new Map<string, ModelContextProfile>();
  const profileGroups = modelProfileGroupsFromConfig(config);
  for (const profiles of profileGroups) {
    for (const [modelId, rawProfile] of Object.entries(profiles)) {
      const canonicalModel = normalizeModelId(modelId);
      if (!canonicalModel) continue;
      const current = byCanonical.get(canonicalModel);
      const next = mergeModelContextProfile(canonicalModel, current, rawProfile);
      if (next) byCanonical.set(canonicalModel, next);
    }
  }
  return [...byCanonical.values()];
}

/**
 * Merge a raw config profile onto an existing (or empty) profile, resolving
 * concrete soft/hard thresholds from explicit thresholds, ratios, or the
 * context window. Returns `undefined` when the profile carries no compaction
 * information at all (so it can be skipped rather than forced through the
 * validation throws). Preserves the original's two validation throws verbatim.
 */
export function mergeModelContextProfile(
  canonicalModel: string,
  current: ModelContextProfile | undefined,
  input: ModelContextProfileConfig,
): ModelContextProfile | undefined {
  const compaction = input.contextCompaction ?? {};
  const configuredContextWindowTokens = input.contextWindowTokens ?? current?.contextWindowTokens;

  const hasCompactionInput =
    configuredContextWindowTokens !== undefined ||
    compaction.softThreshold !== undefined ||
    compaction.hardThreshold !== undefined ||
    compaction.softRatio !== undefined ||
    compaction.hardRatio !== undefined ||
    input.softThreshold !== undefined ||
    input.hardThreshold !== undefined ||
    input.softRatio !== undefined ||
    input.hardRatio !== undefined;

  // A profile that only carries capability metadata (no window/thresholds) and
  // has no prior compaction state carries no compaction info; skip it.
  if (!hasCompactionInput && !current) return undefined;

  const largeWindow = input.largeWindow ?? current?.largeWindow ?? false;
  const fallbackSoftRatio = largeWindow ? LARGE_WINDOW_SOFT_RATIO : DEFAULT_SOFT_RATIO;
  const fallbackHardRatio = largeWindow ? LARGE_WINDOW_HARD_RATIO : DEFAULT_HARD_RATIO;

  const softThreshold =
    compaction.softThreshold ??
    input.softThreshold ??
    thresholdFromWindow({
      contextWindowTokens: configuredContextWindowTokens,
      ratio: compaction.softRatio ?? input.softRatio,
      fallbackRatio: current ? current.softThreshold / current.contextWindowTokens : fallbackSoftRatio,
      fallbackThreshold: current?.softThreshold,
    });

  const hardThreshold =
    compaction.hardThreshold ??
    input.hardThreshold ??
    thresholdFromWindow({
      contextWindowTokens: configuredContextWindowTokens,
      ratio: compaction.hardRatio ?? input.hardRatio,
      fallbackRatio: current ? current.hardThreshold / current.contextWindowTokens : fallbackHardRatio,
      fallbackThreshold: current?.hardThreshold,
    });

  const contextWindowTokens =
    configuredContextWindowTokens ?? Math.max(softThreshold ?? 0, hardThreshold ?? 0);

  if (!contextWindowTokens || !softThreshold || !hardThreshold) {
    throw new Error(`model context profile "${canonicalModel}" needs a context window or thresholds`);
  }
  if (hardThreshold < softThreshold) {
    throw new Error(`model context profile "${canonicalModel}" hard threshold must be >= soft threshold`);
  }

  const modelIds = uniqueModelIds([canonicalModel, ...(current?.modelIds ?? []), ...(input.aliases ?? [])]);
  const reasoning = input.reasoning ?? current?.reasoning;

  return {
    canonicalModel,
    modelIds,
    contextWindowTokens,
    softThreshold,
    hardThreshold,
    largeWindow,
    inputModalities: uniqueModelCapabilityValues(
      input.inputModalities ?? current?.inputModalities ?? [...DEFAULT_MODEL_INPUT_MODALITIES],
    ),
    outputModalities: uniqueModelCapabilityValues(
      input.outputModalities ?? current?.outputModalities ?? [...DEFAULT_MODEL_OUTPUT_MODALITIES],
    ),
    supportsToolCalling: input.supportsToolCalling ?? current?.supportsToolCalling ?? true,
    messageParts: uniqueModelCapabilityValues(
      input.messageParts ?? current?.messageParts ?? [...DEFAULT_MODEL_MESSAGE_PARTS],
    ),
    ...(reasoning ? { reasoning: copyReasoningCapability(reasoning) } : {}),
  };
}

/**
 * thresholdFromWindow = floor(window * ratio). Returns the fallback threshold
 * when no window is configured (faithful to the original).
 */
export function thresholdFromWindow(input: {
  contextWindowTokens?: number;
  ratio?: number;
  fallbackRatio: number;
  fallbackThreshold?: number;
}): number | undefined {
  if (!input.contextWindowTokens) return input.fallbackThreshold;
  return Math.floor(input.contextWindowTokens * (input.ratio ?? input.fallbackRatio));
}

/**
 * Gather the per-model profile override records from config. Adapted to the
 * fork's shape: the fork's `config.models` is an *array* of model entries (each
 * may carry a `compaction` block + `largeWindow` flag), so it is projected into
 * a `{ modelId: profile }` record. Also honors `contextCompaction.modelProfiles`
 * and the original's legacy `models.profiles` / top-level `profiles` /
 * `modelProfiles` record shapes.
 */
export function modelProfileGroupsFromConfig(
  config?: ModelProfileConfigSource,
): Array<Record<string, ModelContextProfileConfig>> {
  if (!config) return [];
  const groups: Array<Record<string, ModelContextProfileConfig>> = [];

  if (config.contextCompaction?.modelProfiles) {
    groups.push(config.contextCompaction.modelProfiles);
  }

  const models = config.models;
  if (Array.isArray(models)) {
    // Fork shape: project the models[] array into a profile record, picking up
    // each model's context window + optional compaction overrides.
    const fromArray: Record<string, ModelContextProfileConfig> = {};
    for (const model of models) {
      const id = model?.id;
      if (!id) continue;
      const override = model.compaction ?? {};
      const profile: ModelContextProfileConfig = {
        ...override,
        contextWindowTokens: override.contextWindowTokens ?? model.contextWindowTokens,
        ...(override.largeWindow !== undefined
          ? {}
          : model.largeWindow !== undefined
            ? { largeWindow: model.largeWindow }
            : {}),
        ...(override.supportsToolCalling !== undefined
          ? {}
          : model.supportsToolCalling !== undefined
            ? { supportsToolCalling: model.supportsToolCalling }
            : {}),
        ...(override.reasoning ?? model.reasoning ? { reasoning: override.reasoning ?? model.reasoning } : {}),
      };
      fromArray[id] = profile;
    }
    if (Object.keys(fromArray).length > 0) groups.push(fromArray);
  } else if (models && typeof models === "object" && "profiles" in models && models.profiles) {
    // Original shape: config.models.profiles record.
    groups.push(models.profiles);
  }

  if (config.profiles) groups.push(config.profiles);
  if (config.modelProfiles) groups.push(config.modelProfiles);

  return groups;
}

/**
 * Find the configured absolute-threshold profile that matches a resolved model,
 * matching by canonical id or `/<id>` suffix (faithful to the original
 * `resolveModelContextProfile` matcher).
 */
function resolveConfiguredProfile(
  resolved: ResolvedModel,
  config: ModelProfileConfigSource,
): ModelContextProfile | undefined {
  const profiles = modelContextProfilesFromConfig(config);
  if (profiles.length === 0) return undefined;
  const candidates = [resolved.id, resolved.wireModel]
    .map((value) => normalizeModelId(value))
    .filter((value): value is string => value.length > 0);
  for (const normalized of candidates) {
    const match = profiles.find((profile) =>
      profile.modelIds.some((modelId) => normalized === modelId || normalized.endsWith(`/${modelId}`)),
    );
    if (match) return match;
  }
  return undefined;
}

// --- Reasoning capability ----------------------------------------------------

/**
 * Build the reasoning capability for a model. Returns `undefined` when the model
 * does not advertise reasoning and is not recognized as a reasoner by pattern.
 */
function resolveReasoningProfile(resolved: ResolvedModel): ContextProfileReasoning | undefined {
  const protocol = inferRequestProtocol(resolved);
  const advertised = resolved.reasoning;

  // DeepSeek reasoners default to thinking ON (their gateway 400s any follow-up
  // turn whose assistant messages drop `reasoning_content` while in thinking
  // mode). Reproduce the original's high/max thinking defaults.
  if (protocol === "deepseek-chat-completions") {
    const supportedEfforts = advertised?.supportedEfforts ?? (["off", "high", "max"] as ReasoningEffort[]);
    return {
      supportedEfforts: [...supportedEfforts],
      defaultEffort: advertised?.defaultEffort ?? pickHighDefault(supportedEfforts),
      requestProtocol: protocol,
    };
  }

  // Other recognized reasoners (glm / anthropic) or any model that advertised a
  // reasoning capability in config get a profile carrying the protocol hint.
  if (advertised) {
    return {
      supportedEfforts: [...advertised.supportedEfforts],
      defaultEffort: advertised.defaultEffort,
      requestProtocol: protocol,
    };
  }

  return undefined;
}

/**
 * Derive the wire protocol hint from the model id / provider id pattern.
 * `deepseek` => deepseek-chat-completions, `glm` => glm-thinking,
 * `mimo` => mimo-chat-completions, anthropic => anthropic-thinking,
 * otherwise openai-chat.
 */
function inferRequestProtocol(resolved: ResolvedModel): ReasoningRequestProtocol {
  const haystack = [resolved.id, resolved.wireModel, resolved.client?.providerId]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (haystack.includes("deepseek")) return "deepseek-chat-completions";
  if (haystack.includes("glm")) return "glm-thinking";
  // MiMo reasoners speak reasoning_effort low|medium|high + thinking:{enabled}
  // (applyMimoChatReasoningEffort); detect them so they are not treated as
  // plain openai-chat.
  if (haystack.includes("mimo")) return "mimo-chat-completions";
  if (haystack.includes("anthropic") || haystack.includes("claude")) return "anthropic-thinking";
  return "openai-chat";
}

/** Prefer the strongest available effort, mirroring the original's `max` default. */
function pickHighDefault(supported: ReasoningEffort[]): ReasoningEffort {
  if (supported.includes("max")) return "max";
  if (supported.includes("high")) return "high";
  // Fall back to the last non-"off"/"auto" effort, else the first listed.
  const concrete = supported.filter((effort) => effort !== "off" && effort !== "auto");
  return concrete.at(-1) ?? supported[0] ?? "high";
}

function copyReasoningCapability(reasoning: ContextProfileReasoning): ContextProfileReasoning {
  return {
    supportedEfforts: [...reasoning.supportedEfforts],
    defaultEffort: reasoning.defaultEffort,
    ...(reasoning.requestProtocol ? { requestProtocol: reasoning.requestProtocol } : {}),
  };
}

// --- Small helpers (faithful to the original) -------------------------------

function uniqueModelIds(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeModelId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueModelCapabilityValues(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeModelId(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase() ?? "";
  return normalized === "auto" ? "" : normalized;
}
