// Connector hub (连接中心) — the real 3-tab surface backed entirely by the
// /v1/connectors/* REST routes (no MCP diagnostics, no localStorage). Three tabs:
//   1) Credential profiles (连接配置) — per-vendor credential cards: list / add /
//      edit / delete / set-default / check, with masked-secret round-trip.
//   2) Project spaces (项目空间) — space list + editor + per-vendor profile
//      bindings + external resource links (per-kind ref payload).
//   3) Activity (活动流) — event feed with space/status filters + status
//      transitions (seen / actioned / dismissed).
// Secret fields arrive masked (MASKED_SECRET sentinel); we pre-fill the sentinel,
// echo it back unchanged for untouched secret fields, and only send plaintext for
// fields the user actually edited (the backend merge-masks on write).
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { useTranslation } from "../../i18n/useTranslation.js";
import { useNav } from "../../store/nav.js";
import {
  CONNECTOR_VENDORS,
  BINDABLE_VENDORS,
  MASKED_SECRET,
  VENDOR_FIELD_SPECS,
  PROJECT_TYPES,
  LINK_KINDS,
  DEFAULT_LINK_REF,
  EVENT_STATUS_FILTERS,
  type ConnectorVendor,
  type BindableVendor,
  type ConnectorProfile,
  type ConnectorProfileCreateRequest,
  type ProjectSpace,
  type ProjectSpaceCreateRequest,
  type ExternalLink,
  type ActivityEvent,
  type EventStatus,
  type EventStatusFilter,
  type LinkKind,
  type ProjectType,
  type HealthCheckResult,
} from "../../api/types.js";

type Tab = "profiles" | "spaces" | "events";

// ---------------------------------------------------------------------------
// Shared style tokens (match ScheduleTasksView / sibling views).
// ---------------------------------------------------------------------------
const input =
  "w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40";
const btnGhost =
  "rounded-lg border border-ds-border bg-ds-card px-2.5 py-1 text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover";
const btnPrimary =
  "rounded-full bg-zinc-950 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50";

function vendorLabel(t: (k: string) => string, vendor: ConnectorVendor): string {
  const map: Record<ConnectorVendor, string> = {
    gitlab: "vendorGitlab",
    k8s: "vendorK8s",
    nacos: "vendorNacos",
    feishu: "vendorFeishu",
  };
  return t(`connectors.${map[vendor]}`);
}

function linkKindLabel(t: (k: string) => string, kind: LinkKind): string {
  const map: Record<LinkKind, string> = {
    gitlab_project: "linkKindGitlabProject",
    k8s_workload: "linkKindK8sWorkload",
    feishu_chat: "linkKindFeishuChat",
    feishu_bitable: "linkKindFeishuBitable",
    nacos_config: "linkKindNacosConfig",
  };
  return t(`connectors.${map[kind]}`);
}

function statusLabel(t: (k: string) => string, status: EventStatus): string {
  const map: Record<EventStatus, string> = {
    new: "statusNew",
    seen: "statusSeen",
    actioned: "statusActioned",
    dismissed: "statusDismissed",
  };
  return t(`connectors.${map[status]}`);
}

function filterLabel(t: (k: string) => string, f: EventStatusFilter): string {
  return f === "all" ? t("connectors.filterAll") : statusLabel(t, f);
}

