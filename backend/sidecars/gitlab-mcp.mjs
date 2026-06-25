#!/usr/bin/env node
/**
 * gitlab-mcp — a stdio MCP server exposing a GitLab instance as agent-callable
 * tools. Faithful, dependency-free reimplementation of the original
 * `gitlab-mcp.mjs` / `gitlab-mcp.dup2.mjs` sidecar (server name "nexus-gitlab"),
 * written without @modelcontextprotocol/sdk or zod so it runs in an offline tree.
 *
 * Credentials come from the environment (injected by the host when it spawns the
 * sidecar): GITLAB_URL + GITLAB_TOKEN. Auth uses the GitLab `PRIVATE-TOKEN`
 * header (NOT Bearer). All 17 `gitlab_*` tools call the GitLab v4 REST API.
 *
 * Launch (the app/desktop shell spawns it):
 *   node gitlab-mcp.mjs --gui-gitlab-mcp-server
 *   (legacy alias flag: --nexus-gitlab-mcp-server)
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
 */
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "nexus-gitlab", version: "0.1.0" };

// --- launch config -----------------------------------------------------------

function parseLaunchOptions(argv) {
  if (!argv.includes("--gui-gitlab-mcp-server") && !argv.includes("--nexus-gitlab-mcp-server")) {
    return null;
  }
  return {};
}

