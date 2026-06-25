import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store.js";
import type { InsightFeedbackToast, Suggestion } from "../api/types.js";

/*
 * Proactive insight center — a floating overlay driven by SSE `suggestion`
 * events. Faithful in shape to the original Nexus insight center: a bell badge
 * with a count, an expandable list of all suggestions, a stack of per-suggestion
 * toasts (Edit / Write), feedback toasts, and a per-detector detail-edit modal.
 *
 * DEVIATION FROM ORIGINAL: the original's "Write" action POSTs
 * `feishu_create_artifact` to create a real Feishu doc/sheet/calendar event. The
 * open-source agent backend has no such endpoint, so accept degrades to a LOCAL
 * action: apply the (edited) draft, surface a success feedback toast + banner,
 * and dismiss the suggestion. The accept() seam returns a {ok,message,url?}
 * result so a real network call can be dropped in later without UI changes.
 */

/* ----------------------------------------------------------- detector glyphs */

function DetectorIcon({ detector, className }: { detector: string; className?: string }): JSX.Element {
  const cls = className ?? "h-4 w-4";
  if (detector === "meeting_alignment") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    );
  }
  if (detector === "data_to_sheet") {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      </svg>
    );
  }
  // knowledge_capture (and fallback)
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function detectorLabel(detector: string): string {
  switch (detector) {
    case "meeting_alignment":
      return "Meeting alignment";
    case "data_to_sheet":
      return "Data → sheet";
    case "knowledge_capture":
      return "Knowledge capture";
    default:
      return detector || "Insight";
  }
}

/* ------------------------------------------------------- editable field model */

interface DraftField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number";
}

/** Editable fields per detector, faithful to the original `rm(detector,target)`. */
function fieldsFor(detector: string, target: string): DraftField[] {
  if (detector === "meeting_alignment") {
    return [
      { key: "summary", label: "Summary", kind: "text" },
      { key: "agenda", label: "Agenda", kind: "textarea" },
      { key: "durationMinutes", label: "Duration (minutes)", kind: "number" },
    ];
  }
  if (detector === "data_to_sheet") {
    return [
      { key: "title", label: "Title", kind: "text" },
      target === "doc"
        ? { key: "markdown", label: "Document", kind: "textarea" }
        : { key: "markdownTable", label: "Table (markdown)", kind: "textarea" },
    ];
  }
  // knowledge_capture
  return [
    { key: "title", label: "Title", kind: "text" },
    { key: "markdown", label: "Document", kind: "textarea" },
  ];
}