// ===========================================================================
// Shell
// ===========================================================================
export function ConnectorHubView(): JSX.Element {
  const { t } = useTranslation();
  // Pad the header when the sidebar is collapsed so AppShell's floating expand
  // button doesn't overlap the title (matches the Workbench pattern).
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);
  const [tab, setTab] = useState<Tab>("profiles");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "profiles", label: t("connectors.tabProfiles") },
    { id: "spaces", label: t("connectors.tabSpaces") },
    { id: "events", label: t("connectors.tabEvents") },
  ];

  return (
    <div className="ds-no-drag flex h-full min-h-0 w-full flex-col bg-ds-main">
      <div className="ds-drag flex shrink-0 flex-col gap-3 border-b border-ds-border px-6 py-4" style={sidebarCollapsed ? { paddingLeft: 56 } : undefined}>
        <div>
          <h1 className="text-[18px] font-semibold text-ds-ink">{t("connectors.title")}</h1>
          <p className="text-[13px] text-ds-muted">{t("connectors.subtitle")}</p>
        </div>
        <div className="ds-no-drag flex items-center gap-1.5">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={
                "rounded-full px-3.5 py-1.5 text-[13px] font-medium transition " +
                (tab === tb.id
                  ? "bg-zinc-950 text-white"
                  : "border border-ds-border bg-ds-card text-ds-ink hover:bg-ds-hover")
              }
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {tab === "profiles" && <ProfilesTab t={t} />}
        {tab === "spaces" && <SpacesTab t={t} />}
        {tab === "events" && <EventsTab t={t} />}
      </div>
    </div>
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function ErrorBanner({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null;
  return <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-[13px] text-red-800">{error}</div>;
}

// ===========================================================================
// Tab 1 — Credential profiles (连接配置)
// ===========================================================================
function ProfilesTab({ t }: { t: T }): JSX.Element {
  const [profiles, setProfiles] = useState<ConnectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<ConnectorVendor | "">("");
  const [creating, setCreating] = useState<ConnectorVendor | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, HealthCheckResult>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { profiles } = await api.listConnectorProfiles(vendorFilter || undefined);
      setProfiles(profiles);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vendorFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteConnectorProfile(id);
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };
  const makeDefault = async (id: string): Promise<void> => {
    try {
      await api.setDefaultConnectorProfile(id);
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };
  const check = async (id: string): Promise<void> => {
    setCheckingId(id);
    try {
      const res = await api.checkConnectorProfile(id);
      setChecks((p) => ({ ...p, [id]: res }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCheckingId(null);
    }
  };

  // Group profiles by vendor (in the contract vendor order).
  const byVendor = CONNECTOR_VENDORS.map((v) => ({ vendor: v, items: profiles.filter((p) => p.vendor === v) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div>
      <ErrorBanner error={error} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.vendorFilter")}</span>
          <select
            className="rounded-lg border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value as ConnectorVendor | "")}
          >
            <option value="">{t("connectors.allVendors")}</option>
            {CONNECTOR_VENDORS.map((v) => (
              <option key={v} value={v}>
                {vendorLabel(t, v)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {CONNECTOR_VENDORS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setCreating(creating === v ? null : v);
                setEditing(null);
              }}
              className={btnGhost}
            >
              {t("connectors.newProfile")} · {vendorLabel(t, v)}
            </button>
          ))}
        </div>
      </div>

      {creating && (
        <ProfileForm
          t={t}
          vendor={creating}
          onCancel={() => setCreating(null)}
          onError={setError}
          onSaved={() => {
            setCreating(null);
            void refresh();
          }}
        />
      )}

      {loading ? (
        <div className="text-[13px] text-ds-faint">{t("connectors.loading")}</div>
      ) : profiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
          {t("connectors.profilesEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {byVendor.map((group) => (
            <div key={group.vendor}>
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ds-faint">
                {vendorLabel(t, group.vendor)}
              </div>
              <div className="flex flex-col gap-3">
                {group.items.map((profile) =>
                  editing === profile.id ? (
                    <ProfileForm
                      key={profile.id}
                      t={t}
                      vendor={profile.vendor}
                      profile={profile}
                      onCancel={() => setEditing(null)}
                      onError={setError}
                      onSaved={() => {
                        setEditing(null);
                        void refresh();
                      }}
                    />
                  ) : (
                    <div key={profile.id} className="rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[15px] font-semibold text-ds-ink">{profile.name}</span>
                            {profile.isDefault && (
                              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-200">
                                {t("connectors.defaultBadge")}
                              </span>
                            )}
                          </div>
                          {profile.url && (
                            <div className="mt-1 break-all font-mono text-[12px] text-ds-faint">{profile.url}</div>
                          )}
                          {checks[profile.id] && (
                            <div
                              className={
                                "mt-2 rounded-lg px-2.5 py-1.5 text-[12px] " +
                                (checks[profile.id].ok
                                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                                  : "bg-amber-500/10 text-amber-700 dark:text-amber-200")
                              }
                            >
                              {checks[profile.id].ok
                                ? t("connectors.checkOk")
                                : t("connectors.checkMissing", { fields: checks[profile.id].missingFields.join(", ") })}
                              {checks[profile.id].message ? ` ${checks[profile.id].message}` : ""}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void check(profile.id)}
                            disabled={checkingId === profile.id}
                            className={btnGhost}
                          >
                            {checkingId === profile.id ? t("connectors.checking") : t("connectors.check")}
                          </button>
                          {!profile.isDefault && (
                            <button type="button" onClick={() => void makeDefault(profile.id)} className={btnGhost}>
                              {t("connectors.setDefault")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(profile.id);
                              setCreating(null);
                            }}
                            className={btnGhost}
                          >
                            {t("connectors.editProfile")}
                          </button>
                          <button type="button" onClick={() => void remove(profile.id)} className={`${btnGhost} text-red-500`}>
                            {t("connectors.deleteProfile")}
                          </button>
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileForm({
  t,
  vendor,
  profile,
  onSaved,
  onCancel,
  onError,
}: {
  t: T;
  vendor: ConnectorVendor;
  profile?: ConnectorProfile;
  onSaved: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const specs = VENDOR_FIELD_SPECS[vendor];
  const isEdit = !!profile;

  // Initialise field values from the profile (or empty). Secret fields pre-fill
  // with whatever the backend returned (already the MASKED_SECRET sentinel when
  // stored), and start empty on create.
  const initial: Record<string, string> = {};
  for (const spec of specs) {
    const v = profile ? ((profile as unknown as Record<string, unknown>)[spec.key] ?? "") : "";
    initial[spec.key] = typeof v === "string" ? v : String(v ?? "");
  }
  const [values, setValues] = useState<Record<string, string>>(initial);
  // Track which secret fields the user actually edited; only those send plaintext.
  const [touchedSecrets, setTouchedSecrets] = useState<Record<string, boolean>>({});
  // Feishu-only shared-credentials toggle (not in VENDOR_FIELD_SPECS).
  const [useShared, setUseShared] = useState<boolean>(profile?.useSharedCredentials ?? false);
  const [busy, setBusy] = useState(false);

  const setField = (key: string, value: string, secret: boolean): void => {
    setValues((p) => ({ ...p, [key]: value }));
    if (secret) setTouchedSecrets((p) => ({ ...p, [key]: true }));
  };

  const labelFor = (spec: { key: string }): string => {
    const map: Record<string, string> = {
      name: "fieldName",
      url: "fieldUrl",
      token: "fieldToken",
      username: "fieldUsername",
      encrypt: "fieldEncrypt",
      context: "fieldContext",
      namespace: "fieldNamespace",
      ksUrl: "fieldKsUrl",
      password: "fieldPassword",
      appId: "fieldAppId",
      appSecret: "fieldAppSecret",
    };
    return map[spec.key] ? t(`connectors.${map[spec.key]}`) : spec.key;
  };

  const submit = async (): Promise<void> => {
    const nameSpec = specs.find((s) => s.key === "name");
    if (nameSpec && !(values.name || "").trim()) {
      onError(t("connectors.fieldName"));
      return;
    }
    setBusy(true);
    try {
      // Build the request body. For secret fields: on edit, echo MASKED_SECRET
      // unchanged when the user did not type a new value (backend merge-masks).
      const body: Record<string, unknown> = {};
      for (const spec of specs) {
        if (spec.key === "name") continue; // handled below
        const raw = values[spec.key] ?? "";
        if (spec.secret) {
          if (isEdit && !touchedSecrets[spec.key]) {
            // Untouched stored secret → send the sentinel back unchanged.
            body[spec.key] = profile ? (profile as unknown as Record<string, unknown>)[spec.key] ?? MASKED_SECRET : MASKED_SECRET;
          } else if (raw) {
            body[spec.key] = raw;
          }
        } else if (raw !== "") {
          body[spec.key] = raw;
        }
      }
      body.name = (values.name || "").trim();
      if (vendor === "feishu") body.useSharedCredentials = useShared;

      if (isEdit && profile) {
        await api.updateConnectorProfile(profile.id, body as Partial<ConnectorProfileCreateRequest>);
      } else {
        await api.createConnectorProfile({ vendor, name: body.name as string, ...(body as object) } as ConnectorProfileCreateRequest);
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasSecret = specs.some((s) => s.secret);

  return (
    <div className="mb-4 rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="mb-3 text-[13px] font-semibold text-ds-ink">
        {(isEdit ? t("connectors.editProfile") : t("connectors.newProfile")) + " · " + vendorLabel(t, vendor)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {specs.map((spec) => (
          <label key={spec.key} className="col-span-2 flex flex-col gap-1 md:col-span-1">
            <span className="text-[12px] font-medium text-ds-muted">
              {labelFor(spec)}
              {spec.required && <span className="text-red-400"> *</span>}
            </span>
            <input
              className={input}
              type={spec.secret ? "password" : "text"}
              value={values[spec.key] ?? ""}
              onChange={(e) => setField(spec.key, e.target.value, spec.secret)}
              autoComplete={spec.secret ? "new-password" : "off"}
            />
          </label>
        ))}
        {vendor === "feishu" && (
          <label className="col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={useShared} onChange={(e) => setUseShared(e.target.checked)} />
            <span className="text-[12px] font-medium text-ds-muted">{t("connectors.fieldUseShared")}</span>
          </label>
        )}
      </div>
      {hasSecret && <p className="mt-2 text-[11.5px] text-ds-faint">{t("connectors.secretMaskedHint")}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          {t("connectors.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className={btnPrimary}>
          {t("connectors.save")}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 2 — Project spaces (项目空间)
// ===========================================================================
function SpacesTab({ t }: { t: T }): JSX.Element {
  const [spaces, setSpaces] = useState<ProjectSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const { spaces } = await api.listConnectorSpaces();
      setSpaces(spaces);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteConnectorSpace(id);
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };

  return (
    <div>
      <ErrorBanner error={error} />

      <div className="mb-4 flex justify-end">
        <button type="button" onClick={() => setCreating((v) => !v)} className={btnGhost}>
          {creating ? t("connectors.cancel") : t("connectors.newSpace")}
        </button>
      </div>

      {creating && (
        <SpaceForm
          t={t}
          onCancel={() => setCreating(false)}
          onError={setError}
          onSaved={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {loading ? (
        <div className="text-[13px] text-ds-faint">{t("connectors.loading")}</div>
      ) : spaces.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
          {t("connectors.spacesEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {spaces.map((space) =>
            editing === space.id ? (
              <SpaceForm
                key={space.id}
                t={t}
                space={space}
                onCancel={() => setEditing(null)}
                onError={setError}
                onSaved={() => {
                  setEditing(null);
                  void refresh();
                }}
              />
            ) : (
              <div key={space.id} className="rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-ds-ink">{space.displayName || space.name}</span>
                      <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-faint">{space.projectType}</span>
                    </div>
                    {space.localRepoPath && (
                      <div className="mt-1 break-all font-mono text-[12px] text-ds-faint">{space.localRepoPath}</div>
                    )}
                    {space.branch && <div className="mt-0.5 text-[12px] text-ds-muted">branch: {space.branch}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setExpanded((p) => ({ ...p, [space.id]: !p[space.id] }))}
                      className={btnGhost}
                    >
                      {expanded[space.id] ? t("connectors.bindings") + " ▴" : t("connectors.bindings") + " ▾"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(space.id);
                        setCreating(false);
                      }}
                      className={btnGhost}
                    >
                      {t("connectors.editSpace")}
                    </button>
                    <button type="button" onClick={() => void remove(space.id)} className={`${btnGhost} text-red-500`}>
                      {t("connectors.deleteSpace")}
                    </button>
                  </div>
                </div>
                {expanded[space.id] && (
                  <div className="mt-4 flex flex-col gap-4 border-t border-ds-border-muted pt-4">
                    <SpaceBindings t={t} space={space} onChanged={refresh} onError={setError} />
                    <SpaceLinks t={t} space={space} onError={setError} />
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  generic: "Generic",
  mr: "Merge request",
  diagnose: "Diagnose",
  k8s: "Kubernetes",
};

function SpaceForm({
  t,
  space,
  onSaved,
  onCancel,
  onError,
}: {
  t: T;
  space?: ProjectSpace;
  onSaved: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const isEdit = !!space;
  const [name, setName] = useState(space?.name ?? "");
  const [displayName, setDisplayName] = useState(space?.displayName ?? "");
  const [localRepoPath, setLocalRepoPath] = useState(space?.localRepoPath ?? "");
  const [projectType, setProjectType] = useState<ProjectType>(space?.projectType ?? "generic");
  const [branch, setBranch] = useState(space?.branch ?? "");
  const [shipCommand, setShipCommand] = useState(space?.shipCommand ?? "");
  const [commitMsgFlag, setCommitMsgFlag] = useState(space?.commitMsgFlag ?? "");
  const [envVars, setEnvVars] = useState(space?.envVars ?? "");
  const [extraRepoPaths, setExtraRepoPaths] = useState(space?.extraRepoPaths ?? "");
  const [systemPrompt, setSystemPrompt] = useState(space?.systemPrompt ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      onError(t("connectors.spaceName"));
      return;
    }
    setBusy(true);
    try {
      const body: ProjectSpaceCreateRequest = {
        name: name.trim(),
        displayName: displayName.trim(),
        localRepoPath: localRepoPath.trim(),
        projectType,
        branch: branch.trim(),
        shipCommand: shipCommand.trim(),
        commitMsgFlag: commitMsgFlag.trim(),
        envVars: envVars.trim(),
        extraRepoPaths: extraRepoPaths.trim(),
        systemPrompt,
      };
      if (isEdit && space) {
        await api.updateConnectorSpace(space.id, body);
      } else {
        await api.createConnectorSpace(body);
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="mb-3 text-[13px] font-semibold text-ds-ink">{isEdit ? t("connectors.editSpace") : t("connectors.newSpace")}</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">
            {t("connectors.spaceName")}
            <span className="text-red-400"> *</span>
          </span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceDisplayName")}</span>
          <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceLocalRepoPath")}</span>
          <input className={input} value={localRepoPath} onChange={(e) => setLocalRepoPath(e.target.value)} placeholder="/absolute/path" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceProjectType")}</span>
          <select className={input} value={projectType} onChange={(e) => setProjectType(e.target.value as ProjectType)}>
            {PROJECT_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {PROJECT_TYPE_LABEL[pt]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceBranch")}</span>
          <input className={input} value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceShipCommand")}</span>
          <input className={input} value={shipCommand} onChange={(e) => setShipCommand(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceCommitFlag")}</span>
          <input className={input} value={commitMsgFlag} onChange={(e) => setCommitMsgFlag(e.target.value)} />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceEnvVars")}</span>
          <textarea className={`${input} font-mono`} rows={2} value={envVars} onChange={(e) => setEnvVars(e.target.value)} placeholder='{"KEY":"value"}' />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceExtraRepoPaths")}</span>
          <textarea className={`${input} font-mono`} rows={2} value={extraRepoPaths} onChange={(e) => setExtraRepoPaths(e.target.value)} placeholder='["/path/a","/path/b"]' />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.spaceSystemPrompt")}</span>
          <textarea className={input} rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          {t("connectors.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className={btnPrimary}>
          {t("connectors.save")}
        </button>
      </div>
    </div>
  );
}

function SpaceBindings({
  t,
  space,
  onChanged,
  onError,
}: {
  t: T;
  space: ProjectSpace;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}): JSX.Element {
  // Per-bindable-vendor profile options, loaded lazily.
  const [options, setOptions] = useState<Partial<Record<BindableVendor, ConnectorProfile[]>>>({});
  const [picks, setPicks] = useState<Partial<Record<BindableVendor, string>>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Partial<Record<BindableVendor, ConnectorProfile[]>> = {};
      for (const v of BINDABLE_VENDORS) {
        try {
          const { profiles } = await api.listConnectorProfiles(v);
          next[v] = profiles;
        } catch {
          next[v] = [];
        }
      }
      if (!cancelled) setOptions(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bind = async (vendor: BindableVendor): Promise<void> => {
    const profileId = picks[vendor];
    if (!profileId) return;
    try {
      await api.bindConnectorProfile(space.id, vendor, profileId);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const unbind = async (vendor: BindableVendor): Promise<void> => {
    try {
      await api.unbindConnectorProfile(space.id, vendor);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const nameOf = (vendor: BindableVendor, id?: string): string => {
    if (!id) return t("connectors.notBound");
    const found = options[vendor]?.find((p) => p.id === id);
    return found ? found.name : id;
  };

  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-ds-ink">{t("connectors.bindings")}</div>
      <div className="flex flex-col gap-2">
        {BINDABLE_VENDORS.map((vendor) => {
          const boundId = space.bindings?.[vendor];
          return (
            <div key={vendor} className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[12.5px] font-medium text-ds-muted">{vendorLabel(t, vendor)}</span>
              {boundId ? (
                <>
                  <span className="text-[12.5px] text-ds-ink">{nameOf(vendor, boundId)}</span>
                  <button type="button" onClick={() => void unbind(vendor)} className={`${btnGhost} text-red-500`}>
                    {t("connectors.unbind")}
                  </button>
                </>
              ) : (
                <>
                  <span className="text-[12.5px] text-ds-faint">{t("connectors.notBound")}</span>
                  <select
                    className="rounded-lg border border-ds-border bg-ds-card px-2.5 py-1 text-[12.5px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
                    value={picks[vendor] ?? ""}
                    onChange={(e) => setPicks((p) => ({ ...p, [vendor]: e.target.value }))}
                  >
                    <option value="">{t("connectors.bindSelectPlaceholder")}</option>
                    {(options[vendor] ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.isDefault ? ` (${t("connectors.defaultBadge")})` : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void bind(vendor)} disabled={!picks[vendor]} className={btnGhost}>
                    {t("connectors.bind")}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpaceLinks({ t, space, onError }: { t: T; space: ProjectSpace; onError: (msg: string) => void }): JSX.Element {
  const [links, setLinks] = useState<ExternalLink[]>([]);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<LinkKind>(LINK_KINDS[0]);
  const [ref, setRef] = useState<string>(DEFAULT_LINK_REF[LINK_KINDS[0]]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { links } = await api.listConnectorLinks(space.id);
      setLinks(links);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [space.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.createConnectorLink({ spaceId: space.id, kind, ref });
      setAdding(false);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteConnectorLink(id);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ds-ink">{t("connectors.tabLinks")}</span>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setKind(LINK_KINDS[0]);
            setRef(DEFAULT_LINK_REF[LINK_KINDS[0]]);
          }}
          className={btnGhost}
        >
          {adding ? t("connectors.cancel") : t("connectors.newLink")}
        </button>
      </div>

      {adding && (
        <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-main/40 px-3 py-3">
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ds-muted">{t("connectors.linkKind")}</span>
              <select
                className={input}
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as LinkKind;
                  setKind(k);
                  setRef(DEFAULT_LINK_REF[k]);
                }}
              >
                {LINK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {linkKindLabel(t, k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ds-muted">{t("connectors.linkRef")}</span>
              <textarea className={`${input} font-mono`} rows={3} value={ref} onChange={(e) => setRef(e.target.value)} />
            </label>
            <div className="flex justify-end">
              <button type="button" onClick={() => void create()} disabled={busy} className={btnPrimary}>
                {t("connectors.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {links.length === 0 ? (
        <div className="text-[12.5px] text-ds-faint">{t("connectors.linksEmpty")}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {links.map((link) => (
            <div key={link.id} className="flex items-start gap-2 rounded-lg border border-ds-border-muted bg-ds-main/30 px-3 py-2">
              <span className="shrink-0 rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">{linkKindLabel(t, link.kind)}</span>
              <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-ds-faint">{link.ref}</code>
              <button type="button" onClick={() => void remove(link.id)} className={`${btnGhost} shrink-0 text-red-500`}>
                {t("connectors.deleteLink")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Tab 3 — Activity (活动流)
// ===========================================================================
function EventsTab({ t }: { t: T }): JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [spaces, setSpaces] = useState<ProjectSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<EventStatusFilter>("all");
  const [spaceFilter, setSpaceFilter] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const { events } = await api.listConnectorEvents({
        status: statusFilter,
        ...(spaceFilter ? { spaceId: spaceFilter } : {}),
      });
      setEvents(events);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, spaceFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      try {
        const { spaces } = await api.listConnectorSpaces();
        setSpaces(spaces);
      } catch {
        /* space filter is optional */
      }
    })();
  }, []);

  const setStatus = async (id: string, status: EventStatus): Promise<void> => {
    try {
      await api.setConnectorEventStatus(id, status);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const spaceName = (id: string): string => {
    const s = spaces.find((x) => x.id === id);
    return s ? s.displayName || s.name : id;
  };

  return (
    <div>
      <ErrorBanner error={error} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.eventFilterStatus")}</span>
          <select
            className="rounded-lg border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EventStatusFilter)}
          >
            {EVENT_STATUS_FILTERS.map((f) => (
              <option key={f} value={f}>
                {filterLabel(t, f)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-ds-muted">{t("connectors.eventFilterSpace")}</span>
          <select
            className="rounded-lg border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            value={spaceFilter}
            onChange={(e) => setSpaceFilter(e.target.value)}
          >
            <option value="">{t("connectors.eventAllSpaces")}</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName || s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="text-[13px] text-ds-faint">{t("connectors.loading")}</div>
      ) : events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
          {t("connectors.eventsEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {events.map((event) => (
            <EventRow key={event.id} t={t} event={event} spaceName={spaceName} onSetStatus={setStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
  t,
  event,
  spaceName,
  onSetStatus,
}: {
  t: T;
  event: ActivityEvent;
  spaceName: (id: string) => string;
  onSetStatus: (id: string, status: EventStatus) => Promise<void>;
}): JSX.Element {
  let title = "";
  let message = "";
  try {
    const parsed = JSON.parse(event.payload || "{}") as { title?: unknown; message?: unknown };
    if (typeof parsed.title === "string") title = parsed.title;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    message = event.payload || "";
  }

  const statusPill: Record<EventStatus, string> = {
    new: "bg-sky-500/15 text-sky-700 dark:text-sky-200",
    seen: "bg-ds-subtle text-ds-muted",
    actioned: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
    dismissed: "bg-ds-subtle text-ds-faint",
  };

  return (
    <div className="rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {title && <span className="text-[14px] font-semibold text-ds-ink">{title}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill[event.status]}`}>
              {statusLabel(t, event.status)}
            </span>
          </div>
          {message && <div className="mt-1 text-[13px] text-ds-muted">{message}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ds-faint">
            {event.source && <span>{event.source}</span>}
            {event.type && <span>· {event.type}</span>}
            {event.spaceId && <span>· {spaceName(event.spaceId)}</span>}
            <span>· {fmt(event.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {event.status !== "seen" && (
            <button type="button" onClick={() => void onSetStatus(event.id, "seen")} className={btnGhost}>
              {t("connectors.markSeen")}
            </button>
          )}
          {event.status !== "actioned" && (
            <button type="button" onClick={() => void onSetStatus(event.id, "actioned")} className={btnGhost}>
              {t("connectors.markActioned")}
            </button>
          )}
          {event.status !== "dismissed" && (
            <button type="button" onClick={() => void onSetStatus(event.id, "dismissed")} className={`${btnGhost} text-red-500`}>
              {t("connectors.markDismissed")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
