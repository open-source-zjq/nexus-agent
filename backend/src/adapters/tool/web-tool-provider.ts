import type { LocalTool } from "./types.js";
import { defineTool } from "./types.js";
import type { ToolProvider } from "./capability-registry.js";
import {
  sourceIdFor,
  UnavailableWebProvider,
  type WebProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchRequest,
  type WebSearchResult,
} from "../../ports/web-provider.js";

const DEFAULT_WEB_TIMEOUT_MS = 15_000;
const DEFAULT_WEB_MAX_BYTES = 1_000_000;
const MIN_WEB_FETCH_BYTES = 4096;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

export interface WebSearchConfig {
  endpoint?: string;
  apiKey?: string;
  /** Provider hint ("tavily" | "brave" | "searxng" | generic). Best-effort request shaping. */
  provider?: string;
}

export interface WebToolProviderConfig {
  enabled?: boolean;
  /** Advertise web_fetch (default false). The original gated each web tool independently. */
  fetchEnabled?: boolean;
  /** Advertise web_search (default false). */
  searchEnabled?: boolean;
  allowDomains?: string[];
  denyDomains?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  search?: WebSearchConfig;
}

export interface BuildWebToolProviderOptions {
  /** Override the web provider (tests/feature scripts). */
  provider?: WebProvider;
  nowIso?: () => string;
}

/**
 * Build the "web" tool provider exposing web_fetch and web_search.
 *
 * The actual network I/O is delegated to a {@link WebProvider}: by default a
 * {@link FetchWebProvider} that always supports `fetch`, and additionally
 * `search` when an endpoint + apiKey are configured. When a capability is
 * unavailable the tool still advertises but returns a clean
 * "provider unavailable" result (it never throws) so the model learns how to
 * enable it.
 *
 * Outputs carry source metadata: every fetch/search result includes a
 * deterministic `sourceId`, a `sources`/`citations` array, and a `telemetry`
 * block (durationMs, cacheStatus, policy, byteCount/resultCount).
 */
export function buildWebToolProvider(
  config: WebToolProviderConfig,
  options: BuildWebToolProviderOptions = {},
): ToolProvider {
  const enabled = Boolean(config.enabled);
  const fetchEnabled = Boolean(config.fetchEnabled);
  const searchEnabled = Boolean(config.searchEnabled);
  const allowDomains = (config.allowDomains ?? []).map((d) => d.toLowerCase());
  const denyDomains = (config.denyDomains ?? []).map((d) => d.toLowerCase());
  const maxBytesCap = config.maxBytes ?? DEFAULT_WEB_MAX_BYTES;
  const timeoutCap = config.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const search = config.search ?? {};
  const searchConfigured = Boolean(search.endpoint && search.apiKey);

  // Faithful to the original: a fetch provider is only built when fetch is
  // enabled; otherwise web tools fall back to the null-object provider.
  const provider: WebProvider =
    options.provider ??
    (enabled && fetchEnabled
      ? new FetchWebProvider(search, searchConfigured, options.nowIso)
      : new UnavailableWebProvider(search.provider));

  // The original gates each tool independently: web_fetch only when
  // fetchEnabled, web_search only when searchEnabled. Enabling web with both
  // false advertises no web tools at all.
  const tools: LocalTool[] = [];
  if (enabled && fetchEnabled) {
    tools.push(createFetchTool({ allowDomains, denyDomains, maxBytesCap, timeoutCap, provider }));
  }
  if (enabled && searchEnabled) {
    tools.push(createSearchTool({ search, searchConfigured, timeoutCap, provider }));
  }

  const fetchAvailable = Boolean(fetchEnabled && provider.fetch);
  const searchAvailable = Boolean(searchEnabled && provider.search);
  const reason = !enabled
    ? "web tools are disabled by config"
    : tools.length === 0
      ? "web tools are disabled by config"
      : !fetchAvailable && !searchAvailable
        ? "web provider is unavailable"
        : undefined;

  return {
    id: "web",
    kind: "web",
    enabled,
    available: tools.length > 0,
    ...(reason ? { reason } : {}),
    tools,
  };
}

