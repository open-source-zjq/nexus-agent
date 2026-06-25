import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./atomic-write.js";
import { MASKED_SECRET } from "../../config/config.js";
import {
  ImProviderSchema,
  ImChannelSchema,
  ThreadChannelBindingSchema,
  ImMemberSchema,
  SECRET_FIELDS_BY_PROVIDER_KIND,
  PROVIDER_KIND_SPECS,
  type ImProvider,
  type ImProviderCreateInput,
  type ImProviderUpdateInput,
  type ImCredentials,
  type ProviderKind,
  type ImChannel,
  type ImChannelCreateInput,
  type ImChannelUpdateInput,
  type ThreadChannelBinding,
  type ThreadChannelBindInput,
  type ImMember,
  type AtMember,
  type ConnectionTestResult,
} from "../../contracts/phone.js";

/**
 * Persisted Connect Phone document. A single JSON file holds providers,
 * channels, bindings, and the cached @-mention member roster — mirroring the
 * ConnectorStore one-file pattern (and the original `settings.nexus` blob, which
 * held `im`, `channels`, and `chatThreadBindings` side-by-side).
 */
interface PhoneDoc {
  providers: ImProvider[];
  channels: ImChannel[];
  bindings: ThreadChannelBinding[];
  members: ImMember[];
}

const EMPTY_DOC: PhoneDoc = { providers: [], channels: [], bindings: [], members: [] };

/**
 * File-backed Connect Phone store (连接手机). Persists IM providers, channels,
 * thread↔channel bindings, and the cached member roster to
 * `<dataDir>/phone/phone.json`. De-branded: rooted under the app data dir (no
 * `~/.nexus`), provider kinds are pluggable (no hardcoded WeChat/POPO/Lobster),
 * and `/nexus/im` is replaced by the `/v1/phone/*` routes that wrap this store.
 *
 * Secret discipline: provider credential secrets (feishu `appSecret`, custom
 * `verificationToken`/`encryptKey`/`botToken`) are MASKED on every read/list and
 * MERGE-MASKED on update — an incoming `********` preserves the stored value
 * rather than clobbering it. Raw secrets never leave the store; orchestration
 * (the service's bridge spawn / connection test) reads the STORED unmasked
 * values via `getProviderUnmasked`.
 *
 * CRUD is serialized through a single in-flight promise so concurrent writes
 * never interleave. A read never throws; a corrupt file is re-seeded empty.
 */
