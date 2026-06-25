#!/usr/bin/env node
/**
 * Headless agent CLI — the `run` / `chat` / `exec` subcommands that drive the
 * same fully-wired runtime `serve` builds, without the HTTP/GUI layer. Faithful
 * port of the original `cli/agent-cli` module (runAgentCommand + the three
 * sub-runners + the shared option/positional parsing). The unified entry
 * (`serve-entry.ts`) imports `runAgentCommand`/`splitNexusCliCommand` to
 * dispatch; this file also runs standalone (via the `nexus-agent-cli` bin /
 * `npm run cli`), dispatching everything except `serve`.
 *
 *   run  [options] <prompt>   one agent turn, prints the reply, exits
 *   chat [options]            line-oriented terminal chat (/exit or /quit)
 *   exec [options] <tool>     list (--list-tools) or invoke a tool directly
 */
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { buildRuntime, parseServeOptionsSafe, ServeExitCode, type ParseServeOptionsResult } from "./serve.js";
import { systemClock } from "../ports/clock.js";
import type { Runtime } from "../server/runtime.js";
import type { RuntimeEvent } from "../contracts/events.js";
import type { TurnItem } from "../contracts/items.js";
import type { ToolContext, ToolCall } from "../adapters/tool/types.js";

export const NEXUS_CLI_USAGE = `nexus-agent <command> [options]

Commands:
  serve [options]            Start the local HTTP/SSE runtime
  run [options] <prompt>     Run one agent turn without the GUI
  chat [options]             Start a line-oriented terminal chat
  exec [options] <tool>      List or invoke tools directly

Common options:
  --config <path>            JSON config file
  --data-dir <path>          Root directory for Nexus data
  --workspace <path>         Workspace root for run/chat/exec
  --model <model>            Model id
  --approval-policy <p>      on-request | untrusted | never | auto | suggest
  --json                     Emit machine-readable JSON where supported

Exec options:
  --list-tools               Print available tools
  --args <json>              JSON object passed to the selected tool
`;

/** I/O surface so the commands stay testable (defaults to the real process). */
export interface CliIO {
  stdin: NodeJS.ReadStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
}

/** Flags that consume the following token as their value (for positional scan). */
const VALUE_FLAGS = new Set([
  "config",
  "config-file",
  "host",
  "port",
  "data-dir",
  "token",
  "runtime-token",
  "model",
  "approval-policy",
  "sandbox-mode",
  "workspace",
  "prompt",
  "p",
  "args",
  "title",
  "storage",
  "storage-backend",
  "sqlite-path",
  "static",
]);

export type NexusCliCommand = "help" | "serve" | "run" | "chat" | "exec";

/** First-token dispatch: bare flags imply `serve`; unknown verbs are help+error. */
export function splitNexusCliCommand(argv: string[]): { command: NexusCliCommand; args: string[]; error?: string } {
  const first = argv[0];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    return { command: "help", args: [] };
  }
  if (first === "serve" || first === "run" || first === "chat" || first === "exec") {
    return { command: first, args: [...argv.slice(1)] };
  }
  if (first.startsWith("--")) {
    return { command: "serve", args: [...argv] };
  }
  return { command: "help", args: [], error: `unknown command: ${first}` };
}

export async function runAgentCommand(
  command: "run" | "chat" | "exec",
  argv: string[],
  io: CliIO,
): Promise<number> {
  switch (command) {
    case "run":
      return runOneShot(argv, io);
    case "chat":
      return runChat(argv, io);
    case "exec":
      return runExec(argv, io);
  }
}

/* ------------------------------------------------------------------- run */