// --- value helpers (faithful to gitlab-mcp.dup2.mjs) -------------------------

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function requiredString(value, name) {
  const text = stringValue(value).trim();
  if (!text) throw new Error(`Missing ${name}.`);
  return text;
}
function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Invalid ${name}.`);
  return number;
}
function encodeProject(project) {
  if (typeof project === "number") {
    if (!Number.isInteger(project) || project <= 0) throw new Error("Invalid GitLab project id.");
    return String(project);
  }
  const value = requiredString(project, "GitLab project");
  return /^\d+$/.test(value) ? value : encodeURIComponent(value);
}
function encodePath(value, name) {
  return encodeURIComponent(requiredString(value, name));
}
function readGitlabCredentials() {
  const baseUrl = stringValue(process.env.GITLAB_URL).trim().replace(/\/+$/, "");
  const token = stringValue(process.env.GITLAB_TOKEN).trim();
  if (!baseUrl || !token) {
    throw new Error("Missing GitLab environment. Set GITLAB_URL and GITLAB_TOKEN.");
  }
  return { baseUrl, token };
}
function buildGitlabApiUrl(baseUrl, path, query = {}) {
  const normalizedBaseUrl = requiredString(baseUrl, "GitLab URL").replace(/\/+$/, "");
  const normalizedPath = requiredString(path, "GitLab API path").replace(/^\/+/, "");
  const url = new URL(`${normalizedBaseUrl}/api/v4/${normalizedPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
async function gitlabFetch(path, opts = {}) {
  const { baseUrl, token } = readGitlabCredentials();
  const headers = {
    "PRIVATE-TOKEN": token,
    ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  const response = await fetch(buildGitlabApiUrl(baseUrl, path, opts.query), {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30000),
  });
  const text = await response.text();
  const parsed = parseResponseBody(text);
  if (!response.ok) throw new Error(responseErrorMessage(response.status, parsed, text));
  return opts.rawText ? text : parsed;
}
function parseResponseBody(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function responseErrorMessage(status, parsed, text) {
  if (parsed && typeof parsed === "object") {
    const message = parsed.message ?? parsed.error;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (message && typeof message === "object") return JSON.stringify(message);
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  return text.trim() || `HTTP ${status}`;
}

// --- MCP result helpers ------------------------------------------------------

function textResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function jsonResult(summary, value, key = "result") {
  return textResult(summary, { [key]: value });
}
function decodeFileContent(file) {
  if (!file || typeof file !== "object") return file;
  if (file.encoding !== "base64" || typeof file.content !== "string") return file;
  return { ...file, decodedContent: Buffer.from(file.content, "base64").toString("utf8") };
}
function labelsValue(labels) {
  if (Array.isArray(labels)) {
    return labels.filter((label) => typeof label === "string" && label.trim()).join(",");
  }
  return typeof labels === "string" ? labels : undefined;
}
function projectMergeRequestPath(project, mrIid, suffix = "") {
  return `/projects/${encodeProject(project)}/merge_requests/${positiveInt(mrIid, "MR iid")}${suffix}`;
}
function projectPath(project, suffix = "") {
  return `/projects/${encodeProject(project)}${suffix}`;
}

// --- shared schema fragments (JSON Schema equivalents of the zod fields) -----

const projectSchema = {
  anyOf: [
    { type: "string", minLength: 1, description: "GitLab project numeric id or URL path, e.g. 142 or group/name" },
    { type: "integer", minimum: 1, description: "GitLab project numeric id" },
  ],
};
const stateSchema = { type: "string", enum: ["opened", "closed", "locked", "merged", "all"] };
const issueStateSchema = { type: "string", enum: ["opened", "closed", "all"] };
const paginationProps = {
  page: { type: "integer", minimum: 1, description: "GitLab pagination page" },
  per_page: { type: "integer", minimum: 1, maximum: 100, description: "GitLab page size" },
};
const mrIidSchema = { type: "integer", minimum: 1, description: "Merge request iid" };
const pipelineIdSchema = { type: "integer", minimum: 1, description: "Pipeline id" };
const jobIdSchema = { type: "integer", minimum: 1, description: "CI job id" };

function objectSchema(properties, required) {
  return { type: "object", properties, ...(required && required.length ? { required } : {}) };
}

// --- tool table --------------------------------------------------------------

function buildTools() {
  const defs = [
    {
      name: "gitlab_list_mrs",
      description:
        "List merge requests in a GitLab project. Returns one page only (use `page`/`per_page` to fetch more); the reported count is the number of items on the current page, not the project total.",
      inputSchema: objectSchema({ project: projectSchema, state: stateSchema, ...paginationProps }, ["project"]),
      run: async ({ project, state, page, per_page }) => {
        const mergeRequests = await gitlabFetch(projectPath(project, "/merge_requests"), { query: { state, page, per_page } });
        const count = Array.isArray(mergeRequests) ? mergeRequests.length : 0;
        return jsonResult(`Found ${count} merge request(s).`, mergeRequests, "mergeRequests");
      },
    },
    {
      name: "gitlab_get_mr",
      description: "Get a GitLab merge request by project and iid.",
      inputSchema: objectSchema({ project: projectSchema, mr_iid: mrIidSchema }, ["project", "mr_iid"]),
      run: async ({ project, mr_iid }) => {
        const mergeRequest = await gitlabFetch(projectMergeRequestPath(project, mr_iid));
        return jsonResult(`Loaded merge request !${mr_iid}.`, mergeRequest, "mergeRequest");
      },
    },
    {
      name: "gitlab_get_mr_changes",
      description: "Get changed files and diffs for a GitLab merge request.",
      inputSchema: objectSchema({ project: projectSchema, mr_iid: mrIidSchema }, ["project", "mr_iid"]),
      run: async ({ project, mr_iid }) => {
        const changes = await gitlabFetch(projectMergeRequestPath(project, mr_iid, "/changes"));
        return jsonResult(`Loaded changes for merge request !${mr_iid}.`, changes, "changes");
      },
    },
    {
      name: "gitlab_approve_mr",
      description: "Approve a GitLab merge request.",
      inputSchema: objectSchema({ project: projectSchema, mr_iid: mrIidSchema }, ["project", "mr_iid"]),
      run: async ({ project, mr_iid }) => {
        const approval = await gitlabFetch(projectMergeRequestPath(project, mr_iid, "/approve"), { method: "POST" });
        return jsonResult(`Approved merge request !${mr_iid}.`, approval, "approval");
      },
    },
    {
      name: "gitlab_merge_mr",
      description: "Merge a GitLab merge request.",
      inputSchema: objectSchema(
        {
          project: projectSchema,
          mr_iid: mrIidSchema,
          squash: { type: "boolean" },
          should_remove_source_branch: { type: "boolean" },
          merge_when_pipeline_succeeds: { type: "boolean" },
          sha: { type: "string", description: "Expected source branch SHA" },
        },
        ["project", "mr_iid"],
      ),
      run: async ({ project, mr_iid, squash, should_remove_source_branch, merge_when_pipeline_succeeds, sha }) => {
        const mergeRequest = await gitlabFetch(projectMergeRequestPath(project, mr_iid, "/merge"), {
          method: "PUT",
          body: { squash, should_remove_source_branch, merge_when_pipeline_succeeds, sha },
        });
        return jsonResult(`Merged merge request !${mr_iid}.`, mergeRequest, "mergeRequest");
      },
    },
    {
      name: "gitlab_post_mr_note",
      description: "Post a note to a GitLab merge request.",
      inputSchema: objectSchema(
        { project: projectSchema, mr_iid: mrIidSchema, body: { type: "string", minLength: 1, description: "Markdown note body" } },
        ["project", "mr_iid", "body"],
      ),
      run: async ({ project, mr_iid, body }) => {
        const note = await gitlabFetch(projectMergeRequestPath(project, mr_iid, "/notes"), { method: "POST", body: { body } });
        return jsonResult(`Posted note to merge request !${mr_iid}.`, note, "note");
      },
    },
    {
      name: "gitlab_post_mr_discussion",
      description:
        'Post a merge request discussion. For a line-level comment, pass `position` with the GitLab-required fields: position_type:"text", base_sha, start_sha, head_sha (all from gitlab_get_mr diff_refs), new_path/old_path, and new_line (added lines) and/or old_line (removed lines). Omit `position` for a plain MR-level discussion.',
      inputSchema: objectSchema(
        {
          project: projectSchema,
          mr_iid: mrIidSchema,
          body: { type: "string", minLength: 1, description: "Markdown discussion body" },
          position: {
            type: "object",
            additionalProperties: true,
            description:
              'Line-comment position: { position_type:"text", base_sha, start_sha, head_sha, new_path, old_path, new_line?, old_line? }. Get the *_sha values from gitlab_get_mr diff_refs. Omit for an MR-level comment.',
          },
        },
        ["project", "mr_iid", "body"],
      ),
      run: async ({ project, mr_iid, body, position }) => {
        const discussion = await gitlabFetch(projectMergeRequestPath(project, mr_iid, "/discussions"), {
          method: "POST",
          body: { body, position },
        });
        return jsonResult(`Posted discussion to merge request !${mr_iid}.`, discussion, "discussion");
      },
    },
    {
      name: "gitlab_list_pipelines",
      description: "List GitLab pipelines for a project.",
      inputSchema: objectSchema(
        { project: projectSchema, ref: { type: "string", description: "Branch or tag name" }, ...paginationProps },
        ["project"],
      ),
      run: async ({ project, ref, page, per_page }) => {
        const pipelines = await gitlabFetch(projectPath(project, "/pipelines"), { query: { ref, page, per_page } });
        const count = Array.isArray(pipelines) ? pipelines.length : 0;
        return jsonResult(`Found ${count} pipeline(s).`, pipelines, "pipelines");
      },
    },
    {
      name: "gitlab_get_pipeline_jobs",
      description: "List jobs for a GitLab pipeline.",
      inputSchema: objectSchema({ project: projectSchema, pipeline_id: pipelineIdSchema, ...paginationProps }, ["project", "pipeline_id"]),
      run: async ({ project, pipeline_id, page, per_page }) => {
        const jobs = await gitlabFetch(projectPath(project, `/pipelines/${positiveInt(pipeline_id, "pipeline id")}/jobs`), {
          query: { page, per_page },
        });
        const count = Array.isArray(jobs) ? jobs.length : 0;
        return jsonResult(`Found ${count} pipeline job(s).`, jobs, "jobs");
      },
    },
    {
      name: "gitlab_get_job_log",
      description: "Get a GitLab CI job trace log.",
      inputSchema: objectSchema({ project: projectSchema, job_id: jobIdSchema }, ["project", "job_id"]),
      run: async ({ project, job_id }) => {
        const log = await gitlabFetch(projectPath(project, `/jobs/${positiveInt(job_id, "job id")}/trace`), { rawText: true });
        return textResult(log || `Job ${job_id} log is empty.`, { log });
      },
    },
    {
      name: "gitlab_retry_job",
      description: "Retry a GitLab CI job.",
      inputSchema: objectSchema({ project: projectSchema, job_id: jobIdSchema }, ["project", "job_id"]),
      run: async ({ project, job_id }) => {
        const job = await gitlabFetch(projectPath(project, `/jobs/${positiveInt(job_id, "job id")}/retry`), { method: "POST" });
        return jsonResult(`Retried job ${job_id}.`, job, "job");
      },
    },
    {
      name: "gitlab_search_code",
      description: "Search GitLab code blobs globally or within a project.",
      inputSchema: objectSchema(
        { project: { ...projectSchema }, query: { type: "string", minLength: 1, description: "Search query" }, ...paginationProps },
        ["query"],
      ),
      run: async ({ project, query, page, per_page }) => {
        const path = project === undefined ? "/search" : projectPath(project, "/search");
        const results = await gitlabFetch(path, { query: { scope: "blobs", search: query, page, per_page } });
        const count = Array.isArray(results) ? results.length : 0;
        return jsonResult(`Found ${count} code search result(s).`, results, "results");
      },
    },
    {
      name: "gitlab_get_file",
      description: "Get a repository file from GitLab.",
      inputSchema: objectSchema(
        {
          project: projectSchema,
          path: { type: "string", minLength: 1, description: "Repository file path" },
          ref: { type: "string", description: "Branch, tag, or commit SHA" },
        },
        ["project", "path"],
      ),
      run: async ({ project, path, ref }) => {
        const file = decodeFileContent(
          await gitlabFetch(projectPath(project, `/repository/files/${encodePath(path, "file path")}`), { query: { ref: ref || "HEAD" } }),
        );
        const decoded = typeof file?.decodedContent === "string" ? file.decodedContent : "";
        return textResult(decoded || `Loaded file ${path}.`, { file });
      },
    },
    {
      name: "gitlab_list_commits",
      description: "List repository commits in a GitLab project.",
      inputSchema: objectSchema(
        { project: projectSchema, ref: { type: "string", description: "Branch, tag, or commit SHA" }, ...paginationProps },
        ["project"],
      ),
      run: async ({ project, ref, page, per_page }) => {
        const commits = await gitlabFetch(projectPath(project, "/repository/commits"), { query: { ref_name: ref, page, per_page } });
        const count = Array.isArray(commits) ? commits.length : 0;
        return jsonResult(`Found ${count} commit(s).`, commits, "commits");
      },
    },
    {
      name: "gitlab_get_commit_diff",
      description: "Get a GitLab commit diff.",
      inputSchema: objectSchema({ project: projectSchema, sha: { type: "string", minLength: 1, description: "Commit SHA" } }, ["project", "sha"]),
      run: async ({ project, sha }) => {
        const diff = await gitlabFetch(projectPath(project, `/repository/commits/${encodePath(sha, "commit sha")}/diff`));
        const count = Array.isArray(diff) ? diff.length : 0;
        return jsonResult(`Loaded ${count} diff file(s) for ${sha}.`, diff, "diff");
      },
    },
    {
      name: "gitlab_list_issues",
      description: "List GitLab issues in a project.",
      inputSchema: objectSchema({ project: projectSchema, state: issueStateSchema, ...paginationProps }, ["project"]),
      run: async ({ project, state, page, per_page }) => {
        const issues = await gitlabFetch(projectPath(project, "/issues"), { query: { state, page, per_page } });
        const count = Array.isArray(issues) ? issues.length : 0;
        return jsonResult(`Found ${count} issue(s).`, issues, "issues");
      },
    },
    {
      name: "gitlab_create_issue",
      description: "Create a GitLab issue in a project.",
      inputSchema: objectSchema(
        {
          project: projectSchema,
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          labels: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Comma-separated labels or label array",
          },
        },
        ["project", "title"],
      ),
      run: async ({ project, title, description, labels }) => {
        const issue = await gitlabFetch(projectPath(project, "/issues"), {
          method: "POST",
          body: { title, description, labels: labelsValue(labels) },
        });
        return jsonResult(`Created issue: ${typeof issue?.title === "string" ? issue.title : title}`, issue, "issue");
      },
    },
  ];

  const tools = new Map();
  for (const def of defs) tools.set(def.name, def);
  return tools;
}

// --- JSON-RPC stdio loop -----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, logging: {} }, serverInfo: SERVER_INFO },
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
        // Faithful to the original registerTool wrapper: surface failures as a
        // normal MCP result with isError (not a protocol error).
        result = errorResult(`Failed to run ${tool.name}: ${errMessage(error)}`);
      }
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (error) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: errMessage(error) } });
  }
}

function main() {
  const options = parseLaunchOptions(process.argv.slice(2));
  if (!options) {
    console.error("[gitlab-mcp] missing --gui-gitlab-mcp-server launch flag");
    process.exit(1);
  }
  const tools = buildTools();
  const rl = createInterface({ input: process.stdin });

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
      return;
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
