// Connect phone (连接手机) — the IM relay surface backed entirely by the
// /v1/phone/* REST routes. De-branded port of the original native IM relay:
// a pluggable IM-provider interface (feishu = the one reference bridge; custom
// = a loopback inbound webhook). Sections, top→bottom:
//   1) Relay header — title + background-automation toggle + live relay status
//      + the inbound webhook bind address.
//   2) Providers — catalog-driven masked-secret cards: list / add / edit /
//      delete / connect / disconnect / test, with the masked-secret round-trip.
//   3) Channels — per selected provider: list / add / edit / delete.
//   4) Members + bindings — per channel: the @-mention roster (refresh, 503 ⇒
//      "transport not connected"), and the thread↔channel binding (bind/unbind
//      + inbound/outbound mirror toggles, observe-only = inbound on/outbound off).
// There is NO QR install flow (supportsQrInstall is always false). Custom
// providers are inbound-only; their outbound 503 is surfaced as a clear notice,
// never faked. Secret fields arrive masked (MASKED_SECRET); we pre-fill the
// sentinel, echo it back unchanged for untouched secret fields, and only send
// plaintext for fields the user actually edited (the backend merge-masks).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api/client.js";
import { useStore } from "../../store/store.js";
import { useNav } from "../../store/nav.js";
import { useTranslation } from "../../i18n/useTranslation.js";
import {
  MASKED_SECRET,
  SECRET_FIELDS_BY_PROVIDER_KIND,
  type ProviderKind,
  type ProviderKindSpec,
  type ImProvider,
  type ImProviderCreateRequest,
  type ImProviderUpdateRequest,
  type ImChannel,
  type ImChannelCreateRequest,
  type ImChannelUpdateRequest,
  type ImMember,
  type ThreadChannelBinding,
  type ChannelKind,
  type PhoneStatus,
  type PhoneConnectionTestResult,
} from "../../api/types.js";

