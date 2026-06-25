import { z } from "zod";
import { confidenceFloor, type InsightSensitivity, type SuggestionEvent } from "./types.js";
import { errorMessage, extractJsonObject } from "./conversation.js";
import type { InsightModelGateway } from "./model-gateway.js";
import type { InsightClock } from "./insight-engine.js";

/**
 * Watches a work group chat (e.g. Feishu/Lark) and, after a quiet window,
 * decides whether the recent discussion warrants ONE proactive office action
 * (a meeting alignment or a knowledge capture).
 *
 * The chat transport is PLUGGABLE: this module does not implement any Feishu
 * SDK. The host injects a `GroupTransport` that delivers normalized messages
 * via `onMessage`. With no transport, the watcher is inert.
 */

const DEFAULT_DEBOUNCE_MS = 25_000;
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_BUFFER = 60;
const MAX_EXCERPT_CHARS = 4000;
const MAX_DISMISSED = 1000;

/** Group classification accepts the two group detectors plus an explicit none. */
const GroupClassificationSchema = z.object({
  type: z.enum(["meeting_alignment", "knowledge_capture", "none"]),
  confidence: z.number().min(0).max(1).default(0),
  title: z.string().default(""),
  summary: z.string().default(""),
  topic: z.string().default(""),
});
type GroupClassification = z.infer<typeof GroupClassificationSchema>;

const GROUP_SYSTEM_PROMPT = [
  "You watch a work group chat and decide whether the recent discussion warrants ONE proactive office action. Be conservative — most chatter warrants nothing.",
  "Choose exactly one:",
  '- "meeting_alignment": the group is hashing out requirements/plans/open questions that clearly need a live meeting or alignment to resolve (scheduling intent, repeated back-and-forth on a decision, "we should sync/discuss/拉个会").',
  '- "knowledge_capture": the group reached a concrete conclusion, decision, spec, or solution worth writing into a doc so it is not lost.',
  '- "none": neither is clearly warranted.',
  `Return ONLY a JSON object: {"type": "...", "confidence": 0..1, "title": "short actionable title in the chat's language", "summary": "1-3 sentence summary of what to capture or align on", "topic": "short lowercase slug"}.`,
  'Confidence reflects how clearly the signal is present. When in doubt, return type "none" with low confidence.',
].join("\n");

function buildUserPrompt(excerpt: string): string {
  return `Recent group chat messages (oldest first):

${excerpt}

Classify per the instructions and reply with the JSON object only.`;
}

function defaultTitle(type: "meeting_alignment" | "knowledge_capture"): string {
  return type === "meeting_alignment" ? "Align the group in a meeting" : "Capture this to a doc";
}

/** One observed group message, transport-normalized. */
export interface GroupMessage {
  sender?: string;
  text?: string;
}

/** A batch of messages observed for one chat thread. */
export interface GroupObservation {
  chatId: string;
  threadId: string;
  messages: GroupMessage[];
}

/**
 * Pluggable chat transport. The host implements this against its real provider
 * (Feishu/Lark, Slack, …) and calls `handler` as messages arrive. `start`
 * returns an unsubscribe/disposer. The watcher never imports a provider SDK.
 */
export interface GroupTransport {
  start(handler: (observation: GroupObservation) => void): { stop: () => void };
}

interface ScheduleHandle {
  clear: () => void;
}

interface CleanMessage {
  sender: string;
  text: string;
}

interface ChatBuffer {
  threadId: string;
  messages: CleanMessage[];
  timer: ScheduleHandle | null;
}

export interface GroupWatcherConfig {
  enabled: boolean;
  sensitivity: InsightSensitivity;
  minConfidence?: number;
}

export interface GroupWatcherDeps {
  gateway: InsightModelGateway;
  emit: (event: SuggestionEvent) => void;
  clock: InsightClock;
  config: GroupWatcherConfig;
  /**
   * Optional chat transport. When omitted the watcher is inert (no `start`
   * subscription, `observe` is still callable for tests but gated by config).
   */
  transport?: GroupTransport;
  debounceMs?: number;
  ids?: () => string;
  schedule?: (fn: () => void, ms: number) => ScheduleHandle;
  logger?: (line: string) => void;
}

export class GroupWatcher {
  private readonly deps: GroupWatcherDeps;
  private readonly buffers = new Map<string, ChatBuffer>();
  private readonly cooldowns = new Map<string, number>();
  private readonly dismissed = new Set<string>();
  private readonly ids: () => string;
  private readonly debounceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => ScheduleHandle;
  private subscription: { stop: () => void } | null = null;

