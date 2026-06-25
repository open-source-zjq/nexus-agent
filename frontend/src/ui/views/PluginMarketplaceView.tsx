// PluginMarketplace — a real MCP / Skill marketplace (T4.6).
//
// Everything here is wired to real state: the "catalog" lists installable MCP
// server templates (the backend's built-in sidecars + a couple of generic
// public stdio templates); "Install" appends an entry to
// config.capabilities.mcp.servers and persists it via saveConfig(); "Remove"
// and "Edit" rewrite that same array; per-entry status is derived from the live
// GET /v1/mcp diagnostics. There are NO dead clicks: every action either writes
// config (saveConfig) or deep-links to the relevant Settings section.
//
// Secrets in MCP server env are masked on the read path (redactConfig sends
// "********") and merged back on save (mergeMaskedSecrets), so the masked
// placeholder round-trips untouched — we never clobber a real secret.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store/store.js";
import { useNav } from "../../store/nav.js";
import type { McpServerConfig, McpServerStatus, NexusConfig, SkillValidationError } from "../../api/types.js";

/**
 * Coerce a skill validation error to a display string. The backend sends objects
 * ({ root, message }); rendering an object directly in a JSX child slot throws
 * "Objects are not valid as a React child" and blanks the whole Skills tab, so
 * everything that reaches a child slot must go through here.
 */
function validationErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return JSON.stringify(err);
}

const ACCENT = "#0088ff";

// --- catalog ---------------------------------------------------------------
// Curated, installable MCP server templates. The three first-party sidecars
// mirror backend/src/cli/serve.ts withBuiltinMcpSidecars (which the backend
// auto-injects when MCP is enabled + creds present); installing them here makes
// them explicit user-config entries the user owns. The generic templates use a
// clearly-templated command/args the user is expected to edit before it runs.

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** First-party sidecars the backend can auto-inject; the rest are templates. */
  builtin: boolean;
  /** Env keys whose presence the backend uses to gate the built-in sidecar. */
  requires?: string[];
  /** The config.capabilities.mcp.servers entry this entry would add. */
  template: McpServerConfig;
}

const MCP_CATALOG: CatalogEntry[] = [
  {
    id: "nexus-schedule",
    name: "Nexus Schedule",
    description:
      "First-party sidecar. Lets the agent create / list / run scheduled tasks through the runtime's schedule control-plane. Auto-injected by the backend when MCP is enabled.",
    builtin: true,
    template: {
      id: "nexus-schedule",
      command: "nexus-schedule",
      args: ["--gui-schedule-mcp-server"],
      trusted: true,
    },
  },
  {
    id: "nexus-gitlab",
    name: "Nexus GitLab",
    description:
      "First-party sidecar exposing gitlab_* tools (merge requests, pipelines, repos). The backend auto-injects it when GITLAB_URL + GITLAB_TOKEN are present in the serve environment.",
    builtin: true,
    requires: ["GITLAB_URL", "GITLAB_TOKEN"],
    template: {
      id: "nexus-gitlab",
      command: "nexus-gitlab",
      args: ["--gui-gitlab-mcp-server"],
      env: { GITLAB_URL: "", GITLAB_TOKEN: "" },
      trusted: true,
    },
  },
  {
    id: "nexus-k8s",
    name: "Nexus K8s / KubeSphere",
    description:
      "First-party sidecar exposing k8s_* / ks_* / nacos_* tools. The backend auto-injects it when a KubeSphere / K8s / Nacos signal is present in the serve environment.",
    builtin: true,
    requires: ["KUBESPHERE_URL", "K8S_USERNAME", "K8S_CONTEXT", "NACOS_URL"],
    template: {
      id: "nexus-k8s",
      command: "nexus-k8s",
      args: ["--gui-k8s-mcp-server"],
      trusted: true,
    },
  },
  {
    id: "filesystem",
    name: "Filesystem (template)",
    description:
      "Generic public MCP server template. Exposes file read/write tools over a directory. Edit the path argument before use.",
    builtin: false,
    template: {
      id: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      trusted: false,
    },
  },
  {
    id: "git",
    name: "Git (template)",
    description:
      "Generic public MCP server template. Exposes git repository tools. Edit the repository path before use.",
    builtin: false,
    template: {
      id: "git",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-git", "--repository", "."],
      trusted: false,
    },
  },
];

