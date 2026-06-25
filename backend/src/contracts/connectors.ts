import { z } from "zod";

/**
 * ConnectorHub (连接中心) contracts.
 *
 * Faithful to the original Nexus ConnectorHubView, de-branded so vendors are
 * pluggable tool integrations rather than company-URL-bound presets. The hub has
 * three axes, persisted side-by-side in `<dataDir>/connectors/connectors.json`:
 *
 *  - **Credential profiles** (连接配置) — named credential sets for a vendor
 *    (`gitlab` / `k8s` / `nacos` / `feishu`), each with one default per vendor.
 *    Secret fields (gitlab `token`, k8s `encrypt`, nacos `password`, feishu
 *    `appSecret`) are SECRETS: masked on read, merge-masked on write.
 *  - **Project spaces** (项目空间) — a workspace binding local repo metadata to
 *    one credential profile per vendor.
 *  - **External links** (资源链接) — per-space resource references (a GitLab
 *    project, a K8s workload, a feishu chat / bitable, a nacos config), each
 *    carrying a free-form JSON `ref` payload.
 *  - **Activity events** (活动流) — an append-only event log per space.
 *
 * The original hard-coded `gitlab.intra.nexus.ai` / `k8s.intra.nexus.ai` /
 * `nacos.k8s.intra.nexus.ai` URL presets; those are dropped here in favor of
 * empty/generic placeholders so the build carries no company URLs.
 */

/* ------------------------------------------------------------------------- *
 * Vendors
 * ------------------------------------------------------------------------- */

/**
 * Known vendor identifiers. Kept as generic tool names (not company-bound) and
 * deliberately ordered to match the original `ge` vendor list, with `feishu`
 * appended (it is a profile vendor here, not only a nexus-channel credential).
 */
export const CONNECTOR_VENDORS = ["gitlab", "k8s", "nacos", "feishu"] as const;
export const ConnectorVendorSchema = z.enum(CONNECTOR_VENDORS);
export type ConnectorVendor = z.infer<typeof ConnectorVendorSchema>;

/** Vendors that participate in per-vendor space bindings (`connector_profile`). */
export const BINDABLE_VENDORS = ["gitlab", "k8s", "nacos"] as const;
export const BindableVendorSchema = z.enum(BINDABLE_VENDORS);
export type BindableVendor = z.infer<typeof BindableVendorSchema>;

/**
 * Secret field keys per vendor. The original marked these via the field
 * `password:!0` flag. The k8s `encrypt` key does NOT match the generic config
 * secret pattern, so the connector store masks these EXACT keys instead of
 * relying on key-pattern matching (see `SECRET_FIELDS_BY_VENDOR` use in the
 * store).
 */
export const SECRET_FIELDS_BY_VENDOR: Readonly<Record<ConnectorVendor, readonly string[]>> = {
  gitlab: ["token"],
  k8s: ["encrypt"],
  nacos: ["password"],
  feishu: ["appSecret"],
};

/* ------------------------------------------------------------------------- *
 * Credential profiles
 * ------------------------------------------------------------------------- */

/**
 * A vendor credential profile. A profile is `{ id, vendor, name, isDefault }`
 * plus the per-vendor credential fields flattened onto the object (matching the
 * original stored shape `{ id, name, <field key>: string }`). `vendor` is added
 * so a single store can hold all profile arrays.
 *
 * Field-level requiredness is enforced lightly here (the credential strings are
 * all optional at the schema level so a partial draft can be stored); the
 * "health check / 检测" endpoint does the required-fields-present validation,
 * delegating real connectivity checks to the corresponding MCP.
 */
