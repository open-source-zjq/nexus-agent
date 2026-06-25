import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PhoneStore } from "../adapters/store/phone-store.js";
import type { ThreadService } from "./thread-service.js";
import type { TurnService } from "./turn-service.js";
import type { EventBus } from "../adapters/event/event-bus.js";
import type { SessionStore } from "../adapters/store/types.js";
import type {
  ImProvider,
  ImProviderCreateInput,
  ImProviderUpdateInput,
  ProviderKind,
  ImChannel,
  ImChannelCreateInput,
  ImChannelUpdateInput,
  ThreadChannelBinding,
  ThreadChannelBindInput,
  ImMember,
  AtMember,
  InboundMessage,
  InboundDispatchResult,
  ConnectionTestResult,
} from "../contracts/phone.js";
import { InboundMessageSchema } from "../contracts/phone.js";
import { FeishuProvider } from "../adapters/im/feishu-provider.js";
import type { ImProvider_Transport } from "../adapters/im/types.js";

/** How long an inbound message is considered "fresh" (matches the bridge's 5min). */
const STALE_WINDOW_MS = 5 * 60 * 1000;
/** Dedup ring cap (per relay process). */
const SEEN_CAP = 2000;

export interface PhoneServiceDeps {
  store: PhoneStore;
  threadService: ThreadService;
  turnService: TurnService;
  eventBus: EventBus;
  sessionStore: SessionStore;
  /** Fire-and-forget turn driver (`agentLoop.run`). */
  runTurn: (threadId: string, turnId: string) => void;
  /** Absolute path to `backend/sidecars` (bridge lookup). */
  sidecarDir: string;
  /**
   * Whether the relay should auto-start enabled providers + the inbound webhook
   * on `start()` (the de-branded "background automation mode" toggle). When
   * false, `start()` only registers the loopback webhook so the management
   * routes still work, but no provider bridges are spawned until one is enabled
   * via the API. Defaults to true.
   */
  backgroundMode?: boolean;
  /** Loopback webhook bind host. Forced to 127.0.0.1 in `start()` regardless. */
  webhookHost?: string;
  /** Loopback webhook port (0 = ephemeral). Defaults to 0. */
  webhookPort?: number;
  /** Background reconnect/reap tick interval (ms). Defaults to 30s. */
  tickMs?: number;
  /**
   * Optional proactive-insight sink: inbound GROUP messages are forwarded here so
   * the (decoupled) group watcher can surface meeting-alignment / knowledge-capture
   * suggestions with `source: "feishu_group"`. Kept as a plain callback so this
   * service never imports the insight subsystem. Omit to disable group insight.
   */
  observeGroupMessage?: (observation: {
    chatId: string;
    threadId: string;
    messages: Array<{ sender?: string; text?: string }>;
  }) => void;
  logger?: (line: string) => void;
}

/**
 * Connect Phone (连接手机) relay service.
 *
 * De-branded re-creation of the original Nexus IM relay (which lived in the
 * native desktop shell as `window.nexusGui.*` over `settings.nexus`). It owns:
 *
 *  - a pluggable {@link ImProvider_Transport} per enabled provider (Feishu is
 *    the one reference impl — see {@link FeishuProvider} driving the
 *    `feishu-bridge.mjs` sidecar);
 *  - a 127.0.0.1-only inbound webhook for config-registered (`custom`)
 *    providers — the de-branded "local IM webhook / companion client";
 *  - the inbound→thread mirror: an inbound IM message on a bound channel starts
 *    a thread turn carrying the message + sender + mentions as context;
 *  - the reply→IM mirror: when a bound thread's turn completes, the assistant's
 *    reply is sent back out to the IM channel via the provider;
 *  - the member roster + @-mention support feeding T2.8.
 *
 * `start()` / `stop()` are the background-mode hook (mirrors the scheduler's
 * background pattern). The thin CRUD methods delegate to {@link PhoneStore},
 * which owns the secret mask / merge-mask discipline; the service adds the real
 * orchestration the store cannot do (bridge spawn, webhook, mirror, tick).
 *
 * Honest-scope gaps (documented stubs, NOT faked): the QR device-code login
 * (`startNexusImInstallQr`) is platform-coupled and exposed via
 * `supportsQrInstall=false` (Feishu uses appId/appSecret app-auth instead); the
 * full headless OS-automation daemon is reduced to a clean recurring tick that
 * reconnects dropped bridges + trims the dedup ring.
 */
