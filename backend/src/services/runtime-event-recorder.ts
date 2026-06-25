import { RuntimeEvent, type RuntimeEventInput } from "../contracts/events.js";
import type { SessionStore } from "../adapters/store/types.js";
import type { EventBus } from "../adapters/event/event-bus.js";

export interface RuntimeEventRecorderDeps {
  sessionStore: SessionStore;
  eventBus: EventBus;
  nowIso: () => string;
  allocateSeq: (threadId: string) => number;
}

/**
 * Stamps each event with a monotonic, collision-free per-thread seq, persists it
 * to the session log, then publishes it on the bus. EVERY event is persisted
 * (assistant_text_delta, tool_call_ready, heartbeat, pipeline_stage, …), so
 * since_seq / loadEventsSince replay reproduces the full live stream.
 *
 * Faithful to the original RuntimeEventRecorder: the persisted high-water mark is
 * read once per thread and cached in `lastIssuedSeq`; afterwards issuance is
 * synchronous (`max(allocated, floor + 1)`), so concurrent record() calls can no
 * longer race the store read and stamp the same seq twice (which made since_seq
 * replay skip events). No per-thread record() serialization is needed.
 */
export class RuntimeEventRecorder {
  private readonly lastIssuedSeq = new Map<string, number>();

  constructor(private readonly deps: RuntimeEventRecorderDeps) {}

  async record(draft: RuntimeEventInput): Promise<RuntimeEvent> {
    const seq = await this.nextSeq(draft.threadId);
    this.noteIssuedSeq(draft.threadId, seq);
    const event = RuntimeEvent.parse({ ...draft, seq, timestamp: this.deps.nowIso() });
    await this.deps.sessionStore.appendEvent(event.threadId, event);
    this.deps.eventBus.publish(event);
    return event;
  }

  /**
   * Issues the next per-thread seq. The persisted high-water mark is read once
   * per thread and cached; afterwards issuance is synchronous.
   */
  private async nextSeq(threadId: string): Promise<number> {
    let floor = this.lastIssuedSeq.get(threadId);
    if (floor === undefined) {
      const persisted = await this.deps.sessionStore.highestSeq(threadId).catch(() => 0);
      floor = Math.max(persisted, this.lastIssuedSeq.get(threadId) ?? 0);
    }
    const allocated = this.deps.allocateSeq(threadId);
    const seq = Math.max(allocated, floor + 1);
    this.noteIssuedSeq(threadId, seq);
    return seq;
  }

  private noteIssuedSeq(threadId: string, seq: number): void {
    const current = this.lastIssuedSeq.get(threadId) ?? 0;
    if (seq > current) this.lastIssuedSeq.set(threadId, seq);
  }
}
