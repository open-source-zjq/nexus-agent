import type { TurnItem } from "../../contracts/items.js";
import {
  InsightClassificationSchema,
  confidenceFloor,
  type InsightClassification,
  type InsightDecision,
  type InsightDetector,
  type InsightSensitivity,
  type Suggestion,
  type SuggestionEvent,
} from "./types.js";
import {
  conversationExcerpt,
  errorMessage,
  extractJsonObject,
  topicFromItems,
} from "./conversation.js";
import type { InsightModelGateway } from "./model-gateway.js";
import { knowledgeCaptureDetector } from "./detectors/knowledge-capture.js";
import { meetingAlignmentDetector } from "./detectors/meeting-alignment.js";
import { dataToSheetDetector } from "./detectors/data-to-sheet.js";
import type { CompleteFn } from "./model-gateway.js";
import { InsightModelGateway as Gateway } from "./model-gateway.js";

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_DISMISSED = 1000;

/** Per-detector enable map; absent/true = on, false = off. */
export interface InsightDetectorToggles {
  knowledge_capture?: boolean;
  meeting_alignment?: boolean;
  data_to_sheet?: boolean;
}

export interface InsightConfig {
  enabled: boolean;
  sensitivity: InsightSensitivity;
  /** Floors the published confidence; can only raise the sensitivity floor. */
  minConfidence?: number;
  detectors?: InsightDetectorToggles;
}

/** Minimal clock the engine reads; matches the host clock shape (nowMs). */
export interface InsightClock {
  nowMs(): number;
}

export interface InsightEngineDeps {
  gateway: InsightModelGateway;
  /** Sink for published suggestions. The host decides the transport. */
  emit: (event: SuggestionEvent) => void;
  clock: InsightClock;
  config: InsightConfig;
  detectors?: InsightDetector[];
  ids?: () => string;
  /** Best-effort decision logger for observability; throwing is swallowed. */
  logger?: (decision: InsightDecision) => void;
}

interface EvaluateInput {
  detector: InsightDetector;
  items: TurnItem[];
  excerpt: string;
  sensitivity: InsightSensitivity;
  threadId: string;
  turnId?: string;
}

/**
 * Proactive insight engine. On each completed turn it runs every enabled
 * detector in parallel, each gated by a cheap deterministic prefilter; only
 * matches spend an LLM classification. Results are deduped (30-min cooldown per
 * thread:detector:topic plus a per-session dismissed set) and floored on
 * confidence before a `suggestion` event is emitted.
 *
 * BEST-EFFORT: onTurnEnd never throws into the agent loop.
 */
export class InsightEngine {
  private readonly deps: InsightEngineDeps;
  private readonly detectors: InsightDetector[];
  private readonly cooldowns = new Map<string, number>();
  private readonly dismissed = new Set<string>();
  private readonly ids: () => string;

  constructor(deps: InsightEngineDeps) {
    this.deps = deps;
    this.detectors = deps.detectors ?? [
      knowledgeCaptureDetector,
      meetingAlignmentDetector,
      dataToSheetDetector,
    ];
    this.ids = deps.ids ?? (() => Math.random().toString(36).slice(2, 12));
  }

  private nowMs(): number {
    return this.deps.clock.nowMs();
  }

  /** Records a (detector, topic) as dismissed for this session — never re-shown. */
  dismiss(threadId: string, detector: string, topic: string): void {
    this.dismissed.add(this.key(threadId, detector, topic));
    while (this.dismissed.size > MAX_DISMISSED) {
      const oldest = this.dismissed.values().next().value;
      if (oldest === undefined) break;
      this.dismissed.delete(oldest);
    }
  }

