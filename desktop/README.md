# Nexus Agent — native desktop shell (Tauri 2.x)

One SPA, two hosts. This is the **native** host: it spawns the
backend runtime as a sidecar (`nexus-agent-runtime`), waits for the
`NEXUS_READY` JSON handshake, then points the WebView at the runtime-served SPA
— the same relative-fetch + `nexus.token` contract the browser build uses.

## Layout

- `src-tauri/tauri.conf.json` — window/bundle/deep-link config; identifier `dev.nexus.agent`, scheme `nexus://`.
- `src-tauri/capabilities/default.json` — least-authority IPC allow-list.
- `src-tauri/src/lib.rs` — sidecar orchestration, NEXUS_READY handshake, tray, single-instance, deep-link, autostart, and all T9.x IPC commands (mirroring `frontend/src/lib/tauri.ts`).
- `src-tauri/icons/` — Nexus-owned icon set (generated from the original `favicon.svg` mark).
- `src-tauri/binaries/` — the runtime sidecar (`externalBin`, git-ignored).

## Out of scope

No in-app software auto-update: `tauri-plugin-updater` is **not** registered and
`run_update_installer` is **not** exposed. Distribution is via platform
installers / package managers.

## Run (dev)

From the repo root, **double-click `launch-dev.command`** (or
`open -a Terminal launch-dev.command`). It builds `frontend/dist` + the debug
binary, code-signs the binary with `dev.entitlements`, starts the backend
runtime on `127.0.0.1:8910`, and runs the signed binary in
`NEXUS_EXTERNAL_RUNTIME=1` mode pointed at the runtime-served SPA. See the root
[`README.md`](../README.md#desktop-app-tauri) for details and the macOS-26
rationale.

> Plain `cargo tauri dev` flash-crashes on macOS 26: AMFI kills the unsigned
> debug binary as soon as it spawns the node runtime as a sidecar. The launcher
> exists to sign the binary and keep the runtime outside the app process tree.

## Build / validate

```bash
# from the repo root
npm run build -w frontend            # produce frontend/dist (embedded + served)
cargo tauri build --config desktop/src-tauri/tauri.conf.json   # .app/.dmg/.msi/.deb/.AppImage
cd desktop/src-tauri && cargo check  # validate the Rust shell without bundling/signing
```
