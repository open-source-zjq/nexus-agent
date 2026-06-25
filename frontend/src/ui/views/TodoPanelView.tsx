import { useStore } from "../../store/store.js";
import type { ThreadTodoItem } from "../../api/types.js";

/** lucide: circle-check (completed) */
function CompletedIcon(): JSX.Element {
  return (
    <svg
      className="h-[18px] w-[18px] text-emerald-600"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** lucide: circle-play (in_progress) */
function ActiveIcon(): JSX.Element {
  return (
    <svg
      className="h-[18px] w-[18px] text-amber-600"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  );
}

/** lucide: circle (pending) */
function PendingIcon(): JSX.Element {
  return (
    <svg
      className="h-[18px] w-[18px]"
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

type TodoStatus = ThreadTodoItem["status"];

/** The three status pills under each card; clicking one sets that status. */
function StatusPills({ status, onSet }: { status: TodoStatus; onSet: (status: TodoStatus) => void }): JSX.Element {
  const activeStyle = { background: "color-mix(in srgb,var(--ds-accent,#0088ff) 12%,transparent)" };
  const pill = (target: TodoStatus, label: string): JSX.Element => {
    const isActive = status === target;
    return (
      <button
        type="button"
        onClick={() => {
          if (!isActive) onSet(target);
        }}
        aria-pressed={isActive}
        className={
          "rounded-full px-2 py-1 text-[11px] font-medium transition " +
          (isActive ? "text-accent" : "text-ds-faint hover:bg-ds-hover hover:text-ds-ink")
        }
        style={isActive ? activeStyle : undefined}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="mt-2 flex items-center gap-1.5 pl-6">
      {pill("pending", "Pending")}
      {pill("in_progress", "Active")}
      {pill("completed", "Done")}
    </div>
  );
}

/** A single live todo card driven by a ThreadTodoItem. */
function TodoCard({
  todo,
  onToggle,
  onSet,
}: {
  todo: ThreadTodoItem;
  onToggle: () => void;
  onSet: (status: TodoStatus) => void;
}): JSX.Element {
  const isDone = todo.status === "completed";
  return (
    <div
      className="rounded-lg border border-ds-border-muted bg-white px-3 py-2.5 dark:bg-ds-card"
      style={{ boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="mt-0.5 shrink-0 rounded-full text-ds-muted transition hover:text-accent"
          aria-label={isDone ? "Mark pending" : "Mark complete"}
          title={isDone ? "Mark pending" : "Mark complete"}
        >
          {todo.status === "completed" ? <CompletedIcon /> : todo.status === "in_progress" ? <ActiveIcon /> : <PendingIcon />}
        </button>
        <div className="min-w-0 flex-1">
          {isDone ? (
            <div
              className="break-words text-[13px] leading-5 text-ds-faint line-through"
              style={{ textDecorationColor: "rgba(148,163,184,0.6)" }}
            >
              {todo.content}
            </div>
          ) : (
            <div className="break-words text-[13px] leading-5 text-ds-ink">{todo.content}</div>
          )}
        </div>
      </div>
      <StatusPills status={todo.status} onSet={onSet} />
    </div>
  );
}

/** lucide: clipboard-list (empty-state glyph) */
function EmptyIcon(): JSX.Element {
  return (
    <svg
      className="h-7 w-7 text-ds-faint"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

export function TodoPanelView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const thread = useStore((s) => s.thread);
  const editTodos = useStore((s) => s.editTodos);
  const clearTodos = useStore((s) => s.clearTodos);
  const todos = thread?.todos?.items ?? [];

  const hasTodos = todos.length > 0;
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const activeCount = todos.filter((t) => t.status === "in_progress").length;
  const doneCount = todos.filter((t) => t.status === "completed").length;

  /** Persist a status change for one todo (demoting any other in_progress, which
   *  the backend forbids more than one of) via POST /v1/threads/:id/todos. */
  const setStatus = (id: string, status: TodoStatus): void => {
    const next = todos.map((t) => {
      if (t.id === id) return { ...t, status };
      // Only one todo may be in_progress; demote the previous active one.
      if (status === "in_progress" && t.status === "in_progress") return { ...t, status: "pending" as TodoStatus };
      return t;
    });
    void editTodos(next.map((t) => ({ id: t.id, content: t.content, status: t.status })));
  };

  const toggle = (todo: ThreadTodoItem): void => {
    setStatus(todo.id, todo.status === "completed" ? "pending" : "completed");
  };

  return (
    <aside className="ds-no-drag flex h-full max-h-full min-h-0 w-full flex-col border-l border-ds-border-muted bg-white dark:bg-ds-canvas">
        <div className="shrink-0 border-b border-ds-border-muted bg-ds-card">
          <div className="flex h-12 min-w-0 items-center gap-2 px-4">
            <button
              type="button"
              className="ds-sidebar-toggle-button shrink-0"
              aria-label="Collapse right sidebar"
              title="Collapse right sidebar"
              onClick={onCollapse}
            >
              <svg
                className="h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M15 3v18" />
                <path d="m8 9 3 3-3 3" />
              </svg>
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <svg
                className="h-4 w-4 shrink-0 text-accent"
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="5" width="6" height="6" rx="1" />
                <path d="m3 17 2 2 4-4" />
                <path d="M13 6h8" />
                <path d="M13 12h8" />
                <path d="M13 18h8" />
              </svg>
              <span className="truncate text-[13px] font-semibold text-ds-ink">Thread Todo</span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (hasTodos) void clearTodos();
              }}
              disabled={!hasTodos}
              className="rounded-full p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ds-faint"
              aria-label="Clear todos"
              title="Clear todos"
            >
              <svg
                className="h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" x2="10" y1="11" y2="17" />
                <line x1="14" x2="14" y1="11" y2="17" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 px-4 pb-3">
            <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--ds-surface-subtle,#eef2f7)" }}>
              <div className="text-[15px] font-semibold leading-none text-ds-ink">{pendingCount}</div>
              <div className="mt-1 truncate text-[10px] font-medium uppercase tracking-[0.04em] text-ds-faint">Pending</div>
            </div>
            <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--ds-surface-subtle,#eef2f7)" }}>
              <div className="text-[15px] font-semibold leading-none text-ds-ink">{activeCount}</div>
              <div className="mt-1 truncate text-[10px] font-medium uppercase tracking-[0.04em] text-ds-faint">Active</div>
            </div>
            <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--ds-surface-subtle,#eef2f7)" }}>
              <div className="text-[15px] font-semibold leading-none text-ds-ink">{doneCount}</div>
              <div className="mt-1 truncate text-[10px] font-medium uppercase tracking-[0.04em] text-ds-faint">Done</div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {hasTodos ? (
            <div className="space-y-2">
              {todos.map((todo) => (
                <TodoCard key={todo.id} todo={todo} onToggle={() => toggle(todo)} onSet={(status) => setStatus(todo.id, status)} />
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ds-surface-subtle">
                <EmptyIcon />
              </span>
              <div className="text-[13px] font-medium text-ds-ink">No todos for this thread yet</div>
              <p className="mt-1.5 text-[12px] leading-5 text-ds-faint">
                {thread
                  ? "The agent writes a todo list as it plans multi-step work. Todos for this thread will appear here."
                  : "Open or start a thread to track its todos."}
              </p>
            </div>
          )}
        </div>
    </aside>
  );
}
