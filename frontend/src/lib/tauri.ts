// Thin helpers for the optional Tauri desktop host. Everything degrades
// gracefully on the plain web build: `isTauri()` is false and the native
// folder picker is simply unavailable (callers fall back to the text input).

/** True when running inside the Tauri webview (IPC bridge is present). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------------------------------------------------------------------
// Native command layer (T9.1–T9.10) — JS `invoke()` wrappers.
//
// Each wrapper mirrors a `#[tauri::command]` exposed by the Rust shell
// (src-tauri/src/lib.rs) and is `isTauri()`-gated: on the plain web build it
// degrades to a graceful no-op (returning a sensible default) so callers never
// have to branch. Tauri's IPC maps Rust snake_case arg names to camelCase on
// the JS side, so we pass camelCase keys here.
//
// `invoke` is imported lazily (per-call dynamic import) so the web bundle never
// pulls `@tauri-apps/api` into its startup graph.
// ---------------------------------------------------------------------------

/** Lazily resolve Tauri's `invoke`, or null when not running under Tauri. */
async function getInvoke(): Promise<
  (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | null
> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  } catch {
    return null;
  }
}

/** Invoke a native command, swallowing IPC errors and returning `fallback`. */
async function invokeSafe<T>(
  cmd: string,
  args: Record<string, unknown>,
  fallback: T,
): Promise<T> {
  const invoke = await getInvoke();
  if (!invoke) return fallback;
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return fallback;
  }
}

/** T9.1 — Launch a downloaded update installer at `path`. No-op on web. */
export async function runUpdateInstaller(path: string): Promise<void> {
  await invokeSafe<void>("run_update_installer", { path }, undefined);
}

/** Outcome of an update check (T9.1 / T10.8) — a discriminated result the UI renders. */
export type UpdateCheckResult =
  /** Not running under Tauri / updater plugin unavailable — desktop app only. */
  | { status: "unavailable" }
  /** Checked successfully and the installed build is current. */
  | { status: "up-to-date"; currentVersion: string | null }
  /** A newer release is available (and was downloaded + installed if possible). */
  | { status: "available"; version: string; currentVersion: string | null; installed: boolean }
  /** The check or download/install failed. */
  | { status: "error"; message: string };

/** Minimal shape of `@tauri-apps/plugin-updater`'s `Update` (only what we use). */
interface TauriUpdate {
  version: string;
  downloadAndInstall(): Promise<void>;
}

/** Minimal shape of the updater plugin module (`check()` resolves to an Update or null). */
interface TauriUpdaterModule {
  check(): Promise<TauriUpdate | null>;
}

/**
 * Lazily load the updater plugin. The module specifier is held in a variable so
 * the bundler/typechecker never statically resolves it: the plugin is an
 * optional native-only dependency that is absent from the web build's module
 * graph, so a static `import("@tauri-apps/plugin-updater")` would fail to
 * resolve. At runtime under Tauri the plugin is present and loads normally;
 * everywhere else this rejects and the caller degrades gracefully.
 */
async function loadUpdaterPlugin(): Promise<TauriUpdaterModule> {
  const spec = "@tauri-apps/plugin-updater";
  return (await import(/* @vite-ignore */ spec)) as TauriUpdaterModule;
}

/**
 * T9.1 / T10.8 — Check for an application update via `@tauri-apps/plugin-updater`.
 *
 * The Rust shell registers `tauri_plugin_updater` and the capabilities grant
 * `updater:allow-check / -download / -install`, so the JS side drives the flow.
 * When an update is found we download + install it in place; the caller then
 * relaunches (or prompts the user to). The plugin is imported lazily so the web
 * bundle never pulls it in, and every failure mode degrades to a structured
 * result (never an unhandled throw): on the plain web build this returns
 * `{ status: "unavailable" }` so the UI can show a "desktop app only" hint.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { status: "unavailable" };
  let currentVersion: string | null = null;
  try {
    currentVersion = await getAppVersion();
  } catch {
    /* best-effort — version is informational only */
  }
  try {
    const { check } = await loadUpdaterPlugin();
    const update = await check();
    if (!update) return { status: "up-to-date", currentVersion };
    let installed = false;
    try {
      // Download + install in place; the caller relaunches afterwards.
      await update.downloadAndInstall();
      installed = true;
    } catch {
      // Found an update but couldn't install it (e.g. download blocked); still
      // report that a newer version exists so the user can update manually.
      installed = false;
    }
    return { status: "available", version: update.version, currentVersion, installed };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message ?? "Update check failed" };
  }
}

/** App behavior flags applied natively (launch-at-login, tray, etc.). */
export interface AppBehaviorSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  autoStart: boolean;
}

/** T9.2 — Apply launch-at-login / start-minimized / close-to-tray. No-op on web. */
export async function applyAppBehavior(settings: AppBehaviorSettings): Promise<void> {
  await invokeSafe<void>("apply_app_behavior", { settings }, undefined);
}

/** T9.3 — Show a native "turn complete" notification. No-op on web. */
export async function showTurnCompleteNotification(payload: {
  title: string;
  body: string;
}): Promise<void> {
  await invokeSafe<void>("show_turn_complete_notification", { payload }, undefined);
}

