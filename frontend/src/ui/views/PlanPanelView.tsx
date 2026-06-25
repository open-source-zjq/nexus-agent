// PlanPanel — the SDD (spec-driven development) plan editor (T3.3). A faithful
// port of the original Nexus `PlanPanel`: a Markdown plan editor (TEXTAREA — no
// CodeMirror offline) coupled to a requirement SPEC, with a save state machine
// (debounced autosave via POST /v1/files/write), a spec-coverage chip + Uncovered
// list + spec-changed banner driven by POST /v1/plan/verify, and Draft / Verify /
// Refine / Replan / Build buttons wired to the real /v1/plan/* + /v1/files/*
// endpoints. The plan Markdown is the file that is loaded/saved; the SPEC drives
// coverage. Model-backed ops (draft/refine/replan) degrade to disabled with a
// tooltip when no model is configured (the backend returns 503).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/store.js";
import { useTranslation } from "../../i18n/useTranslation.js";
import { api, ApiError } from "../../api/client.js";
import type { VerifyPlanResult } from "../../api/types.js";

/** The file save lifecycle (mirrors the original `saveStatus`). */
type SaveStatus = "idle" | "saving" | "dirty" | "saved" | "error";
/** The model-backed op lifecycle (mirrors the original `operationStatus`). */
type OperationStatus = "idle" | "drafting" | "refining" | "building";

/** Default reserved plan path (mirrors the backend `.nexus-plan/plan/<feature>.md`). */
const DEFAULT_PLAN_PATH = ".nexus-plan/plan/plan.md";

/** Resolve the status-pill i18n key (faithful port of the original `he`). */
function statusKey(save: SaveStatus, op: OperationStatus): string {
  if (op === "drafting") return "plan.planStatusDrafting";
  if (op === "refining") return "plan.planStatusRefining";
  if (op === "building") return "plan.planStatusBuilding";
  if (op === "idle" && save === "error") return "plan.planStatusError";
  if (save === "saving") return "plan.planStatusSaving";
  if (save === "dirty") return "plan.planStatusDirty";
  if (save === "error") return "plan.planStatusError";
  return "plan.planStatusSaved";
}

