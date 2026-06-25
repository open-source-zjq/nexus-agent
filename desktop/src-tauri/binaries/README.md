# Runtime sidecar binaries

Tauri's `externalBin` resolves `nexus-agent-runtime` to a target-triple-suffixed
executable placed here, e.g.:

```
nexus-agent-runtime-aarch64-apple-darwin
nexus-agent-runtime-x86_64-apple-darwin
nexus-agent-runtime-x86_64-pc-windows-msvc.exe
nexus-agent-runtime-x86_64-unknown-linux-gnu
```

Each is the backend runtime packaged as a single self-contained executable
(bundle `backend/src/cli/serve-entry.ts` with esbuild + a Node launcher, or
`pkg`/`bun build --compile`). The shell spawns it with `serve` and reads the
`NEXUS_READY` JSON handshake from stdout (see `src/lib.rs::spawn_runtime`).

These artifacts are produced by the packaging step and are git-ignored.