export class PhoneStore {
  /** Absolute path to the store root (`<dataDir>/phone`). */
  readonly root: string;
  private readonly path: string;
  private readonly nowIso: () => string;
  private cache: PhoneDoc | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; nowIso?: () => string }) {
    this.root = resolve(options.dataDir, "phone");
    this.path = join(this.root, "phone.json");
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /** Ensure the store root exists. Idempotent. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /* --------------------------------------------------------------------- *
   * Providers
   * --------------------------------------------------------------------- */

  /** All providers, secrets masked, optionally filtered to one kind. */
  async listProviders(kind?: ProviderKind): Promise<ImProvider[]> {
    const doc = await this.load();
    const providers = kind ? doc.providers.filter((p) => p.kind === kind) : doc.providers;
    return providers.map((p) => this.maskProvider(p));
  }

  /** A single provider by id, secrets masked. */
  async getProvider(id: string): Promise<ImProvider | undefined> {
    const doc = await this.load();
    const found = doc.providers.find((p) => p.id === id);
    return found ? this.maskProvider(found) : undefined;
  }

  /**
   * A single provider by id with RAW (unmasked) credentials. For the service's
   * bridge-spawn / connection-test orchestration only — never returned over
   * HTTP. Returns undefined for an unknown id.
   */
  async getProviderUnmasked(id: string): Promise<ImProvider | undefined> {
    const doc = await this.load();
    const found = doc.providers.find((p) => p.id === id);
    return found ? this.clone(found) : undefined;
  }

  /** Create an IM provider instance. Returns it with secrets masked. */
  async createProvider(input: ImProviderCreateInput): Promise<ImProvider> {
    const doc = await this.load();
    const now = this.nowIso();
    const spec = PROVIDER_KIND_SPECS[input.kind];
    const provider: ImProvider = ImProviderSchema.parse({
      ...input,
      id: `${input.kind}-${randomUUID().slice(0, 8)}`,
      transport: input.transport ?? spec.transport,
      enabled: input.enabled ?? false,
      credentials: input.credentials ?? {},
      status: "idle",
      statusMessage: "",
      createdAt: now,
      updatedAt: now,
    });
    doc.providers.push(provider);
    await this.persist(doc);
    return this.maskProvider(provider);
  }

  /**
   * Patch a provider. Incoming credential secrets equal to `********` preserve
   * the stored value (merge-masked). `kind` is immutable. Returns the updated
   * provider, secrets masked. Throws "provider not found" on an unknown id.
   */
  async updateProvider(id: string, patch: ImProviderUpdateInput): Promise<ImProvider> {
    const doc = await this.load();
    const index = doc.providers.findIndex((p) => p.id === id);
    if (index === -1) throw new Error(`provider not found: ${id}`);
    const current = doc.providers[index];
    const mergedCredentials = patch.credentials
      ? this.mergeMaskedCredentials(current.kind, current.credentials, patch.credentials)
      : current.credentials;
    const next: ImProvider = ImProviderSchema.parse({
      ...current,
      ...patch,
      credentials: mergedCredentials,
      // id + kind + status are managed here; createdAt preserved.
      id: current.id,
      kind: current.kind,
      status: current.status,
      statusMessage: current.statusMessage,
      createdAt: current.createdAt,
      updatedAt: this.nowIso(),
    });
    doc.providers[index] = next;
    await this.persist(doc);
    return this.maskProvider(next);
  }

  /**
   * Record a transport-managed status transition for a provider (called by the
   * service on bridge `ready`/`error`, never by an HTTP route). Returns the
   * updated provider, secrets masked. No-op (returns undefined) on unknown id.
   */
  async setProviderStatus(
    id: string,
    status: ImProvider["status"],
    statusMessage = "",
  ): Promise<ImProvider | undefined> {
    const doc = await this.load();
    const index = doc.providers.findIndex((p) => p.id === id);
    if (index === -1) return undefined;
    const next: ImProvider = ImProviderSchema.parse({
      ...doc.providers[index],
      status,
      statusMessage,
      updatedAt: this.nowIso(),
    });
    doc.providers[index] = next;
    await this.persist(doc);
    return this.maskProvider(next);
  }

  /**
   * Delete a provider and cascade-delete its channels, those channels'
   * bindings, and cached members. Returns the removed provider, secrets masked.
   * Throws on unknown id.
   */
  async deleteProvider(id: string): Promise<ImProvider> {
    const doc = await this.load();
    const index = doc.providers.findIndex((p) => p.id === id);
    if (index === -1) throw new Error(`provider not found: ${id}`);
    const [removed] = doc.providers.splice(index, 1);
    const orphanChannelIds = new Set(doc.channels.filter((c) => c.providerId === id).map((c) => c.id));
    doc.channels = doc.channels.filter((c) => c.providerId !== id);
    doc.bindings = doc.bindings.filter((b) => b.providerId !== id && !orphanChannelIds.has(b.channelId));
    doc.members = doc.members.filter((m) => !orphanChannelIds.has(m.channelId));
    await this.persist(doc);
    return this.maskProvider(removed);
  }

  /**
   * LIGHTWEIGHT connection test ("检测"): required-fields-present for the kind.
   * Operates on the STORED (unmasked) credentials so a masked echo never
   * produces a false "missing". No network probe — live connectivity is the
   * provider's `status`. Throws on unknown id.
   */
  async testProvider(id: string): Promise<ConnectionTestResult> {
    const doc = await this.load();
    const provider = doc.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`provider not found: ${id}`);
    return checkProviderValues(provider.kind, {
      displayName: provider.displayName,
      ...(provider.credentials as unknown as Record<string, unknown>),
    });
  }

  /* --------------------------------------------------------------------- *
   * Channels
   * --------------------------------------------------------------------- */

  /** Channels, optionally filtered to one provider. */
  async listChannels(providerId?: string): Promise<ImChannel[]> {
    const doc = await this.load();
    const channels = providerId ? doc.channels.filter((c) => c.providerId === providerId) : doc.channels;
    return channels.map((c) => ({ ...c }));
  }

  async getChannel(id: string): Promise<ImChannel | undefined> {
    const doc = await this.load();
    const found = doc.channels.find((c) => c.id === id);
    return found ? { ...found } : undefined;
  }

  /** Look up a channel by its provider-native chat id (inbound dispatch path). */
  async findChannelByChatId(providerId: string, channelId: string): Promise<ImChannel | undefined> {
    const doc = await this.load();
    const found = doc.channels.find((c) => c.providerId === providerId && c.channelId === channelId);
    return found ? { ...found } : undefined;
  }

  /**
   * Create a channel. Validates the owning provider exists and rejects a
   * duplicate (providerId, channelId) pair. Throws on unknown provider.
   */
  async createChannel(input: ImChannelCreateInput): Promise<ImChannel> {
    const doc = await this.load();
    if (!doc.providers.some((p) => p.id === input.providerId)) {
      throw new Error(`provider not found: ${input.providerId}`);
    }
    if (doc.channels.some((c) => c.providerId === input.providerId && c.channelId === input.channelId)) {
      throw new Error(`channel already exists for chat: ${input.channelId}`);
    }
    const now = this.nowIso();
    const channel: ImChannel = ImChannelSchema.parse({
      ...input,
      id: `channel-${randomUUID().slice(0, 8)}`,
      name: input.name ?? "",
      createdAt: now,
      updatedAt: now,
    });
    doc.channels.push(channel);
    await this.persist(doc);
    return { ...channel };
  }

  /** Patch a channel. `providerId`/`channelId` are immutable. Throws on unknown id. */
  async updateChannel(id: string, patch: ImChannelUpdateInput): Promise<ImChannel> {
    const doc = await this.load();
    const index = doc.channels.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`channel not found: ${id}`);
    const current = doc.channels[index];
    const next: ImChannel = ImChannelSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      providerId: current.providerId,
      channelId: current.channelId,
      createdAt: current.createdAt,
      updatedAt: this.nowIso(),
    });
    doc.channels[index] = next;
    await this.persist(doc);
    return { ...next };
  }

  /** Delete a channel and cascade-delete its binding + cached members. Throws on unknown id. */
  async deleteChannel(id: string): Promise<ImChannel> {
    const doc = await this.load();
    const index = doc.channels.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`channel not found: ${id}`);
    const [removed] = doc.channels.splice(index, 1);
    doc.bindings = doc.bindings.filter((b) => b.channelId !== id);
    doc.members = doc.members.filter((m) => m.channelId !== id);
    await this.persist(doc);
    return { ...removed };
  }

  /* --------------------------------------------------------------------- *
   * Thread ↔ channel bindings
   * --------------------------------------------------------------------- */

  /** Bindings, optionally filtered to one channel or one thread. */
  async listBindings(filter?: { channelId?: string; threadId?: string }): Promise<ThreadChannelBinding[]> {
    const doc = await this.load();
    let bindings = doc.bindings;
    if (filter?.channelId) bindings = bindings.filter((b) => b.channelId === filter.channelId);
    if (filter?.threadId) bindings = bindings.filter((b) => b.threadId === filter.threadId);
    return bindings.map((b) => ({ ...b }));
  }

  /** The binding for a channel (at most one), if any. */
  async getBindingForChannel(channelId: string): Promise<ThreadChannelBinding | undefined> {
    const doc = await this.load();
    const found = doc.bindings.find((b) => b.channelId === channelId);
    return found ? { ...found } : undefined;
  }

  /**
   * Upsert the binding for a channel (idempotent on `channelId`, mirroring the
   * native `setNexusChatThreadBinding`). Resolves `providerId` from the channel.
   * Throws on unknown channel.
   */
  async upsertBinding(input: ThreadChannelBindInput): Promise<ThreadChannelBinding> {
    const doc = await this.load();
    const channel = doc.channels.find((c) => c.id === input.channelId);
    if (!channel) throw new Error(`channel not found: ${input.channelId}`);
    const now = this.nowIso();
    const existing = doc.bindings.find((b) => b.channelId === input.channelId);
    const binding: ThreadChannelBinding = ThreadChannelBindingSchema.parse({
      id: existing?.id ?? `binding-${randomUUID().slice(0, 8)}`,
      threadId: input.threadId,
      channelId: input.channelId,
      providerId: channel.providerId,
      label: input.label ?? existing?.label ?? "",
      mirrorInbound: input.mirrorInbound ?? existing?.mirrorInbound ?? true,
      mirrorOutbound: input.mirrorOutbound ?? existing?.mirrorOutbound ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (existing) {
      doc.bindings[doc.bindings.indexOf(existing)] = binding;
    } else {
      doc.bindings.push(binding);
    }
    await this.persist(doc);
    return { ...binding };
  }

  /**
   * Remove a channel's binding (the native unbind, originally `threadId=""`).
   * Returns the removed binding. Throws when the channel has no binding.
   */
  async deleteBinding(channelId: string): Promise<ThreadChannelBinding> {
    const doc = await this.load();
    const index = doc.bindings.findIndex((b) => b.channelId === channelId);
    if (index === -1) throw new Error(`binding not found for channel: ${channelId}`);
    const [removed] = doc.bindings.splice(index, 1);
    await this.persist(doc);
    return { ...removed };
  }

  /* --------------------------------------------------------------------- *
   * Members (@-mention roster cache)
   * --------------------------------------------------------------------- */

  /** The cached member roster for a channel (the @-mention picker source). */
  async listMembers(channelId: string): Promise<ImMember[]> {
    const doc = await this.load();
    return doc.members.filter((m) => m.channelId === channelId).map((m) => ({ ...m }));
  }

  /**
   * Replace a channel's cached member roster wholesale (after the service
   * fetches it from the provider via the bridge `list_chat_members` command).
   * Returns the persisted roster. Throws on unknown channel.
   */
  async replaceMembers(channelId: string, members: AtMember[]): Promise<ImMember[]> {
    const doc = await this.load();
    if (!doc.channels.some((c) => c.id === channelId)) {
      throw new Error(`channel not found: ${channelId}`);
    }
    const now = this.nowIso();
    doc.members = doc.members.filter((m) => m.channelId !== channelId);
    const next: ImMember[] = members.map((m) =>
      ImMemberSchema.parse({
        id: `member-${randomUUID().slice(0, 8)}`,
        channelId,
        name: m.name ?? "",
        providerMemberId: m.id,
        avatar: "",
        updatedAt: now,
      }),
    );
    doc.members.push(...next);
    await this.persist(doc);
    return next.map((m) => ({ ...m }));
  }

  /* --------------------------------------------------------------------- *
   * Secret masking helpers
   * --------------------------------------------------------------------- */

  /**
   * Return a defensive copy of a provider with its kind's secret credential
   * fields replaced by `********`. Empty secrets stay empty so a cleared secret
   * reads as cleared (matching the config masker's `value === "" → value` rule).
   */
  private maskProvider(provider: ImProvider): ImProvider {
    const out = this.clone(provider);
    const credentials = out.credentials as unknown as Record<string, unknown>;
    for (const key of SECRET_FIELDS_BY_PROVIDER_KIND[provider.kind]) {
      const value = credentials[key];
      if (typeof value === "string" && value !== "") {
        credentials[key] = MASKED_SECRET;
      }
    }
    return out;
  }

  /**
   * Merge a credentials patch into the stored credentials, preserving stored
   * secrets wherever the patch echoes the `********` sentinel. A masked value
   * for a key with no stored counterpart falls back to "" so the sentinel is
   * never persisted as a real secret.
   */
  private mergeMaskedCredentials(
    kind: ProviderKind,
    current: ImCredentials,
    patch: Partial<ImCredentials>,
  ): Record<string, unknown> {
    const secretKeys = new Set<string>(SECRET_FIELDS_BY_PROVIDER_KIND[kind]);
    const out: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (secretKeys.has(key) && value === MASKED_SECRET) {
        const stored = (current as unknown as Record<string, unknown>)[key];
        out[key] = typeof stored === "string" ? stored : "";
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /** Structured deep-ish clone (records + nested credentials/bindings only). */
  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /* --------------------------------------------------------------------- *
   * Persistence
   * --------------------------------------------------------------------- */

  /** Load (lazily) the document, caching the parsed result. Re-seeds on corrupt. */
  private async load(): Promise<PhoneDoc> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PhoneDoc>;
      this.cache = {
        providers: parseAll(parsed.providers, ImProviderSchema),
        channels: parseAll(parsed.channels, ImChannelSchema),
        bindings: parseAll(parsed.bindings, ThreadChannelBindingSchema),
        members: parseAll(parsed.members, ImMemberSchema),
      };
      return this.cache;
    } catch {
      // Missing or corrupt → start from an empty document and persist it.
      this.cache = { providers: [], channels: [], bindings: [], members: [] };
      await this.persist(this.cache);
      return this.cache;
    }
  }

  /** Atomically write the document, serialized behind any in-flight write. */
  private async persist(doc: PhoneDoc): Promise<void> {
    this.cache = doc;
    const write = this.writing.then(async () => {
      await mkdir(this.root, { recursive: true });
      await atomicWriteFile(this.path, JSON.stringify(doc, null, 2));
    });
    this.writing = write.catch(() => undefined);
    await write;
  }
}

/** Parse a heterogeneous array, dropping entries that fail validation. */
function parseAll<T>(
  value: unknown,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/**
 * Lightweight credential validation shared by the store and any caller: returns
 * the required fields that are missing/blank for a provider kind, plus a
 * structured result. No network probe — live connectivity is the provider's
 * `status`. `EMPTY_DOC` is exported for the service's seed path.
 */
export function checkProviderValues(kind: ProviderKind, values: Record<string, unknown>): ConnectionTestResult {
  const specs = PROVIDER_KIND_SPECS[kind]?.fields ?? [];
  const missing: string[] = [];
  for (const spec of specs) {
    if (!spec.required) continue;
    const value = values[spec.key];
    if (typeof value !== "string" || value.trim() === "") missing.push(spec.label);
  }
  if (missing.length > 0) {
    return { ok: false, missingFields: missing, message: `缺少：${missing.join("、")}` };
  }
  return { ok: true, missingFields: [], message: "配置完整；实时连通性见 provider status（由桥接 ready 上报）" };
}

/** Re-export the empty doc for callers needing a typed seed. */
export const PHONE_EMPTY_DOC: Readonly<PhoneDoc> = EMPTY_DOC;
