// Agents (智能体) — the agent directory. A curated, editable catalog of
// scenario-orchestration agents (场景编排): each combines connector + plugin
// tool access under a named card with a tool whitelist (工具白名单), trigger
// methods (触发方式), a category, and a per-agent visibility flag (会话可选 /
// 已隐藏) controlling whether it appears in a session's agent selector. Backed by
// GET/POST/PATCH/DELETE /v1/agents. Faithful to the original AgentMatrixView,
// plus create/edit/delete so agents can be authored here.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client.js";
import { useNav } from "../../store/nav.js";
import type { AgentDefinition, AgentTrigger, AgentCreateRequest } from "../../api/types.js";

const ACCENT = "#0088ff";
const CATEGORIES = ["研发", "办公", "数据"];

function categoryBadgeClass(category: string): string {
  switch (category) {
    case "研发":
      return "bg-sky-50 text-sky-700";
    case "办公":
      return "bg-amber-50 text-amber-700";
    case "数据":
      return "bg-violet-50 text-violet-700";
    default:
      return "bg-ds-subtle text-ds-muted";
  }
}

const triggerLabel: Record<AgentTrigger["kind"], string> = {
  command: "命令",
  event: "事件",
  schedule: "定时",
};

/** Parse a triggers textarea (one "kind value" per line) into structured triggers. */
function parseTriggers(text: string): AgentTrigger[] {
  const triggers: AgentTrigger[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/\s+/);
    const kind = (["command", "event", "schedule"] as const).find((k) => k === first);
    if (kind && rest.length > 0) {
      triggers.push({ kind, value: rest.join(" ") });
    } else {
      // No explicit kind → treat the whole line as a command value.
      triggers.push({ kind: "command", value: line.startsWith("/") ? line : `/${line}` });
    }
  }
  return triggers;
}

/** Render structured triggers back into the textarea format. */
function triggersToText(triggers: AgentTrigger[]): string {
  return triggers.map((t) => `${t.kind} ${t.value}`).join("\n");
}

interface DraftState {
  name: string;
  subtitle: string;
  category: string;
  description: string;
  tools: string;
  triggers: string;
  visible: boolean;
}

function emptyDraft(): DraftState {
  return { name: "", subtitle: "", category: "研发", description: "", tools: "", triggers: "", visible: true };
}

function draftFrom(agent: AgentDefinition): DraftState {
  return {
    name: agent.name,
    subtitle: agent.subtitle,
    category: agent.category,
    description: agent.description,
    tools: agent.tools.join(" "),
    triggers: triggersToText(agent.triggers),
    visible: agent.visible,
  };
}

function draftToRequest(draft: DraftState): AgentCreateRequest {
  return {
    name: draft.name.trim(),
    subtitle: draft.subtitle.trim(),
    category: draft.category.trim() || "研发",
    description: draft.description.trim(),
    tools: draft.tools
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean),
    triggers: parseTriggers(draft.triggers),
    visible: draft.visible,
  };
}

