import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./atomic-write.js";
import { MASKED_SECRET } from "../../config/config.js";
import {
  ConnectorProfileSchema,
  ProjectSpaceSchema,
  ExternalLinkSchema,
  ActivityEventSchema,
  SECRET_FIELDS_BY_VENDOR,
  VENDOR_FIELD_SPECS,
  DEFAULT_LINK_REF,
  CONNECTOR_VENDORS,
  type ConnectorProfile,
  type ConnectorProfileCreateInput,
  type ConnectorProfileUpdateInput,
  type ConnectorVendor,
  type BindableVendor,
  type ProjectSpace,
  type ProjectSpaceCreateInput,
  type ProjectSpaceUpdateInput,
  type ExternalLink,
  type ExternalLinkCreateInput,
  type ExternalLinkUpdateInput,
  type ActivityEvent,
  type ActivityEventCreateInput,
  type EventStatus,
  type EventStatusFilter,
  type HealthCheckResult,
} from "../../contracts/connectors.js";

/**
 * Persisted ConnectorHub document. A single JSON file holds all four axes
 * (profiles, spaces, links, events) so the store mirrors the original's
 * one-file `AgentDirectoryStore` pattern.
 */
interface ConnectorsDoc {
  profiles: ConnectorProfile[];
  spaces: ProjectSpace[];
  links: ExternalLink[];
  events: ActivityEvent[];
}

const EMPTY_DOC: ConnectorsDoc = { profiles: [], spaces: [], links: [], events: [] };

/** Hard cap on retained activity events (oldest dropped first). */
const MAX_EVENTS = 1000;

/**
 * File-backed ConnectorHub store (连接中心). Persists credential profiles,
 * project spaces, external links, and activity events to
 * `<dataDir>/connectors/connectors.json`. De-branded: rooted under the app data
 * dir (no `~/.nexus`), no company URL presets.
 *
 * Secret discipline: profile credential secrets (gitlab `token`, k8s `encrypt`,
 * nacos `password`, feishu `appSecret`) are MASKED on every read/list and
 * MERGE-MASKED on update — an incoming `********` preserves the stored value
 * rather than clobbering it. Raw secrets never leave the store.
 *
 * CRUD is serialized through a single in-flight promise so concurrent writes
 * never interleave. A read never throws; a corrupt file is re-seeded empty.
 */
