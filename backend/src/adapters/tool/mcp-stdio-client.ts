import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A minimal Model Context Protocol (MCP) client over the stdio transport,
 * implemented by hand with `node:child_process` (no SDK, no extra deps).
 *
 * MCP stdio transport framing: JSON-RPC 2.0 messages, exactly one compact JSON
 * object per line (newline-delimited UTF-8) on the child's stdin/stdout. We
 * buffer partial lines, correlate responses by request id, and surface errors
 * and timeouts per call. Notifications (no id) are ignored on receive.
 */

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** A tool descriptor as advertised by an MCP server's `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  execution?: Record<string, unknown>;
  icons?: unknown;
  _meta?: Record<string, unknown>;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpStdioClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Client identity reported during `initialize`. */
  clientName?: string;
  clientVersion?: string;
  initTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

type JsonRpcId = number;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: JsonRpcId | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class McpStdioClient {
  private readonly options: McpStdioClientOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private closed = false;
  private exitReason: string | undefined;

  constructor(options: McpStdioClientOptions) {
    this.options = options;
  }

  /** Spawn the server and complete the MCP initialize handshake. */
  async connect(): Promise<void> {
    if (this.child) return;
    const env = { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv;
    const child = spawn(this.options.command, this.options.args ?? [], {
      env,
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.on("error", (error: Error) => this.fail(`process error: ${error.message}`));
    child.on("exit", (code, signal) => {
      const reason =
        signal != null
          ? `process exited via signal ${signal}`
          : `process exited with code ${code ?? "null"}`;
      this.fail(reason);
    });
    // Drain stderr so the pipe never blocks; do not treat it as protocol data.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});

    const initResult = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? "nexus-agent",
          version: this.options.clientVersion ?? "0.0.0",
        },
      },
      { timeoutMs: this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS },
    );
    void initResult;
    this.notify("notifications/initialized", {});
  }

  /** Fetch the server's advertised tools via `tools/list` (paginated). */
  async listTools(options: McpCallOptions = {}): Promise<McpToolDescriptor[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    // Bound pagination to avoid an unbounded loop against a misbehaving server.
    for (let page = 0; page < 50; page += 1) {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        { timeoutMs, signal: options.signal },
      )) as { tools?: McpToolDescriptor[]; nextCursor?: string } | null;
      if (result && Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (tool && typeof tool.name === "string") tools.push(tool);
        }
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Invoke a tool via `tools/call`. Returns the raw JSON-RPC result. */
  async callTool(params: McpCallToolParams, options: McpCallOptions = {}): Promise<unknown> {
    return this.request(
      "tools/call",
      { name: params.name, arguments: params.arguments ?? {} },
      { timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, signal: options.signal },
    );
  }

  /** Terminate the child and reject any in-flight requests. */
  async close(): Promise<void> {
    this.fail("client closed");
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      // Escalate if the process does not exit promptly.
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2_000);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error(this.exitReason ?? "MCP client is not connected"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`MCP request ${method} aborted`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal: options.signal };
      if (options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.detachAbort(pending);
          reject(new Error(`MCP request ${method} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        if (typeof pending.timer.unref === "function") pending.timer.unref();
      }
      if (options.signal) {
        pending.onAbort = () => {
          this.pending.delete(id);
          this.clearTimer(pending);
          this.detachAbort(pending);
          reject(new Error(`MCP request ${method} aborted`));
        };
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      const ok = this.write({ jsonrpc: JSONRPC_VERSION, id, method, params });
      if (!ok) {
        this.pending.delete(id);
        this.clearTimer(pending);
        this.detachAbort(pending);
        reject(new Error(this.exitReason ?? "failed to write to MCP server"));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  private write(message: Record<string, unknown>): boolean {
    const child = this.child;
    if (!child || this.closed) return false;
    try {
      return child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    // Server-initiated requests/notifications carry a method; we do not act on them.
    if (typeof message.method === "string" && message.result === undefined && message.error === undefined) {
      return;
    }
    if (message.id == null || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.clearTimer(pending);
    this.detachAbort(pending);
    if (message.error) {
      pending.reject(
        new Error(`MCP error ${message.error.code}: ${message.error.message}`),
      );
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = reason;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.clearTimer(pending);
      this.detachAbort(pending);
      pending.reject(new Error(reason));
    }
  }

  private clearTimer(pending: PendingRequest): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  private detachAbort(pending: PendingRequest): void {
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.onAbort = undefined;
    }
  }
}