// --- status mapping --------------------------------------------------------
// Per-server lifecycle state derived from GET /v1/mcp diagnostics + config:
//   Connected — live server.connected === true.
//   Disabled  — configured, trusted === false (untrusted ⇒ tools not exposed).
//   Error     — live server.unavailableReason present.
//   Drift     — in config but absent from live diagnostics (not yet (re)started),
//               or live with toolCount === 0 (handshake produced no tools).

type ServerState = "Connected" | "Disabled" | "Error" | "Drift" | "Unknown";

function deriveState(cfg: McpServerConfig, live: McpServerStatus | undefined): ServerState {
  if (!live) return "Drift";
  if (live.unavailableReason) return "Error";
  if (cfg.trusted === false || live.trusted === false) return "Disabled";
  if (live.connected) return live.toolCount === 0 ? "Drift" : "Connected";
  return "Drift";
}

const STATE_BADGE: Record<ServerState, string> = {
  Connected: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
  Disabled: "bg-amber-500/15 text-amber-700 dark:text-amber-200",
  Error: "bg-red-500/15 text-red-700 dark:text-red-200",
  Drift: "bg-sky-500/15 text-sky-700 dark:text-sky-200",
  Unknown: "bg-ds-subtle text-ds-muted",
};

const STATE_DOT: Record<ServerState, string> = {
  Connected: "bg-emerald-500",
  Disabled: "bg-amber-500",
  Error: "bg-red-500",
  Drift: "bg-sky-500",
  Unknown: "bg-ds-faint",
};

// --- config helpers --------------------------------------------------------

function readServers(config: NexusConfig | null): McpServerConfig[] {
  return config?.capabilities?.mcp?.servers ?? [];
}

function withServers(config: NexusConfig, servers: McpServerConfig[]): NexusConfig {
  const caps = config.capabilities ?? {};
  const mcp = caps.mcp ?? { enabled: false };
  return { ...config, capabilities: { ...caps, mcp: { ...mcp, servers } } };
}

// ---------------------------------------------------------------------------

type SubTab = "mcp" | "skills";
type Category = "all" | "recommended" | "added";