async function runOneShot(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseSharedOptions(argv, io);
  if (!parsed.ok) return writeParseError(parsed, io, "nexus-agent run");
  const prompt = stringFlag(argv, ["prompt", "p"]) ?? positionals(argv).join(" ").trim();
  if (!prompt) {
    io.stderr.write("nexus-agent run: missing prompt\n");
    return ServeExitCode.usage;
  }
  const model = stringFlag(argv, ["model"]);
  let runtime: Runtime | undefined;
  try {
    runtime = (await buildRuntime(parsed.options)).runtime;
    const thread = await runtime.threadService.create({
      title: stringFlag(argv, ["title"]) ?? prompt.slice(0, 80),
      workspace: parsed.workspace,
      ...(model ? { model } : {}),
      mode: "agent",
      ...(parsed.options.approvalPolicy ? { approvalPolicy: parsed.options.approvalPolicy } : {}),
      ...(parsed.options.sandboxMode ? { sandboxMode: parsed.options.sandboxMode } : {}),
    });
    const turn = await runtime.turnService.startTurn({
      threadId: thread.id,
      request: { prompt, ...(model ? { model } : {}), mode: "agent", attachmentIds: [] },
    });
    let streamed = false;
    const status = await runTurnToCompletion(runtime, thread.id, turn.turnId, (delta) => {
      if (!parsed.json) {
        streamed = true;
        io.stdout.write(delta);
      }
    });
    const items = await runtime.sessionStore.loadItems(thread.id);
    if (parsed.json) {
      io.stdout.write(JSON.stringify({ threadId: thread.id, turnId: turn.turnId, status, items }) + "\n");
    } else {
      if (!streamed) {
        const text = assistantText(items);
        if (text) io.stdout.write(text);
      }
      io.stdout.write("\n");
    }
    return status === "completed" ? ServeExitCode.ok : ServeExitCode.runtime;
  } catch (error) {
    io.stderr.write(`nexus-agent run: ${errorMessage(error)}\n`);
    return ServeExitCode.runtime;
  }
}

/* ------------------------------------------------------------------ chat */

async function runChat(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseSharedOptions(argv, io);
  if (!parsed.ok) return writeParseError(parsed, io, "nexus-agent chat");
  const model = stringFlag(argv, ["model"]);
  let runtime: Runtime | undefined;
  try {
    runtime = (await buildRuntime(parsed.options)).runtime;
    const thread = await runtime.threadService.create({
      title: stringFlag(argv, ["title"]) ?? "CLI chat",
      workspace: parsed.workspace,
      ...(model ? { model } : {}),
      mode: "agent",
      ...(parsed.options.approvalPolicy ? { approvalPolicy: parsed.options.approvalPolicy } : {}),
      ...(parsed.options.sandboxMode ? { sandboxMode: parsed.options.sandboxMode } : {}),
    });
    const input = io.stdin;
    const terminal = Boolean(input.isTTY);
    const rl = createInterface({ input, ...(terminal ? { output: io.stdout as NodeJS.WritableStream } : {}), terminal });
    try {
      if (terminal) {
        for (;;) {
          let prompt: string;
          try {
            prompt = await rl.question("> ");
          } catch (error) {
            if (isReadlineClosedError(error)) break;
            throw error;
          }
          if (!(await runChatTurn(runtime, thread.id, prompt, model, io))) break;
        }
      } else {
        for await (const prompt of rl) {
          if (!(await runChatTurn(runtime, thread.id, prompt, model, io))) break;
        }
      }
    } finally {
      rl.close();
    }
    return ServeExitCode.ok;
  } catch (error) {
    io.stderr.write(`nexus-agent chat: ${errorMessage(error)}\n`);
    return ServeExitCode.runtime;
  }
}

