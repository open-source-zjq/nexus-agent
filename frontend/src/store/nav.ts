import { create } from "zustand";

/**
 * Which view occupies the main stage. The sidebar's primary nav drives this.
 * "workbench" is the agent chat surface; the rest mirror the recovered Nexus
 * screens (login/InitialSetup is intentionally omitted — this build runs against
 * a local loopback runtime, not the corp SSO).
 *
 * The Goal/Plan, Changes and Todo panels are NOT views: faithful to the original
 * Nexus they dock as a resizable right rail beside the chat (see WorkbenchPanel
 * below), never replacing the chat stage.
 */
export type ViewKey =
  | "workbench"
  | "agents"
  | "connectors"
  | "plugins"
  | "schedule"
  | "phone"
  | "settings";

/**
 * Which contextual panel is docked in the workbench right rail (null = hidden).
 * Mirrors the original Nexus `rightPanelMode` single-string state: the three
 * chat-topbar buttons toggle it (clicking the open one closes the rail), and the
 * chat stays mounted side-by-side to its left.
 */
export type WorkbenchPanel = "plan" | "changes" | "todos" | "memory" | "usage" | "rounds" | null;

// Resizable right-rail width, persisted to localStorage — faithful to the
// original `nexus.layout.rightInspectorWidth` (default 360, clamped 280–760).
const RAIL_WIDTH_KEY = "nexus.layout.rightInspectorWidth";
export const RAIL_WIDTH_DEFAULT = 360;
export const RAIL_WIDTH_MIN = 280;
export const RAIL_WIDTH_MAX = 760;

export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_DEFAULT;
  return Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, Math.round(width)));
}

function loadRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw) return clampRailWidth(Number(raw));
  } catch {
    /* localStorage unavailable (SSR / sandbox) — fall through to default */
  }
  return RAIL_WIDTH_DEFAULT;
}

function persistRailWidth(width: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

// Resizable LEFT sidebar width, persisted to localStorage — faithful to the
// original `nexus.layout.leftSidebarWidth` (default 304, clamped 240–520).
const LEFT_WIDTH_KEY = "nexus.layout.leftSidebarWidth";
export const LEFT_WIDTH_DEFAULT = 304;
export const LEFT_WIDTH_MIN = 240;
export const LEFT_WIDTH_MAX = 520;

export function clampLeftWidth(width: number): number {
  if (!Number.isFinite(width)) return LEFT_WIDTH_DEFAULT;
  return Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, Math.round(width)));
}

function loadLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_WIDTH_KEY);
    if (raw) return clampLeftWidth(Number(raw));
  } catch {
    /* localStorage unavailable (SSR / sandbox) — fall through to default */
  }
  return LEFT_WIDTH_DEFAULT;
}

function persistLeftWidth(width: number): void {
  try {
    localStorage.setItem(LEFT_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

interface NavState {
  view: ViewKey;
  sidebarCollapsed: boolean;
  workbenchPanel: WorkbenchPanel;
  railWidth: number;
  leftWidth: number;
  /** First-run onboarding wizard visibility (mounted app-level in AppShell). */
  onboardingOpen: boolean;
  setView(view: ViewKey): void;
  toggleSidebar(): void;
  /** Open `panel`, or close the rail if it is already the open panel. */
  toggleWorkbenchPanel(panel: NonNullable<WorkbenchPanel>): void;
  closeWorkbenchPanel(): void;
  setRailWidth(width: number): void;
  setLeftWidth(width: number): void;
  setOnboardingOpen(open: boolean): void;
}

export const useNav = create<NavState>((set) => ({
  view: "workbench",
  sidebarCollapsed: false,
  workbenchPanel: null,
  railWidth: loadRailWidth(),
  leftWidth: loadLeftWidth(),
  onboardingOpen: false,
  setView: (view) => set({ view }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleWorkbenchPanel: (panel) => set((s) => ({ workbenchPanel: s.workbenchPanel === panel ? null : panel })),
  closeWorkbenchPanel: () => set({ workbenchPanel: null }),
  setRailWidth: (width) => {
    const clamped = clampRailWidth(width);
    persistRailWidth(clamped);
    set({ railWidth: clamped });
  },
  setLeftWidth: (width) => {
    const clamped = clampLeftWidth(width);
    persistLeftWidth(clamped);
    set({ leftWidth: clamped });
  },
}));
