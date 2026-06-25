import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImProvider, ImChannel, ImCredentials, InboundMessage, AtMember } from "../../contracts/phone.js";
import { InboundMessageSchema } from "../../contracts/phone.js";
import type { ImProvider_Transport, ImProviderDeps } from "./types.js";

/**
 * Feishu reference transport — the one shipped {@link ImProvider_Transport}
 * implementation. Spawns + owns `backend/sidecars/feishu-bridge.mjs` and speaks
 * its bidirectional NDJSON-over-stdio protocol (NOT MCP):
 *
 *   - stdout events: `{ type: "ready"|"message"|"card_action"|"p2p_entered"|
 *       "reconnecting"|"reconnected"|"error"|"warn"|"commandResult", ... }`
 *   - stdin commands: `{ id, type, ...payload }` → a correlated `commandResult`.
 *
 * Credentials are injected as the EXACT env names the bridge expects
 * (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_CHANNEL_ID`, `FEISHU_DOMAIN`) —
 * de-branded integration config, not user SSO. The bridge handles the long-conn
 * WebSocket, inbound filtering (stale-drop / dedup / drop-own / group-needs-
 * mention), markdown chunking, and the OpenAPI calls; this transport is a thin
 * spawn + line-router + command-correlator over it.
 *
 * NOTE (honest scope): the original native shell also offered a QR device-code
 * login (`startNexusImInstallQr`/`pollNexusImInstall`). That is platform-coupled
 * (Nexus-hosted device-code endpoints + native QR rendering) and is NOT faked —
 * the bridge authenticates with plain `appId`/`appSecret` app-auth, which is the
 * supported offline path. See `ProviderKindSpec.supportsQrInstall = false`.
 */
export class FeishuProvider implements ImProvider_Transport {
  readonly providerId: string;
  readonly kind = "feishu" as const;

  private readonly credentials: ImCredentials;
  private readonly channelId: string;
  private readonly sidecarDir: string;
  private readonly log: (line: string) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private stopped = false;

  private readonly inboundHandlers = new Set<(message: InboundMessage) => void>();
  private readonly statusHandlers = new Set<(status: ImProvider["status"], message: string) => void>();
  /** Pending bridge commands awaiting their correlated `commandResult`. */
  private readonly pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(provider: ImProvider, deps: ImProviderDeps & { channelId?: string }) {
    this.providerId = provider.id;
    this.credentials = provider.credentials;
    // FEISHU_CHANNEL_ID is the bridge's long-conn channel id. The original
    // `settings.nexus.im` held one channel id per provider instance; here it is
    // supplied by the service (it has no per-message use — the bridge tags every
    // event with it). Default to the provider id so the bridge always has one.
    this.channelId = (deps.channelId ?? provider.id).trim() || provider.id;
    this.sidecarDir = deps.sidecarDir;
    this.log = deps.logger ?? (() => undefined);
  }

  /* ----------------------------------------------------------------------- *
   * Lifecycle
   * ----------------------------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.child) return; // already up
    this.stopped = false;
    const bridgePath = join(this.sidecarDir, "feishu-bridge.mjs");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FEISHU_APP_ID: this.credentials.appId ?? "",
      FEISHU_APP_SECRET: this.credentials.appSecret ?? "",
      FEISHU_CHANNEL_ID: this.channelId,
      FEISHU_DOMAIN: this.credentials.domain ?? "feishu",
    };
    const child = spawn(process.execPath, [bridgePath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.emitStatus("connecting", "starting Feishu bridge");

    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleBridgeLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      // The bridge writes [bridge-diag] lines to stderr; surface only briefly.
      const text = chunk.toString("utf-8").trim();
      if (text) this.log(`[phone:feishu:${this.providerId}] ${text.slice(0, 500)}`);
    });

    child.on("error", (error) => {
      this.emitStatus("error", `bridge spawn failed: ${(error as Error).message}`);
      this.rejectAllPending(new Error(`bridge spawn failed: ${(error as Error).message}`));
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      this.rl?.close();
      this.rl = null;
      this.rejectAllPending(new Error(`bridge exited (code=${code ?? "?"} signal=${signal ?? "?"})`));
      if (!this.stopped) {
        this.emitStatus("error", `bridge exited (code=${code ?? "?"} signal=${signal ?? "?"})`);
      } else {
        this.emitStatus("idle", "stopped");
      }
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) {
      this.emitStatus("idle", "stopped");
      return;
    }
    this.rejectAllPending(new Error("transport disconnected"));
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    // Hard-stop fallback if SIGTERM is ignored.
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, 2000);
    if (typeof killTimer.unref === "function") killTimer.unref();
    this.child = null;
    this.rl?.close();
    this.rl = null;
  }

  /* ----------------------------------------------------------------------- *
   * Outbound commands
   * ----------------------------------------------------------------------- */