/** One chat turn; returns false to end the session (blank / `/exit` / `/quit`). */
async function runChatTurn(
  runtime: Runtime,
  threadId: string,
  rawPrompt: string,
  model: string | undefined,
  io: CliIO,
): Promise<boolean> {
  const prompt = rawPrompt.trim();
  if (!prompt || prompt === "/exit" || prompt === "/quit") return false;
  const turn = await runtime.turnService.startTurn({
    threadId,
    request: { prompt, ...(model ? { model } : {}), mode: "agent", attachmentIds: [] },
  });
  let streamed = false;
  const status = await runTurnToCompletion(runtime, threadId, turn.turnId, (delta) => {
    streamed = true;
    io.stdout.write(delta);
  });
  if (!streamed && status === "completed") {
    io.stdout.write(assistantText(await runtime.sessionStore.loadItems(threadId)));
  }
  io.stdout.write("\n");
  return true;
}

/* ------------------------------------------------------------------ exec */

async function runExec(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseSharedOptions(argv, io);
  if (!parsed.ok) return writeParseError(parsed, io, "nexus-agent exec");
  let runtime: Runtime;
  try {
    runtime = (await buildRuntime(parsed.options)).runtime;
  } catch (error) {
    io.stderr.write(`nexus-agent exec: ${errorMessage(error)}\n`);
    return ServeExitCode.runtime;
  }
  const host = runtime.toolHost;
  if (!host) {
    io.stderr.write("nexus-agent exec: tool host unavailable\n");
    return ServeExitCode.runtime;
  }
  const context = buildExecContext(runtime, parsed);
  const json = parsed.json;
  try {
    if (hasFlag(argv, "list-tools")) {
      const tools = host.listTools(context);
      io.stdout.write(json ? `${JSON.stringify({ tools })}\n` : `${tools.map((tool) => tool.name).join("\n")}\n`);
      return ServeExitCode.ok;
    }
    const [toolName] = positionals(argv);
    if (!toolName) {
      io.stderr.write("nexus-agent exec: missing tool name (use --list-tools to inspect tools)\n");
      return ServeExitCode.usage;
    }
    const argsText = stringFlag(argv, ["args"]) ?? "{}";
    const args = parseJsonObject(argsText);
    if (!args.ok) {
      io.stderr.write(`nexus-agent exec: ${args.message}\n`);
      return ServeExitCode.config;
    }
    const result = await host.execute(
      { callId: `cli_${Date.now().toString(36)}`, toolName, arguments: args.value },
      context,
    );
    const item = result.item;
    if (json) {
      io.stdout.write(JSON.stringify(item) + "\n");
    } else if (item.kind === "tool_result") {
      io.stdout.write(`${formatToolOutput(item.output)}\n`);
    } else {
      io.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    }
    return item.kind === "tool_result" && item.isError ? ServeExitCode.runtime : ServeExitCode.ok;
  } catch (error) {
    io.stderr.write(`nexus-agent exec: ${errorMessage(error)}\n`);
    return ServeExitCode.runtime;
  }
}

function buildExecContext(runtime: Runtime, parsed: ParsedSharedOptions): ToolContext {
  const config = runtime.getConfig?.();
  const approvalPolicy = parsed.options.approvalPolicy ?? config?.approvalPolicy ?? "on-request";
  const sandboxMode = parsed.options.sandboxMode ?? config?.sandboxMode ?? "read-only";
  return {
    workspace: parsed.workspace,
    threadId: "cli_exec",
    turnId: "cli_exec",
    abortSignal: new AbortController().signal,
    approvalPolicy,
    sandboxMode,
    threadMode: "agent",
    clock: systemClock,
    awaitApproval: async () => (approvalPolicy === "auto" ? "allow" : "deny"),
  };
}

/* --------------------------------------------------- turn completion bridge */

/**
 * Drive a turn to a terminal lifecycle event over the event bus (the runtime's
 * `runTurn` is fire-and-forget). Streams assistant deltas through `onDelta` and
 * resolves with the terminal status. Subscribe BEFORE driving so no early delta
 * is missed.
 */
