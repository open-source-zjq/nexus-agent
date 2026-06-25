# Nexus Agent

> A GUI-native, provider-neutral AI coding agent — a local runtime plus a rich
> React workbench.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/open-source-zjq/nexus-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/open-source-zjq/nexus-agent/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

**English** | [简体中文](./README.zh-CN.md)

Nexus Agent drives multi-step model turns, calls file / command / retrieval
tools, streams results back for live replay, and persists every session as a
resumable event stream. It is **provider-neutral**: the model layer speaks
generic **OpenAI- / Anthropic-compatible** wire protocols, so it runs against any
compatible gateway with your own API keys — no proprietary cloud, model gateway,
or intranet identity baked in.

## Highlights

- 🧠 **Multi-protocol model client** — OpenAI Chat Completions, OpenAI Responses,
  and Anthropic Messages, with self-healing retries.
- 💸 **Cache economics** — immutable prefix fingerprinting, prompt volatility
  detection, and tool-catalog drift detection keep provider caches warm.
- 🗜️ **Three-tier context compaction** with verifiable `tool_digest` markers.
- 📼 **Event-sourced sessions** — JSONL files are the source of truth; SQLite is
  an optional, disposable derived index; every session replays over resumable SSE.
- 🧰 **Rich workbench** — streaming chat (Markdown / Mermaid / Shiki / KaTeX),
  inline approvals, plan / diff / todo panels, plus agent, connector, and
  schedule surfaces.
- 🔌 **Capabilities off by default** — `web`, `memory`, `skills`, `media`, `mcp`,
  `delegation`, `insight` are all opt-in.
- 🖥️ **One SPA, two hosts** — run it in a browser or as a native Tauri desktop app.
- 🔒 **Safe by default** — loopback-bound + Bearer token, `workspace-write`
  sandbox, `on-request` approvals, and always-on path-traversal checks.

## Architecture

A hexagonal (ports-and-adapters) backend and a Web SPA frontend share one data
flow:

```
contracts → domain → ports → adapters → services → loop → server
```

- **Backend** (`backend/`, Node ≥ 20, TypeScript/ESM) — a single-process runtime
  that binds `127.0.0.1:8910` and exposes a REST + resumable-SSE API. JSONL files
  are the source of truth; SQLite is an optional, disposable derived index.
- **Frontend** (`frontend/`, React 18 + Vite) — the workbench for streaming chat,
  inline approvals, plan/diff/todo panels, settings, and the
  agent/connector/schedule surfaces.
- **Desktop** (`desktop/`, Tauri 2.x) — a native shell that spawns the backend as
  a sidecar and points its WebView at the same runtime-served SPA the browser loads.

## Quick start

```bash
npm install        # backend + frontend workspaces
npm run dev        # backend :8910 + frontend Vite :5173
```

Single-process production build (backend serves the built frontend):

```bash
npm run serve
```

## Desktop app (Tauri)

The native shell lives in [`desktop/`](./desktop). On macOS, **double-click
`launch-dev.command`** in Finder. One Terminal window builds and code-signs the
debug binary, starts the backend on `127.0.0.1:8910`, then runs the app in
external-runtime mode (`NEXUS_EXTERNAL_RUNTIME=1`) pointing at the already-healthy
runtime. Keep the window open; `Ctrl-C` stops everything.

> **Why the launcher instead of `cargo tauri dev`?** On macOS 26 an unsigned debug
> binary is killed by AMFI the instant it spawns the node sidecar. The launcher
> signs the binary and runs the runtime outside the app process tree to avoid
> this. Also make sure no unreachable MCP server is enabled — the runtime blocks
> on MCP connect at boot.

### Build a macOS app

Bundling needs the runtime as a self-contained sidecar at
`desktop/src-tauri/binaries/nexus-agent-runtime-<target-triple>` — the dev
launcher runs the runtime from source, so this only matters for packaging (see
[`binaries/README.md`](./desktop/src-tauri/binaries/README.md)). Then:

```bash
cargo tauri build --config desktop/src-tauri/tauri.conf.json --bundles app,dmg
```

It builds `frontend/dist` first and writes `Nexus Agent.app` and `*.dmg` to
`desktop/src-tauri/target/release/bundle/`.

## Configuration

Config lives at `~/.nexus-agent/config.json`. Providers are OpenAI- or
Anthropic-shaped endpoints (`apiKey` + `baseUrl` + optional `endpointFormat`);
models map a logical id to a provider with per-model pricing — no built-in price
table, no hardcoded vendor model ids. API keys can be injected via
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` instead of being written to disk.

Every optional capability (`web`, `memory`, `skills`, `media`, `mcp`,
`delegation`, `insight`) is **off by default**. Out of the box only the core
coding tools are available; network, media, and extension capabilities must be
explicitly enabled.

## Project layout

```
backend/   hexagonal runtime (contracts, domain, ports, adapters, services, loop, server, cli)
frontend/  React + Vite web shell (api, store, ui, lib, i18n, keybindings, styles)
desktop/   Tauri 2.x native shell (sidecar runtime, one SPA / two hosts)
```

## License

[MIT](./LICENSE) © Nexus Agent contributors.
