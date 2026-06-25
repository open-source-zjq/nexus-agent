import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store/store.js";
import { api } from "../../api/client.js";
import type { LlmRound, DailyUsageReport, DailyUsageBucket, ModelUsageBucket } from "../../api/types.js";

/** Shared right-rail shell: collapsible header + scrollable body (matches the
 *  Goal/Changes/Todo docked panels). */
function PanelShell({
  title,
  onCollapse,
  actions,
  children,
}: {
  title: string;
  onCollapse?: () => void;
  actions?: JSX.Element;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <aside className="ds-no-drag flex h-full max-h-full min-h-0 w-full flex-col border-l border-ds-border-muted bg-white dark:bg-ds-canvas">
      <div className="shrink-0 border-b border-ds-border-muted bg-ds-card">
        <div className="flex h-12 min-w-0 items-center gap-2 px-4">
          <button type="button" className="ds-sidebar-toggle-button shrink-0" aria-label="Collapse" title="Collapse" onClick={onCollapse}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ds-ink">{title}</span>
          {actions}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </aside>
  );
}

const ghostBtn = "rounded-lg border border-ds-border bg-ds-card px-2.5 py-1 text-[12px] font-medium text-ds-ink transition hover:bg-ds-hover";

/* --------------------------------------------------------------- memory (T3.7) */

