# Nexus Agent

> 一个以图形界面为核心、与模型供应商无关的 AI 编码智能体 —— 本地运行时 + 功能丰富的
> React 工作台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/open-source-zjq/nexus-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/open-source-zjq/nexus-agent/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

[English](./README.md) | **简体中文**

Nexus Agent 驱动多步骤的模型回合，调用文件 / 命令 / 检索等工具，将结果实时流式回传
以供回放，并把每次会话持久化为可恢复的事件流。它**与供应商无关**：模型层只说通用的
**OpenAI / Anthropic 兼容**协议，因此只要自带 API Key，就能对接任意兼容网关 —— 不内置
任何专有云、模型网关或内网身份。

## 亮点

- 🧠 **多协议模型客户端** —— 支持 OpenAI Chat Completions、OpenAI Responses 与
  Anthropic Messages，并具备自愈式重试。
- 💸 **缓存经济学** —— 不可变前缀指纹、提示词波动检测、工具目录漂移检测，尽量维持
  供应商侧缓存命中。
- 🗜️ **三级上下文压缩**，带可校验的 `tool_digest` 标记。
- 📼 **事件溯源的会话** —— JSONL 文件是唯一可信源；SQLite 只是可丢弃的派生索引；每个
  会话都能通过可恢复的 SSE 回放。
- 🧰 **丰富的工作台** —— 流式聊天（Markdown / Mermaid / Shiki / KaTeX）、内联审批、
  计划 / 差异 / 待办面板，以及智能体、连接器、定时任务等界面。
- 🔌 **能力默认全部关闭** —— `web`、`memory`、`skills`、`media`、`mcp`、`delegation`、
  `insight` 均为按需开启。
- 🖥️ **一套 SPA，两种宿主** —— 既可在浏览器中运行，也可作为原生 Tauri 桌面应用运行。
- 🔒 **默认安全** —— 仅绑定回环地址 + Bearer Token、`workspace-write` 沙箱、
  `on-request` 审批策略，并始终强制路径穿越检查。

## 架构

后端采用六边形（端口与适配器）架构，前端为 Web SPA，共享同一条数据流：

```
contracts → domain → ports → adapters → services → loop → server
```

- **后端**（`backend/`，Node ≥ 20，TypeScript/ESM）—— 单进程运行时，绑定
  `127.0.0.1:8910`，对外暴露 REST + 可恢复 SSE 接口。JSONL 文件是唯一可信源，
  SQLite 是可选、可丢弃的派生索引。
- **前端**（`frontend/`，React 18 + Vite）—— 用于流式聊天、内联审批、计划/差异/待办
  面板、设置，以及智能体/连接器/定时任务等界面的工作台。
- **桌面端**（`desktop/`，Tauri 2.x）—— 原生外壳，以 sidecar 方式拉起后端，并让其
  WebView 指向由运行时托管的 SPA —— 与浏览器版本加载的是同一套 SPA。

## 快速开始

```bash
npm install        # 安装 backend + frontend 两个 workspace
npm run dev        # 后端 :8910 + 前端 Vite :5173
```

生产环境单进程构建（后端托管已构建好的前端）：

```bash
npm run serve
```

## 桌面应用（Tauri）

原生外壳位于 [`desktop/`](./desktop)。在 macOS 上，于访达中**双击
`launch-dev.command`**。一个终端窗口会构建并签名调试版二进制、在 `127.0.0.1:8910`
启动后端，然后以外部运行时模式（`NEXUS_EXTERNAL_RUNTIME=1`）运行应用并指向已就绪的
运行时。使用期间保持该窗口打开；`Ctrl-C` 会停止全部进程。

> **为什么用启动器而不是 `cargo tauri dev`？** 在 macOS 26 上，未签名的调试二进制一旦
> 拉起 node sidecar 就会被 AMFI 立即杀掉。启动器通过对二进制签名、并把运行时放到应用
> 进程树之外来规避此问题。此外请确认没有启用不可达的 MCP 服务器 —— 运行时在启动时会
> 阻塞等待 MCP 连接。

### 打包 macOS 应用

打包需要把运行时作为自包含 sidecar 放在
`desktop/src-tauri/binaries/nexus-agent-runtime-<目标三元组>` —— 开发启动器是从源码
运行运行时的，因此这一步仅在打包时需要（详见
[`binaries/README.md`](./desktop/src-tauri/binaries/README.md)）。然后：

```bash
cargo tauri build --config desktop/src-tauri/tauri.conf.json --bundles app,dmg
```

它会先构建 `frontend/dist`，并将 `Nexus Agent.app` 与 `*.dmg` 输出到
`desktop/src-tauri/target/release/bundle/`。

## 配置

配置文件位于 `~/.nexus-agent/config.json`。Provider 为 OpenAI 或 Anthropic 形态的
端点（`apiKey` + `baseUrl` + 可选 `endpointFormat`）；模型把一个逻辑 id 映射到某个
Provider，并带有按模型计价 —— 无内置价目表，也无写死的厂商模型 id。API Key 可通过
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 注入，无需写入磁盘。

每一项可选能力（`web`、`memory`、`skills`、`media`、`mcp`、`delegation`、`insight`）
**默认均为关闭**。开箱即用时只有核心编码工具可用；网络、媒体与扩展能力必须显式开启。

## 目录结构

```
backend/   六边形运行时（contracts, domain, ports, adapters, services, loop, server, cli）
frontend/  React + Vite Web 外壳（api, store, ui, lib, i18n, keybindings, styles）
desktop/   Tauri 2.x 原生外壳（sidecar 运行时，一套 SPA / 两种宿主）
```

## 许可证

[MIT](./LICENSE) © Nexus Agent contributors.
