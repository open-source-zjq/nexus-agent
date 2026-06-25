// Quick smoke test for the tool host + builtin tools (no model involved).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "../src/ports/clock.js";
import { LocalToolHost } from "../src/adapters/tool/local-tool-host.js";
import { buildDefaultLocalTools } from "../src/adapters/tool/builtin-tools.js";
import type { ToolContext } from "../src/adapters/tool/types.js";

const ws = mkdtempSync(join(tmpdir(), "nexus-tools-"));
writeFileSync(join(ws, "hello.txt"), "line one\nline two\nhello world\n");

const host = new LocalToolHost({ tools: buildDefaultLocalTools(), readTracker: true });
const ctx: ToolContext = {
  workspace: ws,
  threadId: "t1",
  turnId: "turn1",
  abortSignal: new AbortController().signal,
  approvalPolicy: "auto",
  sandboxMode: "workspace-write",
  clock: systemClock,
  awaitApproval: async () => "allow",
};

// host shell (bash) is only permitted under danger-full-access; workspace-write blocks it.
const dangerCtx: ToolContext = { ...ctx, sandboxMode: "danger-full-access" };

let id = 0;
async function run(toolName: string, args: Record<string, unknown>, ctxOverride?: ToolContext): Promise<void> {
  id += 1;
  const result = await host.execute({ toolName, callId: `c${id}`, arguments: args }, ctxOverride ?? ctx);
  const item = result.item as { kind: string; output: unknown; isError?: boolean };
  console.log(`\n# ${toolName}(${JSON.stringify(args)}) isError=${item.isError ?? false}`);
  console.log(JSON.stringify(item.output).slice(0, 240));
}

await run("ls", {});
await run("write", { path: "sub/new.txt", content: "fresh file\n" });
await run("read", { path: "hello.txt" });
await run("edit", { path: "hello.txt", oldText: "hello world", newText: "HELLO WORLD" });
await run("read", { path: "hello.txt" });
await run("grep", { pattern: "HELLO" });
await run("find", { pattern: "*.txt" });
// bash runs only under danger-full-access
await run("bash", { command: "echo from-shell && ls" }, dangerCtx);
// sandbox: host shell must be blocked under workspace-write (security fix)
await run("bash", { command: "echo should-be-blocked" });
// sandbox: write outside workspace should be blocked
await run("write", { path: "/etc/should-fail.txt", content: "nope" });

console.log("\nOK — tool smoke complete");
