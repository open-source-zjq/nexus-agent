import { z } from "zod";

/**
 * POST /v1/audio/transcribe (语音转写) request/response contracts (T10.4).
 *
 * No backend route reads multipart/binary directly — every route uses
 * `readJsonBody`, so the client sends the audio as a base64 string in JSON. The
 * route hands the bytes to {@link SpeechToTextService}, which re-encodes them as
 * a multipart FormData POST to the configured OpenAI-compatible
 * `{endpoint}/v1/audio/transcriptions` endpoint.
 */
export const TranscribeAudioRequest = z.object({
  /** The recorded audio, base64-encoded (no data-URL prefix). */
  audioBase64: z.string().min(1),
  /** Source container MIME type, e.g. "audio/webm" | "audio/wav" | "audio/mpeg". */
  mimeType: z.string().min(1),
  /** Optional ISO-639-1 language hint; overrides the config default when present. */
  language: z.string().optional(),
});
export type TranscribeAudioRequest = z.infer<typeof TranscribeAudioRequest>;

/** The transcribed text returned by the provider. */
export const TranscribeAudioResponse = z.object({
  text: z.string(),
});
export type TranscribeAudioResponse = z.infer<typeof TranscribeAudioResponse>;
