import type { RuntimeEvent } from "../../contracts/events.js";

export type EventHandler = (event: RuntimeEvent) => void;

/** Per-thread pub/sub with a monotonic seq allocator and a small replay ring. */
export interface EventBus {
  publish(event: RuntimeEvent): void;
  subscribe(threadId: string, handler: EventHandler): () => void;
  snapshotSince(threadId: string, sinceSeq: number): RuntimeEvent[];
  highestSeq(threadId: string): number;
  allocateSeq(threadId: string): number;
  reset(): void;
}

const MAX_RETAINED_EVENTS_PER_THREAD = 256;

export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Map<string, Set<EventHandler>>();
  private readonly recent = new Map<string, RuntimeEvent[]>();
  private readonly highest = new Map<string, number>();
  private readonly nextSeq = new Map<string, number>();

  publish(event: RuntimeEvent): void {
    const ring = this.recent.get(event.threadId) ?? [];
    ring.push(event);
    if (ring.length > MAX_RETAINED_EVENTS_PER_THREAD) ring.splice(0, ring.length - MAX_RETAINED_EVENTS_PER_THREAD);
    this.recent.set(event.threadId, ring);
    if (typeof event.seq === "number") {
      this.highest.set(event.threadId, Math.max(this.highest.get(event.threadId) ?? 0, event.seq));
    }
    for (const handler of this.subscribers.get(event.threadId) ?? []) {
      try {
        handler(event);
      } catch {
        /* a failing subscriber must not break publishing */
      }
    }
  }

  subscribe(threadId: string, handler: EventHandler): () => void {
    const set = this.subscribers.get(threadId) ?? new Set<EventHandler>();
    set.add(handler);
    this.subscribers.set(threadId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(threadId);
    };
  }

  snapshotSince(threadId: string, sinceSeq: number): RuntimeEvent[] {
    const ring = this.recent.get(threadId) ?? [];
    return ring.filter((event) => event.seq > sinceSeq);
  }

  highestSeq(threadId: string): number {
    return this.highest.get(threadId) ?? 0;
  }

  allocateSeq(threadId: string): number {
    const next = (this.nextSeq.get(threadId) ?? this.highestSeq(threadId)) + 1;
    this.nextSeq.set(threadId, next);
    return next;
  }

  reset(): void {
    this.recent.clear();
    this.subscribers.clear();
    this.nextSeq.clear();
    this.highest.clear();
  }
}