export class PhoneService {
  private readonly deps: PhoneServiceDeps;
  private readonly log: (line: string) => void;

  /** Live transports, keyed by provider id. */
  private readonly transports = new Map<string, TransportEntry>();
  /** Inbound-dedup ring (provider-native message ids already routed). */
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Reply-mirror subscriptions, keyed by threadId so each thread subscribes once. */
  private readonly replyMirrors = new Map<string, () => void>();

  private webhookServer: Server | null = null;
  private webhookAddress: { host: string; port: number } | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private started = false;

  constructor(deps: PhoneServiceDeps) {
    this.deps = deps;
    this.log = deps.logger ?? (() => undefined);
  }

  /* ----------------------------------------------------------------------- *
   * Background-mode hook: start / stop
   * ----------------------------------------------------------------------- */

  /**
   * Bring the relay up so IM works without the GUI (the de-branded background
   * automation mode). Starts the 127.0.0.1 inbound webhook, then — when
   * `backgroundMode` is on — connects every enabled provider's transport and
   * arms the reconnect/reap tick. Idempotent; best-effort (a single provider
   * failing to spawn never blocks the rest).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.startWebhook();
    if (this.deps.backgroundMode === false) {
      this.log("[phone] relay started (webhook only; background automation off)");
      return;
    }
    const providers = await this.deps.store.listProviders();
    for (const provider of providers) {
      if (!provider.enabled) continue;
      await this.ensureTransport(provider.id).catch((error) =>
        this.log(`[phone] provider ${provider.id} failed to start: ${errMessage(error)}`),
      );
    }
    this.startTick();
    this.log(`[phone] relay started (${this.transports.size} provider transport(s) live)`);
  }

  /** Tear the relay down: stop every transport, the webhook, and the tick. */
  async stop(): Promise<void> {
    this.stopTick();
    for (const [, entry] of this.transports) {
      await entry.transport.disconnect().catch(() => undefined);
    }
    this.transports.clear();
    for (const [, unsub] of this.replyMirrors) unsub();
    this.replyMirrors.clear();
    await this.stopWebhook();
    this.started = false;
  }

  /** The loopback webhook bind address (host/port), once `start()` has run. */
  webhookInfo(): { host: string; port: number } | null {
    return this.webhookAddress ? { ...this.webhookAddress } : null;
  }

  /**
   * Relay status snapshot for the `/v1/phone/status` route: whether the relay is
   * started, whether background automation is on, the live webhook address, and
   * the number of live provider transports. Read-only; never throws.
   */
  status(): {
    started: boolean;
    backgroundMode: boolean;
    webhook: { host: string; port: number } | null;
    liveTransports: number;
  } {
    return {
      started: this.started,
      backgroundMode: this.deps.backgroundMode !== false,
      webhook: this.webhookInfo(),
      liveTransports: this.transports.size,
    };
  }

  /**
   * Toggle background automation at runtime (the de-branded "background mode"
   * switch). Turning it ON connects every enabled provider transport + arms the
   * reconnect tick (idempotent); turning it OFF tears the transports + tick down
   * but keeps the loopback webhook live so the management routes still work.
   */
  async setBackgroundMode(on: boolean): Promise<void> {
    this.deps.backgroundMode = on;
    if (!this.started) {
      // Not started yet — just record the desired mode; `start()` honors it.
      return;
    }
    if (on) {
      const providers = await this.deps.store.listProviders();
      for (const provider of providers) {
        if (!provider.enabled) continue;
        await this.ensureTransport(provider.id).catch((error) =>
          this.log(`[phone] provider ${provider.id} failed to start: ${errMessage(error)}`),
        );
      }
      this.startTick();
    } else {
      this.stopTick();
      for (const [, entry] of this.transports) {
        await entry.transport.disconnect().catch(() => undefined);
      }
      this.transports.clear();
      for (const [, unsub] of this.replyMirrors) unsub();
      this.replyMirrors.clear();
    }
  }

  /* ----------------------------------------------------------------------- *
   * Providers (thin delegation + transport lifecycle on enable/disable)
   * ----------------------------------------------------------------------- */

  listProviders(kind?: ProviderKind): Promise<ImProvider[]> {
    return this.deps.store.listProviders(kind);
  }

  getProvider(id: string): Promise<ImProvider | undefined> {
    return this.deps.store.getProvider(id);
  }

  createProvider(input: ImProviderCreateInput): Promise<ImProvider> {
    return this.deps.store.createProvider(input);
  }