export class ConnectorStore {
  /** Absolute path to the store root (`<dataDir>/connectors`). */
  readonly root: string;
  private readonly path: string;
  private readonly nowIso: () => string;
  private cache: ConnectorsDoc | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; nowIso?: () => string }) {
    this.root = resolve(options.dataDir, "connectors");
    this.path = join(this.root, "connectors.json");
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /** Ensure the store root exists. Idempotent. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /* --------------------------------------------------------------------- *
   * Profiles
   * --------------------------------------------------------------------- */

  /** All profiles, secrets masked, optionally filtered to one vendor. */
  async listProfiles(vendor?: ConnectorVendor): Promise<ConnectorProfile[]> {
    const doc = await this.load();
    const profiles = vendor ? doc.profiles.filter((p) => p.vendor === vendor) : doc.profiles;
    return profiles.map((p) => this.maskProfile(p));
  }

  /** A single profile by id, secrets masked. */
  async getProfile(id: string): Promise<ConnectorProfile | undefined> {
    const doc = await this.load();
    const found = doc.profiles.find((p) => p.id === id);
    return found ? this.maskProfile(found) : undefined;
  }

  /**
   * Create a vendor credential profile. The first profile created for a vendor
   * (or one with `isDefault: true`) becomes the per-vendor default. Returns the
   * created profile with secrets masked.
   */
  async createProfile(input: ConnectorProfileCreateInput): Promise<ConnectorProfile> {
    const doc = await this.load();
    const now = this.nowIso();
    const profile: ConnectorProfile = ConnectorProfileSchema.parse({
      ...input,
      id: `${input.vendor}-${randomUUID().slice(0, 8)}`,
      isDefault: input.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    });
    doc.profiles.push(profile);
    // First profile of a vendor, or an explicit default request, wins the default.
    const sameVendor = doc.profiles.filter((p) => p.vendor === profile.vendor);
    if (profile.isDefault || sameVendor.length === 1) {
      this.applyDefault(doc, profile.vendor, profile.id);
    }
    await this.persist(doc);
    return this.maskProfile(profile);
  }

  /**
   * Patch a profile. Incoming secret fields equal to `********` preserve the
   * stored secret (merge-masked). Returns the updated profile, secrets masked.
   * Throws "profile not found" on an unknown id.
   */
  async updateProfile(id: string, patch: ConnectorProfileUpdateInput): Promise<ConnectorProfile> {
    const doc = await this.load();
    const index = doc.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error(`profile not found: ${id}`);
    const current = doc.profiles[index];
    const merged = this.mergeMaskedProfileFields(current, patch);
    const next: ConnectorProfile = ConnectorProfileSchema.parse({
      ...current,
      ...merged,
      // id + vendor are immutable; createdAt preserved.
      id: current.id,
      vendor: current.vendor,
      createdAt: current.createdAt,
      updatedAt: this.nowIso(),
    });
    doc.profiles[index] = next;
    if (next.isDefault) this.applyDefault(doc, next.vendor, next.id);
    await this.persist(doc);
    return this.maskProfile(next);
  }

  /**
   * Delete a profile. Clears any space bindings pointing at it and, if it was
   * the vendor default, promotes the next remaining profile of that vendor.
   * Returns the removed profile, secrets masked. Throws on unknown id.
   */
  async deleteProfile(id: string): Promise<ConnectorProfile> {
    const doc = await this.load();
    const index = doc.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error(`profile not found: ${id}`);
    const [removed] = doc.profiles.splice(index, 1);
    const wasDefault = removed.isDefault;
    // Unbind every space that referenced this profile.
    for (const space of doc.spaces) {
      for (const vendor of Object.keys(space.bindings) as BindableVendor[]) {
        if (space.bindings[vendor] === id) delete space.bindings[vendor];
      }
    }
    // Promote a replacement default for the vendor if needed.
    if (wasDefault) {
      const next = doc.profiles.find((p) => p.vendor === removed.vendor);
      if (next) this.applyDefault(doc, removed.vendor, next.id);
    }
    await this.persist(doc);
    return this.maskProfile(removed);
  }

  /**
   * Set the per-vendor default profile. Throws if the id is unknown or belongs
   * to a different vendor. Returns the new default, secrets masked.
   */
  async setDefaultProfile(vendor: ConnectorVendor, id: string): Promise<ConnectorProfile> {
    const doc = await this.load();
    const target = doc.profiles.find((p) => p.id === id);
    if (!target) throw new Error(`profile not found: ${id}`);
    if (target.vendor !== vendor) throw new Error(`profile ${id} is not a ${vendor} profile`);
    this.applyDefault(doc, vendor, id);
    await this.persist(doc);
    return this.maskProfile(doc.profiles.find((p) => p.id === id)!);
  }

  /**
   * LIGHTWEIGHT health check ("检测") for a profile: required-fields-present +
   * URL well-formed only. Real connectivity is delegated to the MCP. Operates
   * on the STORED (unmasked) credentials so a masked echo never produces a
   * false "missing". Throws on unknown id.
   */
  async checkProfile(id: string): Promise<HealthCheckResult> {
    const doc = await this.load();
    const profile = doc.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`profile not found: ${id}`);
    return checkProfileValues(profile.vendor, profile as unknown as Record<string, unknown>);
  }

  /* --------------------------------------------------------------------- *
   * Spaces
   * --------------------------------------------------------------------- */

  /** All project spaces (newest-relevant order preserved). */
  async listSpaces(): Promise<ProjectSpace[]> {
    const doc = await this.load();
    return doc.spaces.map((s) => ({ ...s, bindings: { ...s.bindings } }));
  }

  async getSpace(id: string): Promise<ProjectSpace | undefined> {
    const doc = await this.load();
    const found = doc.spaces.find((s) => s.id === id);
    return found ? { ...found, bindings: { ...found.bindings } } : undefined;
  }

  /** Create a project space; assigns a stable unique id. */
  async createSpace(input: ProjectSpaceCreateInput): Promise<ProjectSpace> {
    const doc = await this.load();
    const now = this.nowIso();
    const space: ProjectSpace = ProjectSpaceSchema.parse({
      ...input,
      id: `space-${randomUUID().slice(0, 8)}`,
      bindings: input.bindings ?? {},
      createdAt: now,
      updatedAt: now,
    });
    doc.spaces.push(space);
    await this.persist(doc);
    return { ...space, bindings: { ...space.bindings } };
  }

  /** Patch a project space. Throws on unknown id. */
  async updateSpace(id: string, patch: ProjectSpaceUpdateInput): Promise<ProjectSpace> {
    const doc = await this.load();
    const index = doc.spaces.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`space not found: ${id}`);
    const current = doc.spaces[index];
    const next: ProjectSpace = ProjectSpaceSchema.parse({
      ...current,
      ...patch,
      // bindings are managed via bind/unbind; a partial patch replaces wholesale only if provided.
      bindings: patch.bindings ?? current.bindings,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowIso(),
    });
    doc.spaces[index] = next;
    await this.persist(doc);
    return { ...next, bindings: { ...next.bindings } };
  }

  /** Delete a space and cascade-delete its links + events. Throws on unknown id. */
  async deleteSpace(id: string): Promise<ProjectSpace> {
    const doc = await this.load();
    const index = doc.spaces.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`space not found: ${id}`);
    const [removed] = doc.spaces.splice(index, 1);
    doc.links = doc.links.filter((l) => l.spaceId !== id);
    doc.events = doc.events.filter((e) => e.spaceId !== id);
    await this.persist(doc);
    return { ...removed, bindings: { ...removed.bindings } };
  }

  /**
   * Bind a space to a credential profile for one bindable vendor (the
   * de-branded `connector_profile` link). Validates the profile exists and is
   * of the matching vendor. Returns the updated space.
   */
  async bindProfile(spaceId: string, vendor: BindableVendor, profileId: string): Promise<ProjectSpace> {
    const doc = await this.load();
    const space = doc.spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error(`space not found: ${spaceId}`);
    const profile = doc.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    if (profile.vendor !== vendor) throw new Error(`profile ${profileId} is not a ${vendor} profile`);
    space.bindings[vendor] = profileId;
    space.updatedAt = this.nowIso();
    await this.persist(doc);
    return { ...space, bindings: { ...space.bindings } };
  }

  /** Remove a space's binding for one bindable vendor. Returns the updated space. */
  async unbindProfile(spaceId: string, vendor: BindableVendor): Promise<ProjectSpace> {
    const doc = await this.load();
    const space = doc.spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error(`space not found: ${spaceId}`);
    delete space.bindings[vendor];
    space.updatedAt = this.nowIso();
    await this.persist(doc);
    return { ...space, bindings: { ...space.bindings } };
  }

  /* --------------------------------------------------------------------- *
   * Links
   * --------------------------------------------------------------------- */

  /** External links, optionally filtered to one space. */
  async listLinks(spaceId?: string): Promise<ExternalLink[]> {
    const doc = await this.load();
    const links = spaceId ? doc.links.filter((l) => l.spaceId === spaceId) : doc.links;
    return links.map((l) => ({ ...l }));
  }

  /** Create a resource link; defaults `ref` to the kind's empty payload. */
  async createLink(input: ExternalLinkCreateInput): Promise<ExternalLink> {
    const doc = await this.load();
    if (!doc.spaces.some((s) => s.id === input.spaceId)) {
      throw new Error(`space not found: ${input.spaceId}`);
    }
    const now = this.nowIso();
    const link: ExternalLink = ExternalLinkSchema.parse({
      id: `link-${randomUUID().slice(0, 8)}`,
      spaceId: input.spaceId,
      kind: input.kind,
      ref: input.ref ?? DEFAULT_LINK_REF[input.kind],
      createdAt: now,
      updatedAt: now,
    });
    doc.links.push(link);
    await this.persist(doc);
    return { ...link };
  }

  /** Patch a resource link. Throws on unknown id. */
  async updateLink(id: string, patch: ExternalLinkUpdateInput): Promise<ExternalLink> {
    const doc = await this.load();
    const index = doc.links.findIndex((l) => l.id === id);
    if (index === -1) throw new Error(`link not found: ${id}`);
    const current = doc.links[index];
    const next: ExternalLink = ExternalLinkSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      spaceId: current.spaceId,
      createdAt: current.createdAt,
      updatedAt: this.nowIso(),
    });
    doc.links[index] = next;
    await this.persist(doc);
    return { ...next };
  }

  /** Delete a resource link. Throws on unknown id. */
  async deleteLink(id: string): Promise<ExternalLink> {
    const doc = await this.load();
    const index = doc.links.findIndex((l) => l.id === id);
    if (index === -1) throw new Error(`link not found: ${id}`);
    const [removed] = doc.links.splice(index, 1);
    await this.persist(doc);
    return { ...removed };
  }

  /* --------------------------------------------------------------------- *
   * Events
   * --------------------------------------------------------------------- */

  /**
   * Activity events (活动流), newest first. Filter by space and/or status; the
   * `all` status filter is a no-op (returns every status).
   */
  async listEvents(filter?: { spaceId?: string; status?: EventStatusFilter }): Promise<ActivityEvent[]> {
    const doc = await this.load();
    let events = doc.events;
    if (filter?.spaceId) events = events.filter((e) => e.spaceId === filter.spaceId);
    if (filter?.status && filter.status !== "all") {
      events = events.filter((e) => e.status === filter.status);
    }
    return events
      .map((e) => ({ ...e }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Append an activity event; trims the log to `MAX_EVENTS` (oldest dropped). */
  async createEvent(input: ActivityEventCreateInput): Promise<ActivityEvent> {
    const doc = await this.load();
    const event: ActivityEvent = ActivityEventSchema.parse({
      id: `event-${randomUUID().slice(0, 8)}`,
      spaceId: input.spaceId ?? "",
      kind: input.kind ?? "",
      source: input.source ?? "",
      type: input.type ?? "",
      payload: input.payload ?? "{}",
      status: input.status ?? "new",
      createdAt: this.nowIso(),
    });
    doc.events.push(event);
    if (doc.events.length > MAX_EVENTS) {
      doc.events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      doc.events.splice(0, doc.events.length - MAX_EVENTS);
    }
    await this.persist(doc);
    return { ...event };
  }

  /** Transition an event's status (new → seen / actioned / dismissed). Throws on unknown id. */
  async setEventStatus(id: string, status: EventStatus): Promise<ActivityEvent> {
    const doc = await this.load();
    const index = doc.events.findIndex((e) => e.id === id);
    if (index === -1) throw new Error(`event not found: ${id}`);
    const next: ActivityEvent = ActivityEventSchema.parse({ ...doc.events[index], status });
    doc.events[index] = next;
    await this.persist(doc);
    return { ...next };
  }

  /* --------------------------------------------------------------------- *
   * Secret masking helpers
   * --------------------------------------------------------------------- */

  /**
   * Return a defensive copy of a profile with this vendor's secret fields
   * replaced by `********`. Empty secrets stay empty so a cleared secret reads
   * as cleared (matching the config masker's `value === "" → value` rule).
   */
  private maskProfile(profile: ConnectorProfile): ConnectorProfile {
    const out: ConnectorProfile = { ...profile };
    for (const key of SECRET_FIELDS_BY_VENDOR[profile.vendor]) {
      const value = (out as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") {
        (out as Record<string, unknown>)[key] = MASKED_SECRET;
      }
    }
    return out;
  }

  /**
   * Merge an update patch into the current profile, preserving stored secrets
   * wherever the patch echoes the `********` sentinel. A masked value for a
   * field that has no stored counterpart falls back to "" so the sentinel is
   * never persisted as a real secret.
   */
  private mergeMaskedProfileFields(
    current: ConnectorProfile,
    patch: ConnectorProfileUpdateInput,
  ): Record<string, unknown> {
    const secretKeys = new Set(SECRET_FIELDS_BY_VENDOR[current.vendor]);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (secretKeys.has(key) && value === MASKED_SECRET) {
        const stored = (current as Record<string, unknown>)[key];
        out[key] = typeof stored === "string" ? stored : "";
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /** Clear `isDefault` on every other profile of the vendor, set it on `id`. */
  private applyDefault(doc: ConnectorsDoc, vendor: ConnectorVendor, id: string): void {
    for (const profile of doc.profiles) {
      if (profile.vendor !== vendor) continue;
      profile.isDefault = profile.id === id;
    }
  }

  /* --------------------------------------------------------------------- *
   * Persistence
   * --------------------------------------------------------------------- */

  /** Load (lazily) the document, caching the parsed result. Re-seeds on corrupt. */
  private async load(): Promise<ConnectorsDoc> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ConnectorsDoc>;
      this.cache = {
        profiles: parseAll(parsed.profiles, ConnectorProfileSchema),
        spaces: parseAll(parsed.spaces, ProjectSpaceSchema),
        links: parseAll(parsed.links, ExternalLinkSchema),
        events: parseAll(parsed.events, ActivityEventSchema),
      };
      return this.cache;
    } catch {
      // Missing or corrupt → start from an empty document and persist it.
      this.cache = { ...EMPTY_DOC, profiles: [], spaces: [], links: [], events: [] };
      await this.persist(this.cache);
      return this.cache;
    }
  }

  /** Atomically write the document, serialized behind any in-flight write. */
  private async persist(doc: ConnectorsDoc): Promise<void> {
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
function parseAll<T>(value: unknown, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/**
 * Lightweight credential validation shared by the store and any caller: returns
 * the required fields that are missing/blank for a vendor, plus a structured
 * result. No network probe — real health checks are delegated to the MCP.
 */
export function checkProfileValues(vendor: ConnectorVendor, values: Record<string, unknown>): HealthCheckResult {
  const specs = VENDOR_FIELD_SPECS[vendor] ?? [];
  const missing: string[] = [];
  for (const spec of specs) {
    if (!spec.required) continue;
    const value = values[spec.key];
    if (typeof value !== "string" || value.trim() === "") missing.push(spec.label);
  }
  // Validate URL well-formedness when a URL field is present and non-empty.
  const urlMalformed = isUrlMalformed(values.url) || isUrlMalformed(values.ksUrl);
  if (missing.length > 0) {
    return { ok: false, missingFields: missing, message: `缺少：${missing.join("、")}` };
  }
  if (urlMalformed) {
    return { ok: false, missingFields: [], message: "URL 格式不正确" };
  }
  return { ok: true, missingFields: [], message: "配置完整；真实健康检查由对应 MCP 承接" };
}

/** True only when a non-empty value is present but not a parseable URL. */
function isUrlMalformed(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new URL(value.trim());
    return false;
  } catch {
    return true;
  }
}

/** The set of vendor ids this store understands (re-exported for callers). */
export const CONNECTOR_STORE_VENDORS = CONNECTOR_VENDORS;