type T = (key: string, vars?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// Shared style tokens (match ConnectorHubView / sibling views).
// ---------------------------------------------------------------------------
const input =
  "w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40";
const btnGhost =
  "rounded-lg border border-ds-border bg-ds-card px-2.5 py-1 text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-50";
const btnPrimary =
  "rounded-full bg-zinc-950 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50";

function ErrorBanner({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null;
  return <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-[13px] text-red-800">{error}</div>;
}

function statusLabel(t: T, status: ImProvider["status"]): string {
  const map: Record<ImProvider["status"], string> = {
    idle: "statusIdle",
    connecting: "statusConnecting",
    ready: "statusReady",
    error: "statusError",
  };
  return t(`phone.${map[status]}`);
}

function statusPill(status: ImProvider["status"]): string {
  const map: Record<ImProvider["status"], string> = {
    idle: "bg-ds-subtle text-ds-muted",
    connecting: "bg-sky-500/15 text-sky-700 dark:text-sky-200",
    ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
    error: "bg-red-500/15 text-red-700 dark:text-red-200",
  };
  return map[status];
}

// ===========================================================================
// Shell
// ===========================================================================
export function ConnectPhoneView(): JSX.Element {
  const { t } = useTranslation();
  const [specs, setSpecs] = useState<ProviderKindSpec[]>([]);
  const [kinds, setKinds] = useState<ProviderKind[]>([]);
  const [providers, setProviders] = useState<ImProvider[]>([]);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [webhook, setWebhook] = useState<{ host: string; port: number } | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // `unavailable` is the relay-not-running (503) state — render an honest notice.
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      const { providers } = await api.listPhoneProviders();
      setProviders(providers);
      setSelectedProviderId((cur) => cur && providers.some((p) => p.id === cur) ? cur : providers[0]?.id ?? null);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setUnavailable(true);
        return;
      }
      setError((e as Error).message);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.phoneStatus();
      setStatus(s);
      setWebhook(s.webhook);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setUnavailable(true);
        return;
      }
      /* status is advisory; don't block the surface on it */
    }
  }, []);

  // Initial load: catalog + providers + status. A 503 from the catalog marks the
  // whole relay unavailable (honest empty state, not a dead surface).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cat = await api.phoneCatalog();
        if (cancelled) return;
        setSpecs(cat.specs);
        setKinds(cat.kinds);
        await refreshProviders();
        await refreshStatus();
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          if (!cancelled) setUnavailable(true);
        } else if (!cancelled) {
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProviders, refreshStatus]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null;

  if (unavailable) {
    return (
      <div className="ds-no-drag flex h-full min-h-0 w-full flex-col bg-ds-main">
        <Header t={t} status={null} webhook={null} onToggleBg={async () => {}} />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="rounded-2xl border border-dashed border-ds-border px-6 py-12 text-center text-[13px] text-ds-faint">
            {t("phone.unavailable")}
          </div>
        </div>
      </div>
    );
  }

  const toggleBackground = async (enabled: boolean): Promise<void> => {
    try {
      const s = await api.setPhoneBackgroundMode(enabled);
      setStatus(s);
      setWebhook(s.webhook);
      await refreshProviders();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="ds-no-drag flex h-full min-h-0 w-full flex-col bg-ds-main">
      <Header t={t} status={status} webhook={webhook} onToggleBg={toggleBackground} />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <ErrorBanner error={error} />

        {loading ? (
          <div className="text-[13px] text-ds-faint">{t("phone.loading")}</div>
        ) : (
          <div className="flex flex-col gap-8">
            <ProvidersSection
              t={t}
              specs={specs}
              kinds={kinds}
              providers={providers}
              selectedId={selectedProviderId}
              onSelect={setSelectedProviderId}
              onError={setError}
              onChanged={async () => {
                await refreshProviders();
                await refreshStatus();
              }}
            />

            {selectedProvider && (
              <ChannelsSection key={selectedProvider.id} t={t} provider={selectedProvider} onError={setError} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Header — title + background-mode toggle + relay status + webhook address
// ===========================================================================
function Header({
  t,
  status,
  webhook,
  onToggleBg,
}: {
  t: T;
  status: PhoneStatus | null;
  webhook: { host: string; port: number } | null;
  onToggleBg: (enabled: boolean) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  // Pad the header when the sidebar is collapsed so AppShell's floating expand
  // button doesn't overlap the title (matches the Workbench pattern).
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);
  const bgOn = status?.backgroundMode ?? false;
  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      await onToggleBg(!bgOn);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ds-drag flex shrink-0 flex-col gap-3 border-b border-ds-border px-6 py-4" style={sidebarCollapsed ? { paddingLeft: 56 } : undefined}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-ds-ink">{t("phone.title")}</h1>
          <p className="text-[13px] text-ds-muted">{t("phone.subtitle")}</p>
        </div>
        {status && (
          <div className="ds-no-drag flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => void toggle()}
              disabled={busy}
              aria-pressed={bgOn}
              className={
                "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition disabled:opacity-50 " +
                (bgOn ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200" : "border border-ds-border bg-ds-card text-ds-ink hover:bg-ds-hover")
              }
              title={t("phone.backgroundModeHint")}
            >
              <span className={"h-2 w-2 rounded-full " + (bgOn ? "bg-emerald-500" : "bg-ds-faint")} />
              {t("phone.backgroundMode")}: {bgOn ? t("phone.backgroundModeOn") : t("phone.backgroundModeOff")}
            </button>
            <div className="flex items-center gap-2 text-[11.5px] text-ds-faint">
              <span>{status.started ? t("phone.relayStarted") : t("phone.relayStopped")}</span>
              <span>· {t("phone.liveTransports", { count: status.liveTransports })}</span>
            </div>
            <div className="text-[11.5px] text-ds-faint">
              {t("phone.webhookAddress")}:{" "}
              {webhook ? (
                <code className="font-mono text-ds-muted">{webhook.host}:{webhook.port}</code>
              ) : (
                t("phone.webhookNone")
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Providers section
// ===========================================================================
function ProvidersSection({
  t,
  specs,
  kinds,
  providers,
  selectedId,
  onSelect,
  onChanged,
  onError,
}: {
  t: T;
  specs: ProviderKindSpec[];
  kinds: ProviderKind[];
  providers: ImProvider[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [creatingKind, setCreatingKind] = useState<ProviderKind | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, PhoneConnectionTestResult>>({});

  const specFor = (kind: ProviderKind): ProviderKindSpec | undefined => specs.find((s) => s.kind === kind);

  const connect = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await api.connectPhoneProvider(id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  const disconnect = async (id: string): Promise<void> => {
    if (!window.confirm(t("phone.disconnectConfirm"))) return;
    setBusyId(id);
    try {
      await api.disconnectPhoneProvider(id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  const test = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      const res = await api.testPhoneProvider(id);
      setTests((p) => ({ ...p, [id]: res }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  const remove = async (id: string): Promise<void> => {
    try {
      await api.deletePhoneProvider(id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ds-ink">{t("phone.providers")}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => {
            const spec = specFor(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setCreatingKind(creatingKind === k ? null : k);
                  setEditingId(null);
                }}
                className={btnGhost}
              >
                {t("phone.addProvider")} · {spec?.displayName ?? k}
              </button>
            );
          })}
        </div>
      </div>

      {creatingKind && specFor(creatingKind) && (
        <ProviderForm
          t={t}
          spec={specFor(creatingKind)!}
          onCancel={() => setCreatingKind(null)}
          onError={onError}
          onSaved={async () => {
            setCreatingKind(null);
            await onChanged();
          }}
        />
      )}

      {providers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
          {t("phone.providersEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((provider) => {
            const spec = specFor(provider.kind);
            if (editingId === provider.id && spec) {
              return (
                <ProviderForm
                  key={provider.id}
                  t={t}
                  spec={spec}
                  provider={provider}
                  onCancel={() => setEditingId(null)}
                  onError={onError}
                  onSaved={async () => {
                    setEditingId(null);
                    await onChanged();
                  }}
                />
              );
            }
            const selected = provider.id === selectedId;
            const tr = tests[provider.id];
            return (
              <div
                key={provider.id}
                className={
                  "rounded-2xl border bg-ds-card/95 px-5 py-4 shadow-sm transition " +
                  (selected ? "border-accent/50 ring-1 ring-accent/30" : "border-ds-border")
                }
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => onSelect(provider.id)}
                    className="min-w-0 flex-1 text-left"
                    title={t("phone.selectProvider")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-ds-ink">{provider.displayName}</span>
                      <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                        {spec?.displayName ?? provider.kind}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill(provider.status)}`}>
                        {statusLabel(t, provider.status)}
                      </span>
                      {provider.enabled && (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-200">
                          {t("phone.bound")}
                        </span>
                      )}
                    </div>
                    {provider.statusMessage && (
                      <div className="mt-1 break-words text-[12px] text-ds-faint">{provider.statusMessage}</div>
                    )}
                    {provider.transport === "webhook" && (
                      <div className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-200">
                        {t("phone.customOutboundUnavailable")}
                      </div>
                    )}
                    {tr && (
                      <div
                        className={
                          "mt-2 rounded-lg px-2.5 py-1.5 text-[12px] " +
                          (tr.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200" : "bg-amber-500/10 text-amber-700 dark:text-amber-200")
                        }
                      >
                        {tr.ok ? t("phone.testOk") : t("phone.testMissing", { fields: tr.missingFields.join(", ") })}
                        {tr.message ? ` ${tr.message}` : ""}
                      </div>
                    )}
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <button type="button" onClick={() => void test(provider.id)} disabled={busyId === provider.id} className={btnGhost}>
                      {t("phone.test")}
                    </button>
                    {provider.enabled ? (
                      <button type="button" onClick={() => void disconnect(provider.id)} disabled={busyId === provider.id} className={btnGhost}>
                        {t("phone.disconnect")}
                      </button>
                    ) : (
                      <button type="button" onClick={() => void connect(provider.id)} disabled={busyId === provider.id} className={btnGhost}>
                        {busyId === provider.id ? t("phone.connecting") : t("phone.connect")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(provider.id);
                        setCreatingKind(null);
                      }}
                      className={btnGhost}
                    >
                      {t("phone.edit")}
                    </button>
                    <button type="button" onClick={() => void remove(provider.id)} className={`${btnGhost} text-red-500`}>
                      {t("phone.delete")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProviderForm({
  t,
  spec,
  provider,
  onSaved,
  onCancel,
  onError,
}: {
  t: T;
  spec: ProviderKindSpec;
  provider?: ImProvider;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const isEdit = !!provider;
  const secretKeys = SECRET_FIELDS_BY_PROVIDER_KIND[spec.kind];
  // Credential field specs (everything except the synthetic `displayName`, which
  // maps to provider.displayName rather than credentials.*).
  const credSpecs = spec.fields.filter((f) => f.key !== "displayName");

  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of credSpecs) {
      const cred = provider?.credentials as Record<string, unknown> | undefined;
      const raw = cred?.[f.key];
      v[f.key] = typeof raw === "string" ? raw : "";
    }
    return v;
  }, [credSpecs, provider]);

  const [displayName, setDisplayName] = useState(provider?.displayName ?? "");
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [domain, setDomain] = useState<"feishu" | "lark">(provider?.credentials?.domain ?? "feishu");
  const [touchedSecrets, setTouchedSecrets] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const setField = (key: string, value: string, secret: boolean): void => {
    setValues((p) => ({ ...p, [key]: value }));
    if (secret) setTouchedSecrets((p) => ({ ...p, [key]: true }));
  };

  const labelFor = (key: string): string => {
    const map: Record<string, string> = {
      appId: "appId",
      appSecret: "appSecret",
      verificationToken: "verificationToken",
      baseUrl: "baseUrl",
    };
    return map[key] ? t(`phone.${map[key]}`) : key;
  };

  const submit = async (): Promise<void> => {
    if (!displayName.trim()) {
      onError(t("phone.displayName"));
      return;
    }
    setBusy(true);
    try {
      // Build credentials. For secret fields on edit: echo MASKED_SECRET back
      // unchanged when the user did not type a new value (backend merge-masks).
      const credentials: Record<string, string> = {};
      for (const f of credSpecs) {
        const raw = values[f.key] ?? "";
        const isSecret = secretKeys.includes(f.key);
        if (isSecret) {
          if (isEdit && !touchedSecrets[f.key]) {
            credentials[f.key] = MASKED_SECRET;
          } else if (raw) {
            credentials[f.key] = raw;
          }
        } else if (raw !== "") {
          credentials[f.key] = raw;
        }
      }
      if (spec.kind === "feishu") credentials.domain = domain;

      if (isEdit && provider) {
        const patch: ImProviderUpdateRequest = { displayName: displayName.trim(), credentials };
        await api.updatePhoneProvider(provider.id, patch);
      } else {
        const body: ImProviderCreateRequest = {
          kind: spec.kind,
          displayName: displayName.trim(),
          transport: spec.transport,
          credentials,
        };
        await api.createPhoneProvider(body);
      }
      await onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasSecret = credSpecs.some((f) => secretKeys.includes(f.key));

  return (
    <div className="mb-4 rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="mb-3 text-[13px] font-semibold text-ds-ink">
        {(isEdit ? t("phone.editProvider") : t("phone.addProvider")) + " · " + spec.displayName}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex flex-col gap-1 md:col-span-1">
          <span className="text-[12px] font-medium text-ds-muted">
            {t("phone.displayName")}
            <span className="text-red-400"> *</span>
          </span>
          <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        {credSpecs.map((f) => {
          const isSecret = secretKeys.includes(f.key);
          return (
            <label key={f.key} className="col-span-2 flex flex-col gap-1 md:col-span-1">
              <span className="text-[12px] font-medium text-ds-muted">
                {labelFor(f.key)}
                {f.required && <span className="text-red-400"> *</span>}
              </span>
              <input
                className={input}
                type={isSecret ? "password" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value, isSecret)}
                autoComplete={isSecret ? "new-password" : "off"}
              />
            </label>
          );
        })}
        {spec.kind === "feishu" && (
          <label className="col-span-2 flex flex-col gap-1 md:col-span-1">
            <span className="text-[12px] font-medium text-ds-muted">{t("phone.domain")}</span>
            <select className={input} value={domain} onChange={(e) => setDomain(e.target.value as "feishu" | "lark")}>
              <option value="feishu">{t("phone.domainFeishu")}</option>
              <option value="lark">{t("phone.domainLark")}</option>
            </select>
          </label>
        )}
      </div>
      {hasSecret && <p className="mt-2 text-[11.5px] text-ds-faint">{t("phone.secretMaskedHint")}</p>}
      {spec.transport === "webhook" && (
        <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-200">{t("phone.customOutboundUnavailable")}</p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          {t("phone.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className={btnPrimary}>
          {t("phone.save")}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Channels section (per selected provider)
// ===========================================================================
function ChannelsSection({ t, provider, onError }: { t: T; provider: ImProvider; onError: (msg: string) => void }): JSX.Element {
  const [channels, setChannels] = useState<ImChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { channels } = await api.listPhoneChannels(provider.id);
      setChannels(channels);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [provider.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deletePhoneChannel(id);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ds-ink">
          {t("phone.channels")} · {provider.displayName}
        </h2>
        <button
          type="button"
          onClick={() => {
            setCreating((v) => !v);
            setEditingId(null);
          }}
          className={btnGhost}
        >
          {creating ? t("phone.cancel") : t("phone.addChannel")}
        </button>
      </div>

      {creating && (
        <ChannelForm
          t={t}
          providerId={provider.id}
          onCancel={() => setCreating(false)}
          onError={onError}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      {loading ? (
        <div className="text-[13px] text-ds-faint">{t("phone.loading")}</div>
      ) : channels.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
          {t("phone.channelsEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {channels.map((channel) =>
            editingId === channel.id ? (
              <ChannelForm
                key={channel.id}
                t={t}
                providerId={provider.id}
                channel={channel}
                onCancel={() => setEditingId(null)}
                onError={onError}
                onSaved={async () => {
                  setEditingId(null);
                  await refresh();
                }}
              />
            ) : (
              <div key={channel.id} className="rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-ds-ink">{channel.name || channel.channelId}</span>
                      <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                        {channel.kind === "p2p" ? t("phone.channelKindP2p") : t("phone.channelKindGroup")}
                      </span>
                      {!channel.enabled && (
                        <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-faint">{t("phone.backgroundModeOff")}</span>
                      )}
                    </div>
                    <div className="mt-1 break-all font-mono text-[12px] text-ds-faint">{channel.channelId}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setExpandedId((id) => (id === channel.id ? null : channel.id))}
                      className={btnGhost}
                    >
                      {expandedId === channel.id ? t("phone.bindings") + " ▴" : t("phone.bindings") + " ▾"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(channel.id);
                        setCreating(false);
                      }}
                      className={btnGhost}
                    >
                      {t("phone.edit")}
                    </button>
                    <button type="button" onClick={() => void remove(channel.id)} className={`${btnGhost} text-red-500`}>
                      {t("phone.delete")}
                    </button>
                  </div>
                </div>
                {expandedId === channel.id && (
                  <div className="mt-4 flex flex-col gap-5 border-t border-ds-border-muted pt-4">
                    <MembersPanel t={t} channel={channel} onError={onError} />
                    <BindingPanel t={t} channel={channel} onError={onError} />
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ChannelForm({
  t,
  providerId,
  channel,
  onSaved,
  onCancel,
  onError,
}: {
  t: T;
  providerId: string;
  channel?: ImChannel;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const isEdit = !!channel;
  const [channelId, setChannelId] = useState(channel?.channelId ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "group");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!isEdit && !channelId.trim()) {
      onError(t("phone.channelId"));
      return;
    }
    setBusy(true);
    try {
      if (isEdit && channel) {
        const patch: ImChannelUpdateRequest = { name: name.trim(), kind, enabled };
        await api.updatePhoneChannel(channel.id, patch);
      } else {
        const body: ImChannelCreateRequest = {
          providerId,
          channelId: channelId.trim(),
          name: name.trim(),
          kind,
          enabled,
        };
        await api.createPhoneChannel(body);
      }
      await onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="mb-3 text-[13px] font-semibold text-ds-ink">{isEdit ? t("phone.editChannel") : t("phone.addChannel")}</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">
            {t("phone.channelId")}
            <span className="text-red-400"> *</span>
          </span>
          <input
            className={input}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={isEdit}
            placeholder="oc_xxxxxxxxxxxxxxxx"
          />
          <span className="text-[11px] text-ds-faint">{t("phone.channelIdHint")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("phone.channelName")}</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">{t("phone.channelKind")}</span>
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)}>
            <option value="group">{t("phone.channelKindGroup")}</option>
            <option value="p2p">{t("phone.channelKindP2p")}</option>
          </select>
        </label>
        <label className="col-span-2 flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-[12px] font-medium text-ds-muted">{t("phone.channelEnabled")}</span>
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          {t("phone.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className={btnPrimary}>
          {t("phone.save")}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Members panel (@-mention roster)
// ===========================================================================
function MembersPanel({ t, channel, onError }: { t: T; channel: ImChannel; onError: (msg: string) => void }): JSX.Element {
  const [members, setMembers] = useState<ImMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // The members/refresh route 503s when the transport is down — surface that as
  // a clear notice rather than a generic error.
  const [transportDown, setTransportDown] = useState(false);

  const load = useCallback(async () => {
    try {
      const { members } = await api.listPhoneMembers(channel.id);
      setMembers(members);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [channel.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setTransportDown(false);
    try {
      const { members } = await api.refreshPhoneMembers(channel.id);
      setMembers(members);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setTransportDown(true);
      } else {
        onError((e as Error).message);
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ds-ink">
          {t("phone.members")} {members.length > 0 && <span className="text-ds-faint">({members.length})</span>}
        </span>
        <button type="button" onClick={() => void refresh()} disabled={refreshing} className={btnGhost}>
          {refreshing ? t("phone.loading") : t("phone.refreshMembers")}
        </button>
      </div>
      {transportDown && (
        <div className="mb-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-700 dark:text-amber-200">
          {t("phone.membersTransportDown")}
        </div>
      )}
      {loading ? (
        <div className="text-[12.5px] text-ds-faint">{t("phone.loading")}</div>
      ) : members.length === 0 ? (
        <div className="text-[12.5px] text-ds-faint">{t("phone.membersEmpty")}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {members.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-main/30 px-2.5 py-1 text-[12px] text-ds-ink"
              title={m.providerMemberId}
            >
              {m.avatar && <img src={m.avatar} alt="" className="h-4 w-4 rounded-full object-cover" />}
              {m.name || m.providerMemberId}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Binding panel (thread ↔ channel)
// ===========================================================================
function BindingPanel({ t, channel, onError }: { t: T; channel: ImChannel; onError: (msg: string) => void }): JSX.Element {
  const threads = useStore((s) => s.threads);
  const [binding, setBinding] = useState<ThreadChannelBinding | null>(null);
  const [loading, setLoading] = useState(true);
  // Draft form state (also used to edit an existing binding's flags).
  const [threadId, setThreadId] = useState("");
  const [label, setLabel] = useState("");
  const [mirrorInbound, setMirrorInbound] = useState(true);
  const [mirrorOutbound, setMirrorOutbound] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { bindings } = await api.listPhoneBindings({ channelId: channel.id });
      const b = bindings[0] ?? null;
      setBinding(b);
      if (b) {
        setThreadId(b.threadId);
        setLabel(b.label);
        setMirrorInbound(b.mirrorInbound);
        setMirrorOutbound(b.mirrorOutbound);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [channel.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (!threadId) {
      onError(t("phone.selectThread"));
      return;
    }
    setBusy(true);
    try {
      await api.bindPhoneChannel({
        threadId,
        channelId: channel.id,
        label: label.trim(),
        mirrorInbound,
        mirrorOutbound,
      });
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (): Promise<void> => {
    if (!window.confirm(t("phone.unbindConfirm"))) return;
    setBusy(true);
    try {
      await api.unbindPhoneChannel(channel.id);
      setBinding(null);
      setThreadId("");
      setLabel("");
      setMirrorInbound(true);
      setMirrorOutbound(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setObserve = (): void => {
    setMirrorInbound(true);
    setMirrorOutbound(false);
  };

  if (loading) {
    return <div className="text-[12.5px] text-ds-faint">{t("phone.loading")}</div>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-ds-ink">{t("phone.bindings")}</span>
        {binding && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200">
            {t("phone.bound")}
          </span>
        )}
      </div>

      {threads.length === 0 ? (
        <div className="text-[12.5px] text-ds-faint">{t("phone.noThreads")}</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ds-muted">{t("phone.bindThread")}</span>
            <select className={input} value={threadId} onChange={(e) => setThreadId(e.target.value)}>
              <option value="">{t("phone.selectThread")}</option>
              {threads.map((th) => (
                <option key={th.id} value={th.id}>
                  {th.title || th.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ds-muted">{t("phone.label")}</span>
            <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={mirrorInbound} onChange={(e) => setMirrorInbound(e.target.checked)} />
            <span className="text-[12.5px] text-ds-ink">{t("phone.mirrorInbound")}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={mirrorOutbound} onChange={(e) => setMirrorOutbound(e.target.checked)} />
            <span className="text-[12.5px] text-ds-ink">{t("phone.mirrorOutbound")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={setObserve} className={btnGhost} title={t("phone.observeModeHint")}>
              {t("phone.observeMode")}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {binding && (
                <button type="button" onClick={() => void unbind()} disabled={busy} className={`${btnGhost} text-red-500`}>
                  {t("phone.unbind")}
                </button>
              )}
              <button type="button" onClick={() => void save()} disabled={busy} className={btnPrimary}>
                {binding ? t("phone.rebind") : t("phone.bindThread")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
