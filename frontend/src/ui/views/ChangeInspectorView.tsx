// Change Inspector — right-docked panel listing the live git working-tree
// changes for the active thread's workspace, with a DiffViewer pane that shows
// the actual unified diff of the selected file. Data comes from
// GET /v1/workspace/status (changed-file list) and GET /v1/workspace/diff
// (per-file `git diff`). Faithful to the original ChangeInspector-lKksm9jr.js:
// a header, a scrollable file list (max 42% height), and a DiffViewer below.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store/store.js";
import { api } from "../../api/client.js";
import type { WorkspaceFileDiff } from "../../api/types.js";

/** Map a git porcelain status code to a short human label. */
function statusLabel(status: string): string {
  const s = status.trim();
  if (s === "??" || s.toUpperCase().startsWith("A")) return "added";
  if (s.toUpperCase().startsWith("D")) return "deleted";
  if (s.toUpperCase().startsWith("R")) return "renamed";
  if (s.toUpperCase().startsWith("M")) return "modified";
  return s || "changed";
}

/** Tailwind classes for a status badge by label. */
function statusBadgeClass(label: string): string {
  switch (label) {
    case "added":
      return "bg-emerald-200/40 text-emerald-900 dark:bg-emerald-700/30 dark:text-emerald-100";
    case "deleted":
      return "bg-red-200/40 text-red-900 dark:bg-red-700/30 dark:text-red-100";
    case "renamed":
      return "bg-sky-200/40 text-sky-900 dark:bg-sky-700/30 dark:text-sky-100";
    case "modified":
      return "bg-amber-200/40 text-amber-900 dark:bg-amber-700/30 dark:text-amber-100";
    default:
      return "bg-ds-subtle text-ds-muted";
  }
}

/** Short language badge (text + tint) derived from a file extension. */
function langBadge(path: string): { label: string; className: string } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const tint: Record<string, string> = {
    ts: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    tsx: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    js: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    jsx: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    rs: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
    py: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
    json: "bg-zinc-100 text-zinc-700 dark:bg-zinc-500/15 dark:text-zinc-300",
    css: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
    md: "bg-zinc-100 text-zinc-700 dark:bg-zinc-500/15 dark:text-zinc-300",
  };
  return {
    label: (ext || "file").toUpperCase().slice(0, 4),
    className: tint[ext] ?? "bg-ds-subtle text-ds-muted",
  };
}

type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "context"; text: string; lineNo: number }
  | { kind: "add"; text: string; lineNo: number }
  | { kind: "del"; text: string }
  | { kind: "meta"; text: string };

/** Parse raw `git diff` text into renderable rows with new-file line numbers. */
function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : newLine;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    // File-level headers are noise for the row view.
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ") ||
      line.startsWith("copy ")
    ) {
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), lineNo: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1) });
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", text: line.slice(1), lineNo: newLine });
      newLine += 1;
      continue;
    }
    // Trailing empty line from the split — keep only if inside a hunk.
    if (line === "" && rows.length > 0) continue;
  }
  return rows;
}

