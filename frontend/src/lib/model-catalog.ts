/**
 * Client-side helpers for the per-provider managed model catalog (T10.4).
 *
 * The original Nexus stored a rich per-provider config (models[], per-capability
 * sub-blocks) and fetched the upstream model list through an Electron preload
 * bridge (`window.nexusGui.probeModelProvider`). This web/Tauri build has neither:
 * `ProviderConfig` is the flat `{ kind, apiKey, baseUrl, endpointFormat, headers }`
 * and there is NO backend `/models` route. So "Fetch from API" is implemented as a
 * REAL browser fetch to the provider's own `/models` endpoint, and the per-provider
 * model list is the flat `config.models[]` grouped by provider name.
 */
import type { ModelConfig, ProviderConfig } from "../api/types.js";

/** The sentinel the backend echoes for redacted secrets (mirrors MASKED_SECRET). */
export const MASKED_SECRET = "********";

/** A masked key cannot be used as an `Authorization: Bearer` value. */
export function isUsableApiKey(apiKey: string | undefined): boolean {
  const trimmed = (apiKey ?? "").trim();
  return trimmed !== "" && trimmed !== MASKED_SECRET;
}

/** A base URL is testable only when it is a non-empty absolute http(s) URL. */
export function isHttpUrl(value: string | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether the provider can be probed for its model list:
 *  - base URL present + a valid http(s) URL,
 *  - endpoint format is not the opaque `custom_endpoint` (no `/models` to hit),
 *  - a usable (non-empty, non-masked) API key.
 */
export function isFetchable(provider: ProviderConfig): boolean {
  return (
    isHttpUrl(provider.baseUrl) &&
    provider.endpointFormat !== "custom_endpoint" &&
    isUsableApiKey(provider.apiKey)
  );
}

/** A short, human reason the Fetch button is disabled (for the title tooltip), or null. */
export function fetchDisabledReason(
  provider: ProviderConfig,
  t: (key: string) => string,
): string | null {
  if (!isUsableApiKey(provider.apiKey)) return t("settings.modelProviderFetchNeedsKey");
  if (!isHttpUrl(provider.baseUrl)) return t("settings.modelProviderInvalidUrl");
  if (provider.endpointFormat === "custom_endpoint") return t("settings.modelProviderFetchCustomEndpoint");
  return null;
}

/** Strip a single trailing slash so we never produce `…/v1//models`. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface FetchModelsResult {
  /** New model ids returned by the upstream that were not already in `existing`. */
  newIds: string[];
  /** The full, deduped upstream id list (for diagnostics / counts). */
  allIds: string[];
}

/**
 * Fetch the provider's model catalog from its own `/models` endpoint.
 *
 * - openai-shaped (chat_completions / responses / default): GET `${baseUrl}/models`
 *   with `Authorization: Bearer ${apiKey}`, parse the OpenAI `{ data: [{ id }] }`.
 * - anthropic-shaped (messages): GET `${baseUrl}/models` with `x-api-key: ${apiKey}`
 *   + `anthropic-version: 2023-06-01`, parse the same `{ data: [{ id }] }` shape.
 *
 * Throws an Error with a clean message on network / CORS / non-2xx / parse failure
 * so the caller can surface it via `modelProviderFetchError` — never a dead button.
 */
export async function fetchProviderModels(
  provider: ProviderConfig,
  existing: string[],
): Promise<FetchModelsResult> {
  if (!isUsableApiKey(provider.apiKey)) {
    throw new Error("Enter this provider's API key first.");
  }
  if (!isHttpUrl(provider.baseUrl)) {
    throw new Error("Base URL must start with http:// or https://.");
  }
  const url = `${trimTrailingSlash(provider.baseUrl!.trim())}/models`;
  const isAnthropic = provider.kind === "anthropic" || provider.endpointFormat === "messages";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers });
  } catch (error) {
    // Network failure or a CORS block (api.openai.com / api.anthropic.com may
    // refuse a browser-origin request) lands here — surface it cleanly.
    throw new Error((error as Error).message || "Network request failed (the endpoint may block browser requests).");
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) detail = `${detail} — ${text.slice(0, 200)}`;
    } catch {
      /* ignore body read errors */
    }
    throw new Error(detail);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Upstream did not return JSON.");
  }
  const upstreamIds = parseModelIds(body);
  if (upstreamIds.length === 0) {
    throw new Error("Upstream returned no models.");
  }
  const have = new Set(existing);
  const seen = new Set<string>();
  const allIds: string[] = [];
  for (const id of upstreamIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    allIds.push(id);
  }
  const newIds = allIds.filter((id) => !have.has(id));
  return { newIds, allIds };
}

/** Pull model ids out of the common OpenAI/Anthropic `{ data: [{ id }] }` shapes. */
function parseModelIds(body: unknown): string[] {
  const root = body as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(root?.data)
    ? root!.data
    : Array.isArray(root?.models)
      ? root!.models
      : Array.isArray(body)
        ? (body as unknown[])
        : [];
  const ids: string[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else if (entry && typeof entry === "object") {
      const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
      if (typeof id === "string" && id.trim() !== "") ids.push(id.trim());
    }
  }
  return ids;
}

/** All models in the flat catalog that belong to one provider (by provider name). */
export function modelsForProvider(models: ModelConfig[], providerName: string): ModelConfig[] {
  return models.filter((m) => m.provider === providerName);
}

/** The flat-catalog default for a freshly-added model id under a provider. */
export function makeModelConfig(id: string, providerName: string): ModelConfig {
  return {
    id,
    provider: providerName,
    contextWindowTokens: 128000,
    supportsToolCalling: true,
    supportsImages: false,
  };
}