  /**
   * Patch a provider (merge-masking echoed secrets in the store), then reconcile
   * its transport: connect if it just became enabled, disconnect if disabled,
   * restart if credentials changed while enabled.
   */
  async updateProvider(id: string, patch: ImProviderUpdateInput): Promise<ImProvider> {
    const updated = await this.deps.store.updateProvider(id, patch);
    if (this.started && this.deps.backgroundMode !== false) {
      if (updated.enabled) {
        // Restart so credential/transport changes take effect.
        await this.teardownTransport(id);
        await this.ensureTransport(id).catch((error) =>
          this.log(`[phone] provider ${id} restart failed: ${errMessage(error)}`),
        );
      } else {
        await this.teardownTransport(id);
        await this.deps.store.setProviderStatus(id, "idle", "disabled");
      }
    }
    return this.deps.store.getProvider(id).then((p) => p ?? updated);
  }

  /** Delete a provider (cascade in the store) and stop its transport. */
  async deleteProvider(id: string): Promise<ImProvider> {
    await this.teardownTransport(id);
    return this.deps.store.deleteProvider(id);
  }

  /** LIGHTWEIGHT connection test (required-fields-present). Throws on unknown id. */
  testProvider(id: string): Promise<ConnectionTestResult> {
    return this.deps.store.testProvider(id);
  }

  /* ----------------------------------------------------------------------- *
   * Channels + bindings (thin delegation)
   * ----------------------------------------------------------------------- */

  listChannels(providerId?: string): Promise<ImChannel[]> {
    return this.deps.store.listChannels(providerId);
  }

  getChannel(id: string): Promise<ImChannel | undefined> {
    return this.deps.store.getChannel(id);
  }

  createChannel(input: ImChannelCreateInput): Promise<ImChannel> {
    return this.deps.store.createChannel(input);
  }

  updateChannel(id: string, patch: ImChannelUpdateInput): Promise<ImChannel> {
    return this.deps.store.updateChannel(id, patch);
  }

  deleteChannel(id: string): Promise<ImChannel> {
    return this.deps.store.deleteChannel(id);
  }

  listBindings(filter?: { channelId?: string; threadId?: string }): Promise<ThreadChannelBinding[]> {
    return this.deps.store.listBindings(filter);
  }

  /** Upsert a thread↔channel binding (de-branded `setNexusChatThreadBinding`). */
  upsertBinding(input: ThreadChannelBindInput): Promise<ThreadChannelBinding> {
    return this.deps.store.upsertBinding(input);
  }

  /** Remove a channel's binding (the native unbind via empty threadId). */
  deleteBinding(channelId: string): Promise<ThreadChannelBinding> {
    return this.deps.store.deleteBinding(channelId);
  }

  /* ----------------------------------------------------------------------- *
   * Members + @-mentions (T2.8)
   * ----------------------------------------------------------------------- */

  /** The cached member roster for a channel (the @-mention picker source). */
  listMembers(channelId: string): Promise<ImMember[]> {
    return this.deps.store.listMembers(channelId);
  }

  /**
   * Refresh a channel's @-mention roster from its provider (Feishu bridge
   * `list_chat_members`) and persist it. Requires the provider transport to be
   * live; throws a clear error otherwise so the route is never a dead endpoint.
   */
  async refreshMembers(channelId: string, pageSize?: number): Promise<ImMember[]> {
    const channel = await this.deps.store.getChannel(channelId);
    if (!channel) throw new Error(`channel not found: ${channelId}`);
    const entry = await this.ensureTransport(channel.providerId);
    const roster = await entry.transport.listMembers({
      channel,
      ...(pageSize ? { pageSize } : {}),
    });
    return this.deps.store.replaceMembers(channelId, roster);
  }

  /* ----------------------------------------------------------------------- *
   * Inbound dispatch (message → thread turn) + outbound mirror (reply → IM)
   * ----------------------------------------------------------------------- */