export function PluginMarketplaceView(): JSX.Element {
  const config = useStore((s) => s.config);
  const skills = useStore((s) => s.skills);
  const skillsRoots = useStore((s) => s.skillsRoots);
  const skillsEnabled = useStore((s) => s.skillsEnabled);
  const skillsValidationErrors = useStore((s) => s.skillsValidationErrors);
  const mcp = useStore((s) => s.mcp);
  const saveConfig = useStore((s) => s.saveConfig);
  const loadSkills = useStore((s) => s.loadSkills);
  const loadMcp = useStore((s) => s.loadMcp);
  const init = useStore((s) => s.init);
  const setView = useNav((s) => s.setView);
  // When the sidebar is collapsed, AppShell floats an expand button at the
  // top-left; pad the header so it doesn't overlap the title (matches Workbench).
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);

  const [tab, setTab] = useState<SubTab>("mcp");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadSkills();
    void loadMcp();
    // config may not be loaded yet if the user deep-links straight here.
    if (!config) void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const servers = useMemo(() => readServers(config), [config]);
  const liveById = useMemo(() => {
    const map = new Map<string, McpServerStatus>();
    for (const s of mcp?.servers ?? []) map.set(s.id, s);
    return map;
  }, [mcp]);
  const installedIds = useMemo(() => new Set(servers.map((s) => s.id)), [servers]);

  const refresh = (): void => {
    void loadSkills();
    void loadMcp();
  };

  // Persist a new servers array, then refresh live diagnostics.
  const persist = async (next: McpServerConfig[], label: string): Promise<void> => {
    if (!config) {
      useStore.getState().setBanner("Config not loaded yet — open Settings first.");
      return;
    }
    setBusy(label);
    const ok = await saveConfig(withServers(config, next));
    setBusy(null);
    if (ok) {
      // Give the runtime a beat to (re)start the hub, then re-pull diagnostics.
      window.setTimeout(() => void loadMcp(), 400);
      void loadMcp();
    }
  };

  const install = (entry: CatalogEntry): void => {
    if (installedIds.has(entry.template.id)) return;
    void persist([...servers, entry.template], `install:${entry.id}`);
  };

  const remove = (id: string): void => {
    void persist(
      servers.filter((s) => s.id !== id),
      `remove:${id}`,
    );
  };

  const upsert = (server: McpServerConfig, originalId: string): void => {
    const exists = servers.some((s) => s.id === originalId);
    const next = exists ? servers.map((s) => (s.id === originalId ? server : s)) : [...servers, server];
    void persist(next, `save:${server.id}`);
    setEditing(null);
    setCreating(false);
  };

  const mcpEnabled = Boolean(config?.capabilities?.mcp?.enabled);

  // --- filtered lists -------------------------------------------------------

  const matches = (text: string): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return text.toLowerCase().includes(q);
  };

  // Installed servers (Added). Catalog entries not yet installed (Recommended).
  const installedView = servers.filter((s) => matches(`${s.id} ${s.command} ${(s.args ?? []).join(" ")}`));
  const recommendedView = MCP_CATALOG.filter(
    (e) => !installedIds.has(e.template.id) && matches(`${e.name} ${e.id} ${e.description}`),
  );

  const showAdded = category === "all" || category === "added";
  const showRecommended = category === "all" || category === "recommended";

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-main">
      {/* Header */}
      <div className="ds-no-drag flex shrink-0 items-center justify-between gap-3 border-b border-ds-border bg-ds-main px-4 py-3" style={sidebarCollapsed ? { paddingLeft: 56 } : undefined}>
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-semibold text-ds-ink">Plugins</h1>
          <p className="mt-0.5 truncate text-[12.5px] text-ds-muted">
            Install MCP servers and manage Skills available to the agent. Changes write to your runtime config.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {tab === "mcp" && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={!mcpEnabled}
              title={mcpEnabled ? "Add a custom MCP server" : "Enable MCP in Settings → Capabilities first"}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-xl px-3 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: ACCENT }}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              Create MCP server
            </button>
          )}
          <button
            type="button"
            onClick={() => setView("settings")}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
          >
            Configure
          </button>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Sub-tabs + search/filter toolbar */}
      <div className="ds-no-drag flex shrink-0 flex-col gap-3 border-b border-ds-border bg-ds-main px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-ds-border bg-ds-card p-0.5">
            <SegButton active={tab === "mcp"} onClick={() => setTab("mcp")}>
              MCP servers
            </SegButton>
            <SegButton active={tab === "skills"} onClick={() => setTab("skills")}>
              Skills
            </SegButton>
          </div>
          <div className="relative ml-auto w-full max-w-xs">
            <svg className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === "mcp" ? "Search servers…" : "Search skills…"}
              className="h-9 w-full rounded-xl border border-ds-border bg-ds-card pl-8 pr-3 text-[13px] text-ds-ink outline-none focus:border-ds-border-strong"
            />
          </div>
        </div>
        {tab === "mcp" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={category === "all"} onClick={() => setCategory("all")}>
              All
            </Chip>
            <Chip active={category === "recommended"} onClick={() => setCategory("recommended")}>
              Recommended <Count n={recommendedView.length} />
            </Chip>
            <Chip active={category === "added"} onClick={() => setCategory("added")}>
              Added <Count n={installedView.length} />
            </Chip>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-7">
          {tab === "mcp" ? (
            <>
              {!mcpEnabled && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-200">
                  <span>
                    MCP is disabled. Installed servers will not start until you enable MCP. You can still install entries here.
                  </span>
                  <button
                    type="button"
                    onClick={() => setView("settings")}
                    className="shrink-0 rounded-lg border border-amber-500/40 px-2.5 py-1 text-[12px] font-semibold transition hover:bg-amber-500/10"
                  >
                    Enable in Settings
                  </button>
                </div>
              )}

              {/* Added (installed) */}
              {showAdded && (
                <section>
                  <SectionHead title="Added" count={installedView.length} sub="In your config" />
                  {installedView.length === 0 ? (
                    <Empty>No MCP servers in your config. Install one from Recommended, or create a custom server.</Empty>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {installedView.map((server) => {
                        const live = liveById.get(server.id);
                        const state = deriveState(server, live);
                        const isBusy = busy === `remove:${server.id}` || busy === `save:${server.id}`;
                        return (
                          <article key={server.id} className="flex min-w-0 flex-col rounded-xl border border-ds-border bg-ds-card/95 p-3.5 shadow-sm">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="min-w-0 truncate text-[14px] font-semibold text-ds-ink">{server.id}</h3>
                              <StateBadge state={state} />
                            </div>
                            <p className="mt-1 break-all font-mono text-[11.5px] text-ds-faint">
                              {server.command} {(server.args ?? []).join(" ")}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                                {(live?.toolCount ?? 0)} {(live?.toolCount ?? 0) === 1 ? "tool" : "tools"}
                              </span>
                              {server.trusted ? (
                                <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-200">trusted</span>
                              ) : (
                                <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">untrusted</span>
                              )}
                              {server.env && Object.keys(server.env).length > 0 && (
                                <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                                  {Object.keys(server.env).length} env
                                </span>
                              )}
                            </div>
                            {live?.unavailableReason && (
                              <p className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[11.5px] leading-5 text-red-700 dark:text-red-200">
                                {live.unavailableReason}
                              </p>
                            )}
                            {!live && (
                              <p className="mt-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-2 py-1.5 text-[11.5px] leading-5 text-sky-700 dark:text-sky-200">
                                Configured but not yet reported live — restart or enable MCP to connect.
                              </p>
                            )}
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setEditing(server)}
                                disabled={isBusy}
                                className="inline-flex h-8 flex-1 items-center justify-center rounded-lg border border-ds-border bg-ds-card px-2.5 text-[12.5px] font-semibold text-ds-ink transition hover:bg-ds-hover disabled:opacity-50"
                              >
                                Manage
                              </button>
                              <button
                                type="button"
                                onClick={() => remove(server.id)}
                                disabled={isBusy}
                                className="inline-flex h-8 items-center justify-center rounded-lg border border-red-500/30 px-2.5 text-[12.5px] font-semibold text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300"
                              >
                                {busy === `remove:${server.id}` ? "Removing…" : "Remove"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {/* Recommended (catalog) */}
              {showRecommended && (
                <section>
                  <SectionHead title="Recommended" count={recommendedView.length} sub="Installable templates & first-party sidecars" />
                  {recommendedView.length === 0 ? (
                    <Empty>Everything in the catalog is already installed.</Empty>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {recommendedView.map((entry) => {
                        const isBusy = busy === `install:${entry.id}`;
                        return (
                          <article key={entry.id} className="flex min-w-0 flex-col rounded-xl border border-ds-border bg-ds-card/95 p-3.5 shadow-sm">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="min-w-0 truncate text-[14px] font-semibold text-ds-ink">{entry.name}</h3>
                              {entry.builtin ? (
                                <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-200">first-party</span>
                              ) : (
                                <span className="shrink-0 rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">template</span>
                              )}
                            </div>
                            <p className="mt-1.5 text-[12.5px] leading-5 text-ds-muted">{entry.description}</p>
                            <p className="mt-2 break-all font-mono text-[11px] text-ds-faint">
                              {entry.template.command} {(entry.template.args ?? []).join(" ")}
                            </p>
                            {entry.requires && entry.requires.length > 0 && (
                              <p className="mt-2 text-[11px] text-ds-faint">
                                Requires: <span className="font-mono">{entry.requires.join(", ")}</span>
                              </p>
                            )}
                            {/* Spacer pushes the Install button to the card bottom so
                                buttons align across cards of differing content height
                                (the grid stretches each card to the row's max height). */}
                            <div className="grow" />
                            <button
                              type="button"
                              onClick={() => install(entry)}
                              disabled={isBusy}
                              className="mt-3 inline-flex h-8 items-center justify-center rounded-lg px-3 text-[12.5px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
                              style={{ background: ACCENT }}
                            >
                              {isBusy ? "Installing…" : "Install"}
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </>
          ) : (
            <SkillsTab
              skills={skills}
              roots={skillsRoots}
              enabled={skillsEnabled}
              validationErrors={skillsValidationErrors}
              query={query}
              onConfigure={() => setView("settings")}
            />
          )}
        </div>
      </div>

      {(editing || creating) && (
        <McpServerForm
          initial={editing ?? null}
          existingIds={installedIds}
          saving={busy != null && busy.startsWith("save:")}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSubmit={(server) => upsert(server, editing?.id ?? server.id)}
        />
      )}
    </div>
  );
}

// --- skills tab ------------------------------------------------------------

function SkillsTab(props: {
  skills: ReturnType<typeof useStore.getState>["skills"];
  roots: string[];
  enabled: boolean;
  validationErrors: SkillValidationError[];
  query: string;
  onConfigure: () => void;
}): JSX.Element {
  const { skills, roots, enabled, validationErrors, query, onConfigure } = props;
  const q = query.trim().toLowerCase();
  const filtered = skills.filter((s) => !q || `${s.name} ${s.id} ${s.description ?? ""}`.toLowerCase().includes(q));

  return (
    <>
      {/* Skill roots — the discovery locations skills are loaded from. */}
      <section>
        <SectionHead title="Skill roots" count={roots.length} sub="Discovery locations" />
        {!enabled ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-200">
            <span>Skills are disabled. Enable Skills and add skill roots to discover skills.</span>
            <button
              type="button"
              onClick={onConfigure}
              className="shrink-0 rounded-lg border border-amber-500/40 px-2.5 py-1 text-[12px] font-semibold transition hover:bg-amber-500/10"
            >
              Enable in Settings
            </button>
          </div>
        ) : roots.length === 0 ? (
          <Empty>
            No skill roots configured. Add one in Settings → Capabilities. A skill is a folder under a root containing a
            SKILL.md manifest; once a root is configured, drop skill folders there and Refresh.
          </Empty>
        ) : (
          <div className="grid gap-2">
            {roots.map((root) => (
              <div key={root} className="flex items-center justify-between gap-3 rounded-xl border border-ds-border bg-ds-card/95 px-3.5 py-2.5 shadow-sm">
                <span className="min-w-0 break-all font-mono text-[12px] text-ds-ink">{root}</span>
                <span className="shrink-0 rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                  {/* A skill's `root` is its own folder, which lives UNDER the
                      discovery root — match by prefix so the count isn't 0. */}
                  {skills.filter((s) => {
                    const sr = s.root ?? "";
                    const base = root.replace(/[\\/]+$/, "");
                    return sr === base || sr.startsWith(`${base}/`);
                  }).length}{" "}
                  skills
                </span>
              </div>
            ))}
          </div>
        )}
        {validationErrors.length > 0 && (
          <div className="mt-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3.5 py-2.5">
            <div className="text-[12px] font-semibold text-red-700 dark:text-red-200">{validationErrors.length} validation error(s)</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] leading-5 text-red-700/90 dark:text-red-200/90">
              {validationErrors.slice(0, 8).map((err, i) => (
                <li key={i} className="break-words">{validationErrorText(err)}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-3 text-[12px] leading-5 text-ds-muted">
          To add a skill, create a folder with a SKILL.md manifest inside a configured root, then Refresh. There is no
          server-side skill installer — skills are discovered from the filesystem.{" "}
          <button type="button" onClick={onConfigure} className="font-semibold text-[#0088ff] hover:underline">
            Manage skill roots in Settings
          </button>
          .
        </p>
      </section>

      {/* Discovered skills */}
      <section>
        <SectionHead title="Discovered skills" count={filtered.length} sub="Loaded from your roots" />
        {filtered.length === 0 ? (
          <Empty>{q ? "No skills match your search." : "No skills discovered yet."}</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((skill) => (
              <article key={skill.id} className="flex min-w-0 flex-col rounded-xl border border-ds-border bg-ds-card/95 p-3.5 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 truncate text-[14px] font-semibold text-ds-ink">{skill.name}</h3>
                  {skill.version && !skill.legacy && skill.version !== "legacy" && (
                    <span className="shrink-0 rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">v{skill.version}</span>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-[11.5px] text-ds-faint">{skill.id}</p>
                {skill.description && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-5 text-ds-muted">{skill.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {skill.legacy && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-200">legacy</span>
                  )}
                  {skill.allowedTools && skill.allowedTools.length > 0 && (
                    <span className="rounded-full border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                      {skill.allowedTools.length} tools
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// --- create / edit MCP server form ----------------------------------------

interface DraftServer {
  id: string;
  command: string;
  args: string;
  envText: string;
  trusted: boolean;
}

function toDraft(server: McpServerConfig | null): DraftServer {
  return {
    id: server?.id ?? "",
    command: server?.command ?? "",
    args: (server?.args ?? []).join(" "),
    envText: Object.entries(server?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    trusted: server?.trusted ?? false,
  };
}

function McpServerForm(props: {
  initial: McpServerConfig | null;
  existingIds: Set<string>;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (server: McpServerConfig) => void;
}): JSX.Element {
  const { initial, existingIds, saving, onCancel, onSubmit } = props;
  const [draft, setDraft] = useState<DraftServer>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const isEdit = initial != null;

  const set = <K extends keyof DraftServer>(key: K, value: DraftServer[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = (): void => {
    const id = draft.id.trim();
    if (!id) {
      setError("Server id is required.");
      return;
    }
    if (!isEdit && existingIds.has(id)) {
      setError(`A server with id "${id}" already exists.`);
      return;
    }
    const command = draft.command.trim();
    if (!command) {
      setError("Command is required.");
      return;
    }
    const args = draft.args.trim() ? draft.args.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    for (const line of draft.envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        setError(`Invalid env line (expected KEY=value): ${trimmed}`);
        return;
      }
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    setError(null);
    const server: McpServerConfig = {
      id,
      command,
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      trusted: draft.trusted,
    };
    onSubmit(server);
  };

  const field = "w-full rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-ds-border-strong";

  return (
    <div className="ds-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onCancel}>
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-ds-ink">{isEdit ? `Manage ${initial?.id}` : "Create MCP server"}</h2>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink" aria-label="Close">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">Server id *</span>
            <input className={field} value={draft.id} disabled={isEdit} onChange={(e) => set("id", e.target.value)} placeholder="filesystem" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">Command *</span>
            <input className={field} value={draft.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">Args (space-separated)</span>
            <input className={field} value={draft.args} onChange={(e) => set("args", e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ." />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">Env (one KEY=value per line — secrets stay masked)</span>
            <textarea
              className={field + " min-h-[72px] resize-y font-mono text-[12px]"}
              spellCheck={false}
              value={draft.envText}
              onChange={(e) => set("envText", e.target.value)}
              placeholder={"API_TOKEN=********\nBASE_URL=https://…"}
            />
          </label>
          <label className="flex items-center gap-2 pt-1">
            <input type="checkbox" checked={draft.trusted} onChange={(e) => set("trusted", e.target.checked)} className="h-4 w-4" />
            <span className="text-[13px] text-ds-ink">Trusted (expose its tools without per-call approval)</span>
          </label>
          {error && <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-300">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ds-border px-5 py-3">
          <button type="button" onClick={onCancel} className="inline-flex h-9 items-center rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:bg-ds-hover">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex h-9 items-center rounded-xl px-4 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- small presentational helpers ------------------------------------------

function SegButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        "rounded-lg px-3 py-1.5 text-[13px] font-semibold transition " +
        (props.active ? "bg-ds-main text-ds-ink shadow-sm" : "text-ds-muted hover:text-ds-ink")
      }
    >
      {props.children}
    </button>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] font-medium transition " +
        (props.active
          ? "border-transparent bg-[#0088ff]/15 text-[#0088ff]"
          : "border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink")
      }
    >
      {props.children}
    </button>
  );
}

function Count(props: { n: number }): JSX.Element {
  return <span className="rounded-full bg-ds-subtle px-1.5 text-[11px] text-ds-muted">{props.n}</span>;
}

function SectionHead(props: { title: string; count: number; sub: string }): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-[15px] font-semibold text-ds-ink">{props.title}</h2>
      <span className="text-[12px] text-ds-faint">{props.count}</span>
      <span className="ml-auto text-[11.5px] text-ds-faint">{props.sub}</span>
    </div>
  );
}

function StateBadge(props: { state: ServerState }): JSX.Element {
  return (
    <span className={"inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold " + STATE_BADGE[props.state]}>
      <span className={"h-1.5 w-1.5 rounded-full " + STATE_DOT[props.state]} />
      {props.state}
    </span>
  );
}

function Empty(props: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-ds-border bg-ds-card/60 px-5 py-8 text-center text-[13px] leading-6 text-ds-muted">
      {props.children}
    </div>
  );
}
