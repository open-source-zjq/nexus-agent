import { useMemo, useState } from "react";
import { useStore } from "../store/store.js";
import { useNav, type ViewKey } from "../store/nav.js";
import { NexusLogo } from "./NexusLogo.js";
import { isTauri, pickWorkspaceDir } from "../lib/tauri.js";
import type { ThreadSummary } from "../api/types.js";

/** Last path segment of a workspace dir, used as the project label. */
function projectName(workspace: string): string {
  const trimmed = (workspace || "").replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || workspace || "workspace";
}

/** A primary-nav row in the sidebar. Accent rows (new*) use primary ink, the
 *  rest are muted. Colours are theme tokens (var(--ds-text*)) so they track
 *  light/dark — the glyph inherits the row's currentColor. */
function NavRow({
  label,
  active,
  accent,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  accent?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const ink = active || accent ? "text-ds-ink" : "text-ds-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex min-h-[34px] w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-[13px] font-normal transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink " +
        (active ? "bg-[var(--ds-sidebar-row-active)] text-ds-ink shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]" : ink)
      }
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

export function Sidebar(): JSX.Element {
  const threads = useStore((s) => s.threads);
  const currentThreadId = useStore((s) => s.currentThreadId);
  const selectThread = useStore((s) => s.selectThread);
  const newThread = useStore((s) => s.newThread);
  const newProject = useStore((s) => s.newProject);
  const pendingWorkspace = useStore((s) => s.pendingWorkspace);
  const defaultWorkspace = useStore((s) => s.runtimeInfo?.defaultWorkspace) ?? "";
  const setComposerMode = useStore((s) => s.setComposerMode);
  const composerMode = useStore((s) => s.composerMode);

  const view = useNav((s) => s.view);
  const setView = useNav((s) => s.setView);
  const toggleSidebar = useNav((s) => s.toggleSidebar);

  const renameThread = useStore((s) => s.renameThread);
  const archiveThread = useStore((s) => s.archiveThread);
  const compactThread = useStore((s) => s.compactThread);
  const removeThread = useStore((s) => s.removeThread);
  const unread = useStore((s) => s.unread);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // Which thread row's kebab menu is open (one at a time).
  const [menuId, setMenuId] = useState<string | null>(null);

  // Group threads by workspace into project folders (filtered by the live search
  // query over thread title + workspace path — a client-side filter of real
  // GET /v1/threads state, no extra request).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? threads.filter(
          (t) => (t.title || "").toLowerCase().includes(q) || (t.workspace || "").toLowerCase().includes(q),
        )
      : threads;
    const byWorkspace = new Map<string, ThreadSummary[]>();
    for (const t of filtered) {
      const key = t.workspace || "(no workspace)";
      const list = byWorkspace.get(key) ?? [];
      list.push(t);
      byWorkspace.set(key, list);
    }
    return [...byWorkspace.entries()].map(([workspace, list]) => ({ workspace, list }));
  }, [threads, query]);

  // After "New Agent" no thread is selected yet; fall back to pendingWorkspace
  // so the project the new thread will land in stays expanded.
  const currentWorkspace = threads.find((t) => t.id === currentThreadId)?.workspace ?? pendingWorkspace ?? undefined;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [wsPath, setWsPath] = useState("");
  // An active search expands every matching folder so hits are visible.
  const isExpanded = (ws: string): boolean =>
    query.trim() ? true : (expanded[ws] ?? ws === (currentWorkspace ?? groups[0]?.workspace));

  const desktop = isTauri();
  const openCreate = (): void => {
    setWsPath(defaultWorkspace);
    setProjectsCollapsed(false);
    setCreating(true);
  };
  const browse = (): void => {
    void pickWorkspaceDir(wsPath || defaultWorkspace || undefined).then((dir) => {
      if (dir) setWsPath(dir);
    });
  };
  const submitProject = (): void => {
    setView("workbench");
    void newProject(wsPath);
    setCreating(false);
    setWsPath("");
  };

  const openThread = (id: string): void => {
    void selectThread(id);
    setView("workbench");
  };
  const startAgent = (mode: "agent" | "plan"): void => {
    newThread();
    setComposerMode(mode);
    setView("workbench");
  };
  const go = (v: ViewKey): void => {
    setView(v);
  };

  return (
    <aside className="ds-drag ds-sidebar-shell relative flex h-full w-full shrink-0 flex-col overflow-hidden px-4 pb-3">
      {/* titlebar spacer: macOS traffic-light safe block + collapse toggle */}
      <div className="ds-sidebar-titlebar-spacer shrink-0 pb-5 pt-3">
        <div className="ds-sidebar-titlebar-row flex min-h-[34px] items-start justify-between">
          <div aria-hidden="true" className="ds-titlebar-safe-block min-w-[86px]" />
          <button
            type="button"
            title="Nexus"
            aria-label="Toggle sidebar"
            onClick={toggleSidebar}
            className="ds-titlebar-sidebar-toggle ds-no-drag ds-sidebar-titlebar-toggle mt-[5px]"
          >
            <svg className="h-[13px] w-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        </div>
      </div>

      {/* brand header + primary nav */}
      <div className="ds-no-drag flex flex-col px-1">
        <div className="mb-2 flex w-fit max-w-full items-center gap-1.5 rounded-md py-1 text-left text-[15px] font-medium text-ds-muted">
          <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5">
            <NexusLogo />
          </span>
          <span className="tabular-nums ds-shiny-text">Nexus</span>
        </div>

        {/* Primary nav. "New Agent" opens a fresh workbench in agent mode; plan
            mode is reached from the composer (Plan toggle / `/plan` / `+` menu). */}
        <NavRow label="New Agent" accent active={view === "workbench" && !currentThreadId && composerMode === "agent"} onClick={() => startAgent("agent")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </svg>
        </NavRow>
        <NavRow label="Plugins" active={view === "plugins"} onClick={() => go("plugins")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect width="7" height="7" x="3" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="14" rx="1" />
            <rect width="7" height="7" x="3" y="14" rx="1" />
          </svg>
        </NavRow>
        <NavRow label="Connectors" active={view === "connectors"} onClick={() => go("connectors")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
            <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
            <path d="M21 21v-2h-4" />
            <path d="M3 5h4V3" />
            <path d="M7 5a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1z" />
          </svg>
        </NavRow>
        <NavRow label="Connect Phone" active={view === "phone"} onClick={() => go("phone")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
            <path d="M12 18h.01" />
          </svg>
        </NavRow>
        <NavRow label="Scheduled" active={view === "schedule"} onClick={() => go("schedule")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </NavRow>
        <NavRow label="Agents" active={view === "agents"} onClick={() => go("agents")}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z" />
            <path d="m7 16.5-4.74-2.85" />
            <path d="m7 16.5 5-3" />
            <path d="M7 16.5v5.17" />
            <path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z" />
            <path d="m17 16.5-5-3" />
            <path d="m17 16.5 4.74-2.85" />
            <path d="M17 16.5v5.17" />
            <path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z" />
            <path d="M12 8 7.26 5.15" />
            <path d="m12 8 4.74-2.85" />
            <path d="M12 13.5V8" />
          </svg>
        </NavRow>
      </div>

      <div className="ds-no-drag mx-1 my-3" />

      {/* Projects / thread tree */}
      <div className="ds-no-drag flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-[38px] items-center justify-between px-2 pb-1.5 pt-3">
          <button
            type="button"
            onClick={() => setProjectsCollapsed((v) => !v)}
            aria-expanded={!projectsCollapsed}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-muted"
            title="Toggle projects"
          >
            <span className="truncate">Projects</span>
            <svg
              className={"h-3 w-3 shrink-0 transition-transform " + (projectsCollapsed ? "" : "rotate-90")}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setProjectsCollapsed(false);
                setSearching((v) => {
                  if (v) setQuery("");
                  return !v;
                });
              }}
              className={
                "ds-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink " +
                (searching ? "bg-[var(--ds-sidebar-row-active)] text-ds-ink" : "text-ds-faint")
              }
              title="Search threads"
              aria-label="Search threads"
              aria-pressed={searching}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            <button type="button" onClick={openCreate} className="ds-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink" title="New project (choose a workspace path)" aria-label="New project">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
          </div>
        </div>

        {searching && (
          <div className="px-2 pb-2">
            <div className="flex items-center gap-1.5 rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[color-mix(in_srgb,var(--ds-sidebar-field-bg)_84%,transparent)] px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.62)]">
              <svg className="h-3.5 w-3.5 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    setSearching(false);
                  }
                }}
                placeholder="Search threads"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ds-ink placeholder:text-ds-faint focus:outline-none"
                spellCheck={false}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} className="shrink-0 rounded-md p-0.5 text-ds-faint transition hover:text-ds-ink" aria-label="Clear search" title="Clear search">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              )}
            </div>
          </div>
        )}

        {creating && (
          <div className="px-2 pb-2">
            <div className="flex items-center gap-1.5 rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[color-mix(in_srgb,var(--ds-sidebar-field-bg)_84%,transparent)] px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.62)]">
              <svg className="h-3.5 w-3.5 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
              <input
                autoFocus
                value={wsPath}
                onChange={(e) => setWsPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitProject();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder={defaultWorkspace || "/absolute/workspace/path"}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ds-ink placeholder:text-ds-faint focus:outline-none"
                spellCheck={false}
              />
              {desktop && (
                <button
                  type="button"
                  onClick={browse}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-ds-muted transition hover:text-ds-ink"
                  title="Choose a folder…"
                >
                  Browse…
                </button>
              )}
              <button type="button" onClick={submitProject} className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-semibold text-white transition hover:opacity-90" style={{ background: "#0088ff" }} title="Create project">
                Create
              </button>
              <button type="button" onClick={() => setCreating(false)} className="shrink-0 rounded-md p-0.5 text-ds-faint transition hover:text-ds-ink" aria-label="Cancel" title="Cancel">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
            <div className="px-1 pt-1 text-[11px] leading-4 text-ds-faint">Absolute path to a project folder. Leave blank to use the runtime's working directory.</div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-0.5" hidden={projectsCollapsed}>
          {groups.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-ds-faint">
              {query.trim() ? `No threads match “${query.trim()}”` : "No threads yet"}
            </div>
          )}
          {groups.map(({ workspace, list }) => {
            const open = isExpanded(workspace);
            return (
              <div key={workspace} className="mb-2">
                <div
                  className={
                    "group relative flex w-full items-center overflow-hidden rounded-[8px] text-[13.5px] font-normal transition " +
                    (open ? "bg-[var(--ds-sidebar-row-active)] text-ds-ink shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]" : "text-ds-muted hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink")
                  }
                  title={workspace}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [workspace]: !open }))}
                    className="flex min-w-0 flex-1 text-left items-center gap-2 px-2.5 py-2"
                  >
                    {open ? (
                      <svg className="h-4 w-4 shrink-0 text-ds-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 shrink-0 text-ds-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                      </svg>
                    )}
                    <span className="min-w-0 flex-1 truncate">{projectName(workspace)}</span>
                    {!open && (
                      <span className="min-w-0 max-w-[42%] shrink truncate text-[12.5px] text-ds-faint transition group-hover:opacity-0">
                        {list.length} {list.length === 1 ? "thread" : "threads"}
                      </span>
                    )}
                  </button>
                </div>
                {open && (
                  <div className="mt-1 space-y-[3px] pl-4">
                    {list.map((t) => {
                      const isActive = t.id === currentThreadId && view === "workbench";
                      return (
                        <div
                          key={t.id}
                          className={
                            "group relative flex w-full items-center overflow-hidden rounded-[8px] text-[13px] font-normal transition " +
                            (isActive ? "bg-[var(--ds-sidebar-row-active)] text-ds-ink shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]" : "text-ds-muted hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink")
                          }
                          title={t.title || "Untitled"}
                        >
                          <span aria-hidden="true" className={"absolute bottom-1 left-0 top-1 w-[2px] rounded-full transition " + (t.status === "running" ? "bg-accent opacity-100" : "bg-transparent opacity-0")} />
                          <button type="button" onClick={() => openThread(t.id)} className="flex min-w-0 flex-1 text-left items-center gap-2 px-2.5 py-2">
                            <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
                            {unread[t.id] && <span aria-label="unread" title="Finished while in the background" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                          </button>
                          <button
                            type="button"
                            aria-label="Thread actions"
                            title="Thread actions"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuId((id) => (id === t.id ? null : t.id));
                            }}
                            className="mr-1 shrink-0 rounded p-1 text-ds-faint opacity-0 transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink group-hover:opacity-100"
                          >
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
                          </button>
                          {menuId === t.id && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setMenuId(null)} />
                              <div className="absolute right-1 top-8 z-50 w-36 overflow-hidden rounded-lg border border-ds-border bg-ds-card py-1 shadow-lg">
                                {[
                                  {
                                    label: "Rename",
                                    run: () => {
                                      const next = window.prompt("Rename thread", t.title || "");
                                      if (next != null) void renameThread(t.id, next);
                                    },
                                  },
                                  { label: "Compact", run: () => void compactThread(t.id) },
                                  { label: "Archive", run: () => void archiveThread(t.id) },
                                  {
                                    label: "Delete",
                                    danger: true,
                                    run: () => {
                                      if (window.confirm(`Delete "${t.title || "Untitled"}"?`)) void removeThread(t.id);
                                    },
                                  },
                                ].map((a) => (
                                  <button
                                    key={a.label}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMenuId(null);
                                      a.run();
                                    }}
                                    className={
                                      "block w-full px-3 py-1.5 text-left text-[13px] transition hover:bg-ds-hover " +
                                      ((a as { danger?: boolean }).danger ? "text-red-500" : "text-ds-ink")
                                    }
                                  >
                                    {a.label}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* footer: Settings */}
      <div className="ds-no-drag mt-2 border-t border-[var(--ds-sidebar-divider)] px-1.5 pt-3">
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            title="Settings"
            aria-pressed={view === "settings"}
            onClick={() => go("settings")}
            className={
              "inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[9px] px-2 text-[12px] font-medium transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink " +
              (view === "settings" ? "bg-[var(--ds-sidebar-row-active)] text-ds-ink" : "text-ds-muted")
            }
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ds-faint">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            <span className="min-w-0 truncate">Settings</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