  async sendMessage(input: {
    channel: ImChannel;
    text: string;
    mentions?: AtMember[];
    replyToMessageId?: string;
  }): Promise<{ messageId?: string; chunkIds?: string[] }> {
    // The bridge `send` command: `{ to, input: { markdown }, options: { mentions, replyTo } }`.
    // It auto-detects receive_id_type from `to` (oc_/ou_/...), chunks long
    // markdown, and renders mentions as `<at user_id=...>`.
    const mentions = (input.mentions ?? [])
      .filter((m) => m.id)
      .map((m) => ({ openId: m.id, name: m.name ?? "" }));
    const result = (await this.command("send", {
      to: input.channel.channelId,
      input: { markdown: input.text },
      options: {
        ...(mentions.length ? { mentions } : {}),
        ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}),
      },
    })) as { messageId?: string; chunkIds?: string[] } | null;
    return {
      ...(result?.messageId ? { messageId: result.messageId } : {}),
      ...(result?.chunkIds ? { chunkIds: result.chunkIds } : {}),
    };
  }

  async listMembers(input: { channel: ImChannel; pageSize?: number }): Promise<AtMember[]> {
    // The bridge `list_chat_members` command returns `[{ openId, name, ... }]`.
    const result = (await this.command("list_chat_members", {
      chatId: input.channel.channelId,
      ...(input.pageSize ? { pageSize: input.pageSize } : {}),
    })) as Array<{ openId?: string; name?: string }> | null;
    return (result ?? [])
      .filter((m) => typeof m?.openId === "string" && m.openId)
      .map((m) => ({ id: String(m.openId), ...(m.name ? { name: String(m.name) } : {}) }));
  }

  /* ----------------------------------------------------------------------- *
   * Subscriptions
   * ----------------------------------------------------------------------- */

  subscribeInbound(handler: (message: InboundMessage) => void): () => void {
    this.inboundHandlers.add(handler);
    return () => this.inboundHandlers.delete(handler);
  }

  onStatus(handler: (status: ImProvider["status"], message: string) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /** Write one NDJSON command and await its correlated `commandResult`. */
  private command(type: string, payload: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("Feishu bridge is not connected"));
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Feishu bridge command "${type}" timed out`));
      }, 30_000);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Parse + route one bridge stdout line. Never throws to the readline pump. */
  private handleBridgeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON noise
    }
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "ready":
        this.emitStatus("ready", this.describeIdentity(event));
        return;
      case "reconnecting":
        this.emitStatus("connecting", "reconnecting");
        return;
      case "reconnected":
        this.emitStatus("ready", "reconnected");
        return;
      case "error":
        this.emitStatus("error", typeof event.message === "string" ? event.message : "bridge error");
        return;
      case "message": {
        const parsed = InboundMessageSchema.safeParse(event.message);
        if (parsed.success) {
          for (const handler of this.inboundHandlers) {
            try {
              handler(parsed.data);
            } catch {
              /* a failing subscriber must not break the pump */
            }
          }
        }
        return;
      }
      case "commandResult":
        this.resolveCommand(event);
        return;
      default:
        // card_action / p2p_entered / warn — not consumed by the relay core.
        return;
    }
  }

  /** Settle a pending command from its `commandResult` line. */
  private resolveCommand(event: Record<string, unknown>): void {
    const id = typeof event.id === "string" ? event.id : "";
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (event.ok === true) {
      waiter.resolve(event.result ?? null);
    } else {
      waiter.reject(new Error(typeof event.message === "string" && event.message ? event.message : "bridge command failed"));
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private describeIdentity(event: Record<string, unknown>): string {
    const identity = event.botIdentity as { name?: string; openId?: string } | null | undefined;
    if (identity && (identity.name || identity.openId)) {
      return `connected as ${identity.name ?? identity.openId ?? "bot"}`;
    }
    return "connected";
  }

  private emitStatus(status: ImProvider["status"], message: string): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status, message);
      } catch {
        /* ignore */
      }
    }
  }
}