  constructor(deps: GroupWatcherDeps) {
    this.deps = deps;
    this.ids = deps.ids ?? (() => Math.random().toString(36).slice(2, 12));
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return { clear: () => clearTimeout(handle) };
      });
  }

  private nowMs(): number {
    return this.deps.clock.nowMs();
  }

  /**
   * Subscribes to the injected transport. Inert (no-op) when no transport is
   * provided, so the watcher is dormant unless the host wires a chat source.
   */
  start(): void {
    if (this.subscription || !this.deps.transport) return;
    this.subscription = this.deps.transport.start((observation) => this.observe(observation));
  }

  /** Buffer an observed message batch and (re)arm the per-chat debounce timer. */
  observe(observation: GroupObservation): void {
    if (!this.deps.config.enabled) return;
    const chatId = observation.chatId.trim();
    const threadId = observation.threadId.trim();
    if (!chatId || !threadId) return;

    const clean: CleanMessage[] = observation.messages
      .filter((message) => message && typeof message.text === "string" && message.text.trim())
      .map((message) => ({
        sender: (message.sender || "").trim() || "someone",
        text: (message.text as string).trim(),
      }));
    if (clean.length === 0) return;

    const buffer: ChatBuffer = this.buffers.get(chatId) ?? { threadId, messages: [], timer: null };
    buffer.threadId = threadId;
    buffer.messages.push(...clean);
    if (buffer.messages.length > MAX_BUFFER) {
      buffer.messages.splice(0, buffer.messages.length - MAX_BUFFER);
    }
    buffer.timer?.clear();
    buffer.timer = this.schedule(() => {
      void this.flush(chatId);
    }, this.debounceMs);
    this.buffers.set(chatId, buffer);
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

  /** Cancels all pending timers + the transport subscription. Call on shutdown. */
  dispose(): void {
    for (const buffer of this.buffers.values()) buffer.timer?.clear();
    this.buffers.clear();
    this.subscription?.stop();
    this.subscription = null;
  }

  private async flush(chatId: string): Promise<void> {
    const buffer = this.buffers.get(chatId);
    if (!buffer) return;
    this.buffers.delete(chatId);
    const { threadId, messages } = buffer;
    if (messages.length === 0) return;

    this.pruneCooldowns(this.nowMs());
    const excerpt = messages
      .map((message) => `${message.sender}: ${message.text}`)
      .join("\n")
      .slice(-MAX_EXCERPT_CHARS);

    let raw: string;
    try {
      raw = await this.deps.gateway.classify({ system: GROUP_SYSTEM_PROMPT, user: buildUserPrompt(excerpt) });
    } catch (error) {
      this.log(`classify error chat=${chatId}: ${errorMessage(error)}`);
      return;
    }

    const parsed = parseClassification(raw);
    if (!parsed || parsed.type === "none") {
      this.log(`no signal chat=${chatId}`);
      return;
    }

    const detector = parsed.type;
    const topic = (parsed.topic || parsed.title || "group").slice(0, 48).toLowerCase().trim();
    const key = this.key(threadId, detector, topic);
    if (this.dismissed.has(key)) return;
    const cooledUntil = this.cooldowns.get(key);
    if (typeof cooledUntil === "number" && this.nowMs() < cooledUntil) return;

    const floor = this.confidenceFloorFor(this.deps.config.sensitivity);
    if (parsed.confidence < floor) {
      this.log(`below floor chat=${chatId} ${parsed.confidence.toFixed(2)} < ${floor.toFixed(2)}`);
      return;
    }

    this.cooldowns.set(key, this.nowMs() + COOLDOWN_MS);
    this.deps.emit({
      kind: "suggestion",
      threadId,
      suggestionId: `sug_${this.ids()}`,
      detector,
      title: parsed.title.trim() || defaultTitle(detector),
      confidence: parsed.confidence,
      topic,
      draftPayload: {
        source: "feishu_group",
        chatId,
        summary: parsed.summary,
        title: parsed.title,
      },
    });
    this.log(`published ${detector} chat=${chatId} conf=${parsed.confidence.toFixed(2)}`);
  }

  private confidenceFloorFor(sensitivity: InsightSensitivity): number {
    const base = confidenceFloor(sensitivity);
    const min = this.deps.config.minConfidence;
    return typeof min === "number" ? Math.max(base, min) : base;
  }

  private pruneCooldowns(now: number): void {
    for (const [key, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(key);
    }
  }

  private key(threadId: string, detector: string, topic: string): string {
    return `${threadId}:${detector}:${topic}`;
  }

  private log(line: string): void {
    try {
      this.deps.logger?.(`[group-watcher] ${line}`);
    } catch {
      // swallow
    }
  }
}

function parseClassification(raw: string): GroupClassification | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  const result = GroupClassificationSchema.safeParse(json);
  return result.success ? result.data : null;
}