export const ConnectorProfileSchema = z.object({
  id: z.string().min(1),
  vendor: ConnectorVendorSchema,
  name: z.string().min(1).max(120),
  /** Whether this profile is the per-vendor default. */
  isDefault: z.boolean().default(false),

  // --- gitlab ---
  /** GitLab base URL (generic placeholder; no company preset). */
  url: z.string().max(2000).default(""),
  /** GitLab personal access token (SECRET). */
  token: z.string().max(4000).default(""),

  // --- k8s ---
  /** K8s username (=K8S_USERNAME). */
  username: z.string().max(200).default(""),
  /** K8s encrypted credential (SECRET, =K8S_ENCRYPT). */
  encrypt: z.string().max(8000).default(""),
  /** K8s context. */
  context: z.string().max(200).default(""),
  /** K8s namespace. */
  namespace: z.string().max(200).default(""),
  /** KubeSphere URL (optional). */
  ksUrl: z.string().max(2000).default(""),

  // --- nacos ---
  // `url` reused from gitlab block (Nacos server URL).
  // `username` reused from k8s block (optional Nacos username).
  /** Nacos password (SECRET, optional). */
  password: z.string().max(4000).default(""),

  // --- feishu ---
  /** Feishu app id. */
  appId: z.string().max(400).default(""),
  /** Feishu app secret (SECRET). */
  appSecret: z.string().max(4000).default(""),
  /**
   * Reuse the shared nexus-channel feishu credentials instead of this profile's
   * own appId/appSecret (de-branded rename of the original
   * `useNexusCredentials`).
   */
  useSharedCredentials: z.boolean().default(false),
  /** Optional token expiry (ISO 8601) carried for feishu auth bookkeeping. */
  expiresAt: z.string().default(""),

  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectorProfile = z.infer<typeof ConnectorProfileSchema>;

/** Request body for POST /v1/connectors/profiles (create). */
export const ConnectorProfileCreateRequest = z.object({
  vendor: ConnectorVendorSchema,
  name: z.string().min(1).max(120),
  isDefault: z.boolean().optional(),
  url: z.string().max(2000).optional(),
  token: z.string().max(4000).optional(),
  username: z.string().max(200).optional(),
  encrypt: z.string().max(8000).optional(),
  context: z.string().max(200).optional(),
  namespace: z.string().max(200).optional(),
  ksUrl: z.string().max(2000).optional(),
  password: z.string().max(4000).optional(),
  appId: z.string().max(400).optional(),
  appSecret: z.string().max(4000).optional(),
  useSharedCredentials: z.boolean().optional(),
  expiresAt: z.string().optional(),
});
export type ConnectorProfileCreateInput = z.infer<typeof ConnectorProfileCreateRequest>;

/**
 * Request body for PATCH /v1/connectors/profiles/:id (partial update). `vendor`
 * is immutable after creation, so it is omitted from the update shape.
 */
export const ConnectorProfileUpdateRequest = ConnectorProfileCreateRequest.omit({ vendor: true }).partial();
export type ConnectorProfileUpdateInput = z.infer<typeof ConnectorProfileUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * Project spaces
 * ------------------------------------------------------------------------- */

export const PROJECT_TYPES = ["generic", "mr", "diagnose", "k8s"] as const;
export const ProjectTypeSchema = z.enum(PROJECT_TYPES);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/**
 * A project space (项目空间). Holds local repo metadata + ship config, and binds
 * the space to one credential profile per bindable vendor via `bindings`
 * (`{ gitlab?: profileId, k8s?: profileId, nacos?: profileId }`), the
 * de-branded representation of the original `connector_profile` link kind.
 */
export const ProjectSpaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** Display name; falls back to `name` when blank. */
  displayName: z.string().max(200).default(""),
  /** Local repo path string (stored verbatim; no filesystem check, like origin). */
  localRepoPath: z.string().max(4000).default(""),
  projectType: ProjectTypeSchema.default("generic"),
  branch: z.string().max(400).default(""),
  shipCommand: z.string().max(4000).default(""),
  commitMsgFlag: z.string().max(40).default("-m"),
  /** Env vars as a JSON-object string (original stored `"{}"`). */
  envVars: z.string().default("{}"),
  /** Extra repo paths as a JSON-array string (original stored `"[]"`). */
  extraRepoPaths: z.string().default("[]"),
  systemPrompt: z.string().max(20000).default(""),
  /** Space → profile bindings, keyed by bindable vendor. */
  bindings: z.record(BindableVendorSchema, z.string()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSpace = z.infer<typeof ProjectSpaceSchema>;

/** Request body for POST /v1/connectors/spaces (create). */
export const ProjectSpaceCreateRequest = z.object({
  name: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
  localRepoPath: z.string().max(4000).optional(),
  projectType: ProjectTypeSchema.optional(),
  branch: z.string().max(400).optional(),
  shipCommand: z.string().max(4000).optional(),
  commitMsgFlag: z.string().max(40).optional(),
  envVars: z.string().optional(),
  extraRepoPaths: z.string().optional(),
  systemPrompt: z.string().max(20000).optional(),
  bindings: z.record(BindableVendorSchema, z.string()).optional(),
});
export type ProjectSpaceCreateInput = z.infer<typeof ProjectSpaceCreateRequest>;

/** Request body for PATCH /v1/connectors/spaces/:id (partial update). */
export const ProjectSpaceUpdateRequest = ProjectSpaceCreateRequest.partial();
export type ProjectSpaceUpdateInput = z.infer<typeof ProjectSpaceUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * External links (resource references)
 * ------------------------------------------------------------------------- */

export const LINK_KINDS = ["gitlab_project", "k8s_workload", "feishu_chat", "feishu_bitable", "nacos_config"] as const;
export const LinkKindSchema = z.enum(LINK_KINDS);
export type LinkKind = z.infer<typeof LinkKindSchema>;

/** Default `ref` JSON payload (as a string) per link kind, matching origin `De(kind)`. */
export const DEFAULT_LINK_REF: Readonly<Record<LinkKind, string>> = {
  gitlab_project: JSON.stringify({ projectId: "", path: "" }),
  k8s_workload: JSON.stringify({ context: "", namespace: "", workload: "", pipeline: "" }),
  feishu_chat: JSON.stringify({ chatId: "", chatName: "" }),
  feishu_bitable: JSON.stringify({ appToken: "", tableId: "" }),
  nacos_config: JSON.stringify({ dataId: "", group: "" }),
};

/**
 * An external resource link (资源链接) belonging to a space. `ref` is a free-form
 * JSON string payload (the "fragment") whose shape depends on `kind`.
 */
export const ExternalLinkSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  kind: LinkKindSchema,
  /** JSON-string payload; shape depends on `kind`. */
  ref: z.string().default("{}"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;

/** Request body for POST /v1/connectors/links (create). */
export const ExternalLinkCreateRequest = z.object({
  spaceId: z.string().min(1),
  kind: LinkKindSchema,
  ref: z.string().optional(),
});
export type ExternalLinkCreateInput = z.infer<typeof ExternalLinkCreateRequest>;

/** Request body for PATCH /v1/connectors/links/:id (partial update). */
export const ExternalLinkUpdateRequest = z
  .object({
    kind: LinkKindSchema.optional(),
    ref: z.string().optional(),
  })
  .partial();
export type ExternalLinkUpdateInput = z.infer<typeof ExternalLinkUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * Activity events
 * ------------------------------------------------------------------------- */

/** Event lifecycle statuses (origin `Zs`, minus the filter-only `all`). */
export const EVENT_STATUSES = ["new", "seen", "actioned", "dismissed"] as const;
export const EventStatusSchema = z.enum(EVENT_STATUSES);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/** Filter value for listing events: a real status or `all` (filter-only). */
export const EVENT_STATUS_FILTERS = ["all", ...EVENT_STATUSES] as const;
export const EventStatusFilterSchema = z.enum(EVENT_STATUS_FILTERS);
export type EventStatusFilter = z.infer<typeof EventStatusFilterSchema>;

/**
 * An activity-stream event (活动流). `payload` is a free-form JSON string; the UI
 * extracts `.title` / `.message` from it for rendering.
 */
export const ActivityEventSchema = z.object({
  id: z.string().min(1),
  /** Owning space (optional — some events are workspace-wide). */
  spaceId: z.string().default(""),
  /** Logical event kind (e.g. mr_opened, pipeline_failed). */
  kind: z.string().max(120).default(""),
  /** Source badge (e.g. gitlab, k8s, feishu). */
  source: z.string().max(120).default(""),
  /** Human-facing title/type. */
  type: z.string().max(200).default(""),
  /** JSON-string payload; UI extracts `.title`/`.message`. */
  payload: z.string().default("{}"),
  status: EventStatusSchema.default("new"),
  createdAt: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** Request body for POST /v1/connectors/events (append). */
export const ActivityEventCreateRequest = z.object({
  spaceId: z.string().optional(),
  kind: z.string().max(120).optional(),
  source: z.string().max(120).optional(),
  type: z.string().max(200).optional(),
  payload: z.string().optional(),
  status: EventStatusSchema.optional(),
});
export type ActivityEventCreateInput = z.infer<typeof ActivityEventCreateRequest>;

/** Request body for PATCH /v1/connectors/events/:id (status transition only). */
export const ActivityEventUpdateRequest = z.object({
  status: EventStatusSchema,
});
export type ActivityEventUpdateInput = z.infer<typeof ActivityEventUpdateRequest>;

/* ------------------------------------------------------------------------- *
 * Bindings + health check
 * ------------------------------------------------------------------------- */

/** Request body for PUT /v1/connectors/spaces/:id/bindings/:vendor (bind). */
export const BindProfileRequest = z.object({
  profileId: z.string().min(1),
});
export type BindProfileInput = z.infer<typeof BindProfileRequest>;

/**
 * Health-check ("检测") result. LIGHTWEIGHT validation only: required fields
 * present + URL well-formed. Real connectivity is delegated to the MCP
 * ("真实健康检查由对应 MCP 承接"). No network probe.
 */
export const HealthCheckResultSchema = z.object({
  ok: z.boolean(),
  missingFields: z.array(z.string()),
  message: z.string(),
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

/**
 * Required credential fields per vendor, with the UI label used in the
 * "缺少：…" health-check message. Mirrors the original catalog `f`, de-branded
 * (no URL presets). `password` here is the secret-flag, not requiredness.
 */
export interface VendorFieldSpec {
  key: string;
  label: string;
  required: boolean;
  /** Whether the field is a secret (masked on read, merge-masked on write). */
  secret: boolean;
}

export const VENDOR_FIELD_SPECS: Readonly<Record<ConnectorVendor, readonly VendorFieldSpec[]>> = {
  gitlab: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "url", label: "URL", required: true, secret: false },
    { key: "token", label: "Token", required: true, secret: true },
  ],
  k8s: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "username", label: "用户名", required: true, secret: false },
    { key: "encrypt", label: "加密凭据", required: true, secret: true },
    { key: "context", label: "Context", required: true, secret: false },
    { key: "namespace", label: "Namespace", required: true, secret: false },
    { key: "ksUrl", label: "KubeSphere URL", required: false, secret: false },
  ],
  nacos: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "url", label: "URL", required: true, secret: false },
    { key: "username", label: "用户名", required: false, secret: false },
    { key: "password", label: "密码", required: false, secret: true },
  ],
  feishu: [
    { key: "name", label: "名称", required: true, secret: false },
    { key: "appId", label: "App ID", required: true, secret: false },
    { key: "appSecret", label: "App Secret", required: true, secret: true },
  ],
};
