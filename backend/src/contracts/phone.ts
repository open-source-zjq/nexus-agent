import { z } from "zod";

/**
 * Connect Phone (连接手机) contracts.
 *
 * Faithful, de-branded port of the original Nexus IM/phone relay. The original
 * hard-wired four Nexus IM backends (WeChat/微信, POPO, LobsterAI, Feishu/Lark)
 * and lived in the native desktop shell (`window.nexusGui.*` bridge + a
 * `settings.nexus` config blob). This repo has no native shell, so the relay is
 * re-created as a backend subsystem with a GENERIC pluggable IM-provider
 * interface. **Feishu is the one reference provider** (its bridge is the
 * existing `backend/sidecars/feishu-bridge.mjs`); every other provider is
 * config-registered, not hardcoded.
 *
 * Three records are persisted side-by-side in `<dataDir>/phone/phone.json`:
 *
 *  - **IM providers** (`ImProvider`) — a configured provider instance: a kind
 *    (`feishu` + extensible), a display name, an `enabled` flag, and the
 *    per-provider credential set. Secret credential fields (feishu `appSecret`,
 *    and any provider `verificationToken` / `encryptKey` / `botToken`) are
 *    SECRETS: masked on read, merge-masked on write.
 *  - **IM channels** (`ImChannel`) — a chat/group on a provider that the relay
 *    listens to and mirrors (the de-branded `settings.nexus.channels[]`).
 *  - **Thread↔channel bindings** (`ThreadChannelBinding`) — a binding from an
 *    agent thread to an IM channel, with inbound/outbound mirror toggles (the
 *    de-branded `settings.nexus.chatThreadBindings` + the native
 *    `setNexusChatThreadBinding`/`mirrorNexusChannelMessage` flow).
 *
 * Plus inbound IM members (`ImMember`, for the @-mention picker) and the
 * `AtMember` mention shape (T2.8) that an inbound message carries into the turn.
 *
 * De-brand notes: the original `/nexus/im` API path and `window.nexusGui` native
 * methods become `/v1/phone/*` HTTP routes; provider auth is plain integration
 * config (e.g. Feishu `appId`/`appSecret`), NOT user SSO; the QR-scan device
 * login flow is platform-coupled and is exposed as a documented stub flag, not
 * faked (see `ProviderKindSpec.supportsQrInstall`).
 */

/* ------------------------------------------------------------------------- *
 * Provider kinds
 * ------------------------------------------------------------------------- */

/**
 * Known provider kinds. `feishu` is the one shipped reference implementation
 * (backed by `feishu-bridge.mjs`). The enum is intentionally extensible: a
 * `custom` kind lets an operator config-register a provider that speaks the
 * loopback webhook contract without a bundled bridge — no WeChat/POPO/Lobster
 * are hardcoded. Adding a real bundled bridge for another kind is a future
 * additive change.
 */
