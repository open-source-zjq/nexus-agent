import { create } from "zustand";

/**
 * Local appearance / behavior preferences (T10.6) — persisted to localStorage,
 * never sent to the backend. Mirrors the original Nexus "General" preferences:
 * a theme (light / dark / follow-system), a UI font-size scale, and whether a
 * desktop notification fires when a background reply completes.
 *
 * The design system is driven by `data-theme="dark"` on <html> (the compiled
 * `.ds-*` palette redefines every `--ds-*` var under `html[data-theme=dark]`),
 * so applying a theme is just setting that attribute. Font scale is applied as
 * the root font-size (rem-based spacing scales with it).
 */
export type ThemePreference = "light" | "dark" | "system";
export type FontSizePreference = "small" | "medium" | "large";

const THEME_KEY = "nexus.pref.theme";
const FONT_KEY = "nexus.pref.fontSize";
const NOTIFY_KEY = "nexus.pref.notifyOnReplyComplete";
// T10.8 desktop-behavior flags (Tauri host only) — device-local, never sent to
// the backend. Applied natively via `apply_app_behavior`.
const OPEN_AT_LOGIN_KEY = "nexus.pref.openAtLogin";
const START_MINIMIZED_KEY = "nexus.pref.startMinimized";
const CLOSE_TO_TRAY_KEY = "nexus.pref.closeToTray";
const AUTO_START_KEY = "nexus.pref.autoStart";

const FONT_SIZE_PX: Record<FontSizePreference, string> = {
  small: "14px",
  medium: "16px",
  large: "18px",
};

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    /* localStorage unavailable (SSR / sandbox) */
  }
  return fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Resolve a theme preference to the concrete light/dark applied to <html>. */
function resolveTheme(theme: ThemePreference): "light" | "dark" {
  if (theme === "system") {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }
  return theme;
}

/** Apply theme + font size to the document root. Safe to call repeatedly. */
export function applyPreferences(theme: ThemePreference, fontSize: FontSizePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(theme));
  root.style.fontSize = FONT_SIZE_PX[fontSize];
}

/** T10.8 — Desktop-behavior flags, mirrored to {@link AppBehaviorSettings}. */
export interface DesktopBehaviorPreferences {
  /** Launch the app when the user logs in. */
  openAtLogin: boolean;
  /** Start the window minimized / hidden to the tray. */
  startMinimized: boolean;
  /** Closing the window hides to the tray instead of quitting. */
  closeToTray: boolean;
  /** Auto-start the app (alias of launch-at-login on the native side). */
  autoStart: boolean;
}

export type DesktopBehaviorKey = keyof DesktopBehaviorPreferences;

interface PreferencesState {
  theme: ThemePreference;
  fontSize: FontSizePreference;
  /** When true (default), a desktop notification fires when a background reply completes. */
  notifyOnReplyComplete: boolean;
  /** T10.8 — desktop-behavior flags (Tauri host only). Off by default. */
  desktopBehavior: DesktopBehaviorPreferences;
  setTheme(theme: ThemePreference): void;
  setFontSize(fontSize: FontSizePreference): void;
  setNotifyOnReplyComplete(value: boolean): void;
  /** Patch one desktop-behavior flag (persisted to this device). */
  setDesktopBehavior(key: DesktopBehaviorKey, value: boolean): void;
}

export const usePreferences = create<PreferencesState>((set, get) => {
  const theme = readStored<ThemePreference>(THEME_KEY, ["light", "dark", "system"], "system");
  const fontSize = readStored<FontSizePreference>(FONT_KEY, ["small", "medium", "large"], "medium");
  const notifyOnReplyComplete = readBool(NOTIFY_KEY, true);
  const desktopBehavior: DesktopBehaviorPreferences = {
    openAtLogin: readBool(OPEN_AT_LOGIN_KEY, false),
    startMinimized: readBool(START_MINIMIZED_KEY, false),
    closeToTray: readBool(CLOSE_TO_TRAY_KEY, false),
    autoStart: readBool(AUTO_START_KEY, false),
  };
  const DESKTOP_KEYS: Record<DesktopBehaviorKey, string> = {
    openAtLogin: OPEN_AT_LOGIN_KEY,
    startMinimized: START_MINIMIZED_KEY,
    closeToTray: CLOSE_TO_TRAY_KEY,
    autoStart: AUTO_START_KEY,
  };

  // Apply on store creation so the first paint already reflects the saved theme.
  applyPreferences(theme, fontSize);

  // Re-resolve a "system" theme when the OS color scheme changes.
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const s = get();
      if (s.theme === "system") applyPreferences("system", s.fontSize);
    });
  } catch {
    /* matchMedia unavailable */
  }

  return {
    theme,
    fontSize,
    notifyOnReplyComplete,
    desktopBehavior,
    setTheme: (next) => {
      persist(THEME_KEY, next);
      applyPreferences(next, get().fontSize);
      set({ theme: next });
    },
    setFontSize: (next) => {
      persist(FONT_KEY, next);
      applyPreferences(get().theme, next);
      set({ fontSize: next });
    },
    setNotifyOnReplyComplete: (value) => {
      persist(NOTIFY_KEY, String(value));
      set({ notifyOnReplyComplete: value });
    },
    setDesktopBehavior: (key, value) => {
      persist(DESKTOP_KEYS[key], String(value));
      set({ desktopBehavior: { ...get().desktopBehavior, [key]: value } });
    },
  };
});

/**
 * Read the current "notify on reply complete" preference imperatively (used by
 * the store's background-thread completion path, which is outside React).
 */
export function shouldNotifyOnReplyComplete(): boolean {
  return usePreferences.getState().notifyOnReplyComplete;
}