/** Create / edit modal. */
function AgentEditor({
  initial,
  title,
  onCancel,
  onSubmit,
}: {
  initial: DraftState;
  title: string;
  onCancel: () => void;
  onSubmit: (req: AgentCreateRequest) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<DraftState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]): void => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (): Promise<void> => {
    if (!draft.name.trim()) {
      setError("名称不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draftToRequest(draft));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-ds-border-strong";

  return (
    <div className="ds-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onCancel}>
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-ds-ink">{title}</h2>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink" aria-label="关闭">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ds-muted">名称 *</span>
              <input className={field} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="MR 评审官" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ds-muted">分类</span>
              <input className={field} value={draft.category} onChange={(e) => set("category", e.target.value)} list="agent-categories" placeholder="研发" />
              <datalist id="agent-categories">
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">副标题</span>
            <input className={field} value={draft.subtitle} onChange={(e) => set("subtitle", e.target.value)} placeholder="GitLab + 本地仓库" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">描述</span>
            <textarea className={field + " min-h-[64px] resize-y"} value={draft.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">工具白名单（空格或逗号分隔）</span>
            <input className={field} value={draft.tools} onChange={(e) => set("tools", e.target.value)} placeholder="read bash gitlab_get_mr" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ds-muted">触发方式（每行一个：command/event/schedule + 值）</span>
            <textarea
              className={field + " min-h-[64px] resize-y font-mono text-[12px]"}
              value={draft.triggers}
              onChange={(e) => set("triggers", e.target.value)}
              placeholder={"command /mr-review\nevent mr_opened\nschedule 每周五 17:00"}
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.visible} onChange={(e) => set("visible", e.target.checked)} className="h-4 w-4" />
            <span className="text-[13px] text-ds-ink">在会话的智能体选择器中可选（会话可选）</span>
          </label>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ds-border px-5 py-3">
          <button type="button" onClick={onCancel} className="inline-flex h-9 items-center rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:bg-ds-hover">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="inline-flex h-9 items-center rounded-xl px-4 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

const boxesIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 1.03 1.75l3 1.65a2 2 0 0 0 1.94 0L10 20v-5l-3.07-1.68a1 1 0 0 0-.98 0z" />
    <path d="M7 16.5 4 15v-3" />
    <path d="M12 12.92a2 2 0 0 0-.97 1.71v3.24a2 2 0 0 0 1.03 1.75l3 1.65a2 2 0 0 0 1.94 0L20 20v-5l-3.07-1.68a1 1 0 0 0-.98 0z" />
    <path d="M17 16.5 14 15v-3" />
    <path d="M7.5 4.27 12 6.6l4.5-2.33" />
    <path d="M7 8.27a2 2 0 0 0-1 1.73v3.24a2 2 0 0 0 1 1.73l3 1.65a2 2 0 0 0 2 0l3-1.65a2 2 0 0 0 1-1.73V10a2 2 0 0 0-1-1.73L12 6.6z" />
  </svg>
);

export function AgentMatrixView(): JSX.Element {
  const setView = useNav((s) => s.setView);
  // Pad the header when the sidebar is collapsed so AppShell's floating expand
  // button doesn't overlap the title (matches the Workbench pattern).
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("全部");
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const { agents: list } = await api.listAgents();
      setAgents(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const flash = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1);
    return [...counts.entries()];
  }, [agents]);

  const visibleCount = agents.filter((a) => a.visible).length;
  const shown = filter === "全部" ? agents : agents.filter((a) => a.category === filter);

  const toggleVisible = async (agent: AgentDefinition): Promise<void> => {
    try {
      const { agent: updated } = await api.updateAgent(agent.id, { visible: !agent.visible });
      setAgents((list) => list.map((a) => (a.id === updated.id ? updated : a)));
      flash(updated.visible ? `已将「${updated.name}」显示到会话` : `已隐藏「${updated.name}」`);
    } catch (e) {
      flash(`操作失败：${(e as Error).message}`);
    }
  };

  const remove = async (agent: AgentDefinition): Promise<void> => {
    if (!window.confirm(`删除智能体「${agent.name}」？`)) return;
    try {
      await api.deleteAgent(agent.id);
      setAgents((list) => list.filter((a) => a.id !== agent.id));
      flash(`已删除「${agent.name}」`);
    } catch (e) {
      flash(`删除失败：${(e as Error).message}`);
    }
  };

  const submitCreate = async (req: AgentCreateRequest): Promise<void> => {
    const { agent } = await api.createAgent(req);
    setAgents((list) => [...list, agent]);
    setCreating(false);
    flash(`已创建「${agent.name}」`);
  };

  const submitEdit = async (req: AgentCreateRequest): Promise<void> => {
    if (!editing) return;
    const { agent } = await api.updateAgent(editing.id, req);
    setAgents((list) => list.map((a) => (a.id === agent.id ? agent : a)));
    setEditing(null);
    flash(`已更新「${agent.name}」`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-main">
      {/* Header */}
      <div className="ds-no-drag flex shrink-0 items-center justify-between gap-3 border-b border-ds-border bg-ds-main px-4 py-3" style={sidebarCollapsed ? { paddingLeft: 56 } : undefined}>
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-semibold text-ds-ink">智能体</h1>
          <p className="mt-0.5 truncate text-[12.5px] text-ds-muted">
            智能体目录：控制哪些智能体出现在会话的选择器里；组合连接器与插件能力。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ background: ACCENT }}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            新建智能体
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            刷新
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-5">
          {toast && (
            <div className="rounded-xl border px-3 py-2 text-[13px]" style={{ borderColor: "rgba(110,231,183,.7)", background: "#ecfdf5", color: "#065f46" }}>
              {toast}
            </div>
          )}

          {/* info banner */}
          <div className="rounded-xl border border-ds-border bg-ds-card px-4 py-2.5 text-[12.5px] text-ds-muted shadow-sm">
            智能体 = 场景编排，组合连接器与插件能力；连接凭证在
            <button type="button" onClick={() => setView("connectors")} className="mx-0.5 font-semibold text-accent underline-offset-2 hover:underline">
              连接器
            </button>
            配置，定时触发在「定时任务」配置。
          </div>

          {/* count summary */}
          <div className="rounded-xl border border-ds-border bg-ds-card px-4 py-3 text-[13px] text-ds-muted shadow-sm">
            <span>
              共 <span className="font-semibold text-ds-ink">{agents.length}</span> 个智能体，其中{" "}
              <span className="font-semibold text-ds-ink">{visibleCount}</span> 个会出现在会话的智能体选择器中。
            </span>
          </div>

          {error && <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">{error}</div>}

          {/* category filter chips */}
          {agents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip label="全部" count={agents.length} active={filter === "全部"} onClick={() => setFilter("全部")} />
              {categories.map(([cat, count]) => (
                <FilterChip key={cat} label={cat} count={count} active={filter === cat} onClick={() => setFilter(cat)} />
              ))}
            </div>
          )}

          {/* grid */}
          {loading ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-ds-border bg-ds-card/60 px-6 py-12 text-center text-[13px] text-ds-muted">
              加载中…
            </div>
          ) : agents.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-ds-border bg-ds-card/60 px-6 py-12 text-center">
              <div className="text-[14px] font-semibold text-ds-ink">还没有智能体</div>
              <p className="mt-1.5 max-w-md text-[13px] leading-6 text-ds-muted">点击「新建智能体」创建一个场景编排智能体，组合工具白名单与触发方式。</p>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mt-4 inline-flex h-9 items-center rounded-xl px-4 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
                style={{ background: ACCENT }}
              >
                新建智能体
              </button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((agent) => (
                <AgentCard key={agent.id} agent={agent} onToggle={() => void toggleVisible(agent)} onEdit={() => setEditing(agent)} onDelete={() => void remove(agent)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && <AgentEditor title="新建智能体" initial={emptyDraft()} onCancel={() => setCreating(false)} onSubmit={submitCreate} />}
      {editing && <AgentEditor title={`编辑「${editing.name}」`} initial={draftFrom(editing)} onCancel={() => setEditing(null)} onSubmit={submitEdit} />}
    </div>
  );
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex h-8 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-semibold transition " +
        (active ? "text-accent" : "border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover")
      }
      style={active ? { borderColor: "rgba(0,136,255,.6)", background: "rgba(0,136,255,.1)", color: ACCENT } : undefined}
    >
      {label} <span className={"text-[11px] " + (active ? "" : "text-ds-faint")}>{count}</span>
    </button>
  );
}

