//! Nexus Agent — native desktop shell (Tauri 2.x).
//!
//! Architecture: one SPA, two hosts. This shell is the *native*
//! host. It does **not** ship its own UI — it spawns the backend runtime as a
//! sidecar (`nexus-agent-runtime`), waits for the `NEXUS_READY` JSON handshake,
//! then points the WebView at the runtime-served SPA (same relative-fetch +
//! `nexus.token` contract the browser build uses). The browser host is the
//! identical SPA served by `nexus-agent serve`.
//!
//! Every exposed `#[tauri::command]` mirrors a wrapper in the frontend's
//! `lib/tauri.ts` (the T9.x set). Application commands bypass the ACL, so only
//! the handful of *plugin* commands the web bundle calls directly need a
//! capability grant (see `capabilities/default.json`). Software auto-update is
//! intentionally out of scope: no updater plugin is registered.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_deep_link::DeepLinkExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt as _;

const MAIN_WINDOW: &str = "main";
/// Fixed loopback port for the runtime sidecar. The handshake still reports the
/// actual port (and we honor it), but a fixed default keeps the capability
/// `remote.urls` allow-list deterministic.
const RUNTIME_PORT: u16 = 8910;
const RUNTIME_HOST: &str = "127.0.0.1";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Behavior flags mirrored from `AppBehaviorSettings` in `lib/tauri.ts`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppBehaviorSettings {
    open_at_login: bool,
    start_minimized: bool,
    close_to_tray: bool,
    auto_start: bool,
}

/// Notification payload mirrored from `showTurnCompleteNotification`.
#[derive(Debug, Clone, Deserialize)]
struct NotificationPayload {
    title: String,
    body: String,
}

#[derive(Default)]
struct DesktopState {
    /// The spawned runtime sidecar; held so it is not dropped (which would kill it).
    child: Mutex<Option<CommandChild>>,
    /// Window label native callbacks should target (T9.10).
    target_window: Mutex<Option<String>>,
    /// Latest applied behavior flags (drives the close-to-tray window handler).
    behavior: Mutex<AppBehaviorSettings>,
}

// ---------------------------------------------------------------------------
// Filesystem helpers (skills live under the Nexus data dir)
// ---------------------------------------------------------------------------

/// `~/.nexus-agent` — the single Nexus data/config root. Honors an explicit
/// `NEXUS_DATA_DIR` override so the shell and a manually-launched runtime agree.
fn nexus_data_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(explicit) = std::env::var("NEXUS_DATA_DIR") {
        if !explicit.is_empty() {
            return std::path::PathBuf::from(explicit);
        }
    }
    app.path()
        .home_dir()
        .map(|home| home.join(".nexus-agent"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".nexus-agent"))
}

fn skills_dir(app: &AppHandle) -> std::path::PathBuf {
    nexus_data_dir(app).join("skills")
}