function createFetchTool(deps: {
  allowDomains: string[];
  denyDomains: string[];
  maxBytesCap: number;
  timeoutCap: number;
  provider: WebProvider;
}): LocalTool {
  return defineTool({
    name: "web_fetch",
    description: "Fetch an allowed HTTP or HTTPS URL and return extracted text with source metadata.",
    toolKind: "tool_call",
    policy: "untrusted",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        max_bytes: { type: "number" },
        timeout_ms: { type: "number" },
      },
      required: ["url"],
    },
    async execute(args, context) {
      const startedAt = Date.now();
      const rawUrl = pickString(args.url);
      if (!rawUrl) return toolError("invalid_url", "url is required");

      const policy = validateUrlPolicy(rawUrl, deps.allowDomains, deps.denyDomains);
      if (!policy.ok) {
        return toolError(
          "policy_blocked",
          policy.reason,
          telemetry({ startedAt, policy: "blocked", url: rawUrl }),
        );
      }

      if (!deps.provider.fetch) {
        return toolError("provider_unavailable", "web fetch provider is unavailable");
      }

      const maxBytes = boundedInt(
        args.max_bytes,
        deps.maxBytesCap,
        Math.min(MIN_WEB_FETCH_BYTES, deps.maxBytesCap),
        deps.maxBytesCap,
      );
      const timeoutMs = boundedInt(args.timeout_ms, deps.timeoutCap, 1, deps.timeoutCap);

      try {
        const result = await deps.provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs,
          signal: context.abortSignal,
        });
        return {
          output: fetchOutput(
            result,
            telemetry({
              startedAt,
              policy: "allowed",
              url: policy.url.href,
              provider: deps.provider.id,
              byteCount: result.byteCount,
            }),
          ),
        };
      } catch (error) {
        return toolError(
          "fetch_failed",
          errorMessage(error),
          telemetry({ startedAt, policy: "allowed", url: policy.url.href, provider: deps.provider.id }),
        );
      }
    },
  });
}

function createSearchTool(deps: {
  search: WebSearchConfig;
  searchConfigured: boolean;
  timeoutCap: number;
  provider: WebProvider;
}): LocalTool {
  return defineTool({
    name: "web_search",
    description: "Search the web through the configured provider and return ranked results with source metadata.",
    toolKind: "tool_call",
    policy: "untrusted",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        timeout_ms: { type: "number" },
      },
      required: ["query"],
    },
    async execute(args, context) {
      const startedAt = Date.now();
      const query = pickString(args.query);
      if (!query) return toolError("invalid_query", "query is required");

      if (!deps.provider.search) {
        return toolError("provider_unavailable", "web search provider is unavailable");
      }

      const limit = boundedInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      const timeoutMs = boundedInt(args.timeout_ms, deps.timeoutCap, 1, deps.timeoutCap);

      try {
        const results = await deps.provider.search({
          query,
          limit,
          timeoutMs,
          signal: context.abortSignal,
        });
        return {
          output: searchOutput(
            query,
            deps.provider.id,
            results,
            telemetry({
              startedAt,
              policy: "allowed",
              provider: deps.provider.id,
              query,
              resultCount: results.length,
            }),
          ),
        };
      } catch (error) {
        return toolError(
          "search_failed",
          errorMessage(error),
          telemetry({ startedAt, policy: "allowed", provider: deps.provider.id, query }),
        );
      }
    },
  });
}

// --- provider ------------------------------------------------------------

/**
 * Default web provider. Always supports `fetch`; supports `search` only when an
 * endpoint + apiKey are configured (otherwise the `search` method is omitted so
 * the tool reports the capability as unavailable, like the original
 * {@link UnavailableWebProvider} null object).
 */
export class FetchWebProvider implements WebProvider {
  readonly id = "fetch";
  private readonly nowIso: () => string;
  // Assigned conditionally so an unconfigured provider reports search unavailable.
  search?: (request: WebSearchRequest) => Promise<WebSearchResult[]>;

  constructor(
    private readonly searchConfig: WebSearchConfig,
    searchConfigured: boolean,
    nowIso?: () => string,
  ) {
    this.nowIso = nowIso ?? (() => new Date().toISOString());
    if (searchConfigured) {
      this.search = (request) => this.runSearch(request);
    }
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const onAbort = () => controller.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(request.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("response body is not readable");

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = request.maxBytes - totalBytes;
        if (remaining <= 0) {
          truncated = true;
          await reader.cancel();
          break;
        }
        if (value.length > remaining) {
          chunks.push(value.subarray(0, remaining));
          totalBytes += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        totalBytes += value.length;
      }

      const buffer = Buffer.concat(chunks);
      const contentType = response.headers.get("content-type") ?? undefined;
      const raw = buffer.toString("utf8");
      const extracted = extractReadableText(raw, contentType);
      const finalUrl = response.url || request.url;

      return {
        sourceId: sourceIdFor("fetch", finalUrl),
        url: request.url,
        finalUrl,
        ...(extracted.title ? { title: extracted.title } : {}),
        ...(contentType ? { contentType } : {}),
        text: extracted.text,
        retrievedAt: this.nowIso(),
        byteCount: totalBytes,
        truncated,
      };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  private async runSearch(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const endpoint = this.searchConfig.endpoint!;
    const apiKey = this.searchConfig.apiKey!;
    const provider = (this.searchConfig.provider ?? "").toLowerCase();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);

    let response: Response;
    if (provider === "brave" || provider === "searxng") {
      // GET-style endpoints with the query in the URL.
      const url = new URL(endpoint);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.limit));
      if (provider === "searxng") url.searchParams.set("format", "json");
      response = await fetch(url.href, {
        method: "GET",
        headers:
          provider === "brave"
            ? { Accept: "application/json", "X-Subscription-Token": apiKey }
            : { Accept: "application/json" },
        signal,
      });
    } else {
      // Tavily / generic POST-style endpoint.
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: request.query, api_key: apiKey, max_results: request.limit, count: request.limit }),
        signal,
      });
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const retrievedAt = this.nowIso();
    return parseSearchResults(payload)
      .slice(0, request.limit)
      .map((entry) => ({
        sourceId: sourceIdFor("search", entry.url),
        title: entry.title,
        url: entry.url,
        snippet: entry.snippet,
        retrievedAt,
      }));
  }
}

