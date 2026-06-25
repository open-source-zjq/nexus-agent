import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { useNav } from "../store/nav.js";
import { useStore } from "../store/store.js";
import { Sidebar } from "./Sidebar.js";
import { InsightCenter } from "./InsightCenter.js";
import { FilePreviewPanel } from "./FilePreviewPanel.js";
import { VIEWS } from "./views/registry.js";
import { useAppKeybindings } from "../keybindings/useAppKeybindings.js";
import { useI18n } from "../i18n/index.js";
import { usePreferences } from "../store/preferences.js";
import { OnboardingWizard, shouldAutoShowOnboarding } from "./OnboardingWizard.js";

export function AppShell(): JSX.Element {
  const view = useNav((s) => s.view);
  const collapsed = useNav((s) => s.sidebarCollapsed);
  const toggleSidebar = useNav((s) => s.toggleSidebar);
  const leftWidth = useNav((s) => s.leftWidth);
  const setLeftWidth = useNav((s) => s.setLeftWidth);

  // Drag the left-sidebar divider to resize it (persisted to
  // `nexus.layout.leftSidebarWidth`). Pointer capture keeps the drag smooth
  // even when the cursor leaves the thin handle.
  const startLeftResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: PointerEvent): void => setLeftWidth(startW + (ev.clientX - startX));
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const banner = useStore((s) => s.banner);
  const setBanner = useStore((s) => s.setBanner);
  const config = useStore((s) => s.config);
  const onboardingOpen = useNav((s) => s.onboardingOpen);
  const setOnboardingOpen = useNav((s) => s.setOnboardingOpen);
  const language = useI18n((s) => s.language);
  // Subscribe so the preferences store is created at app start — its initializer
  // applies the saved theme + font scale to <html> before first paint (T10.6).
  usePreferences((s) => s.theme);

  // First-run onboarding (T10.12): auto-open the setup wizard app-wide the first
  // time the config loads with no API key + no completion flag, regardless of
  // which view is active. Dismissible; re-openable from Settings → General.
  useEffect(() => {
    if (config && shouldAutoShowOnboarding(config)) setOnboardingOpen(true);
    // Only react to config arriving; shouldAutoShowOnboarding self-gates repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config !== null]);

  // Global rebindable shortcuts (new-chat, settings, plan-mode, nav, …).
  useAppKeybindings();
  // Reflect the active language on <html lang> for a11y / CSS.
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);

  const ActiveView = VIEWS[view];

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="ds-route-transition-host flex min-h-0 flex-1 flex-col">
        <div className="ds-route-transition-frame ds-route-transition-workbench" data-route-surface="workbench">
          <div className="ds-workbench-shell ds-drag flex h-full min-h-0 w-full min-w-0 bg-ds-main">
            {/* left sidebar (collapsible) */}
            <div
              className="ds-left-sidebar-panel min-h-0 shrink-0 overflow-hidden transition-[width] duration-200"
              style={{ width: collapsed ? 0 : leftWidth }}
            >
              <div className="ds-left-sidebar-inner h-full min-h-0" style={{ width: leftWidth }}>
                <Sidebar />
              </div>
            </div>

            {/* collapsed: a floating expand affordance */}
            {collapsed && (
              <button
                type="button"
                onClick={toggleSidebar}
                title="Expand sidebar"
                aria-label="Expand sidebar"
                className="ds-no-drag absolute left-3 top-3 z-30 flex h-7 w-7 items-center justify-center rounded-md text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <svg className="h-[14px] w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            )}

            {/* divider — drag to resize the left sidebar (persisted) */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={startLeftResize}
              className="ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
            />

            {/* main stage — neutral fill; each view paints its own surface */}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ds-main">
              {banner && (
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="ds-no-drag absolute inset-x-0 top-0 z-40 mx-auto mt-2 flex max-w-2xl items-center justify-center gap-2 rounded-full border border-ds-border bg-ds-card/95 px-4 py-1.5 text-[12.5px] font-medium text-ds-muted shadow-[var(--ds-shadow-card-soft)] transition hover:bg-ds-hover"
                  style={{ left: 0, right: 0, width: "fit-content" }}
                >
                  <span className="truncate">{banner}</span>
                  <span className="text-ds-faint">dismiss</span>
                </button>
              )}
              {/* The active workbench/agent view paints the main stage. */}
              <ActiveView />
            </main>
          </div>
        </div>
      </div>
      {/* Proactive insight overlay — floats over every view (fixed-position). */}
      <InsightCenter />
      {/* Workspace file preview overlay (opened from file-path links). */}
      <FilePreviewPanel />
      {/* First-run / re-entrant setup wizard (T10.12), mounted app-level. */}
      {onboardingOpen && <OnboardingWizard onClose={() => setOnboardingOpen(false)} />}
    </div>
  );
}