export function PlanPanelView({ onCollapse }: { onCollapse?: () => void } = {}): JSX.Element {
  const { t } = useTranslation();
  const thread = useStore((s) => s.thread);
  const currentThreadId = useStore((s) => s.currentThreadId);
  const workspace = useStore((s) => s.thread?.workspace);
  const editTodos = useStore((s) => s.editTodos);
  const models = useStore((s) => s.runtimeInfo?.models ?? []);
  const modelReady = useMemo(() => models.some((m) => m.configured), [models]);

  // The plan path is what we load/save; the spec drives coverage.
  const [planPath, setPlanPath] = useState<string>(DEFAULT_PLAN_PATH);
  const [planMarkdown, setPlanMarkdown] = useState<string>("");
  const [specMarkdown, setSpecMarkdown] = useState<string>("");
  const [refineInput, setRefineInput] = useState<string>("");

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [operationStatus, setOperationStatus] = useState<OperationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [verify, setVerify] = useState<VerifyPlanResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  // The last-saved content; autosave only fires while the editor is `dirty`.
  const savedContentRef = useRef<string>("");
  // Reset everything when the thread changes (per-thread plan file).
  useEffect(() => {
    setPlanPath(DEFAULT_PLAN_PATH);
    setPlanMarkdown("");
    setSpecMarkdown("");
    setRefineInput("");
    setSaveStatus("idle");
    setOperationStatus("idle");
    setError(null);
    setVerify(null);
    setLoaded(false);
    savedContentRef.current = "";
  }, [currentThreadId]);

  // Load the plan file (best-effort: a missing plan simply starts empty).
  useEffect(() => {
    if (!thread || loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await api.retrieveFile(planPath, workspace);
        if (cancelled) return;
        setPlanMarkdown(file.content);
        savedContentRef.current = file.content;
        setSaveStatus("idle");
      } catch (err) {
        // A not-yet-created plan is expected — start with an empty editor.
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setPlanMarkdown("");
          savedContentRef.current = "";
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thread, loaded, planPath, workspace]);

  // Debounced autosave (650ms, faithful to the original) — writes the plan
  // through POST /v1/files/write whenever the editor is `dirty`.
  useEffect(() => {
    if (saveStatus !== "dirty") return;
    const content = planMarkdown;
    const timer = window.setTimeout(() => {
      setSaveStatus("saving");
      void api
        .writeWorkspaceFile({ ...(workspace ? { workspace } : {}), path: planPath, content })
        .then(() => {
          // Only land "saved" if the editor hasn't moved on since.
          setPlanMarkdown((current) => {
            if (current === content) {
              savedContentRef.current = content;
              setSaveStatus("saved");
              setError(null);
            }
            return current;
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setSaveStatus("error");
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [saveStatus, planMarkdown, planPath, workspace]);

  const onPlanChange = (value: string): void => {
    setPlanMarkdown(value);
    setSaveStatus(value === savedContentRef.current ? "idle" : "dirty");
  };

  const busy = operationStatus !== "idle";

  // --- Verify (pure local spec-coverage; always available) ------------------
  const runVerify = useCallback(async (): Promise<void> => {
    if (verifying || busy) return;
    setVerifying(true);
    setError(null);
    try {
      const todoItems = (thread?.todos?.items ?? []).map((it) => ({
        content: it.content,
        status: it.status,
      }));
      const result = await api.verifyPlan({
        specMarkdown,
        planMarkdown,
        planRelativePath: planPath,
        ...(todoItems.length ? { threadTodos: { items: todoItems } } : {}),
      });
      setVerify(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, [verifying, busy, thread?.todos, specMarkdown, planMarkdown, planPath]);

  // --- Draft (model-backed) -------------------------------------------------
  const runDraft = async (): Promise<void> => {
    if (busy || !modelReady || !specMarkdown.trim()) return;
    setOperationStatus("drafting");
    setError(null);
    try {
      const result = await api.draftPlan({
        spec: specMarkdown,
        ...(workspace ? { workspaceRoot: workspace } : {}),
        planRelativePath: planPath,
      });
      setPlanPath(result.planRelativePath);
      setPlanMarkdown(result.content);
      setSaveStatus("dirty");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    } finally {
      setOperationStatus("idle");
    }
  };

  // --- Refine (model-backed) ------------------------------------------------
  const runRefine = async (): Promise<void> => {
    if (busy || !modelReady || !planMarkdown.trim() || !refineInput.trim()) return;
    setOperationStatus("refining");
    setError(null);
    try {
      const result = await api.refinePlan({
        planMarkdown,
        instruction: refineInput,
        ...(specMarkdown.trim() ? { spec: specMarkdown } : {}),
        planRelativePath: planPath,
      });
      setPlanMarkdown(result.content);
      setRefineInput("");
      setSaveStatus("dirty");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    } finally {
      setOperationStatus("idle");
    }
  };

  // --- Replan (model-backed) — re-cover the changed/added requirements ------
  const runReplan = async (changedIds: string[]): Promise<void> => {
    if (busy || !modelReady || !planMarkdown.trim() || !specMarkdown.trim()) return;
    setOperationStatus("refining");
    setError(null);
    try {
      const result = await api.replanPlan({
        planMarkdown,
        spec: specMarkdown,
        changedIds,
        planRelativePath: planPath,
      });
      setPlanMarkdown(result.content);
      setSaveStatus("dirty");
      void runVerify();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    } finally {
      setOperationStatus("idle");
    }
  };

  // --- Build (pure todo extraction → thread todos) --------------------------
  const runBuild = async (): Promise<void> => {
    if (busy || !planMarkdown.trim()) return;
    setOperationStatus("building");
    setError(null);
    try {
      const result = await api.buildPlan({
        planMarkdown,
        ...(currentThreadId ? { threadId: currentThreadId } : {}),
        planRelativePath: planPath,
      });
      if (currentThreadId && result.todos.length > 0) {
        await editTodos(result.todos.map((todo) => ({ content: todo.content, status: todo.status })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    } finally {
      setOperationStatus("idle");
    }
  };

  const hasPlan = planMarkdown.trim().length > 0;
  const coveredCount = verify ? verify.perRequirement.filter((r) => r.totalSteps > 0).length : 0;
  const totalReqs = verify ? verify.blocks.length : 0;
  const changedIds = verify ? [...verify.changedIds, ...verify.addedIds] : [];
  const showStatusSpinner = saveStatus === "saving" || busy;
  const readOnly = busy;

  return (
    <aside className="ds-no-drag flex h-full max-h-full min-h-0 w-full flex-col border-l border-ds-border-muted bg-white dark:bg-ds-canvas">
      {/* Header */}
      <div className="shrink-0 border-b border-ds-border-muted bg-ds-card">
        <div className="flex h-12 min-w-0 items-center gap-2 px-3">
          <button
            type="button"
            onClick={onCollapse}
            className="ds-sidebar-toggle-button shrink-0"
            aria-label={t("plan.rightPanelCollapse")}
            title={t("plan.rightPanelCollapse")}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-ds-surface-subtle px-3 py-1.5 dark:bg-white/8">
            <svg className="h-4 w-4 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span className="min-w-0 truncate text-[13px] font-medium text-ds-ink">{t("plan.planPanelTitle")}</span>
          </div>
        </div>

        {/* plan path chip + save-status pill */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3">
          <div className="min-w-0 flex-1 truncate rounded-full border border-ds-border-muted bg-ds-surface-subtle px-3 py-1.5 text-[11.5px] font-medium text-ds-muted dark:bg-white/6">
            {hasPlan || loaded ? planPath : t("plan.planNoActiveFile")}
          </div>
          <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-card px-2.5 py-1.5 text-[11.5px] font-medium text-ds-muted">
            {showStatusSpinner ? (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            ) : (
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>
            )}
            <span>{t(statusKey(saveStatus, operationStatus))}</span>
          </div>
        </div>

        {/* spec-coverage chip + Uncovered list + Verify + spec-changed banner */}
        {verify && verify.blocks.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3">
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-[11.5px] font-semibold text-accent">
              {t("plan.planCoverageLabel", { covered: coveredCount, total: totalReqs })}
            </span>
            {verify.uncoveredIds.length > 0 && (
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-amber-500/12 px-2.5 py-1 text-[11.5px] font-semibold text-amber-700 dark:text-amber-300">
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                <span className="truncate">{t("plan.planCoverageUncovered", { ids: verify.uncoveredIds.join(", ") })}</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => void runVerify()}
              disabled={verifying || busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-card px-2.5 py-1 text-[11.5px] font-semibold text-ds-ink transition hover:border-accent/30 hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>
              {t(verifying ? "plan.planVerifyRunning" : "plan.planVerify")}
            </button>
            {changedIds.length > 0 && (
              <div className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/90 px-3 py-1.5 text-[11.5px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-100">
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                <span className="min-w-0 flex-1 truncate">{t("plan.sddChangedBanner", { ids: changedIds.join(", ") })}</span>
                <button
                  type="button"
                  onClick={() => void runReplan(changedIds)}
                  disabled={busy || !modelReady}
                  title={!modelReady ? t("plan.modelUnavailable") : undefined}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
                  {t("plan.sddReplanButton")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {!thread ? (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
          </div>
          <div className="mt-4 text-[16px] font-semibold text-ds-ink">{t("plan.planEmptyTitle")}</div>
          <p className="mt-2 max-w-[22rem] text-[13px] leading-6 text-ds-muted">{t("plan.planEmptySub")}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-ds-main/45 px-3 py-3 dark:bg-transparent">
          {/* Requirement SPEC (drives coverage) */}
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ds-faint">{t("plan.specLabel")}</label>
          <textarea
            value={specMarkdown}
            onChange={(e) => setSpecMarkdown(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={t("plan.specPlaceholder")}
            className="w-full resize-y rounded-xl border border-ds-border bg-white px-3 py-2 font-mono text-[12.5px] leading-5 text-ds-ink placeholder:text-ds-faint focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/25 dark:bg-ds-canvas"
          />

          {/* Implementation PLAN (the file that is loaded/saved/built) */}
          <label className="mb-1.5 mt-4 block text-[11px] font-semibold uppercase tracking-wide text-ds-faint">{t("plan.planLabel")}</label>
          <textarea
            value={planMarkdown}
            onChange={(e) => onPlanChange(e.target.value)}
            readOnly={readOnly}
            rows={12}
            spellCheck={false}
            placeholder={t("plan.planPlaceholder")}
            className="w-full flex-1 resize-y rounded-xl border border-ds-border bg-white px-3 py-2 font-mono text-[12.5px] leading-5 text-ds-ink placeholder:text-ds-faint focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/25 disabled:opacity-60 dark:bg-ds-canvas"
          />

          {/* Draft + Refine (model-backed) */}
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void runDraft()}
              disabled={busy || !modelReady || !specMarkdown.trim()}
              title={!modelReady ? t("plan.modelUnavailable") : undefined}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:border-accent/30 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              {t(operationStatus === "drafting" ? "plan.drafting" : "plan.draftPlan")}
            </button>

            <label className="mt-1 block text-[11px] font-semibold uppercase tracking-wide text-ds-faint">{t("plan.refineLabel")}</label>
            <textarea
              value={refineInput}
              onChange={(e) => setRefineInput(e.target.value)}
              rows={2}
              placeholder={t("plan.refinePlaceholder")}
              className="w-full resize-y rounded-xl border border-ds-border bg-white px-3 py-2 text-[12.5px] leading-5 text-ds-ink placeholder:text-ds-faint focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/25 dark:bg-ds-canvas"
            />
            <button
              type="button"
              onClick={() => void runRefine()}
              disabled={busy || !modelReady || !planMarkdown.trim() || !refineInput.trim()}
              title={!modelReady ? t("plan.modelUnavailable") : undefined}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:border-accent/30 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t(operationStatus === "refining" ? "plan.refining" : "plan.refinePlan")}
            </button>
            {!modelReady && (
              <p className="text-[11.5px] leading-5 text-ds-faint">{t("plan.modelUnavailable")}</p>
            )}
          </div>
        </div>
      )}

      {/* Footer: error + refine hint + Verify + Build */}
      {thread && (
        <div className="shrink-0 border-t border-ds-border-muted bg-ds-card p-3">
          {error && (
            <div className="mb-2 rounded-lg border border-red-300/70 bg-red-500/10 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-800/60 dark:text-red-300">
              {error}
            </div>
          )}
          <p className="mb-2 text-[12px] leading-5 text-ds-muted">{t("plan.planRefineHint")}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runVerify()}
              disabled={verifying || busy}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:border-accent/30 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>
              {t(verifying ? "plan.planVerifyRunning" : "plan.planVerify")}
            </button>
            <button
              type="button"
              onClick={() => void runBuild()}
              disabled={busy || !hasPlan || !currentThreadId}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: "#0088ff" }}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-6 0v4" /><rect width="20" height="14" x="2" y="9" rx="2" /></svg>
              {t(operationStatus === "building" ? "plan.planStatusBuilding" : "plan.planBuild")}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
