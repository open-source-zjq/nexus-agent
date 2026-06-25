import type { ImProvider, ImChannel, InboundMessage, AtMember } from "../../contracts/phone.js";

/**
 * Pluggable IM-provider transport interface (连接手机).
 *
 * De-branded port of the original Nexus IM relay, which hard-wired four Nexus
 * backends (WeChat/微信, POPO, LobsterAI, Feishu/Lark) inside the native desktop
 * shell. Here every transport implements this one interface so the
 * {@link PhoneService} stays provider-agnostic; **Feishu is the one shipped
 * reference implementation** (see {@link FeishuProvider}, which drives the
 * existing `backend/sidecars/feishu-bridge.mjs` over its NDJSON-over-stdio
 * protocol). Other kinds are config-registered (the loopback webhook), not
 * hardcoded.
 *
 * Lifecycle: the service calls {@link connect} when a provider is enabled and
 * {@link disconnect} on stop / disable / delete. Inbound IM events arrive via
 * {@link subscribeInbound}; outbound replies + member lookups go through
 * {@link sendMessage} / {@link listMembers}.
 */
export interface ImProvider_Transport {
  /** The persisted provider instance id this transport drives. */
  readonly providerId: string;
  /** The provider kind (`feishu` | `custom`). */
  readonly kind: ImProvider["kind"];

  /**
   * Bring the transport up. For the Feishu bridge this spawns the sidecar and
   * resolves once the process is launched (the long-conn `ready`/`error` event
   * is reported asynchronously through {@link onStatus}); for a webhook provider
   * this is a no-op (the loopback route is always live). Idempotent.
   */
  connect(): Promise<void>;

  /** Tear the transport down (kill the bridge child). Idempotent; never throws. */
  disconnect(): Promise<void>;

  /**
   * Send an outbound message to a channel (the reply→IM mirror half). `text` is
   * markdown; `mentions` become provider `<at>` segments. Resolves to the
   * provider-native message id(s). Rejects when the transport is unavailable.
   */
  sendMessage(input: {
    channel: ImChannel;
    text: string;
    mentions?: AtMember[];
    replyToMessageId?: string;
  }): Promise<{ messageId?: string; chunkIds?: string[] }>;

  /**
   * Fetch a channel's member roster (the @-mention picker source). For Feishu
   * this is the bridge `list_chat_members` command. Rejects when unavailable.
   */
  listMembers(input: { channel: ImChannel; pageSize?: number }): Promise<AtMember[]>;

  /**
   * Subscribe to normalized inbound messages from this transport. Returns an
   * unsubscribe fn. The service routes each message through its thread↔channel
   * binding dispatcher.
   */
  subscribeInbound(handler: (message: InboundMessage) => void): () => void;

  /**
   * Subscribe to transport status transitions (bridge `ready`/`reconnecting`/
   * `error`). The service persists these onto the provider record so the
   * (future) UI can show a live connection state.
   */
  onStatus(handler: (status: ImProvider["status"], message: string) => void): () => void;
}

/**
 * Dependencies a transport needs from the service to be constructed. Kept
 * minimal + injectable so transports are unit-testable without the full
 * runtime (mirrors the rest of this backend's adapter conventions).
 */
export interface ImProviderDeps {
  /** Absolute path to the `backend/sidecars` directory (bridge lookup). */
  sidecarDir: string;
  /** Best-effort diagnostic logger (defaults to console.error in serve). */
  logger?: (line: string) => void;
}