/// Reject path-traversal / nested names: a skill file name must be a single
/// path component (no separators, no `..`).
fn safe_skill_name(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 200 {
        return None;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.starts_with('.') {
        return None;
    }
    Some(name.to_string())
}

// ---------------------------------------------------------------------------
// Commands (T9.x) — each mirrors a wrapper in frontend/src/lib/tauri.ts.
// NOTE: T9.1 run_update_installer is intentionally absent (updater out of scope);
// the JS wrapper degrades to a no-op when the command is missing.
// ---------------------------------------------------------------------------

/// T9.2 — apply launch-at-login / start-minimized / close-to-tray / auto-start.
#[tauri::command]
fn apply_app_behavior(app: AppHandle, settings: AppBehaviorSettings) -> Result<(), String> {
    let want_autostart = settings.open_at_login || settings.auto_start;
    let mgr = app.autolaunch();
    let result = if want_autostart {
        mgr.enable()
    } else {
        mgr.disable()
    };
    if let Err(e) = result {
        // Non-fatal: record nothing, surface the message to the caller.
        eprintln!("[nexus-desktop] autostart toggle failed: {e}");
    }
    *app.state::<DesktopState>().behavior.lock().unwrap() = settings;
    Ok(())
}

/// T9.3 — native "turn complete" notification.
#[tauri::command]
fn show_turn_complete_notification(app: AppHandle, payload: NotificationPayload) -> Result<(), String> {
    app.notification()
        .builder()
        .title(payload.title)
        .body(payload.body)
        .show()
        .map_err(|e| e.to_string())
}

/// T9.4 — open an external URL in the user's default browser.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Reveal a file/folder in the OS file manager.
#[tauri::command]
fn reveal_item_in_dir(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

/// T9.6 — macOS window vibrancy / frosted glass. No-op off macOS.
#[tauri::command]
fn apply_vibrancy(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
            let _ = apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, None, None);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

/// T9.6 — alias of {@link apply_vibrancy}.
#[tauri::command]
fn set_effects(app: AppHandle) -> Result<(), String> {
    apply_vibrancy(app)
}

/// T9.6 — show/hide the macOS Dock icon.
#[tauri::command]
fn set_dock_visibility(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        app.set_activation_policy(policy).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
    Ok(())
}

/// T9.6 — set the window theme ("light" / "dark" / "system").
#[tauri::command]
fn set_app_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let resolved = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None, // "system"
    };
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        win.set_theme(resolved).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// T9.7 — toggle webview devtools (debug builds only).
#[tauri::command]
fn toggle_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
            win.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
    Ok(())
}

/// T9.7 — the app's semantic version.
#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// T9.7 — reveal the app log directory in the OS file manager.
#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| nexus_data_dir(&app).join("logs"));
    std::fs::create_dir_all(&dir).ok();
    app.opener()
        .reveal_item_in_dir(dir)
        .map_err(|e| e.to_string())
}

