import type { ModelRegistry, ResolvedModel, ModelClient } from "../../ports/model-client.js";
import type { NexusConfig, ProviderConfig, ModelConfig } from "../../config/config.js";
import { defaultBaseUrl, defaultEndpointFormat } from "../../config/config.js";
import { OpenAiClient } from "./openai-client.js";
import { AnthropicClient } from "./anthropic-client.js";
import { ResponsesClient } from "./responses-client.js";
import { inferEndpointFormatFromUrl } from "./shared.js";

/**
 * Resolves logical model ids to concrete provider clients, reading the live
 * config so Settings changes (API keys, models) take effect without a restart.
 */
export class ConfigModelRegistry implements ModelRegistry {
  constructor(private readonly getConfig: () => NexusConfig) {}

  get defaultModelId(): string {
    const config = this.getConfig();
    return config.defaultModel ?? config.models[0]?.id ?? "";
  }

  resolve(modelId: string | undefined): ResolvedModel {
    const config = this.getConfig();
    let id = modelId?.trim();
    if (!id || id.toLowerCase() === "auto") id = this.defaultModelId;

    const model = config.models.find((m) => m.id === id) ?? config.models.find((m) => m.id === this.defaultModelId);
    if (!model) throw new Error(`no model configured (requested "${modelId ?? ""}")`);
    const provider = config.providers[model.provider];
    if (!provider) throw new Error(`model "${model.id}" references unknown provider "${model.provider}"`);

    return this.buildResolved(model, provider);
  }

  list(): ResolvedModel[] {
    const config = this.getConfig();
    const out: ResolvedModel[] = [];
    for (const model of config.models) {
      const provider = config.providers[model.provider];
      if (!provider) continue;
      out.push(this.buildResolved(model, provider));
    }
    return out;
  }

  private buildResolved(model: ModelConfig, provider: ProviderConfig): ResolvedModel {
    return {
      id: model.id,
      wireModel: model.wireModel ?? model.id,
      client: buildClient(model.provider, provider),
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      supportsToolCalling: model.supportsToolCalling,
      supportsImages: model.supportsImages,
      reasoning: model.reasoning,
      pricing: model.pricing,
      ...(model.largeWindow !== undefined ? { largeWindow: model.largeWindow } : {}),
    };
  }
}

function buildClient(providerId: string, provider: ProviderConfig): ModelClient {
  const baseUrl = provider.baseUrl ?? defaultBaseUrl(provider.kind);
  let format = provider.endpointFormat ?? defaultEndpointFormat(provider.kind);
  if (format === "custom_endpoint") {
    format = inferEndpointFormatFromUrl(baseUrl) ?? "chat_completions";
  }
  if (format === "messages" || provider.kind === "anthropic") {
    return new AnthropicClient({ providerId, baseUrl, apiKey: provider.apiKey, headers: provider.headers });
  }
  if (format === "responses") {
    return new ResponsesClient({ providerId, baseUrl, apiKey: provider.apiKey, headers: provider.headers });
  }
  return new OpenAiClient({ providerId, baseUrl, apiKey: provider.apiKey, headers: provider.headers });
}