  /**
   * Route a normalized inbound IM message to its bound thread and start a turn,
   * carrying the message + sender + mentions as turn context. Shared by both the
   * bridge stdout `message` event and the loopback webhook body. Returns a
   * structured result (mirrored + reason) so neither path is a dead endpoint.
   *
   * Guards (faithful to the bridge's own inbound filtering, re-applied here so
   * the webhook path is equally strict): stale-drop (>5min), dedup by messageId,
   * group messages require a bot @-mention, the channel + its binding must exist
   * and have `mirrorInbound`.
   */
  async dispatchInbound(providerId: string, message: InboundMessage): Promise<InboundDispatchResult> {
    // Stale-drop using provider epoch-millis (0 = unknown → treated as fresh).
    if (message.createTime && Date.now() - message.createTime > STALE_WINDOW_MS) {
      return { mirrored: false, reason: "stale" };
    }
    // Dedup by provider-native message id.
    if (message.messageId) {
      if (this.seen.has(message.messageId)) return { mirrored: false, reason: "duplicate" };
      this.remember(message.messageId);
    }
    const channel = await this.deps.store.findChannelByChatId(providerId, message.chatId);
    if (!channel) return { mirrored: false, reason: "no_binding" };
    if (!channel.enabled) return { mirrored: false, reason: "channel_disabled" };
    const binding = await this.deps.store.getBindingForChannel(channel.id);

    // Proactive insight (source: "feishu_group"): forward EVERY group message —
    // not just bot-@-mentioned ones — to the decoupled group watcher so the
    // meeting-alignment / knowledge-capture detectors observe the whole
    // conversation. Gated on a binding so the suggestion has a GUI thread to
    // surface in; the watcher itself debounces + decides whether to emit.
    if (channel.kind === "group" && binding && this.deps.observeGroupMessage) {
      const text = message.content?.trim();
      if (text) {
        this.deps.observeGroupMessage({
          chatId: message.chatId,
          threadId: binding.threadId,
          messages: [{ sender: message.senderName, text }],
        });
      }
    }

    // Group messages only proceed to a bot turn when the bot was @-mentioned.
    if (channel.kind === "group" && !message.mentionedBot && !message.mentionAll) {
      return { mirrored: false, reason: "no_bot_mention" };
    }
    if (!binding) return { mirrored: false, reason: "no_binding" };
    if (!binding.mirrorInbound) return { mirrored: false, reason: "inbound_disabled" };

    // Confirm the bound thread still exists (it may have been deleted).
    const thread = await this.deps.threadService.get(binding.threadId);
    if (!thread) return { mirrored: false, reason: "no_binding" };

    const prompt = this.composePrompt(message);
    const turn = await this.deps.turnService.startTurn({
      threadId: binding.threadId,
      request: {
        prompt,
        mode: "agent",
        attachmentIds: [],
        // IM bridges have no interactive user; the loop hides user_input tools.
        disableUserInput: true,
        // Bind the turn to the group so the agent can read it via feishu_* tools.
        feishuChatId: channel.channelId,
        // T2.8: the inbound mentions become turn context the loop folds into the
        // per-turn instructions via mentionsContextInstruction. Forwarded only
        // when the field is supported by the turns contract (additive-safe).
        ...(message.mentions.length ? { atMembers: message.mentions } : {}),
      } as Parameters<TurnService["startTurn"]>[0]["request"],
    });

    // Arm the reply→IM mirror for this thread (once), then drive the turn.
    if (binding.mirrorOutbound) this.armReplyMirror(binding, channel.id);
    this.deps.runTurn(turn.threadId, turn.turnId);
    return { mirrored: true, reason: "mirrored", threadId: turn.threadId, turnId: turn.turnId };
  }

  /**
   * Subscribe (once per thread) to the bound thread's terminal turn event; on
   * `turn_completed`, collect the assistant text from the session log and send
   * it back out to the IM channel via the provider (the reply→IM mirror, the
   * de-branded `mirrorNexusChannelMessage(..., "assistant")`).
   */
  private armReplyMirror(binding: ThreadChannelBinding, channelRecordId: string): void {
    if (this.replyMirrors.has(binding.threadId)) return;
    const seenTurns = new Set<string>();
    const unsub = this.deps.eventBus.subscribe(binding.threadId, (event) => {
      if (event.kind !== "turn_completed") return;
      const turnId = event.turnId;
      if (!turnId || seenTurns.has(turnId)) return;
      seenTurns.add(turnId);
      void this.mirrorReply(binding.providerId, channelRecordId, binding.threadId, turnId).catch((error) =>
        this.log(`[phone] reply mirror failed (thread ${binding.threadId}): ${errMessage(error)}`),
      );
    });
    this.replyMirrors.set(binding.threadId, unsub);
  }