/// T9.7 — minimize the main window.
#[tauri::command]
fn window_minimize(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        win.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// T9.7 — toggle maximize/restore on the main window.
#[tauri::command]
fn window_toggle_maximize(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        if win.is_maximized().unwrap_or(false) {
            win.unmaximize().map_err(|e| e.to_string())?;
        } else {
            win.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// T9.7 — toggle fullscreen on the main window.
#[tauri::command]
fn window_toggle_fullscreen(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let now = win.is_fullscreen().unwrap_or(false);
        win.set_fullscreen(!now).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Dock/taskbar unread badge.
#[tauri::command]
fn set_badge_count(app: AppHandle, count: Option<i64>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        win.set_badge_count(count).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// T9.9 — list skill file names under `~/.nexus-agent/skills`.
#[tauri::command]
fn list_skills(app: AppHandle) -> Vec<String> {
    let dir = skills_dir(&app);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out
}

/// T9.9 — write a skill file (validated name, no traversal).
#[tauri::command]
fn save_skill_file(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let safe = safe_skill_name(&name).ok_or_else(|| "invalid skill file name".to_string())?;
    let dir = skills_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(safe), content).map_err(|e| e.to_string())
}

/// T9.9 — reveal the skills directory in the OS file manager.
#[tauri::command]
fn open_skill_root(app: AppHandle) -> Result<(), String> {
    let dir = skills_dir(&app);
    std::fs::create_dir_all(&dir).ok();
    app.opener()
        .reveal_item_in_dir(dir)
        .map_err(|e| e.to_string())
}

/// T9.10 — set the window label native callbacks should target.
#[tauri::command]
fn set_target_connection_window(app: AppHandle, label: String) -> Result<(), String> {
    *app.state::<DesktopState>().target_window.lock().unwrap() = Some(label);
    Ok(())
}

/// Clear the WebView's cache / cookies / browsing data.
#[tauri::command]
fn clear_all_browsing_data(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        win.clear_all_browsing_data().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Runtime sidecar: spawn → NEXUS_READY handshake → create the main window.
// ---------------------------------------------------------------------------

/// Resolve the static-dir the runtime should serve the SPA from: the bundled
/// `dist` resource (production), or an explicit `NEXUS_STATIC_DIR` override.
fn resolve_static_dir(app: &AppHandle) -> Option<String> {
    if let Ok(explicit) = std::env::var("NEXUS_STATIC_DIR") {
        if !explicit.is_empty() {
            return Some(explicit);
        }
    }
    if let Some(found) = app
        .path()
        .resource_dir()
        .ok()
        .map(|res| res.join("dist"))
        .filter(|p| p.exists())
        .and_then(|p| p.to_str().map(|s| s.to_string()))
    {
        return Some(found);
    }
    // Dev fallback: the built SPA lives at <repo>/frontend/dist. CARGO_MANIFEST_DIR
    // is <repo>/desktop/src-tauri at build time, so this resolves the repo dist
    // for `tauri dev` without requiring an exported NEXUS_STATIC_DIR.
    #[cfg(debug_assertions)]
    {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/dist");
        if dev.exists() {
            return dev
                .canonicalize()
                .ok()
                .and_then(|p| p.to_str().map(|s| s.to_string()));
        }
    }
    None
}

/// Spawn the runtime sidecar and, once it prints `NEXUS_READY <json>`, build the
/// main window pointed at the runtime-served SPA with the bearer token injected.
fn spawn_runtime(app: &AppHandle) {
    let handle = app.clone();

    // Escape hatch for macOS 26 hosts where the AMFI/Validation Category Policy
    // refuses to host an adhoc-signed sidecar. With NEXUS_EXTERNAL_RUNTIME set,
    // skip the sidecar entirely and point the webview at an already-running
    // backend started by `npm run serve` (or equivalent).
    if std::env::var("NEXUS_EXTERNAL_RUNTIME").ok().filter(|s| !s.is_empty()).is_some() {
        let token = std::env::var("NEXUS_RUNTIME_TOKEN").unwrap_or_default();
        eprintln!("[nexus-desktop] external runtime mode — skipping sidecar spawn");
        build_main_window(&handle, RUNTIME_HOST, RUNTIME_PORT, &token);
        return;
    }

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    // Build the sidecar command up front (on the setup thread).
    let mut cmd = match handle.shell().sidecar("nexus-agent-runtime") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[nexus-desktop] cannot locate runtime sidecar: {e}");
            return;
        }
    };
    cmd = cmd
        .args(["serve"])
        .env("NEXUS_HOST", RUNTIME_HOST)
        .env("NEXUS_PORT", RUNTIME_PORT.to_string())
        .env("NEXUS_RUNTIME_TOKEN", &token)
        .env("NEXUS_DATA_DIR", nexus_data_dir(&handle).to_string_lossy().to_string());
    if let Some(static_dir) = resolve_static_dir(&handle) {
        cmd = cmd.env("NEXUS_STATIC_DIR", static_dir);
    }

    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[nexus-desktop] failed to spawn runtime: {e}");
            return;
        }
    };
    // Keep the child alive for the lifetime of the app.
    *handle.state::<DesktopState>().child.lock().unwrap() = Some(child);

    // Defer window creation until the backend signals NEXUS_READY. On macOS 26+
    // the AMFI/provenance sandbox no longer tolerates a WebContent process whose
    // initial URL load fails — the WebContent init handshake is invalidated and
    // the host app dies ("workspace client connection invalidated"). Creating the
    // window only after the runtime is listening avoids that failure mode. A
    // fallback timer still opens the window after 10s so a stuck backend never
    // results in a dock-icon-only/invisible app.
    let token_for_fallback = token.clone();
    let handle_for_fallback = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        if handle_for_fallback.get_webview_window(MAIN_WINDOW).is_none() {
            eprintln!("[nexus-desktop] backend not ready after 10s — opening window anyway");
            build_main_window(&handle_for_fallback, RUNTIME_HOST, RUNTIME_PORT, &token_for_fallback);
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut window_built = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    for raw in line.split('\n') {
                        if raw.trim().starts_with("NEXUS_READY ") && !window_built {
                            window_built = true;
                            build_main_window(&handle, RUNTIME_HOST, RUNTIME_PORT, &token);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("[runtime] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[nexus-desktop] runtime exited: {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Create the main window on the UI thread, pointed at the runtime-served SPA.
fn build_main_window(app: &AppHandle, host: &str, port: u16, token: &str) {
    let url = format!("http://{host}:{port}/");
    // Inject the bearer token into the SPA's localStorage (the `nexus.token`
    // contract from api/client.ts) before first paint, so the loopback runtime's
    // token gate is satisfied without a manual paste.
    let init = format!(
        "try{{window.localStorage.setItem('nexus.token', '{token}');}}catch(e){{}}"
    );
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let parsed = match tauri::Url::parse(&url) {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[nexus-desktop] bad runtime url {url}: {e}");
                return;
            }
        };
        let built = WebviewWindowBuilder::new(&handle, MAIN_WINDOW, WebviewUrl::External(parsed))
            .title("Nexus Agent")
            .inner_size(1320.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .initialization_script(&init)
            .build();
        match built {
            Ok(win) => {
                let close_handle = win.app_handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let close_to_tray = close_handle
                            .state::<DesktopState>()
                            .behavior
                            .lock()
                            .map(|b| b.close_to_tray)
                            .unwrap_or(false);
                        if close_to_tray {
                            api.prevent_close();
                            if let Some(w) = close_handle.get_webview_window(MAIN_WINDOW) {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            Err(e) => eprintln!("[nexus-desktop] failed to build main window: {e}"),
        }
    });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "Show Nexus Agent").build(app)?;
    let new_chat = MenuItemBuilder::with_id("new_chat", "New Chat").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &new_chat])
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Nexus Agent")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => focus_main(app),
            "new_chat" => {
                focus_main(app);
                let _ = app.emit("nexus://new-chat", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Native application menu bar with standard edit/view/window items and
/// platform accelerators. Set as the app menu in `setup`.
fn build_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "Nexus Agent")
        .item(&PredefinedMenuItem::about(app, Some("About Nexus Agent"), Some(AboutMetadata::default()))?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().close_window().build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &view, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Show + focus the main window (creating nothing — it is built post-handshake).
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

/// Run the desktop shell. Called from `main.rs`.
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(DesktopState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Deep-link routing (nexus://…): forward to the SPA via an event.
            {
                let dl_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    focus_main(&dl_handle);
                    let _ = dl_handle.emit("nexus://deep-link", urls);
                });
                // Runtime registration is needed on Linux/Windows dev; macOS uses Info.plist.
                let _ = app.deep_link().register_all();
            }
            build_tray(&handle)?;
            build_app_menu(&handle)?;
            // Spawn the runtime sidecar and create the main window immediately.
            spawn_runtime(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            apply_app_behavior,
            show_turn_complete_notification,
            open_url,
            reveal_item_in_dir,
            apply_vibrancy,
            set_effects,
            set_dock_visibility,
            set_app_theme,
            toggle_devtools,
            get_app_version,
            open_log_dir,
            window_minimize,
            window_toggle_maximize,
            window_toggle_fullscreen,
            set_badge_count,
            list_skills,
            save_skill_file,
            open_skill_root,
            set_target_connection_window,
            clear_all_browsing_data
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nexus Agent desktop shell")
        .run(|handle, event| {
            // Debug builds: log every lifecycle event so a flash-then-exit is
            // diagnosable from the `tauri dev` console (which event ended the loop).
            #[cfg(debug_assertions)]
            eprintln!("[nexus-desktop] RunEvent: {event:?}");
            // Kill the runtime sidecar when the app exits so it never orphans
            // (an orphaned sidecar would hold the loopback port and break the
            // next launch). Covers Cmd-Q, window close, and quit-from-tray.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(child) = handle.state::<DesktopState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
