// Verifies the two HIGH-severity fixes from the review.
import { streamSseData } from "../src/adapters/model/shared.js";
import { effectiveHistoryAfterLatestCompaction } from "../src/domain/model-history.js";
import type { TurnItem } from "../src/contracts/items.js";

// 1) SSE parser must handle CRLF frame separators (\r\n\r\n).
function crlfStream(): ReadableStream<Uint8Array> {
  const frames = `data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = new TextEncoder().encode(frames);
  return new ReadableStream({
    start(c) {
      // split into two chunks to also exercise cross-chunk buffering
      c.enqueue(bytes.slice(0, 18));
      c.enqueue(bytes.slice(18));
      c.close();
    },
  });
}

const got: string[] = [];
for await (const data of streamSseData(crlfStream(), new AbortController().signal, 0)) {
  got.push(data);
}
const sseOk = got.length === 3 && got[0] === '{"n":1}' && got[1] === '{"n":2}' && got[2] === "[DONE]";
console.log(`CRLF SSE parse: ${sseOk ? "PASS" : "FAIL"} -> ${JSON.stringify(got)}`);

// 2) Compaction must preserve the kept tail across the effective-history derivation.
const base = (id: string, kind: "user_message" | "assistant_text", text: string): TurnItem =>
  ({ kind, id, turnId: "t1", threadId: "th1", role: kind === "user_message" ? "user" : "assistant", status: "completed", createdAt: "now", text }) as TurnItem;

const summary: TurnItem = {
  kind: "compaction",
  id: "c1",
  turnId: "t1",
  threadId: "th1",
  role: "system",
  status: "completed",
  createdAt: "now",
  summary: "folded u1+a1",
  replacedTokens: 100,
  pinnedConstraints: [],
  sourceItemIds: ["u1", "a1"],
};

// append-only log: head [u1,a1], tail [u2,a2], then the appended summary, then a new u3
const log: TurnItem[] = [base("u1", "user_message", "first"), base("a1", "assistant_text", "reply1"), base("u2", "user_message", "second"), base("a2", "assistant_text", "reply2"), summary, base("u3", "user_message", "third")];
const effective = effectiveHistoryAfterLatestCompaction(log);
const ids = effective.map((i) => i.id);
const compactOk = JSON.stringify(ids) === JSON.stringify(["c1", "u2", "a2", "u3"]);
console.log(`Compaction tail preserved: ${compactOk ? "PASS" : "FAIL"} -> ${JSON.stringify(ids)}`);

if (!sseOk || !compactOk) process.exit(1);
console.log("\nBoth HIGH fixes verified.");
