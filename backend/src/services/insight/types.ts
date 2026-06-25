import { z } from "zod";
import type { TurnItem } from "../../contracts/items.js";

/**
 * Proactive insight engine, ported from the original Nexus insight service but
 * adapted to generic model providers and the nexus-agent contracts. The engine
 * watches completed turns and, when cheap regex prefilters fire, asks an LLM to
 * classify whether ONE proactive office action is warranted.
 */

/** Sensitivity governs prefilter thresholds and the published-confidence floor. */
export const InsightSensitivity = z.enum(["high", "medium", "low"]);
export type InsightSensitivity = z.infer<typeof InsightSensitivity>;

/** The three turn-end detectors plus the two group-chat detectors share this id space. */
export const InsightDetectorType = z.enum([
  "knowledge_capture",
  "meeting_alignment",
  "data_to_sheet",
]);
export type InsightDetectorType = z.infer<typeof InsightDetectorType>;

/**
 * Schema for the model's JSON classification. The detector validates its own
 * `type` against this; `draft_payload` is detector-specific and left open.
 */
export const InsightClassificationSchema = z.object({
  type: InsightDetectorType,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1),
  draft_payload: z.record(z.string(), z.unknown()).default({}),
});
export type InsightClassification = z.infer<typeof InsightClassificationSchema>;

/** Result of a detector's cheap prefilter: whether to spend an LLM call. */
export interface PrefilterResult {
  matched: boolean;
  /** Short lowercase slug used for dedupe keying; falls back to topicFromItems. */
  topic?: string;
  /** Free-form hints fed into the classifier user prompt. */
  hints?: string;
  /** Optional human-readable reason for skip-logging. */
  reason?: string;
}

/** Input passed to a detector's user-prompt builder. */
export interface DetectorPromptInput {
  excerpt: string;
  hints?: string;
}

/** Input passed to a detector's draft-payload builder. */
export interface DetectorDraftInput {
  classification: InsightClassification;
  items: TurnItem[];
  topic: string;
}

/**
 * A detector pairs a cheap deterministic prefilter with an LLM classification.
 * `classify` is the gateway-backed path the engine drives; detectors expose the
 * system prompt + prompt/payload builders the gateway needs.
 */
export interface InsightDetector {
  readonly id: InsightDetectorType;
  prefilter(items: TurnItem[], sensitivity: InsightSensitivity): PrefilterResult;
  readonly systemPrompt: string;
  buildUserPrompt(input: DetectorPromptInput): string;
  buildDraftPayload?(input: DetectorDraftInput): Record<string, unknown>;
}

/** A published proactive suggestion. */
export interface Suggestion {
  suggestionId: string;
  detector: InsightDetectorType;
  title: string;
  confidence: number;
  topic: string;
  draftPayload: Record<string, unknown>;
}

/** Best-effort decision record emitted by the engine for observability. */
export interface InsightDecision {
  threadId: string;
  turnId?: string;
  detector: InsightDetectorType;
  reason:
    | "prefilter_skipped"
    | "dismissed"
    | "cooldown"
    | "model_error"
    | "unparseable"
    | "type_mismatch"
    | "below_confidence"
    | "published";
  detail?: string;
  topic?: string;
  confidence?: number;
}

/**
 * Runtime event the engine emits when a suggestion is published. The host's
 * RuntimeEvent union does not (yet) carry a `suggestion` kind, so the engine
 * emits through an injected `emit` sink rather than the shared recorder; the
 * integrator decides how to surface it (side channel, bus extension, etc.).
 */
export interface SuggestionEvent {
  kind: "suggestion";
  threadId: string;
  turnId?: string;
  suggestionId: string;
  detector: InsightDetectorType;
  title: string;
  confidence: number;
  topic: string;
  draftPayload: Record<string, unknown>;
}

/** Confidence floor by sensitivity. A configured minConfidence can only raise it. */
export function confidenceFloor(sensitivity: InsightSensitivity): number {
  switch (sensitivity) {
    case "high":
      return 0.6;
    case "low":
      return 0.82;
    case "medium":
    default:
      return 0.7;
  }
}