// --- output shaping ------------------------------------------------------

function fetchOutput(result: WebFetchResult, toolTelemetry: WebTelemetry): Record<string, unknown> {
  const source = {
    sourceId: result.sourceId,
    url: result.finalUrl,
    ...(result.title ? { title: result.title } : {}),
    retrievedAt: result.retrievedAt,
  };
  return {
    sourceId: result.sourceId,
    url: result.url,
    finalUrl: result.finalUrl,
    ...(result.title ? { title: result.title } : {}),
    retrievedAt: result.retrievedAt,
    ...(result.contentType ? { contentType: result.contentType } : {}),
    text: result.text,
    byteCount: result.byteCount,
    truncated: result.truncated,
    sources: [source],
    citations: [source],
    telemetry: toolTelemetry,
  };
}

function searchOutput(
  query: string,
  provider: string,
  results: WebSearchResult[],
  toolTelemetry: WebTelemetry,
): Record<string, unknown> {
  const sources = results.map((result) => ({
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    ...(result.retrievedAt ? { retrievedAt: result.retrievedAt } : {}),
  }));
  return {
    query,
    provider,
    results,
    sources,
    citations: sources,
    telemetry: toolTelemetry,
  };
}

interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Best-effort extraction of a {title,url,snippet}[] array from a variety of provider shapes. */
function parseSearchResults(payload: unknown): ParsedSearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const candidates =
    pickArray(obj.results) ??
    pickArray(obj.web && (obj.web as Record<string, unknown>).results) ??
    pickArray(obj.items) ??
    pickArray(obj.data) ??
    [];
  const out: ParsedSearchResult[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = pickString(e.url) ?? pickString(e.link) ?? pickString(e.href);
    if (!url) continue;
    const title = pickString(e.title) ?? pickString(e.name) ?? url;
    const snippet =
      pickString(e.snippet) ??
      pickString(e.content) ??
      pickString(e.description) ??
      pickString(e.text) ??
      "";
    out.push({ title, url, snippet });
  }
  return out;
}

function pickArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

// --- URL policy -----------------------------------------------------------

type UrlPolicy = { ok: true; url: URL } | { ok: false; reason: string };

function validateUrlPolicy(rawUrl: string, allowDomains: string[], denyDomains: string[]): UrlPolicy {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL must be absolute" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https URLs are allowed" };
  }
  const hostname = url.hostname.toLowerCase();
  if (denyDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is denied: ${hostname}` };
  }
  if (allowDomains.length > 0 && !allowDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is not allowed: ${hostname}` };
  }
  return { ok: true, url };
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

// --- HTML -> text ---------------------------------------------------------

function extractReadableText(raw: string, contentType?: string): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes("html")) {
    return { text: normalizeWhitespace(raw) };
  }
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    ...(title ? { title: normalizeWhitespace(decodeHtmlEntities(title)) } : {}),
    text: normalizeWhitespace(decodeHtmlEntities(text)),
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- telemetry + helpers ---------------------------------------------------

interface WebTelemetry {
  provider?: string;
  url?: string;
  query?: string;
  byteCount?: number;
  resultCount?: number;
  durationMs: number;
  cacheStatus: "miss";
  policy: "allowed" | "blocked";
}

function telemetry(input: {
  startedAt: number;
  policy: "allowed" | "blocked";
  provider?: string;
  url?: string;
  query?: string;
  byteCount?: number;
  resultCount?: number;
}): WebTelemetry {
  return {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.byteCount !== undefined ? { byteCount: input.byteCount } : {}),
    ...(input.resultCount !== undefined ? { resultCount: input.resultCount } : {}),
    durationMs: Date.now() - input.startedAt,
    cacheStatus: "miss",
    policy: input.policy,
  };
}

function toolError(
  code: string,
  message: string,
  toolTelemetry?: WebTelemetry,
): { output: unknown; isError: true } {
  return {
    output: {
      error: { code, message },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {}),
    },
    isError: true,
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exported so callers can inject the null-object provider.
export { UnavailableWebProvider };
