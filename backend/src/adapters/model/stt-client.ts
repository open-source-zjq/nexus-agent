import type { SpeechToTextConfig } from "../../config/config.js";

/**
 * Speech-to-text (语音转写) transcription client (T10.4).
 *
 * A generic OpenAI-compatible transcription adapter that POSTs base64 audio to
 * the configured `{endpoint}/v1/audio/transcriptions` endpoint as multipart
 * FormData (mirroring the media-gen image-edit upload) and returns the plain
 * `{ text }`. It is provider-agnostic over the live config only — it does NOT
 * import a model client and does NOT use the `complete()` completion seam,
 * exactly like the media-gen image/speech clients, because transcription is an
 * audio POST to a vendor endpoint, not a text completion.
 *
 * The service is constructed in serve.ts with a live config getter and gated
 * per-call by the route on `capabilities.speechToText.enabled` + a configured
 * endpoint/apiKey/model.
 */

/** OpenAI's documented hard cap for an `/audio/transcriptions` upload (25 MB). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Default per-request transcription timeout when the config omits `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** A transcription provider/transport failure (HTTP non-2xx, bad payload). */
export class SpeechToTextError extends Error {}

export interface TranscribeInput {
  /** Audio bytes, base64-encoded (no data-URL prefix). */
  audioBase64: string;
  /** Source container MIME type, e.g. "audio/webm". */
  mimeType: string;
  /** Optional ISO-639-1 language hint forwarded to the provider. */
  language?: string;
  /** Optional caller cancellation signal, AND-ed with the per-call timeout. */
  signal?: AbortSignal;
}

/**
 * Live, gated speech-to-text config accessor. Returns the current
 * `capabilities.speechToText` block (or undefined when absent); the service
 * reads it fresh on every call so a Settings change takes effect without a
 * restart.
 */
export type SpeechToTextConfigGetter = () => SpeechToTextConfig | undefined;

export class SpeechToTextService {
  private readonly getConfig: SpeechToTextConfigGetter;

  constructor(deps: { getConfig: SpeechToTextConfigGetter }) {
    this.getConfig = deps.getConfig;
  }

  /**
   * POST the audio to the configured transcription endpoint and return the text.
   *
   * The route has already verified `enabled` + endpoint/apiKey/model, but this
   * method re-reads the live config and throws a {@link SpeechToTextError} if a
   * field is missing (defense in depth), oversized, or the provider returns a
   * non-2xx — never a bare crash.
   */
  async transcribe(input: TranscribeInput): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg?.endpoint || !cfg?.apiKey || !cfg?.model) {
      throw new SpeechToTextError("speech-to-text provider is not configured");
    }

    const bytes = Buffer.from(input.audioBase64, "base64");
    if (bytes.length === 0) {
      throw new SpeechToTextError("audio payload is empty");
    }
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new SpeechToTextError(
        `audio payload is too large (${bytes.length} bytes; max ${MAX_AUDIO_BYTES})`,
      );
    }

    const url = apiUrl(cfg.endpoint, "/v1/audio/transcriptions");
    const form = new FormData();
    form.set("model", cfg.model);
    // A sensible extension is required so the provider can sniff the format.
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: input.mimeType }),
      `audio${extensionFor(input.mimeType)}`,
    );
    const language = input.language ?? cfg.language;
    if (language) form.set("language", language);
    // OpenAI returns `{ text }` for the json response format.
    form.set("response_format", "json");

    const signal = withTimeout(input.signal ?? new AbortController().signal, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      // NO Content-Type header — FormData/undici sets the multipart boundary.
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal,
      });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError" || (error as { name?: string }).name === "TimeoutError") {
        throw new SpeechToTextError("transcription request timed out");
      }
      throw new SpeechToTextError(`transcription request failed: ${(error as Error).message}`);
    }

    if (!response.ok) {
      throw new SpeechToTextError(`HTTP ${response.status}: ${await safeText(response)}`);
    }
    const payload = (await response.json().catch(() => ({}))) as { text?: string };
    return (payload.text ?? "").trim();
  }
}

/** Map an audio MIME type to a provider-recognizable file extension. */
function extensionFor(mimeType: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (type) {
    case "audio/webm":
      return ".webm";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return ".wav";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return ".m4a";
    case "audio/ogg":
    case "audio/opus":
      return ".ogg";
    case "audio/flac":
      return ".flac";
    default:
      return ".webm";
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Normalize `{baseUrl}` + `/v1/<path>` whether or not the base already ends in
 * `/v1` (or already carries the full path). Duplicated from the media-gen tool
 * provider's module-private `apiUrl` (tiny pure helper; duplication is the
 * lower-risk, convention-matching choice over exporting a private symbol).
 */
function apiUrl(baseUrl: string, v1Path: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim());
  const lower = normalized.toLowerCase();
  const path = v1Path.startsWith("/") ? v1Path : `/${v1Path}`;
  const pathWithoutV1 = path.startsWith("/v1/") ? path.slice("/v1".length) : path;
  if (!normalized) return path;
  if (lower.endsWith(path.toLowerCase()) || lower.endsWith(pathWithoutV1.toLowerCase())) return normalized;
  if (lower.endsWith("/v1")) return `${normalized}${pathWithoutV1}`;
  return `${normalized}${path}`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** AND a caller signal with a per-call timeout, mirroring the media-gen helper. */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