function runTurnToCompletion(
  runtime: Runtime,
  threadId: string,
  turnId: string,
  onDelta: (delta: string) => void,
): Promise<"completed" | "failed" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: "completed" | "failed" | "aborted"): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(status);
    };
    const unsubscribe = runtime.eventBus.subscribe(threadId, (event: RuntimeEvent) => {
      if (event.turnId && event.turnId !== turnId) return;
      switch (event.kind) {
        case "assistant_text_delta":
          if (typeof event.delta === "string") onDelta(event.delta);
          break;
        case "turn_completed":
          finish("completed");
          break;
        case "turn_failed":
          finish("failed");
          break;
        case "turn_aborted":
          finish("aborted");
          break;
        default:
          break;
      }
    });
    runtime.runTurn(threadId, turnId);
  });
}

/* --------------------------------------------------------------- shared opts */

interface ParsedSharedOptions {
  ok: true;
  options: Extract<ParseServeOptionsResult, { ok: true }>["options"];
  workspace: string;
  json: boolean;
}

function parseSharedOptions(argv: string[], io: CliIO): ParsedSharedOptions | Extract<ParseServeOptionsResult, { ok: false }> {
  const parsed = parseServeOptionsSafe(argv, io.env ?? {});
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    options: parsed.options,
    workspace: stringFlag(argv, ["workspace"]) ?? io.env?.NEXUS_WORKSPACE ?? io.cwd?.() ?? process.cwd(),
    json: hasFlag(argv, "json"),
  };
}

function writeParseError(parsed: Extract<ParseServeOptionsResult, { ok: false }>, io: CliIO, label: string): number {
  io.stderr.write(`${label}: ${parsed.message}\n`);
  if (parsed.issues) io.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`);
  return parsed.exitCode;
}

/* ------------------------------------------------------------------ helpers */

function assistantText(items: TurnItem[]): string {
  return items
    .filter((item): item is Extract<TurnItem, { kind: "assistant_text" }> => item.kind === "assistant_text")
    .map((item) => item.text)
    .join("\n");
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "--args must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: `invalid --args JSON: ${errorMessage(error)}` };
  }
}

/** Collect non-flag tokens, skipping the values of recognized value-flags. */
function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      out.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const flag = token.slice(2).split("=")[0] ?? "";
      if (!token.includes("=") && VALUE_FLAGS.has(flag)) index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (VALUE_FLAGS.has(token.slice(1))) index += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function stringFlag(argv: string[], names: string[]): string | undefined {
  const nameSet = new Set(names);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      if (nameSet.has(key)) return eq >= 0 ? token.slice(eq + 1) : argv[index + 1];
    } else if (token.startsWith("-") && nameSet.has(token.slice(1))) {
      return argv[index + 1];
    }
  }
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.some((token) => token === `--${name}` || token === `--${name}=true`);
}

function formatToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}

/* -------------------------------------------------- standalone entry (bin) */

function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd(),
  };
}

/** Standalone dispatch for the `nexus-agent-cli` bin (everything but serve). */
export async function agentCliMain(argv: string[]): Promise<number> {
  const command = splitNexusCliCommand(argv);
  if (command.command === "serve") {
    process.stderr.write("nexus-agent-cli: run `nexus-agent serve` to start the runtime\n");
    return ServeExitCode.usage;
  }
  if (command.command === "help") {
    if (command.error) {
      process.stderr.write(`nexus-agent: ${command.error}\n`);
      process.stderr.write(NEXUS_CLI_USAGE);
      return ServeExitCode.usage;
    }
    process.stdout.write(NEXUS_CLI_USAGE);
    return ServeExitCode.ok;
  }
  return runAgentCommand(command.command, command.args, defaultIO());
}

// NOTE: the standalone self-run lives in `agent-cli-entry.ts`, NOT here — a
// self-run guard in this module would mis-fire when esbuild bundles it into the
// unified `backend.mjs` (the merged bundle is the process entry, so an
// `import.meta.url === argv[1]` guard evaluates true). Keep this file a pure
// library; `agent-cli-entry.ts` is the `nexus-agent-cli` bin entrypoint.
