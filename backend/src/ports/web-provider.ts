/**
 * Web provider port — faithfully ported from the original nexus
 * `ports/web-provider.js`.
 *
 * A web provider performs the actual network I/O behind the `web_fetch` and
 * `web_search` tools. The provider is optional: either capability may be
 * absent, and the {@link UnavailableWebProvider} null object implements neither
 * so the tool layer can advertise the tools while returning a clean
 * "provider unavailable" result instead of throwing.
 */

/** A canonical source/citation descriptor attached to fetch/search outputs. */
export interface WebSource {
  sourceId: string;
  url: string;
  title?: string;
  retrievedAt?: string;
}

export interface WebFetchRequest {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface WebFetchResult {
  sourceId: string;
  /** The URL as requested by the model. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  title?: string;
  contentType?: string;
  text: string;
  retrievedAt: string;
  byteCount: number;
  truncated: boolean;
}

export interface WebSearchRequest {
  query: string;
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface WebSearchResult {
  sourceId: string;
  title: string;
  url: string;
  snippet: string;
  retrievedAt?: string;
}

export interface WebProvider {
  readonly id: string;
  fetch?(request: WebFetchRequest): Promise<WebFetchResult>;
  search?(request: WebSearchRequest): Promise<WebSearchResult[]>;
}

/**
 * Null-object web provider. Implements neither `fetch` nor `search`, so the
 * tool layer reports both capabilities as unavailable.
 */
export class UnavailableWebProvider implements WebProvider {
  readonly id: string;
  constructor(id = "unavailable") {
    this.id = id;
  }
}

/**
 * Deterministic source id for a fetched/searched resource:
 * `web_<kind>_<base36(|signed-32-bit-hash|)>`.
 *
 * The hash is the classic `hash * 31 + charCode` rolling hash, computed with
 * `(hash << 5) - hash + charCode | 0` so it stays a signed 32-bit int; the
 * magnitude is then rendered in base 36.
 */
export function sourceIdFor(kind: string, value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return `web_${kind}_${Math.abs(hash).toString(36)}`;
}