export function MemoryPanelView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const memory = useStore((s) => s.memory);
  const loadMemory = useStore((s) => s.loadMemory);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  const search = (): void => void loadMemory(query.trim() || undefined);
  const create = async (): Promise<void> => {
    if (!content.trim()) return;
    try {
      await api.createMemory({ content: content.trim(), scope: "user" });
      setContent("");
      setAdding(false);
      void loadMemory(query.trim() || undefined);
    } catch {
      /* ignore */
    }
  };
  const toggle = async (id: string, disabled: boolean): Promise<void> => {
    try {
      await api.updateMemory(id, { disabled: !disabled });
      void loadMemory(query.trim() || undefined);
    } catch {
      /* ignore */
    }
  };
  const remove = async (id: string): Promise<void> => {
    try {
      await api.deleteMemory(id);
      void loadMemory(query.trim() || undefined);
    } catch {
      /* ignore */
    }
  };

  return (
    <PanelShell title="Memory" onCollapse={onCollapse} actions={<button type="button" className={ghostBtn} onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add"}</button>}>
      <div className="mb-3 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search memories"
          className="w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <button type="button" className={ghostBtn} onClick={search}>Search</button>
      </div>
      {adding && (
        <div className="mb-3 rounded-xl border border-ds-border bg-ds-card p-2">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="A durable fact to remember…" className="w-full resize-y rounded-lg border border-ds-border-muted bg-ds-main/50 px-2 py-1.5 text-[13px] focus:outline-none" />
          <div className="mt-2 flex justify-end">
            <button type="button" className="rounded-lg bg-zinc-950 px-3 py-1 text-[12px] font-medium text-white transition hover:bg-zinc-800" onClick={() => void create()}>Save</button>
          </div>
        </div>
      )}
      {memory.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-ds-faint">No memories.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {memory.map((m) => (
            <div key={m.id} className={`rounded-xl border border-ds-border bg-ds-card px-3 py-2 ${m.disabledAt ? "opacity-50" : ""}`}>
              <div className="text-[13px] text-ds-ink">{m.content}</div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-ds-faint">
                <span>{m.scope}{m.tags.length ? ` · ${m.tags.join(", ")}` : ""}</span>
                <span className="flex gap-2">
                  <button type="button" className="hover:text-ds-ink" onClick={() => void toggle(m.id, Boolean(m.disabledAt))}>{m.disabledAt ? "Enable" : "Disable"}</button>
                  <button type="button" className="text-red-500 hover:underline" onClick={() => void remove(m.id)}>Delete</button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

/* ---------------------------------------------------------------- usage (T3.6) */

export function UsagePanelView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const usage = useStore((s) => s.usage);
  const refreshUsage = useStore((s) => s.refreshUsage);
  const [daily, setDaily] = useState<DailyUsageReport | null>(null);
  const [modelBuckets, setModelBuckets] = useState<ModelUsageBucket[]>([]);
  const [heatmapOpen, setHeatmapOpen] = useState(true);

  const tz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }, []);

  const refreshAll = useMemo(
    () => async (): Promise<void> => {
      void refreshUsage();
      try {
        const d = await api.usageDaily({ window: "all", tz });
        setDaily(d);
        // Per-model breakdown over the same window the daily report resolved
        // (group_by=model needs an explicit from/to, unlike the day grouping).
        try {
          const m = await api.usageByModel({ from: d.from, to: d.to, tz });
          setModelBuckets(m.buckets ?? []);
        } catch {
          setModelBuckets([]);
        }
      } catch {
        /* daily heatmap is best-effort; the summary stats still render */
      }
    },
    [refreshUsage, tz],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const maxModelTokens = useMemo(() => Math.max(1, ...modelBuckets.map((b) => b.total_tokens)), [modelBuckets]);
  const cacheRate = usage && usage.promptTokens > 0 ? Math.round((usage.cacheReadTokens / usage.promptTokens) * 100) : 0;

  return (
    <PanelShell title="Usage" onCollapse={onCollapse} actions={<button type="button" className={ghostBtn} onClick={() => void refreshAll()}>Refresh</button>}>
      {!usage ? (
        <div className="py-8 text-center text-[13px] text-ds-faint">No usage yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Total tokens" value={fmt(usage.totalTokens)} />
            <Stat label="Cost (USD)" value={usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : "—"} />
            <Stat label="Cached" value={`${fmt(usage.cacheReadTokens)} (${cacheRate}%)`} />
            <Stat label="Turns" value={String(usage.requests)} />
          </div>

          {/* Daily calendar heatmap (group_by=day) — collapsible. */}
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              className="flex items-center gap-1 text-[12px] font-semibold text-ds-muted hover:text-ds-ink"
              onClick={() => setHeatmapOpen((v) => !v)}
              aria-expanded={heatmapOpen}
            >
              <svg className={`h-3.5 w-3.5 transition-transform ${heatmapOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              Activity
            </button>
            {daily && <span className="text-[11px] text-ds-faint">{daily.totals.active_days}/{daily.totals.days} active days</span>}
          </div>
          {heatmapOpen && <UsageHeatmap daily={daily} />}

          <div className="mt-4 text-[12px] font-semibold text-ds-muted">Per model</div>
          <div className="mt-2 flex flex-col gap-2">
            {modelBuckets.length === 0 ? (
              <div className="text-[12px] text-ds-faint">No per-model data.</div>
            ) : (
              modelBuckets.map((b) => (
                <div key={b.model}>
                  <div className="flex justify-between text-[12px] text-ds-muted">
                    <span className="truncate">{b.model}</span>
                    <span className="tabular-nums">{fmt(b.total_tokens)}</span>
                  </div>
                  <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-ds-subtle">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((b.total_tokens / maxModelTokens) * 100)}%` }} />
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </PanelShell>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-ds-border bg-ds-card px-3 py-2">
      <div className="text-[11px] text-ds-faint">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums text-ds-ink">{value}</div>
    </div>
  );
}

/** Parse a `YYYY-MM-DD` string into a UTC-midnight Date. */
function parseUtcDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const HEATMAP_SCALE = ["#bfdbfe", "#60a5fa", "#3b82f6", "#1d4ed8"];
function heatColor(tokens: number, max: number): string | null {
  if (tokens <= 0) return null; // empty → rendered with bg-ds-subtle
  const r = tokens / max;
  const level = r > 0.66 ? 3 : r > 0.33 ? 2 : r > 0.1 ? 1 : 0;
  return HEATMAP_SCALE[level];
}

/**
 * GitHub-style calendar heatmap of daily token usage (group_by=day). Columns are
 * weeks (Sunday-aligned), rows are weekdays; cell intensity scales with the
 * day's total tokens. Below it: the windowed totals the spec calls for
 * (input/output/reasoning/cached/cost/cache savings/hit rate).
 */
function UsageHeatmap({ daily }: { daily: DailyUsageReport | null }): JSX.Element {
  const WEEKS = 18;
  const grid = useMemo(() => {
    if (!daily || daily.buckets.length === 0) return null;
    const byDate = new Map<string, DailyUsageBucket>(daily.buckets.map((b) => [b.date, b]));
    const max = Math.max(1, ...daily.buckets.map((b) => b.total_tokens));
    const end = parseUtcDate(daily.to);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (WEEKS * 7 - 1));
    // Pad the front so the first column starts on Sunday (getUTCDay() === 0).
    const lead = start.getUTCDay();
    const cells: (DailyUsageBucket | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    const cursor = new Date(start);
    while (cursor <= end) {
      cells.push(byDate.get(utcDateString(cursor)) ?? null);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const columns: (DailyUsageBucket | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) columns.push(cells.slice(i, i + 7));
    return { columns, max };
  }, [daily]);

  if (!daily) return <div className="mt-2 text-[12px] text-ds-faint">Loading activity…</div>;
  if (!grid) return <div className="mt-2 text-[12px] text-ds-faint">No daily activity yet.</div>;

  const t = daily.totals;
  const hitRate = t.cache_hit_rate != null ? `${Math.round(t.cache_hit_rate * 100)}%` : "—";
  return (
    <div className="mt-2">
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {grid.columns.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-[3px]">
            {col.map((cell, ri) => {
              const color = cell ? heatColor(cell.total_tokens, grid.max) : null;
              return (
                <div
                  key={ri}
                  title={cell ? `${cell.date}: ${fmt(cell.total_tokens)} tok${cell.cost_usd ? ` · $${cell.cost_usd.toFixed(4)}` : ""}` : undefined}
                  className={`h-[10px] w-[10px] rounded-[2px] ${color ? "" : "bg-ds-subtle"}`}
                  style={color ? { backgroundColor: color } : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-ds-faint">
        <span>Less</span>
        <span className="h-[9px] w-[9px] rounded-[2px] bg-ds-subtle" />
        {HEATMAP_SCALE.map((c) => (
          <span key={c} className="h-[9px] w-[9px] rounded-[2px]" style={{ backgroundColor: c }} />
        ))}
        <span>More</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
        <Detail label="Input" value={fmt(t.input_tokens)} />
        <Detail label="Output" value={fmt(t.output_tokens)} />
        <Detail label="Reasoning" value={fmt(t.reasoning_tokens)} />
        <Detail label="Cached" value={fmt(t.cached_tokens)} />
        <Detail label="Cost" value={`$${t.cost_usd.toFixed(4)}`} />
        <Detail label="Cache saved" value={`$${t.cache_savings_usd.toFixed(4)}`} />
        <Detail label="Hit rate" value={hitRate} />
        <Detail label="Econ. saved" value={fmt(t.token_economy_savings_tokens)} />
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ds-faint">{label}</span>
      <span className="tabular-nums text-ds-muted">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------ llm rounds (T3.8) */

export function LlmRoundsPanelView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const currentThreadId = useStore((s) => s.currentThreadId);
  const [rounds, setRounds] = useState<LlmRound[]>([]);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { rounds } = await api.llmRounds(currentThreadId ?? undefined);
      setRounds(rounds);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rounds;
    return rounds.filter((r) => `${r.model} ${r.stopReason ?? ""} ${r.error ?? ""}`.toLowerCase().includes(q));
  }, [rounds, query]);

  return (
    <PanelShell title="LLM rounds" onCollapse={onCollapse} actions={<button type="button" className={ghostBtn} onClick={() => void refresh()}>Refresh</button>}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by model / stop reason / error"
        className="mb-3 w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      {filtered.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-ds-faint">No rounds recorded.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((r) => (
            <div key={r.id} className="rounded-xl border border-ds-border bg-ds-card px-3 py-2">
              <button type="button" onClick={() => setOpenId((id) => (id === r.id ? null : r.id))} className="flex w-full items-center justify-between text-left">
                <span className="min-w-0 truncate text-[13px] font-medium text-ds-ink">#{r.id} {r.model}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${r.error ? "bg-red-100 text-red-700" : "bg-ds-subtle text-ds-faint"}`}>{r.error ? "error" : r.stopReason ?? "—"}</span>
              </button>
              {openId === r.id && (
                <div className="mt-2 space-y-1 text-[11.5px] text-ds-muted">
                  <div>system: {r.requestSummary.systemPromptChars} chars · history: {r.requestSummary.historyItems} · tools: {r.requestSummary.toolCount}{r.requestSummary.reasoningEffort ? ` · effort: ${r.requestSummary.reasoningEffort}` : ""}</div>
                  {r.usage && <div>tokens: {fmt(r.usage.totalTokens)} (in {fmt(r.usage.promptTokens)} / out {fmt(r.usage.completionTokens)})</div>}
                  {r.durationMs !== undefined && <div>duration: {r.durationMs} ms</div>}
                  {r.error && <div className="text-red-500">{r.error}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function fmt(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