  /** Collect a completed turn's assistant text and push it back to the channel. */
  private async mirrorReply(
    providerId: string,
    channelRecordId: string,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const items = await this.deps.sessionStore.loadItems(threadId);
    const reply = items
      .filter((item): item is typeof item & { kind: "assistant_text"; text: string } => item.kind === "assistant_text")
      .filter((item) => item.turnId === turnId)
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (!reply) return;
    const channel = await this.deps.store.getChannel(channelRecordId);
    if (!channel) return;
    const entry = this.transports.get(providerId);
    if (!entry) {
      this.log(`[phone] cannot mirror reply: provider ${providerId} transport is down`);
      return;
    }
    await entry.transport.sendMessage({ channel, text: reply });
  }

  /** Build the turn prompt from an inbound message (sender prefix when known). */
  private composePrompt(message: InboundMessage): string {
    const sender = message.senderName || message.senderId;
    const body = message.content.trim() || "(empty message)";
    return sender ? `[IM ${sender}] ${body}` : body;
  }

  /* ----------------------------------------------------------------------- *
   * Transport management
   * ----------------------------------------------------------------------- */

  /**
   * Ensure a live transport exists for a provider (spawning the Feishu bridge or
   * registering the webhook provider). Returns the entry. Throws when the
   * provider is unknown or its kind has no shipped transport.
   */
  private async ensureTransport(providerId: string): Promise<TransportEntry> {
    const existing = this.transports.get(providerId);
    if (existing) return existing;
    const provider = await this.deps.store.getProviderUnmasked(providerId);
    if (!provider) throw new Error(`provider not found: ${providerId}`);

    if (provider.kind === "feishu") {
      const transport = new FeishuProvider(provider, {
        sidecarDir: this.deps.sidecarDir,
        logger: this.log,
      });
      const entry: TransportEntry = { provider, transport, unsubInbound: () => undefined, unsubStatus: () => undefined };
      entry.unsubInbound = transport.subscribeInbound((message) => {
        void this.dispatchInbound(providerId, message).catch((error) =>
          this.log(`[phone] inbound dispatch failed: ${errMessage(error)}`),
        );
      });
      entry.unsubStatus = transport.onStatus((status, statusMessage) => {
        void this.deps.store.setProviderStatus(providerId, status, statusMessage).catch(() => undefined);
      });
      this.transports.set(providerId, entry);
      await transport.connect();
      return entry;
    }

    // `custom` providers have no bundled bridge — they speak the loopback
    // webhook only, so there is no child process to spawn. Register a webhook-
    // backed entry whose sendMessage/listMembers are unsupported (documented).
    if (provider.kind === "custom") {
      const transport = new WebhookOnlyTransport(provider.id);
      const entry: TransportEntry = { provider, transport, unsubInbound: () => undefined, unsubStatus: () => undefined };
      this.transports.set(providerId, entry);
      await this.deps.store.setProviderStatus(providerId, "ready", "webhook registered (loopback)");
      return entry;
    }

    throw new Error(`provider kind "${provider.kind}" has no shipped transport`);
  }

  /** Stop + drop a provider's transport (if any). */
  private async teardownTransport(providerId: string): Promise<void> {
    const entry = this.transports.get(providerId);
    if (!entry) return;
    entry.unsubInbound();
    entry.unsubStatus();
    this.transports.delete(providerId);
    await entry.transport.disconnect().catch(() => undefined);
  }

  /* ----------------------------------------------------------------------- *
   * Inbound webhook (127.0.0.1 only)
   * ----------------------------------------------------------------------- */

