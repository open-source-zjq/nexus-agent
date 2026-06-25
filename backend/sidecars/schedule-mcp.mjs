#!/usr/bin/env node
/**
 * schedule-mcp — a stdio MCP server exposing the running Nexus app's scheduled
 * tasks as agent-callable tools. Faithful reimplementation of the original
 * `schedule-mcp.min.cjs` sidecar (server name "nexus-schedule"), written
 * dependency-free (no @modelcontextprotocol/sdk) so it runs in an offline tree.
 *
 * It owns no storage: every tool POSTs to the backend's bearer-guarded
 * `/schedule/internal/{list,create,update,delete}` control-plane endpoints,
 * mapping the snake_case MCP tool arguments to the backend's camelCase wire shape
 * (exactly as the original did).
 *
 * Launch (the app/desktop shell spawns it):
 *   node schedule-mcp.mjs --gui-schedule-mcp-server \
 *     --base-url http://127.0.0.1:8788 --secret <runtimeToken>
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
 */
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "nexus-schedule", version: "0.1.0" };
const REASONING_EFFORTS = ["off", "low", "medium", "high", "max"];

// --- launch config -----------------------------------------------------------

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "";
}

function parseConfig(argv) {
  if (!argv.includes("--gui-schedule-mcp-server") && !argv.includes("--nexus-schedule-mcp-server")) {
    return null;
  }
  return {
    baseUrl: (flagValue(argv, "--base-url").trim() || "http://127.0.0.1:8788").replace(/\/$/, ""),
    secret: flagValue(argv, "--secret").trim(),
  };
}

// --- backend control-plane fetch --------------------------------------------

