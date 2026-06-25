import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { useNav } from "../../store/nav.js";
import type { ScheduleKind, ScheduleTask } from "../../api/types.js";

/**
 * Scheduled-tasks screen (T4.1). Lists tasks with their schedule / next-run /
 * last-run + status, supports enable toggle / run-now / delete, expandable last
 * result, and a "+ New task" inline form. Backed by /v1/schedule.
 */
export function ScheduleTasksView(): JSX.Element {
  // Pad the header when the sidebar is collapsed so AppShell's floating expand
  // button doesn't overlap the title (matches the Workbench pattern).
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const { tasks } = await api.listSchedule();
      setTasks(tasks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const runNow = async (id: string): Promise<void> => {
    try {
      await api.runSchedule(id);
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };
  const toggleEnabled = async (task: ScheduleTask): Promise<void> => {
    try {
      await api.updateSchedule(task.id, { enabled: !task.enabled });
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };
  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteSchedule(id);
    } catch (e) {
      setError((e as Error).message);
    }
    void refresh();
  };

  return (
    <div className="ds-no-drag flex h-full min-h-0 w-full flex-col bg-ds-main">
      <div className="ds-drag flex shrink-0 items-center justify-between border-b border-ds-border px-6 py-4" style={sidebarCollapsed ? { paddingLeft: 56 } : undefined}>
        <div>
          <h1 className="text-[18px] font-semibold text-ds-ink">Scheduled tasks</h1>
          <p className="text-[13px] text-ds-muted">Run a prompt as a fresh agent thread on a recurring or one-off schedule.</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="ds-no-drag rounded-full bg-zinc-950 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-zinc-800"
        >
          {creating ? "Cancel" : "+ New task"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-[13px] text-red-800">{error}</div>}

        {creating && (
          <NewTaskForm
            onCreated={() => {
              setCreating(false);
              void refresh();
            }}
            onError={setError}
          />
        )}

        {loading ? (
          <div className="text-[13px] text-ds-faint">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ds-border px-6 py-10 text-center text-[13px] text-ds-faint">
            No scheduled tasks yet. Click “+ New task” to create one.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((task) => (
              <div key={task.id} className="rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-ds-ink">{task.title}</span>
                      <StatusBadge status={task.lastStatus} />
                      {!task.enabled && <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-faint">paused</span>}
                    </div>
                    <div className="mt-1 text-[13px] text-ds-muted">{describeSchedule(task)}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-ds-faint">
                      <span>next: {fmt(task.nextRunAt)}</span>
                      <span>last: {fmt(task.lastRunAt)}</span>
                      {task.model && <span>model: {task.model}</span>}
                      <span>priority: {task.priority}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => void runNow(task.id)} className={btnGhost} title="Run now">
                      Run
                    </button>
                    <button type="button" onClick={() => void toggleEnabled(task)} className={btnGhost}>
                      {task.enabled ? "Pause" : "Resume"}
                    </button>
                    <button type="button" onClick={() => void remove(task.id)} className={`${btnGhost} text-red-500`}>
                      Delete
                    </button>
                  </div>
                </div>
                {task.lastResult && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setExpanded((p) => ({ ...p, [task.id]: !p[task.id] }))}
                      className="text-[12px] font-medium text-accent hover:underline"
                    >
                      {expanded[task.id] ? "Hide last result" : "Show last result"}
                    </button>
                    {expanded[task.id] && (
                      <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-ds-border-muted bg-ds-main/50 p-3 text-[12px] text-ds-ink">
                        {task.lastResult}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const btnGhost =
  "rounded-lg border border-ds-border bg-ds-card px-2.5 py-1 text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover";

function StatusBadge({ status }: { status: ScheduleTask["lastStatus"] }): JSX.Element {
  const map: Record<string, string> = {
    success: "bg-emerald-100 text-emerald-700",
    error: "bg-red-100 text-red-700",
    running: "bg-amber-100 text-amber-700",
    idle: "bg-ds-subtle text-ds-faint",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status] ?? map.idle}`}>{status}</span>;
}

function describeSchedule(task: ScheduleTask): string {
  const s = task.schedule;
  if (s.kind === "manual") return "Manual (run on demand)";
  if (s.kind === "at") return `Once at ${fmt(s.atTime)}`;
  if (s.kind === "daily") return `Daily at ${s.timeOfDay}`;
  return `Every ${s.everyMinutes} min`;
}

function fmt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function NewTaskForm({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("interval");
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [atTime, setAtTime] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!title.trim() || !prompt.trim()) {
      onError("Title and prompt are required.");
      return;
    }
    if (kind === "at" && !atTime.trim()) {
      onError("Pick a date and time for a one-off task.");
      return;
    }
    setBusy(true);
    try {
      const schedule =
        kind === "manual"
          ? { kind }
          : kind === "at"
            ? { kind, atTime: new Date(atTime || Date.now()).toISOString() }
            : kind === "daily"
              ? { kind, timeOfDay }
              : { kind, everyMinutes };
      await api.createSchedule({
        title: title.trim(),
        prompt: prompt.trim(),
        ...(workspaceRoot.trim() ? { workspaceRoot: workspaceRoot.trim() } : {}),
        schedule,
      });
      onCreated();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40";

  return (
    <div className="mb-5 rounded-2xl border border-ds-border bg-ds-card/95 px-5 py-4 shadow-sm">
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">Title</span>
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Morning digest" />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">Prompt</span>
          <textarea className={input} rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize overnight changes" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">Schedule</span>
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)}>
            <option value="interval">Every N minutes</option>
            <option value="daily">Daily</option>
            <option value="at">Once</option>
            <option value="manual">Manual (run on demand)</option>
          </select>
        </label>
        {kind === "interval" && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ds-muted">Minutes</span>
            <input className={input} type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(Number(e.target.value) || 1)} />
          </label>
        )}
        {kind === "daily" && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ds-muted">Time (HH:MM)</span>
            <input className={input} type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
          </label>
        )}
        {kind === "at" && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ds-muted">At</span>
            <input className={input} type="datetime-local" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
          </label>
        )}
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ds-muted">Workspace (optional)</span>
          <input className={input} value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} placeholder="/absolute/path" />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-full bg-zinc-950 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create task"}
        </button>
      </div>
    </div>
  );
}
