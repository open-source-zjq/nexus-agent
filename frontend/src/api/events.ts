import type { RuntimeEvent } from "./types.js";
import { getToken } from "./client.js";

export interface EventStreamHandle {
  close(): void;
}

/**
 * Subscribe to a thread's SSE event stream via fetch + ReadableStream (so we
 * can send the Authorization header and a since_seq cursor). Auto-reconnects.
 */
export function subscribeThreadEvents(
  threadId: string,
  sinceSeq: number,
  onEvent: (event: RuntimeEvent) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
): EventStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let cursor = sinceSeq;

  const connect = async (): Promise<void> => {
    if (closed) return;
    onStatus?.("connecting");
    controller = new AbortController();
    const token = getToken();
    try {
      const response = await fetch(`/v1/threads/${threadId}/events?since_seq=${cursor}`, {
        headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);
      onStatus?.("open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine) as RuntimeEvent;
            if (typeof event.seq === "number" && event.seq > cursor) cursor = event.seq;
            if (event.kind !== "heartbeat") onEvent(event);
          } catch {
            /* skip bad frame */
          }
        }
      }
    } catch {
      /* connection dropped */
    }
    if (!closed) {
      onStatus?.("closed");
      setTimeout(connect, 1000);
    }
  };

  void connect();

  return {
    close() {
      closed = true;
      controller?.abort();
      onStatus?.("closed");
    },
  };
}