async function callBackend(config, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (config.secret) headers.Authorization = `Bearer ${config.secret}`;
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { message: text.trim() || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message =
      (typeof parsed.message === "string" && parsed.message.trim()) ||
      (typeof parsed.error === "string" && parsed.error.trim()) ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

// --- MCP result helpers ------------------------------------------------------

function ok(text, structured) {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}
function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// --- tool definitions --------------------------------------------------------

/** Build the tool table (each tool registered twice: gui_* + nexus_* legacy alias). */
function buildTools(config) {
  const listInput = { type: "object", properties: {} };
  const createInput = {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, description: "Short task title shown in the GUI" },
      prompt: { type: "string", minLength: 1, description: "The prompt/instruction the agent should run at schedule time" },
      schedule_kind: { type: "string", enum: ["at", "daily", "interval"], description: "Schedule type" },
      at_time: { type: "string", description: "ISO 8601 timestamp with timezone offset, required when schedule_kind is `at`" },
      time_of_day: { type: "string", description: "24h time like 09:00, required when schedule_kind is `daily`" },
      every_minutes: { type: "integer", minimum: 1, maximum: 10080, description: "Interval in minutes, required when schedule_kind is `interval`" },
      workspace_root: { type: "string", description: "Optional workspace directory override" },
      model: { type: "string", description: "Optional model id, e.g. auto" },
      reasoning_effort: { type: "string", enum: REASONING_EFFORTS, description: "Optional reasoning strength" },
      mode: { type: "string", enum: ["agent", "plan"], description: "Execution mode" },
      enabled: { type: "boolean", description: "Whether the task should be enabled immediately" },
    },
    required: ["title", "prompt", "schedule_kind"],
  };
  const updateInput = {
    type: "object",
    properties: {
      task_id: { type: "string", minLength: 1, description: "Task id returned by gui_schedule_list or gui_schedule_create" },
      title: { type: "string" },
      prompt: { type: "string" },
      enabled: { type: "boolean" },
      workspace_root: { type: "string" },
      model: { type: "string" },
      reasoning_effort: { type: "string", enum: REASONING_EFFORTS },
      mode: { type: "string", enum: ["agent", "plan"] },
      schedule_kind: { type: "string", enum: ["manual", "at", "daily", "interval"] },
      at_time: { type: "string" },
      time_of_day: { type: "string" },
      every_minutes: { type: "integer", minimum: 1, maximum: 10080 },
    },
    required: ["task_id"],
  };
  const deleteInput = {
    type: "object",
    properties: { task_id: { type: "string", minLength: 1, description: "Task id returned by gui_schedule_list or gui_schedule_create" } },
    required: ["task_id"],
  };

  const listHandler = async () => {
    const result = await callBackend(config, "/schedule/internal/list", {});
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    return ok(tasks.length ? `Found ${tasks.length} scheduled task(s).` : "No scheduled tasks are configured.", { tasks });
  };
  const createHandler = async (args) => {
    const result = await callBackend(config, "/schedule/internal/create", {
      input: {
        title: args.title,
        prompt: args.prompt,
        workspaceRoot: args.workspace_root,
        model: args.model,
        reasoningEffort: args.reasoning_effort,
        mode: args.mode,
        enabled: args.enabled,
        schedule: {
          kind: args.schedule_kind,
          atTime: args.at_time,
          timeOfDay: args.time_of_day,
          everyMinutes: args.every_minutes,
        },
      },
    });
    const task = result.task ?? null;
    return ok(`Scheduled task created: ${typeof task?.title === "string" ? task.title : args.title}`, task ? { task } : undefined);
  };
  const updateHandler = async (args) => {
    const patch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.workspace_root !== undefined) patch.workspaceRoot = args.workspace_root;
    if (args.model !== undefined) patch.model = args.model;
    if (args.reasoning_effort !== undefined) patch.reasoningEffort = args.reasoning_effort;
    if (args.mode !== undefined) patch.mode = args.mode;
    if (args.schedule_kind !== undefined || args.at_time !== undefined || args.time_of_day !== undefined || args.every_minutes !== undefined) {
      patch.schedule = {
        ...(args.schedule_kind !== undefined ? { kind: args.schedule_kind } : {}),
        ...(args.at_time !== undefined ? { atTime: args.at_time } : {}),
        ...(args.time_of_day !== undefined ? { timeOfDay: args.time_of_day } : {}),
        ...(args.every_minutes !== undefined ? { everyMinutes: args.every_minutes } : {}),
      };
    }
    const result = await callBackend(config, "/schedule/internal/update", { taskId: args.task_id, patch });
    const task = result.task ?? null;
    return ok(`Scheduled task updated: ${typeof task?.title === "string" ? task.title : args.task_id}`, task ? { task } : undefined);
  };
  const deleteHandler = async (args) => {
    await callBackend(config, "/schedule/internal/delete", { taskId: args.task_id });
    return ok(`Scheduled task deleted: ${args.task_id}`);
  };

  const defs = [
    { base: "schedule_list", input: listInput, run: listHandler, gui: "List scheduled tasks managed by the currently running Nexus app." },
    { base: "schedule_create", input: createInput, run: createHandler, gui: "Create a scheduled task in Nexus. Supports one-time (`at`), daily, or interval schedules." },
    { base: "schedule_update", input: updateInput, run: updateHandler, gui: "Update an existing Nexus scheduled task." },
    { base: "schedule_delete", input: deleteInput, run: deleteHandler, gui: "Delete a scheduled task from Nexus." },
  ];

  const tools = new Map();
  for (const def of defs) {
    for (const prefix of ["gui_", "nexus_"]) {
      const name = `${prefix}${def.base}`;
      const description = prefix === "nexus_" ? `Legacy alias. ${def.gui}` : def.gui;
      tools.set(name, { name, description, inputSchema: def.input, run: def.run });
    }
  }
  return tools;
}

// --- JSON-RPC stdio loop -----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message, tools) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, logging: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") {
      if (isRequest) send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: { tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      });
      return;
    }
    if (method === "tools/call") {
      const tool = tools.get(params?.name);
      if (!tool) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
        return;
      }
      let result;
      try {
        result = await tool.run(params?.arguments ?? {});
      } catch (error) {
        // Tool failures surface as a normal result with isError (MCP convention),
        // not a protocol error — matching the original's Wf() helper.
        result = fail(`${tool.name} failed: ${errMessage(error)}`);
      }
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (error) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: errMessage(error) } });
  }
}

function main() {
  const config = parseConfig(process.argv.slice(2));
  if (!config) {
    console.error("[schedule-mcp] missing --gui-schedule-mcp-server launch flag");
    process.exit(1);
  }
  const tools = buildTools(config);
  const rl = createInterface({ input: process.stdin });

  // Defer shutdown until in-flight requests settle: an async tools/call must not
  // be dropped if stdin closes (or the transport disconnects) mid-call.
  let inFlight = 0;
  let stdinClosed = false;
  const maybeExit = () => {
    if (stdinClosed && inFlight === 0) process.exit(0);
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    inFlight += 1;
    void handleMessage(message, tools).finally(() => {
      inFlight -= 1;
      maybeExit();
    });
  });
  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}

main();