export const PROVIDER_KINDS = ["feishu", "custom"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * Secret credential field keys per provider kind. These EXACT keys are masked
 * by the store (some, like `encryptKey`, do not match the generic config secret
 * pattern, so the store masks by key list rather than by pattern — mirrors the
 * ConnectorStore `SECRET_FIELDS_BY_VENDOR` discipline).
 */
export const SECRET_FIELDS_BY_PROVIDER_KIND: Readonly<Record<ProviderKind, readonly string[]>> = {
  feishu: ["appSecret"],
  // A config-registered custom provider authenticates its loopback webhook with
  // a shared verification token (and optionally an encrypt key / bot token).
  custom: ["verificationToken", "encryptKey", "botToken"],
};

/**
 * Channel/transport kind for a provider. `bridge` = an owned NDJSON-over-stdio
 * sidecar with a long-connection WebSocket (Feishu). `webhook` = the
 * loopback-only inbound HTTP webhook for config-registered providers. The
 * original modeled this as "Feishu long-conn bridge vs local IM webhook /
 * companion client".
 */
export const TRANSPORT_KINDS = ["bridge", "webhook"] as const;
export const TransportKindSchema = z.enum(TRANSPORT_KINDS);
export type TransportKind = z.infer<typeof TransportKindSchema>;

/* ------------------------------------------------------------------------- *
 * Credentials
 * ------------------------------------------------------------------------- */

/**
 * Flattened per-provider credentials. All fields are optional strings so a
 * partial draft can be saved; the connection-test endpoint validates that the
 * required fields for a given kind are present. Field meanings:
 *
 *  - Feishu (maps to `FEISHU_*` env injected into the bridge):
 *    `appId` → FEISHU_APP_ID, `appSecret` (SECRET) → FEISHU_APP_SECRET,
 *    `domain` ("feishu" | "lark") → FEISHU_DOMAIN.
 *  - Custom webhook provider: `verificationToken` (SECRET) validates inbound
 *    webhook bodies (replaces bearer auth on the loopback webhook route);
 *    `encryptKey` (SECRET) / `botToken` (SECRET) carried for providers that
 *    need them. `baseUrl` is the optional outbound endpoint the relay POSTs
 *    replies to.
 */
export const ImCredentialsSchema = z.object({
  // --- feishu ---
  /** Feishu app id (=FEISHU_APP_ID). Not a secret. */
  appId: z.string().max(400).default(""),
  /** Feishu app secret (SECRET, =FEISHU_APP_SECRET). */
  appSecret: z.string().max(4000).default(""),
  /** Feishu domain ("feishu" | "lark", =FEISHU_DOMAIN). */
  domain: z.enum(["feishu", "lark"]).default("feishu"),

  // --- custom webhook provider ---
  /** Inbound-webhook verification token (SECRET). */
  verificationToken: z.string().max(4000).default(""),
  /** Inbound-payload encrypt key (SECRET, optional). */
  encryptKey: z.string().max(4000).default(""),
  /** Outbound bot token (SECRET, optional). */
  botToken: z.string().max(4000).default(""),
  /** Outbound reply endpoint base URL (optional; not a secret). */
  baseUrl: z.string().max(2000).default(""),
});
export type ImCredentials = z.infer<typeof ImCredentialsSchema>;

/* ------------------------------------------------------------------------- *
 * IM providers
 * ------------------------------------------------------------------------- */

/**
 * A configured IM provider instance. `kind` is immutable after creation;
 * `enabled` gates whether the relay starts this provider's transport (Feishu
 * bridge spawn / loopback webhook registration). `credentials` secrets are
 * masked on read and merge-masked on write.
 */
export const ImProviderSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  /** Human-facing label (the de-branded `settings.nexus.im` instance name). */
  displayName: z.string().min(1).max(120),
  /** Transport the relay uses for this provider. */
  transport: TransportKindSchema.default("bridge"),
  /** Whether the relay should start this provider on `start()`. */
  enabled: z.boolean().default(false),
  credentials: ImCredentialsSchema.default({}),
  /**
   * Last connection lifecycle status reported by the transport: `idle` (never
   * started), `connecting`, `ready` (bridge `ready`/webhook registered),
   * `error` (last start failed). Advisory only; not user-set.
   */
  status: z.enum(["idle", "connecting", "ready", "error"]).default("idle"),
  /** Last status detail (bridge identity / error message). Not user-set. */
  statusMessage: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImProvider = z.infer<typeof ImProviderSchema>;

/** Request body for POST /v1/phone/providers (create). */
export const ImProviderCreateRequest = z.object({
  kind: ProviderKindSchema,
  displayName: z.string().min(1).max(120),
  transport: TransportKindSchema.optional(),
  enabled: z.boolean().optional(),
  credentials: ImCredentialsSchema.partial().optional(),
});
export type ImProviderCreateInput = z.infer<typeof ImProviderCreateRequest>;

/**
 * Request body for PATCH /v1/phone/providers/:id (partial update). `kind` is
 * immutable after creation, so it is omitted. `status`/`statusMessage` are
 * transport-managed and not user-settable.
 */
export const ImProviderUpdateRequest = z.object({
  displayName: z.string().min(1).max(120).optional(),
  transport: TransportKindSchema.optional(),
  enabled: z.boolean().optional(),
  credentials: ImCredentialsSchema.partial().optional(),
});
export type ImProviderUpdateInput = z.infer<typeof ImProviderUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * IM channels
 * ------------------------------------------------------------------------- */

/** Whether a channel is a 1:1 (`p2p`) or a group/multi-user (`group`) chat. */
export const CHANNEL_KINDS = ["p2p", "group"] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/**
 * An IM channel (the de-branded `settings.nexus.channels[]` entry): a chat/group
 * on a provider that the relay watches. `channelId` is the provider-native chat
 * id (Feishu `oc_*` chat id). The relay only mirrors inbound messages for a
 * channel that has an enabled provider AND (for group channels) a bot @-mention,
 * matching the bridge's inbound filtering.
 */
export const ImChannelSchema = z.object({
  id: z.string().min(1),
  /** Owning provider instance id. */
  providerId: z.string().min(1),
  /** Provider-native chat id (e.g. Feishu `oc_*`). */
  channelId: z.string().min(1).max(400),
  /** Human-facing label. */
  name: z.string().max(200).default(""),
  kind: ChannelKindSchema.default("group"),
  /** Whether the relay actively watches this channel. */
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImChannel = z.infer<typeof ImChannelSchema>;

/** Request body for POST /v1/phone/channels (create). */
export const ImChannelCreateRequest = z.object({
  providerId: z.string().min(1),
  channelId: z.string().min(1).max(400),
  name: z.string().max(200).optional(),
  kind: ChannelKindSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ImChannelCreateInput = z.infer<typeof ImChannelCreateRequest>;

/**
 * Request body for PATCH /v1/phone/channels/:id (partial update). `providerId`
 * + `channelId` identify the channel and are immutable after creation.
 */
export const ImChannelUpdateRequest = z.object({
  name: z.string().max(200).optional(),
  kind: ChannelKindSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ImChannelUpdateInput = z.infer<typeof ImChannelUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * Thread ↔ channel bindings
 * ------------------------------------------------------------------------- */

/**
 * A binding from an agent thread to an IM channel (de-branded
 * `setNexusChatThreadBinding` + `settings.nexus.chatThreadBindings`). When
 * `mirrorInbound` is set, inbound IM messages on the channel start/continue a
 * turn on `threadId`; when `mirrorOutbound` is set, the assistant's reply is
 * mirrored back out to the IM chat. `observe`-only (passive watch) is expressed
 * as `mirrorInbound: true, mirrorOutbound: false`.
 *
 * The native flow unbound by passing an empty `threadId`; here unbinding is an
 * explicit DELETE. At most one binding exists per channel (1:1 chat↔thread, the
 * original keyed bindings by `chatId`).
 */
export const ThreadChannelBindingSchema = z.object({
  id: z.string().min(1),
  /** Bound agent thread id. */
  threadId: z.string().min(1),
  /** Bound channel record id. */
  channelId: z.string().min(1),
  /** Owning provider instance id (denormalized for dispatch without a join). */
  providerId: z.string().min(1),
  /** Optional display label (the native binding `label`). */
  label: z.string().max(200).default(""),
  /** Mirror inbound IM messages into a thread turn. */
  mirrorInbound: z.boolean().default(true),
  /** Mirror the assistant reply back out to IM. */
  mirrorOutbound: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ThreadChannelBinding = z.infer<typeof ThreadChannelBindingSchema>;

/**
 * Request body for PUT /v1/phone/bindings (upsert a binding for a channel).
 * Idempotent on `channelId` — re-PUT replaces the existing binding's thread +
 * mirror flags. `providerId` is resolved from the channel by the store.
 */
export const ThreadChannelBindRequest = z.object({
  threadId: z.string().min(1),
  channelId: z.string().min(1),
  label: z.string().max(200).optional(),
  mirrorInbound: z.boolean().optional(),
  mirrorOutbound: z.boolean().optional(),
});
export type ThreadChannelBindInput = z.infer<typeof ThreadChannelBindRequest>;

/* ------------------------------------------------------------------------- *
 * IM members + mentions (T2.8)
 * ------------------------------------------------------------------------- */

/**
 * A member of an IM channel, cached for the composer's @-mention autocomplete
 * (the de-branded `listFeishuChatMembers` → bridge `list_chat_members` roster).
 * `providerMemberId` is the provider-native id (Feishu `open_id`).
 */
export const ImMemberSchema = z.object({
  id: z.string().min(1),
  /** Owning channel record id. */
  channelId: z.string().min(1),
  /** Display name. */
  name: z.string().max(200).default(""),
  /** Provider-native member id (e.g. Feishu `open_id`). */
  providerMemberId: z.string().max(400).default(""),
  /** Optional avatar URL. */
  avatar: z.string().max(2000).default(""),
  updatedAt: z.string(),
});
export type ImMember = z.infer<typeof ImMemberSchema>;

/**
 * An @-mentioned member reference (T2.8). Carried by an inbound IM message into
 * the turn (`StartTurnRequest.atMembers`) and by an outbound mirror reply
 * (bridge `send` `mentions` opt). `id` is the provider-native member id; `name`
 * is the display name. This is the canonical mention shape the loop's
 * `mentionsContextInstruction` consumes — kept structurally identical to the
 * turns-contract `atMembers` element.
 */
export const AtMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});
export type AtMember = z.infer<typeof AtMemberSchema>;

/**
 * Request body for the @-mention roster refresh
 * (POST /v1/phone/channels/:id/members/refresh) — the relay asks the provider
 * (Feishu bridge `list_chat_members`) and persists the roster on the channel.
 */
export const RefreshMembersRequest = z.object({
  /** Max members to fetch (provider page size). */
  pageSize: z.number().int().min(1).max(500).optional(),
});
export type RefreshMembersInput = z.infer<typeof RefreshMembersRequest>;

/* ------------------------------------------------------------------------- *
 * Inbound message mirror
 * ------------------------------------------------------------------------- */

/**
 * A normalized inbound IM message, identical in shape to the feishu-bridge
 * `message` event payload, so the bridge stdout line and the loopback webhook
 * body share one schema. The relay looks up the channel binding by `chatId`,
 * runs a thread turn (mirror inbound), and — for group chats — only proceeds
 * when `mentionedBot` (matching the bridge's "drop group messages without a bot
 * @-mention" filter).
 */
export const InboundMessageSchema = z.object({
  /** Provider-native message id (used for dedup). */
  messageId: z.string().default(""),
  /** Provider-native chat id (the channel's `channelId`). */
  chatId: z.string().min(1),
  /** Chat type as reported by the provider (e.g. "group" | "p2p"). */
  chatType: z.string().default(""),
  /** Sender's provider-native id. */
  senderId: z.string().default(""),
  /** Sender display name (may be blank; the bridge leaves it empty). */
  senderName: z.string().default(""),
  /** Message body as markdown (bridge-normalized). */
  content: z.string().default(""),
  /** Raw provider content type (e.g. "text", "post"). */
  rawContentType: z.string().default(""),
  /** Members @-mentioned in this message. */
  mentions: z.array(AtMemberSchema).default([]),
  /** Whether the message @-mentioned everyone. */
  mentionAll: z.boolean().default(false),
  /** Whether the message @-mentioned the bot (gates group processing). */
  mentionedBot: z.boolean().default(false),
  /** Thread/root ids for reply-in-thread. */
  rootId: z.string().default(""),
  threadId: z.string().default(""),
  replyToMessageId: z.string().default(""),
  /** Provider epoch-millis create time (used for stale-drop). */
  createTime: z.number().default(0),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

/**
 * Result of dispatching an inbound message: whether it was mirrored into a turn,
 * and why if not (no binding, inbound mirror off, group message without bot
 * @-mention, duplicate, or stale). Returned by the webhook + the service so the
 * route is never a dead endpoint.
 */
export const InboundDispatchResultSchema = z.object({
  mirrored: z.boolean(),
  reason: z
    .enum(["mirrored", "no_binding", "inbound_disabled", "no_bot_mention", "duplicate", "stale", "channel_disabled"])
    .default("no_binding"),
  /** The thread the message was routed into, when mirrored. */
  threadId: z.string().optional(),
  /** The turn started, when mirrored. */
  turnId: z.string().optional(),
});
export type InboundDispatchResult = z.infer<typeof InboundDispatchResultSchema>;

/* ------------------------------------------------------------------------- *
 * Provider catalog + connection test
 * ------------------------------------------------------------------------- */

/**
 * Static, per-kind capability/field descriptor used by the (future) frontend
 * and the connection-test endpoint. `supportsQrInstall` is the honest stub
 * flag: the original native shell rendered a QR device-code login; that flow is
 * platform-coupled and is NOT faked here — Feishu uses plain `appId`/`appSecret`
 * app-auth instead, so `supportsQrInstall` is `false` for every shipped kind.
 */
export interface ProviderFieldSpec {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
}

export interface ProviderKindSpec {
  kind: ProviderKind;
  displayName: string;
  transport: TransportKind;
  /** QR device-code login is platform-coupled; never faked. Always false here. */
  supportsQrInstall: boolean;
  fields: readonly ProviderFieldSpec[];
}

export const PROVIDER_KIND_SPECS: Readonly<Record<ProviderKind, ProviderKindSpec>> = {
  feishu: {
    kind: "feishu",
    displayName: "Feishu / Lark",
    transport: "bridge",
    supportsQrInstall: false,
    fields: [
      { key: "displayName", label: "名称", required: true, secret: false },
      { key: "appId", label: "App ID", required: true, secret: false },
      { key: "appSecret", label: "App Secret", required: true, secret: true },
    ],
  },
  custom: {
    kind: "custom",
    displayName: "Custom Webhook",
    transport: "webhook",
    supportsQrInstall: false,
    fields: [
      { key: "displayName", label: "名称", required: true, secret: false },
      { key: "verificationToken", label: "Verification Token", required: true, secret: true },
    ],
  },
};

/**
 * Connection-test ("检测") result. LIGHTWEIGHT validation only: required fields
 * present for the kind. A real connectivity probe (bridge `ready`) is reported
 * via the provider's live `status`, not by this synchronous check — mirrors the
 * ConnectorHub health-check discipline. No network probe here.
 */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  missingFields: z.array(z.string()),
  message: z.string(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;