/** The diff table for a single file (hunk headers, context, +/- rows). */
function DiffViewer({ file, data }: { file: string; data: WorkspaceFileDiff | null }): JSX.Element {
  const rows = useMemo(() => (data ? parseDiff(data.diff) : []), [data]);
  const badge = langBadge(file);
  const name = file.split("/").pop() ?? file;

  const copy = (): void => {
    if (data?.diff) void navigator.clipboard?.writeText(data.diff).catch(() => undefined);
  };

  return (
    <div className="ds-card-strong flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-0">
      {/* Diff header: badge + filename + +/- counts + copy */}
      <div className="ds-panel-strip flex items-center gap-2.5 border-b border-ds-border-muted px-3 py-2">
        <span className={"shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold " + badge.className}>{badge.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-ds-ink" title={file}>
          {name}
        </span>
        {data && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-ds-diff-added">+{data.added}</span>
            <span className="px-1 text-ds-faint">·</span>
            <span className="text-ds-diff-removed">-{data.removed}</span>
          </span>
        )}
        <button
          type="button"
          onClick={copy}
          disabled={!data?.diff}
          className="ds-chip-muted shrink-0 rounded-md p-1 text-ds-faint transition hover:text-ds-ink disabled:opacity-40"
          aria-label="Copy diff"
          title="Copy diff"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        </button>
      </div>

      {/* Diff body */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto font-mono text-[11.5px] leading-6">
        {data == null ? (
          <div className="flex h-full items-center justify-center px-4 text-[12px] text-ds-faint">Loading diff…</div>
        ) : data.binary ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ds-faint">Binary file — no line-level diff available.</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ds-faint">No textual changes for this file.</div>
        ) : (
          <table className="w-max min-w-full border-collapse">
            <tbody>
              {rows.map((row, index) => {
                if (row.kind === "hunk") {
                  return (
                    <tr key={index} className="bg-accent-soft/60 text-ds-muted">
                      <td className="select-none px-2 text-right tabular-nums text-ds-faint" style={{ width: "2.75rem" }} />
                      <td className="whitespace-pre px-3 pr-2">{row.text}</td>
                    </tr>
                  );
                }
                if (row.kind === "meta") {
                  return (
                    <tr key={index} className="text-ds-faint">
                      <td className="select-none px-2 text-right tabular-nums text-ds-faint" style={{ width: "2.75rem" }} />
                      <td className="whitespace-pre px-3 pr-2">{row.text}</td>
                    </tr>
                  );
                }
                const rowClass =
                  row.kind === "add"
                    ? "bg-ds-diff-added-soft text-ds-diff-added"
                    : row.kind === "del"
                      ? "bg-ds-diff-removed-soft text-ds-diff-removed"
                      : "text-ds-ink";
                const prefix = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
                const lineNo = row.kind === "del" ? "" : String(row.lineNo);
                return (
                  <tr key={index} className={rowClass}>
                    <td className="select-none px-2 text-right tabular-nums text-ds-faint" style={{ width: "2.75rem" }}>
                      {lineNo}
                    </td>
                    <td className="whitespace-pre px-3 pr-2">
                      {prefix}
                      {row.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function ChangeInspectorView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const ws = useStore((s) => s.workspaceStatus);
  const thread = useStore((s) => s.thread);
  const loadWorkspaceStatus = useStore((s) => s.loadWorkspaceStatus);

  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);

  const files = ws?.changedFiles ?? [];
  const branch = ws?.branch ?? null;
  const count = ws?.fileChangeCount ?? files.length;
  const workspace = thread?.workspace;

  // Refresh on open so the list reflects the current working tree.
  useEffect(() => {
    if (thread) void loadWorkspaceStatus();
  }, [thread, loadWorkspaceStatus]);

  // Keep a valid selection: default to the first changed file, and clear it when
  // the selected file is no longer in the list (or the list emptied).
  useEffect(() => {
    if (files.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!selected || !files.some((f) => f.path === selected)) {
      setSelected(files[0].path);
    }
  }, [files, selected]);

  // Load the diff whenever the selected file (or workspace) changes.
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    void api
      .workspaceDiff(selected, workspace)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => {
        if (!cancelled) setDiff({ file: selected, diff: "", added: 0, removed: 0, untracked: false, binary: false });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, workspace]);

  const summary = (): string => {
    if (!thread) return "No thread open";
    if (!ws) return "Loading…";
    if (!ws.exists) return "Workspace not found";
    if (!ws.isGitRepository) return "Not a git repository";
    if (count === 0) return "Working tree clean";
    return `${count} file ${count === 1 ? "change" : "changes"}`;
  };

  return (
    <aside className="ds-no-drag ds-panel-ghost flex h-full max-h-full min-h-0 w-full flex-col border-l border-ds-border-muted backdrop-blur-xl">
      {/* Header: collapse + title + summary + refresh */}
      <div className="flex min-h-[58px] shrink-0 items-center gap-3 border-b border-ds-border-muted px-3 py-3">
        <button
          type="button"
          className="ds-sidebar-toggle-button shrink-0"
          aria-label="Collapse right sidebar"
          title="Collapse right sidebar"
          onClick={onCollapse}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wide text-ds-muted">Changes</div>
          <div className="mt-1 truncate text-[11px] text-ds-faint">{branch ? `${branch} · ${summary()}` : summary()}</div>
        </div>
        <button
          type="button"
          onClick={() => void loadWorkspaceStatus()}
          disabled={!thread}
          className="shrink-0 rounded-md p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Refresh changes"
          title="Refresh changes"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
      </div>

      {files.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* File list (max 42% height, scrollable, selectable) */}
          <div className="max-h-[42%] min-h-0 overflow-y-auto py-2">
            <ul className="divide-y divide-ds-border-muted/60">
              {files.map((file) => {
                const label = statusLabel(file.status);
                const active = file.path === selected;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(file.path)}
                      className={
                        "flex w-full items-start gap-2 px-4 py-2.5 text-left transition " +
                        (active ? "bg-ds-hover text-ds-ink" : "text-ds-ink hover:bg-ds-hover/70")
                      }
                    >
                      <svg
                        className={"mt-0.5 h-3.5 w-3.5 shrink-0 " + (label === "deleted" ? "text-red-700" : "text-ds-muted")}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                      </svg>
                      <div className="min-w-0 flex-1">
                        <div className="break-all text-[12px] text-ds-ink">{file.path}</div>
                      </div>
                      <span className={"shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium " + statusBadgeClass(label)}>{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Diff pane */}
          <div className="ds-panel-strip flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-ds-border-muted">
            {selected ? (
              <DiffViewer file={selected} data={diff} />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ds-faint">Select a file to view its diff.</div>
            )}
          </div>
        </div>
      ) : (
        // Honest empty state
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
            <svg
              className="mb-3 h-7 w-7 text-ds-faint"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <path d="m9 15 2 2 4-4" />
            </svg>
            <div className="text-[13px] font-medium text-ds-ink">{summary()}</div>
            <p className="mt-1.5 text-[12px] leading-5 text-ds-faint">
              {!thread
                ? "Open a thread to inspect its workspace."
                : ws && ws.isGitRepository
                  ? "No uncommitted changes in the working tree. File edits stream inline in the chat as the agent works."
                  : "The active thread's workspace is not a git repository, so there are no tracked changes to show."}
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
