import type { RuntimeEvent } from "../contracts/events.js";
import type { EventBus } from "../adapters/event/event-bus.js";
import type { SessionStore } from "../adapters/store/types.js";

const HEARTBEAT_INTERVAL_MS = 15000;

export function encodeSseEvent(event: RuntimeEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Build a resumable SSE response: replay backlog since_seq, then live events + heartbeat. */
export function buildEventStreamResponse(input: {
  request: Request;
  threadId: string;
  eventBus: EventBus;
  sessionStore: SessionStore;
}): Response {
  const { request, threadId, eventBus, sessionStore } = input;
  const url = new URL(request.url);
  const sinceSeq =
    Number(url.searchParams.get("since_seq") ?? "0") || Number(request.headers.get("Last-Event-ID") ?? "0") || 0;

  const encoder = new TextEncoder();
  let lastDeliveredSeq = sinceSeq;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deliver = (event: RuntimeEvent): void => {
        if (closed) return;
        if (typeof event.seq === "number" && event.seq <= lastDeliveredSeq) return;
        if (typeof event.seq === "number") lastDeliveredSeq = event.seq;
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Subscribe BEFORE reading the backlog so events published during replay
      // are not lost. While replaying, buffer live events; flush them after.
      let replaying = true;
      const liveBuffer: RuntimeEvent[] = [];
      unsubscribe = eventBus.subscribe(threadId, (event) => {
        if (closed) return;
        if (replaying) {
          liveBuffer.push(event);
          return;
        }
        try {
          deliver(event);
        } catch {
          close();
        }
      });

      try {
        const highest = await sessionStore.highestSeq(threadId).catch(() => 0);
        if (sinceSeq < highest) {
          const backlog = await sessionStore.loadEventsSince(threadId, sinceSeq);
          for (const event of backlog) deliver(event);
        }
        replaying = false;
        for (const event of liveBuffer) {
          if (closed) break;
          try {
            deliver(event);
          } catch {
            close();
          }
        }
        heartbeat = setInterval(() => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `id: ${lastDeliveredSeq}\nevent: heartbeat\ndata: ${JSON.stringify({ kind: "heartbeat", seq: lastDeliveredSeq, timestamp: new Date().toISOString(), threadId })}\n\n`,
            ),
          );
        }, HEARTBEAT_INTERVAL_MS);
        request.signal.addEventListener("abort", close, { once: true });
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`));
        close();
      }
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