  /** Drops elapsed cooldown entries so the map stays bounded. */
  private pruneCooldowns(now: number): void {
    for (const [key, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(key);
    }
  }

  /**
   * Turn-end hook. Best-effort: never throws into the agent loop. Detectors run
   * in parallel — the classifier call is the only cost and keeping them serial
   * just added latency to every completed turn.
   */
  async onTurnEnd(input: { threadId: string; turnId?: string; items: TurnItem[] }): Promise<void> {
    try {
      const config = this.deps.config;
      if (!config.enabled) return;
      const items = input.items;
      if (items.length === 0) return;

      this.pruneCooldowns(this.nowMs());
      const sensitivity = config.sensitivity;
      const excerpt = conversationExcerpt(items);

      await Promise.all(
        this.detectors.map(async (detector) => {
          if (config.detectors && config.detectors[detector.id] === false) return;
          try {
            await this.evaluate({
              detector,
              items,
              excerpt,
              sensitivity,
              threadId: input.threadId,
              turnId: input.turnId,
            });
          } catch (error) {
            this.log({
              threadId: input.threadId,
              turnId: input.turnId,
              detector: detector.id,
              reason: "model_error",
              detail: errorMessage(error),
            });
          }
        }),
      );
    } catch {
      // BEST-EFFORT: never propagate into the caller.
    }
  }

  private async evaluate(input: EvaluateInput): Promise<void> {
    const { detector, items, excerpt, sensitivity, threadId, turnId } = input;
    const base = { threadId, turnId, detector: detector.id } as const;

    const prefilter = detector.prefilter(items, sensitivity);
    const topic = prefilter.topic || topicFromItems(items);
    if (!prefilter.matched) {
      this.log({ ...base, reason: "prefilter_skipped", detail: prefilter.hints ?? "no rule match", topic });
      return;
    }

    const key = this.key(threadId, detector.id, topic);
    if (this.dismissed.has(key)) {
      this.log({ ...base, reason: "dismissed", detail: "user dismissed this topic", topic });
      return;
    }
    const cooledUntil = this.cooldowns.get(key);
    if (typeof cooledUntil === "number" && this.nowMs() < cooledUntil) {
      const remainingS = Math.round((cooledUntil - this.nowMs()) / 1000);
      this.log({ ...base, reason: "cooldown", detail: `cooling for ${remainingS}s`, topic });
      return;
    }

    let raw: string;
    try {
      raw = await this.deps.gateway.classify({
        system: detector.systemPrompt,
        user: detector.buildUserPrompt({ excerpt, hints: prefilter.hints }),
      });
    } catch (error) {
      this.log({ ...base, reason: "model_error", detail: errorMessage(error), topic });
      return;
    }

    const parsed = this.parseClassification(raw);
    if (!parsed) {
      this.log({ ...base, reason: "unparseable", detail: raw.slice(0, 160) || "(empty response)", topic });
      return;
    }
    if (parsed.type !== detector.id) {
      this.log({ ...base, reason: "type_mismatch", detail: `model returned ${parsed.type}`, topic });
      return;
    }

    const floor = this.confidenceFloorFor(sensitivity);
    if (parsed.confidence < floor) {
      this.log({
        ...base,
        reason: "below_confidence",
        detail: `confidence ${parsed.confidence.toFixed(2)} < floor ${floor.toFixed(2)}`,
        topic,
        confidence: parsed.confidence,
      });
      return;
    }

    const draftPayload = detector.buildDraftPayload
      ? detector.buildDraftPayload({ classification: parsed, items, topic })
      : parsed.draft_payload;
    const suggestion: Suggestion = {
      suggestionId: `sug_${this.ids()}`,
      detector: detector.id,
      title: parsed.title,
      confidence: parsed.confidence,
      topic,
      draftPayload,
    };

    this.cooldowns.set(key, this.nowMs() + COOLDOWN_MS);
    this.publish(threadId, turnId, suggestion);
    this.log({ ...base, reason: "published", detail: parsed.title, topic, confidence: parsed.confidence });
  }

  /**
   * Confidence gate. The sensitivity floor governs (high 0.60 / medium 0.70 /
   * low 0.82); a configured `minConfidence` can only raise it.
   */
  private confidenceFloorFor(sensitivity: InsightSensitivity): number {
    const base = confidenceFloor(sensitivity);
    const min = this.deps.config.minConfidence;
    return typeof min === "number" ? Math.max(base, min) : base;
  }

  /** Best-effort decision logging; a throwing logger must not break the engine. */
  private log(decision: InsightDecision): void {
    try {
      this.deps.logger?.(decision);
    } catch {
      // swallow
    }
  }

  private parseClassification(raw: string): InsightClassification | null {
    const json = extractJsonObject(raw);
    if (!json) return null;
    const result = InsightClassificationSchema.safeParse(json);
    return result.success ? result.data : null;
  }

  private publish(threadId: string, turnId: string | undefined, suggestion: Suggestion): void {
    this.deps.emit({
      kind: "suggestion",
      threadId,
      turnId,
      suggestionId: suggestion.suggestionId,
      detector: suggestion.detector,
      title: suggestion.title,
      confidence: suggestion.confidence,
      topic: suggestion.topic,
      draftPayload: suggestion.draftPayload,
    });
  }

  private key(threadId: string, detector: string, topic: string): string {
    return `${threadId}:${detector}:${topic}`;
  }
}

export interface BuildInsightEngineDeps {
  /** Injected single-shot completion (serve.ts oneShot adapter). */
  complete: CompleteFn;
  emit: (event: SuggestionEvent) => void;
  clock: InsightClock;
  config: InsightConfig;
  /** Cheap/default classification model id. */
  model?: string;
  /** Classification abort budget; defaults to 20s in the gateway. */
  timeoutMs?: number;
  detectors?: InsightDetector[];
  ids?: () => string;
  logger?: (decision: InsightDecision) => void;
}

/**
 * Wires a gateway from the injected `complete` function and returns a configured
 * InsightEngine. Call this from serve.ts and invoke `onTurnEnd` after a turn
 * completes in the agent loop.
 */
export function buildInsightEngine(deps: BuildInsightEngineDeps): InsightEngine {
  const gateway = new Gateway({
    complete: deps.complete,
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });
  return new InsightEngine({
    gateway,
    emit: deps.emit,
    clock: deps.clock,
    config: deps.config,
    ...(deps.detectors ? { detectors: deps.detectors } : {}),
    ...(deps.ids ? { ids: deps.ids } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