function AgentCard({
  agent,
  onToggle,
  onEdit,
  onDelete,
}: {
  agent: AgentDefinition;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <article
      className="flex min-w-0 flex-col rounded-xl border bg-ds-card p-4 shadow-sm transition"
      style={agent.visible ? { borderColor: "rgba(0,136,255,.6)", boxShadow: "0 0 0 1px rgba(0,136,255,.3),0 1px 2px rgba(0,0,0,.05)" } : { opacity: 0.85 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-ds-border bg-ds-main text-ds-muted">{boxesIcon}</span>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ds-ink">{agent.name}</h2>
            {agent.subtitle && <p className="truncate text-[12px] text-ds-faint">{agent.subtitle}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold " + categoryBadgeClass(agent.category)}>{agent.category}</span>
          {agent.visible ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              会话可选
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] font-semibold text-ds-faint">已隐藏</span>
          )}
        </div>
      </div>

      {agent.description && <p className="mt-3 text-[13px] leading-5 text-ds-muted">{agent.description}</p>}

      {agent.tools.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">工具白名单</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {agent.tools.map((tool) => (
              <span key={tool} className="rounded-full border border-ds-border-muted bg-ds-subtle px-2 py-0.5 font-mono text-[11px] text-ds-muted">
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {agent.triggers.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ds-faint">触发方式</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {agent.triggers.map((trigger, index) => (
              <span key={index} className="inline-flex items-center gap-1 rounded-full border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted">
                <span className="text-ds-faint">{triggerLabel[trigger.kind]}</span>
                <span className="font-mono">{trigger.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-red-600 shadow-sm transition hover:bg-red-50"
          title="删除该智能体"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          删除
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover"
          title="编辑该智能体"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          编辑
        </button>
        {agent.visible ? (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover"
            title="在会话的智能体选择器中隐藏该智能体"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <path d="m2 2 20 20" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            </svg>
            隐藏
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ background: ACCENT }}
            title="让该智能体可在会话中被选择"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            显示到会话
          </button>
        )}
      </div>
    </article>
  );
}