function draftValue(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/* ------------------------------------------------------------- detail modal */

function InsightModal({
  suggestion,
  onClose,
  onAccept,
}: {
  suggestion: Suggestion;
  onClose: () => void;
  onAccept: (s: Suggestion, payload: Record<string, unknown>, target: string) => Promise<void>;
}): JSX.Element {
  // data_to_sheet can write either a doc or a sheet; others have a single target.
  const [target, setTarget] = useState<string>(suggestion.detector === "data_to_sheet" ? "sheet" : "default");
  const fields = useMemo(() => fieldsFor(suggestion.detector, target), [suggestion.detector, target]);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of fieldsFor(suggestion.detector, target)) seed[f.key] = draftValue(suggestion.draftPayload, f.key) || (f.key === "title" ? suggestion.title : "");
    return seed;
  });
  const [busy, setBusy] = useState(false);

  const setField = (key: string, value: string): void => setValues((p) => ({ ...p, [key]: value }));

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...suggestion.draftPayload };
      for (const f of fields) {
        payload[f.key] = f.kind === "number" ? Number(values[f.key] ?? "") || 0 : values[f.key] ?? "";
      }
      await onAccept(suggestion, payload, target);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ds-no-drag fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-[18px] border border-ds-border bg-ds-card shadow-[var(--ds-shadow-card-soft)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ds-border-muted px-4 py-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ds-subtle text-ds-muted">
            <DetectorIcon detector={suggestion.detector} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ds-ink">{suggestion.title || detectorLabel(suggestion.detector)}</div>
            <div className="text-[12px] text-ds-faint">{detectorLabel(suggestion.detector)}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {suggestion.detector === "data_to_sheet" && (
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-ds-muted">Write as</span>
              <div className="flex rounded-full border border-ds-border-muted p-0.5">
                {["sheet", "doc"].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTarget(t)}
                    className={"rounded-full px-3 py-1 text-[12px] font-medium transition " + (target === t ? "bg-accent/10 text-accent" : "text-ds-muted hover:text-ds-ink")}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ds-muted">{f.label}</span>
              {f.kind === "textarea" ? (
                <textarea
                  rows={6}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className="w-full resize-y rounded-lg border border-ds-border-muted bg-ds-main px-3 py-2 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              ) : (
                <input
                  type={f.kind === "number" ? "number" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className="w-full rounded-lg border border-ds-border-muted bg-ds-main px-3 py-2 text-[13px] text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              )}
            </label>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ds-border-muted px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="rounded-full bg-zinc-950 px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? "Writing…" : "Write"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- main center */

export function InsightCenter(): JSX.Element | null {
  const suggestionsByThread = useStore((s) => s.suggestionsByThread);
  const insightToasts = useStore((s) => s.insightToasts);
  const activeInsightId = useStore((s) => s.activeInsightId);
  const threads = useStore((s) => s.threads);
  const openInsight = useStore((s) => s.openInsight);
  const closeInsight = useStore((s) => s.closeInsight);
  const dismissInsightToast = useStore((s) => s.dismissInsightToast);
  const dismissSuggestion = useStore((s) => s.dismissSuggestion);
  const setBanner = useStore((s) => s.setBanner);

  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<InsightFeedbackToast[]>([]);

  // Auto-dismiss feedback toasts after a short delay. Each toast gets exactly
  // ONE timer, scheduled the first time it appears and keyed by id — so adding a
  // new toast doesn't reset the countdown of the ones already on screen.
  const toastTimers = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const t of feedback) {
      if (toastTimers.current[t.id] != null) continue;
      toastTimers.current[t.id] = window.setTimeout(() => {
        delete toastTimers.current[t.id];
        setFeedback((prev) => prev.filter((x) => x.id !== t.id));
      }, 6000);
    }
  }, [feedback]);
  // Clear any outstanding timers on unmount.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => Object.values(timers).forEach((id) => window.clearTimeout(id));
  }, []);

  const allSuggestions = useMemo(
    () =>
      Object.values(suggestionsByThread)
        .flat()
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [suggestionsByThread],
  );
  const byId = useMemo(() => {
    const map = new Map<string, Suggestion>();
    for (const s of allSuggestions) map.set(s.suggestionId, s);
    return map;
  }, [allSuggestions]);
  const toastList = useMemo(
    () => insightToasts.map((id) => byId.get(id)).filter((s): s is Suggestion => Boolean(s)),
    [insightToasts, byId],
  );
  const active = activeInsightId ? byId.get(activeInsightId) ?? null : null;

  const sessionTitle = (threadId: string): string => threads.find((t) => t.id === threadId)?.title || "this session";

  // Local accept seam (see header comment). Returns a result so a future network
  // call can replace the body without touching callers.
  const accept = async (
    s: Suggestion,
    _payload: Record<string, unknown>,
    _target: string,
  ): Promise<{ ok: boolean; message: string; url?: string }> => {
    const result = { ok: true, message: `Insight applied: ${s.title || detectorLabel(s.detector)}` };
    dismissSuggestion(s.threadId, s.suggestionId);
    setBanner(result.message);
    const id = `fb_${s.suggestionId}_${(insightToasts.length + feedback.length).toString(36)}`;
    setFeedback((prev) => [...prev, { id, ok: result.ok, message: result.message, createdAt: new Date().toISOString() }]);
    return result;
  };

  // The badge counts only actionable suggestions — i.e. what the expandable
  // dropdown actually lists. Feedback toasts are transient confirmations
  // rendered separately below, so they keep the panel mounted (the return-null
  // guard) but must not inflate the badge (which would open an empty dropdown).
  const suggestionCount = allSuggestions.length;
  if (suggestionCount === 0 && feedback.length === 0 && !active) return null;

  return (
    <div className="ds-no-drag pointer-events-none fixed right-3 top-3 z-[80] flex w-[340px] flex-col items-end gap-2">
      {/* badge */}
      <div className="pointer-events-auto relative">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title="Insights"
          aria-label="Insights"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted shadow-[var(--ds-shadow-card-soft)] transition hover:bg-ds-hover hover:text-ds-ink"
        >
          <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </button>
        {suggestionCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white">
            {suggestionCount}
          </span>
        )}

        {/* expandable list */}
        {expanded && allSuggestions.length > 0 && (
          <div className="absolute right-0 top-11 max-h-[18rem] w-[320px] overflow-y-auto rounded-[16px] border border-ds-border bg-ds-card p-1.5 shadow-[var(--ds-shadow-card-soft)]">
            {allSuggestions.map((s) => (
              <div
                key={s.suggestionId}
                className="group flex cursor-pointer items-start gap-2 rounded-[12px] px-2 py-2 transition hover:bg-ds-hover"
                onClick={() => {
                  openInsight(s.suggestionId);
                  setExpanded(false);
                }}
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ds-subtle text-ds-muted">
                  <DetectorIcon detector={s.detector} className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ds-ink">{s.title || detectorLabel(s.detector)}</div>
                  <div className="truncate text-[11.5px] text-ds-faint">{sessionTitle(s.threadId)}</div>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="shrink-0 rounded p-1 text-ds-faint opacity-0 transition hover:bg-ds-hover hover:text-ds-ink group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissSuggestion(s.threadId, s.suggestionId);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* per-suggestion toasts */}
      {toastList.map((s) => (
        <div
          key={s.suggestionId}
          className="pointer-events-auto w-full rounded-[14px] border border-ds-border bg-ds-card p-3 shadow-[var(--ds-shadow-card-soft)]"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ds-subtle text-ds-muted">
              <DetectorIcon detector={s.detector} className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ds-ink">{s.title || detectorLabel(s.detector)}</div>
              <div className="truncate text-[11.5px] text-ds-faint">{detectorLabel(s.detector)} · {sessionTitle(s.threadId)}</div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              onClick={() => dismissInsightToast(s.suggestionId)}
            >
              ✕
            </button>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => openInsight(s.suggestionId)}
              className="rounded-full px-3 py-1 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => void accept(s, s.draftPayload, s.detector === "data_to_sheet" ? "sheet" : "default")}
              className="rounded-full bg-zinc-950 px-3 py-1 text-[12px] font-medium text-white transition hover:bg-zinc-800"
            >
              Write
            </button>
          </div>
        </div>
      ))}

      {/* feedback toasts */}
      {feedback.map((f) => (
        <div
          key={f.id}
          className="pointer-events-auto flex w-full items-center gap-2 rounded-[12px] border border-ds-border bg-ds-card px-3 py-2 text-[12.5px] shadow-[var(--ds-shadow-card-soft)]"
        >
          <span className={f.ok ? "text-emerald-600" : "text-red-500"}>{f.ok ? "✓" : "!"}</span>
          <span className="min-w-0 flex-1 truncate text-ds-muted">{f.message}</span>
          {f.url && (
            <a href={f.url} target="_blank" rel="noreferrer" className="shrink-0 text-accent hover:underline">
              open
            </a>
          )}
          <button type="button" aria-label="Dismiss" className="shrink-0 text-ds-faint hover:text-ds-ink" onClick={() => setFeedback((prev) => prev.filter((x) => x.id !== f.id))}>
            ✕
          </button>
        </div>
      ))}

      {/* detail-edit modal */}
      {active && (
        <InsightModal
          suggestion={active}
          onClose={closeInsight}
          onAccept={async (s, payload, target) => {
            await accept(s, payload, target);
          }}
        />
      )}
    </div>
  );
}