/** T9.4 — Open an external URL in the user's default browser. No-op on web. */
export async function openUrl(url: string): Promise<void> {
  await invokeSafe<void>("open_url", { url }, undefined);
}

/** T9.6 — Apply macOS window vibrancy/blur. No-op on web / non-macOS. */
export async function applyVibrancy(): Promise<void> {
  await invokeSafe<void>("apply_vibrancy", {}, undefined);
}

/** T9.6 — Alias of {@link applyVibrancy} ("effects"). No-op on web / non-macOS. */
export async function setEffects(): Promise<void> {
  await invokeSafe<void>("set_effects", {}, undefined);
}

/** T9.6 — Show/hide the macOS Dock icon. No-op on web / non-macOS. */
export async function setDockVisibility(visible: boolean): Promise<void> {
  await invokeSafe<void>("set_dock_visibility", { visible }, undefined);
}

/** T9.6 — Set the window theme ("light" / "dark" / "system"). No-op on web. */
export async function setAppTheme(theme: "light" | "dark" | "system"): Promise<void> {
  await invokeSafe<void>("set_app_theme", { theme }, undefined);
}

/** T9.7 — Toggle webview devtools (debug builds only). No-op on web. */
export async function toggleDevtools(): Promise<void> {
  await invokeSafe<void>("toggle_devtools", {}, undefined);
}

/** T9.7 — Return the app's semantic version, or null on web. */
export async function getAppVersion(): Promise<string | null> {
  return invokeSafe<string | null>("get_app_version", {}, null);
}

/** T9.7 — Reveal the app log directory in the OS file manager. No-op on web. */
export async function openLogDir(): Promise<void> {
  await invokeSafe<void>("open_log_dir", {}, undefined);
}

/** T9.7 — Minimize the main window. No-op on web. */
export async function windowMinimize(): Promise<void> {
  await invokeSafe<void>("window_minimize", {}, undefined);
}

/** T9.7 — Toggle maximize/restore on the main window. No-op on web. */
export async function windowToggleMaximize(): Promise<void> {
  await invokeSafe<void>("window_toggle_maximize", {}, undefined);
}

/** T9.7 — Toggle fullscreen on the main window. No-op on web. */
export async function windowToggleFullscreen(): Promise<void> {
  await invokeSafe<void>("window_toggle_fullscreen", {}, undefined);
}

/** T9.9 — List skill file names under `~/.nexus/skills`. Empty array on web. */
export async function listSkills(): Promise<string[]> {
  return invokeSafe<string[]>("list_skills", {}, []);
}

/** T9.9 — Write a skill file (validated name, no traversal). No-op on web. */
export async function saveSkillFile(name: string, content: string): Promise<void> {
  await invokeSafe<void>("save_skill_file", { name, content }, undefined);
}

/** T9.9 — Reveal the skills directory in the OS file manager. No-op on web. */
export async function openSkillRoot(): Promise<void> {
  await invokeSafe<void>("open_skill_root", {}, undefined);
}

/** T9.10 — Set the window label native callbacks should target. No-op on web. */
export async function setTargetConnectionWindow(label: string): Promise<void> {
  await invokeSafe<void>("set_target_connection_window", { label }, undefined);
}

/**
 * Open the native folder picker and return the chosen absolute path, or null
 * if cancelled / not running under Tauri. The plugin is imported lazily so the
 * web bundle never needs it at startup.
 */
export async function pickWorkspaceDir(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a workspace folder",
      ...(defaultPath ? { defaultPath } : {}),
    });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}

/**
 * Height (px) of the top title-bar band that drags the window. macOS overlay
 * titlebar standard; matches the design system's `--ds-windows-titlebar-height`
 * (40px) and the ~46px workbench topbar so the whole top chrome row drags.
 */
const TITLEBAR_DRAG_HEIGHT = 40;

/**
 * Make the window draggable from its top title-bar band under Tauri.
 *
 * The recovered design system marks draggable chrome with `-webkit-app-region:
 * drag`, but WKWebView ignores it — so the previous bridge dragged from any
 * `.ds-drag` region, and because the whole workbench shell carries `.ds-drag`
 * the entire window became draggable (you couldn't select text, drag-scroll a
 * list, etc.). We instead restrict dragging to the top title-bar band (where the
 * macOS traffic lights live): a primary-button mousedown in the top
 * {@link TITLEBAR_DRAG_HEIGHT}px that isn't on an interactive/opted-out element
 * starts a native window drag. Everything below the band behaves normally.
 * No-op on the plain web build.
 */
export async function setupTauriDrag(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  const OPT_OUT =
    'a, button, input, select, textarea, summary, label, [role="button"], [role="separator"], [contenteditable="true"], .ds-no-drag';
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // Only the top title-bar band drags the window — never the body content.
    if (e.clientY > TITLEBAR_DRAG_HEIGHT) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(OPT_OUT)) return; // never drag from interactive / opted-out elements
    void appWindow.startDragging();
  });
}