  /**
   * Start the loopback inbound-webhook server (the de-branded "local IM webhook /
   * companion client"). Bound to 127.0.0.1 ONLY — an IM provider's companion
   * relay POSTs `POST /phone/webhook/:providerId` with a normalized inbound
   * message body and a `verificationToken` matching the provider's stored token.
   * This is intentionally separate from the main bearer-guarded HTTP router (an
   * external relay cannot send the runtime token); loopback-only binding is the
   * security boundary.
   */
  private async startWebhook(): Promise<void> {
    if (this.webhookServer) return;
    const host = "127.0.0.1"; // forced loopback regardless of config
    const port = this.deps.webhookPort ?? 0;
    const server = createServer((req, res) => {
      void this.handleWebhookRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal error" }));
      });
    });
    this.webhookServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        const addr = server.address() as AddressInfo | null;
        this.webhookAddress = { host, port: addr ? addr.port : port };
        this.log(`[phone] inbound webhook listening on http://${host}:${this.webhookAddress.port}`);
        resolve();
      });
    });
  }

  private async stopWebhook(): Promise<void> {
    const server = this.webhookServer;
    if (!server) return;
    this.webhookServer = null;
    this.webhookAddress = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleWebhookRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });
    const match = /^\/phone\/webhook\/([^/?]+)/.exec(req.url ?? "");
    if (!match) return reply(404, { ok: false, error: "unknown webhook path" });
    const providerId = decodeURIComponent(match[1]);

    const provider = await this.deps.store.getProviderUnmasked(providerId);
    if (!provider) return reply(404, { ok: false, error: "unknown provider" });

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return reply(400, { ok: false, error: "invalid JSON" });
    }

    // Per-channel verification token replaces bearer auth on the loopback route.
    // Feishu inbound arrives via the bridge (not this webhook), so a Feishu
    // provider's webhook requires no token; a `custom` provider must match its
    // stored verificationToken.
    if (provider.kind !== "feishu") {
      const expected = (provider.credentials.verificationToken ?? "").trim();
      const presented = typeof body.verificationToken === "string" ? body.verificationToken.trim() : "";
      if (!expected || presented !== expected) {
        return reply(401, { ok: false, error: "verification token mismatch" });
      }
    }

    // Feishu URL-verification challenge echo (when a custom relay forwards one).
    if (typeof body.challenge === "string") {
      return reply(200, { challenge: body.challenge });
    }

    const messageBody = (body.message ?? body) as unknown;
    const parsed = InboundMessageSchema.safeParse(messageBody);
    if (!parsed.success) {
      return reply(400, { ok: false, error: "invalid inbound message", issues: parsed.error.issues });
    }
    const result = await this.dispatchInbound(providerId, parsed.data);
    return reply(200, { ok: true, ...result });
  }

  /* ----------------------------------------------------------------------- *
   * Background tick (reconnect dropped bridges, trim the dedup ring)
   * ----------------------------------------------------------------------- */

  private startTick(): void {
    if (this.tickTimer) return;
    const tickMs = this.deps.tickMs ?? 30_000;
    this.tickTimer = setInterval(() => void this.tick(), tickMs);
    if (typeof this.tickTimer === "object" && "unref" in this.tickTimer) this.tickTimer.unref();
  }

  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Best-effort recurring maintenance. Never throws to the timer. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const providers = await this.deps.store.listProviders();
      for (const provider of providers) {
        const live = this.transports.has(provider.id);
        if (provider.enabled && !live) {
          // A bridge that exited (or was never started) gets reconnected.
          await this.ensureTransport(provider.id).catch((error) =>
            this.log(`[phone] tick reconnect ${provider.id} failed: ${errMessage(error)}`),
          );
        } else if (!provider.enabled && live) {
          await this.teardownTransport(provider.id);
        }
      }
    } catch (error) {
      this.log(`[phone] tick error: ${errMessage(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Add a message id to the dedup ring, trimming to the cap. */
  private remember(messageId: string): void {
    this.seen.add(messageId);
    this.seenOrder.push(messageId);
    if (this.seenOrder.length > SEEN_CAP) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - SEEN_CAP);
      for (const id of drop) this.seen.delete(id);
    }
  }
}

/** A live provider transport plus its subscription unsubscribers. */
interface TransportEntry {
  provider: ImProvider;
  transport: ImProvider_Transport;
  unsubInbound: () => void;
  unsubStatus: () => void;
}

/**
 * Transport for a config-registered `custom` provider: inbound arrives over the
 * loopback webhook (handled by the service directly), and there is no bundled
 * bridge, so outbound send / member lookup are unsupported. This is the honest
 * minimal version — a real bundled bridge for another kind is a future additive
 * change (no WeChat/POPO/Lobster faked).
 */
class WebhookOnlyTransport implements ImProvider_Transport {
  readonly kind = "custom" as const;
  constructor(readonly providerId: string) {}
  async connect(): Promise<void> {
    /* loopback webhook is always live; nothing to spawn */
  }
  async disconnect(): Promise<void> {
    /* nothing to tear down */
  }
  async sendMessage(): Promise<{ messageId?: string; chunkIds?: string[] }> {
    throw new Error("custom webhook provider has no outbound transport (configure baseUrl + a bundled bridge to enable replies)");
  }
  async listMembers(): Promise<AtMember[]> {
    throw new Error("custom webhook provider does not support member lookup");
  }
  subscribeInbound(): () => void {
    // Inbound for custom providers is delivered via the service's webhook, not
    // a transport stream, so this is a no-op subscription.
    return () => undefined;
  }
  onStatus(): () => void {
    return () => undefined;
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("inbound body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
