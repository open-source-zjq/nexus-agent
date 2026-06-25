#!/usr/bin/env node
/**
 * k8s-mcp — a stdio MCP server exposing Kubernetes / KubeSphere DevOps / Nacos
 * operations as agent-callable tools. Faithful, dependency-free reimplementation
 * of the original `k8s-mcp.min.cjs` sidecar (server name "nexus-k8s"), written
 * without @modelcontextprotocol/sdk or zod so it runs in an offline tree.
 *
 * Two transports back the diagnostics tools: `kubectl` is used when it is on PATH
 * (detected once via `kubectl version --client=true`), otherwise a KubeSphere REST
 * fallback is used. The KubeSphere client logs in via the OAuth password grant
 * (`/oauth/token`) and sends both `Authorization` and `X-Authorization` bearer
 * headers, retrying namespaced API paths with a `/cluster/<context>` prefix.
 *
 * Three tools are HIGH-RISK writes (k8s_rollout_restart, k8s_rollback,
 * nacos_publish_config) and are gated by a strict `confirm_env === namespace`
 * guard (assertConfirmEnv). k8s_rollback REQUIRES kubectl: the KubeSphere REST
 * fallback unconditionally throws because it cannot reconstruct historical rollout
 * revisions. The ks_* (KubeSphere DevOps pipeline) tools have NO confirm guard.
 *
 * Credentials come from the environment (injected by the host when it spawns the
 * sidecar):
 *   K8S_USERNAME, K8S_ENCRYPT, K8S_CONTEXT, K8S_NAMESPACE,
 *   KUBESPHERE_URL, KUBESPHERE_CLIENT_ID (default "kubesphere"),
 *   KUBESPHERE_CLIENT_SECRET (default "kubesphere"),
 *   NACOS_URL, NACOS_USERNAME, NACOS_PASSWORD.
 *
 * Launch (the app/desktop shell spawns it):
 *   node k8s-mcp.mjs --gui-k8s-mcp-server
 *   (legacy alias flag: --nexus-k8s-mcp-server)
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
 */
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Latest protocol version the original SDK defaults to, plus the older versions
// it accepts; on initialize it echoes the client's requested version when it is
// in this list, otherwise it answers with the latest. (Faithful to tw/Dg.)
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const SERVER_INFO = { name: "nexus-k8s", version: "0.1.0" };

const DEFAULT_KUBESPHERE_CLIENT_ID = "kubesphere";
const DEFAULT_KUBESPHERE_CLIENT_SECRET = "kubesphere";
const DEFAULT_NACOS_GROUP = "DEFAULT_GROUP";
const LAUNCH_FLAG = "--gui-k8s-mcp-server";
const LEGACY_LAUNCH_FLAG = "--nexus-k8s-mcp-server";

// --- error type --------------------------------------------------------------

class HttpStatusError extends Error {
  constructor(message, status, detail = null) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.detail = detail;
  }
}

// --- value helpers (faithful to op/K/Qe/kE/C$/vt) ----------------------------

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function trimmed(value) {
  return stringValue(value).trim();
}
function requiredString(value, name) {
  const text = trimmed(value);
  if (!text) throw new Error(`Missing ${name}.`);
  return text;
}
function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function optionalInt(value, fallback = undefined) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}
function encodeSegment(value) {
  return encodeURIComponent(requiredString(value, "path segment"));
}

// --- launch config -----------------------------------------------------------

function parseLaunchOptions(argv) {
  return argv.includes(LAUNCH_FLAG) || argv.includes(LEGACY_LAUNCH_FLAG) ? {} : null;
}

function readConfig(env = process.env) {
  return {
    k8sUsername: trimmed(env.K8S_USERNAME),
    k8sEncrypt: trimmed(env.K8S_ENCRYPT),
    k8sContext: trimmed(env.K8S_CONTEXT),
    k8sNamespace: trimmed(env.K8S_NAMESPACE),
    kubesphereUrl: trimmed(env.KUBESPHERE_URL),
    kubesphereClientId: trimmed(env.KUBESPHERE_CLIENT_ID) || DEFAULT_KUBESPHERE_CLIENT_ID,
    kubesphereClientSecret: trimmed(env.KUBESPHERE_CLIENT_SECRET) || DEFAULT_KUBESPHERE_CLIENT_SECRET,
    nacosUrl: trimmed(env.NACOS_URL),
    nacosUsername: trimmed(env.NACOS_USERNAME),
    nacosPassword: trimmed(env.NACOS_PASSWORD),
  };
}

// --- MCP result helpers (faithful to NL/RL/DL/Z$/dr) -------------------------

function textResult(text, structuredContent) {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}
function errorResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    isError: true,
  };
}
function fromOperation(result) {
  return textResult(result.text, result.structured);
}
function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function runGuarded(label, fn) {
  try {
    return fromOperation(await fn());
  } catch (error) {
    return errorResult(`${label}: ${errMessage(error)}`);
  }
}

// --- subprocess helper (faithful to CL/AL) -----------------------------------

async function runCommand(command, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: opts.timeout ?? 20000,
      maxBuffer: opts.maxBuffer ?? 10485760,
    });
    return { stdout: stringValue(stdout), stderr: stringValue(stderr) };
  } catch (error) {
    const stderr = trimmed(error?.stderr);
    const stdout = trimmed(error?.stdout);
    const detail = stderr || stdout || errMessage(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

let kubectlAvailable;
async function hasKubectl() {
  if (kubectlAvailable !== undefined) return kubectlAvailable;
  try {
    await execFileAsync("kubectl", ["version", "--client=true"], { timeout: 3000, maxBuffer: 512 * 1024 });
    kubectlAvailable = true;
  } catch {
    kubectlAvailable = false;
  }
  return kubectlAvailable;
}

// --- kubectl argv + guard (faithful to zE/bc/Tt) -----------------------------

function buildKubectlArgs({ context, namespace, command, selector, output }) {
  const args = [];
  if (trimmed(context)) args.push("--context", trimmed(context));
  if (trimmed(namespace)) args.push("--namespace", trimmed(namespace));
  args.push(...command);
  if (trimmed(selector)) args.push("--selector", trimmed(selector));
  if (output !== null) args.push("--output", trimmed(output) || "wide");
  return args;
}

function assertConfirmEnv(namespace, confirmEnv) {
  const ns = requiredString(namespace, "namespace");
  const confirm = requiredString(confirmEnv, "confirm_env");
  if (ns !== confirm) {
    throw new Error(`confirm_env must exactly match namespace "${ns}" before this high-risk operation can run.`);
  }
}

function resolveNamespace(config, namespace, { required = true } = {}) {
  const ns = trimmed(namespace) || config.k8sNamespace;
  if (!ns && required) throw new Error("Missing namespace. Pass namespace or set K8S_NAMESPACE.");
  return ns;
}

// --- kind aliases + REST descriptors (faithful to UL/ip) ---------------------

const KIND_ALIASES = new Map([
  ["po", "pod"],
  ["pod", "pod"],
  ["pods", "pod"],
  ["deploy", "deployment"],
  ["deployment", "deployment"],
  ["deployments", "deployment"],
  ["sts", "statefulset"],
  ["statefulset", "statefulset"],
  ["statefulsets", "statefulset"],
  ["ds", "daemonset"],
  ["daemonset", "daemonset"],
  ["daemonsets", "daemonset"],
  ["svc", "service"],
  ["service", "service"],
  ["services", "service"],
  ["cm", "configmap"],
  ["configmap", "configmap"],
  ["configmaps", "configmap"],
  ["secret", "secret"],
  ["secrets", "secret"],
  ["job", "job"],
  ["jobs", "job"],
  ["cronjob", "cronjob"],
  ["cronjobs", "cronjob"],
  ["ing", "ingress"],
  ["ingress", "ingress"],
  ["ingresses", "ingress"],
  ["node", "node"],
  ["nodes", "node"],
  ["namespace", "namespace"],
  ["namespaces", "namespace"],
  ["ns", "namespace"],
  ["pv", "persistentvolume"],
  ["persistentvolume", "persistentvolume"],
  ["persistentvolumes", "persistentvolume"],
]);

const KIND_DESCRIPTORS = {
  pod: { api: "/api/v1", plural: "pods", namespaced: true },
  service: { api: "/api/v1", plural: "services", namespaced: true },
  configmap: { api: "/api/v1", plural: "configmaps", namespaced: true },
  secret: { api: "/api/v1", plural: "secrets", namespaced: true },
  deployment: { api: "/apis/apps/v1", plural: "deployments", namespaced: true, restartable: true },
  statefulset: { api: "/apis/apps/v1", plural: "statefulsets", namespaced: true, restartable: true },
  daemonset: { api: "/apis/apps/v1", plural: "daemonsets", namespaced: true, restartable: true },
  job: { api: "/apis/batch/v1", plural: "jobs", namespaced: true },
  cronjob: { api: "/apis/batch/v1", plural: "cronjobs", namespaced: true },
  ingress: { api: "/apis/networking.k8s.io/v1", plural: "ingresses", namespaced: true },
  node: { api: "/api/v1", plural: "nodes", namespaced: false },
  namespace: { api: "/api/v1", plural: "namespaces", namespaced: false },
  persistentvolume: { api: "/api/v1", plural: "persistentvolumes", namespaced: false },
};

function normalizeKind(value) {
  const kind = requiredString(value, "kind").toLowerCase();
  return KIND_ALIASES.get(kind) ?? kind;
}
function resolveKindDescriptor(value) {
  const kind = normalizeKind(value);
  const descriptor = KIND_DESCRIPTORS[kind];
  if (!descriptor) {
    throw new Error(
      `Unsupported Kubernetes kind for REST fallback: ${value}. Install kubectl for generic describe support.`,
    );
  }
  return { kind, ...descriptor };
}
function resolveWorkload(value) {
  const workload = requiredString(value, "workload");
  if (!workload.includes("/")) {
    return { kind: "deployment", name: workload, kubectl: `deployment/${workload}`, ...KIND_DESCRIPTORS.deployment };
  }
  const [rawKind, rawName] = workload.split("/", 2);
  const descriptor = resolveKindDescriptor(rawKind);
  if (!descriptor.restartable) {
    throw new Error(
      `Unsupported workload kind for rollout operation: ${rawKind}. Use deployment, statefulset, or daemonset.`,
    );
  }
  const name = requiredString(rawName, "workload name");
  return { ...descriptor, name, kubectl: `${descriptor.kind}/${name}` };
}

function joinStdoutStderr(stdout, stderr) {
  const out = stdout.trimEnd();
  const err = stderr.trim();
  return err ? `${out}\n\nstderr:\n${err}`.trim() : out;
}

// --- kubectl transport (faithful to ML) --------------------------------------

function createKubectlTransport(config) {
  const context = config.k8sContext;
  const exec = async (namespace, command, opts = {}) => {
    const args = buildKubectlArgs({
      context,
      namespace,
      command,
      selector: opts.selector,
      output: opts.output,
    });
    const { stdout, stderr } = await runCommand("kubectl", args, {
      timeout: opts.timeout ?? 20000,
      maxBuffer: opts.maxBuffer,
    });
    return joinStdoutStderr(stdout, stderr);
  };

  return {
    kind: "kubectl",
    async listPods(args) {
      const namespace = resolveNamespace(config, args.namespace);
      return {
        text: await exec(namespace, ["get", "pods"], { selector: args.selector, output: "wide" }),
        structured: { transport: "kubectl", namespace },
      };
    },
    async describe(args) {
      const namespaced = KIND_DESCRIPTORS[normalizeKind(args.kind)]?.namespaced === false ? "" : resolveNamespace(config, args.namespace);
      return {
        text: await exec(namespaced, ["describe", requiredString(args.kind, "kind"), requiredString(args.name, "name")], {
          output: null,
          maxBuffer: 5 * 1024 * 1024,
        }),
        structured: { transport: "kubectl", namespace: namespaced },
      };
    },
    async logs(args) {
      const namespace = resolveNamespace(config, args.namespace);
      const command = ["logs", requiredString(args.pod, "pod")];
      if (trimmed(args.container)) command.push("--container", trimmed(args.container));
      const tail = optionalInt(args.tail);
      if (tail !== undefined) command.push("--tail", String(tail));
      return {
        text: await exec(namespace, command, { output: null, maxBuffer: 10 * 1024 * 1024 }),
        structured: { transport: "kubectl", namespace },
      };
    },
    async events(args) {
      const namespace = resolveNamespace(config, args.namespace);
      return {
        text: await exec(namespace, ["get", "events", "--sort-by=.lastTimestamp"], { output: null }),
        structured: { transport: "kubectl", namespace },
      };
    },
    async top(args) {
      const namespace = resolveNamespace(config, args.namespace);
      return {
        text: await exec(namespace, ["top", "pods"], { output: null }),
        structured: { transport: "kubectl", namespace },
      };
    },
    async rolloutRestart(args) {
      const namespace = resolveNamespace(config, args.namespace);
      assertConfirmEnv(namespace, args.confirm_env);
      const workload = resolveWorkload(args.workload);
      return {
        text: await exec(namespace, ["rollout", "restart", workload.kubectl], { output: null }),
        structured: { transport: "kubectl", namespace, workload: workload.kubectl },
      };
    },
    async rollback(args) {
      const namespace = resolveNamespace(config, args.namespace);
      assertConfirmEnv(namespace, args.confirm_env);
      const workload = resolveWorkload(args.workload);
      const command = ["rollout", "undo", workload.kubectl];
      const revision = optionalInt(args.revision);
      if (revision !== undefined) command.push(`--to-revision=${revision}`);
      return {
        text: await exec(namespace, command, { output: null }),
        structured: { transport: "kubectl", namespace, workload: workload.kubectl },
      };
    },
  };
}

// --- HTTP helpers (faithful to EE/U$/$c/qL/TE) -------------------------------

function normalizeUrl(value, name) {
  const raw = requiredString(value, name).replace(/\/+$/, "");
  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

async function readBody(response, raw = false) {
  const text = await response.text();
  if (raw) return text;
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseErrorMessage(status, parsed) {
  if (parsed && typeof parsed === "object") {
    const message = parsed.message || parsed.error || parsed.reason || parsed.details?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return typeof parsed === "string" && parsed.trim() ? parsed.trim() : `HTTP ${status}`;
}

function buildUrl(base, path, query = {}) {
  const url = new URL(path, `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function kubeSpherePathCandidates(path, context) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const ctx = trimmed(context);
  if (!ctx || (!normalizedPath.startsWith("/api/") && !normalizedPath.startsWith("/apis/"))) {
    return [normalizedPath];
  }
  return [`/cluster/${encodeSegment(ctx)}${normalizedPath}`, normalizedPath];
}

function isRetryableStatus(error) {
  return error instanceof HttpStatusError && [404, 405].includes(error.status);
}

// --- KubeSphere REST client (faithful to jE) ---------------------------------

function createKubeSphereClient(config) {
  const baseUrl = normalizeUrl(config.kubesphereUrl, "KUBESPHERE_URL");
  let accessToken = "";
  let expiresAt = 0;

  const login = async () => {
    const now = Date.now();
    if (accessToken && expiresAt > now + 30000) return accessToken;
    const username = requiredString(config.k8sUsername, "K8S_USERNAME");
    const password = requiredString(config.k8sEncrypt, "K8S_ENCRYPT");
    const body = new URLSearchParams({
      grant_type: "password",
      username,
      password,
      client_id: config.kubesphereClientId || DEFAULT_KUBESPHERE_CLIENT_ID,
      client_secret: config.kubesphereClientSecret || DEFAULT_KUBESPHERE_CLIENT_SECRET,
    });
    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const parsed = await readBody(response);
    if (!response.ok) {
      throw new HttpStatusError(`KubeSphere login failed: ${responseErrorMessage(response.status, parsed)}`, response.status, parsed);
    }
    accessToken = requiredString(parsed?.access_token, "KubeSphere access_token");
    const expiresIn = Number(parsed?.expires_in);
    expiresAt = Number.isFinite(expiresIn) ? now + expiresIn * 1000 : now + 3600 * 1000;
    return accessToken;
  };

  return {
    request: async (path, opts = {}) => {
      const token = await login();
      const headers = {
        Accept: opts.raw ? "*/*" : "application/json",
        Authorization: `Bearer ${token}`,
        "X-Authorization": `Bearer ${token}`,
        ...plainObject(opts.headers),
      };
      let body;
      if (opts.body !== undefined) {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        body = headers["Content-Type"].includes("json") ? JSON.stringify(opts.body) : opts.body;
      }
      const candidates = kubeSpherePathCandidates(path, config.k8sContext);
      let lastError;
      for (const candidate of candidates) {
        const response = await fetch(buildUrl(baseUrl, candidate, opts.query), {
          method: opts.method || "GET",
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeout ?? 20000),
        });
        const parsed = await readBody(response, opts.raw);
        if (response.ok) return parsed;
        lastError = new HttpStatusError(responseErrorMessage(response.status, parsed), response.status, parsed);
        if (!isRetryableStatus(lastError)) throw lastError;
      }
      throw lastError;
    },
  };
}

function restResourcePath(descriptor, namespace, name = "") {
  const scope = descriptor.namespaced ? `/namespaces/${encodeSegment(namespace)}/${descriptor.plural}` : `/${descriptor.plural}`;
  return `${descriptor.api}${scope}${name ? `/${encodeSegment(name)}` : ""}`;
}

// --- table formatting (faithful to LL/VL/FL/R$/KL/JL/M$) ----------------------

function readyColumn(pod) {
  const statuses = Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : [];
  return `${statuses.filter((s) => s.ready).length}/${statuses.length}`;
}
function restartColumn(pod) {
  return (Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []).reduce(
    (total, s) => total + (Number(s.restartCount) || 0),
    0,
  );
}
function formatPods(pods) {
  const rows = [["NAME", "READY", "STATUS", "RESTARTS", "NODE"]];
  for (const pod of pods) {
    rows.push([
      trimmed(pod.metadata?.name),
      readyColumn(pod),
      trimmed(pod.status?.phase),
      String(restartColumn(pod)),
      trimmed(pod.spec?.nodeName),
    ]);
  }
  return formatTable(rows);
}
function eventTimestamp(event) {
  return event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || "";
}
function formatEvents(events) {
  const sorted = [...events].sort((a, b) => eventTimestamp(a).localeCompare(eventTimestamp(b)));
  const rows = [["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"]];
  for (const event of sorted) {
    rows.push([
      eventTimestamp(event),
      trimmed(event.type),
      trimmed(event.reason),
      [event.involvedObject?.kind, event.involvedObject?.name].filter(Boolean).join("/"),
      trimmed(event.message).replace(/\s+/g, " "),
    ]);
  }
  return formatTable(rows);
}
function formatMetrics(items) {
  const rows = [["NAME", "CPU", "MEMORY"]];
  for (const item of items) {
    const containers = Array.isArray(item.containers) ? item.containers : [];
    rows.push([
      trimmed(item.metadata?.name),
      containers.map((c) => `${c.name}:${c.usage?.cpu ?? ""}`).join(", "),
      containers.map((c) => `${c.name}:${c.usage?.memory ?? ""}`).join(", "),
    ]);
  }
  return formatTable(rows);
}
function formatTable(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => String(cell).padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

// --- KubeSphere REST transport (faithful to HL) ------------------------------

function createKubeSphereTransport(config) {
  const client = createKubeSphereClient(config);
  return {
    kind: "kubesphere-rest",
    async listPods(args) {
      const namespace = resolveNamespace(config, args.namespace);
      const response = await client.request(restResourcePath(KIND_DESCRIPTORS.pod, namespace), {
        query: args.selector ? { labelSelector: args.selector } : {},
      });
      const items = Array.isArray(response?.items) ? response.items : [];
      return {
        text: items.length ? formatPods(items) : `No pods found in namespace ${namespace}.`,
        structured: { transport: "kubesphere-rest", namespace, pods: items },
      };
    },
    async describe(args) {
      const descriptor = resolveKindDescriptor(args.kind);
      const namespace = descriptor.namespaced ? resolveNamespace(config, args.namespace) : "";
      const object = await client.request(restResourcePath(descriptor, namespace, requiredString(args.name, "name")));
      return {
        text: JSON.stringify(object, null, 2),
        structured: { transport: "kubesphere-rest", namespace, object },
      };
    },
    async logs(args) {
      const namespace = resolveNamespace(config, args.namespace);
      const query = {};
      if (trimmed(args.container)) query.container = trimmed(args.container);
      const tail = optionalInt(args.tail);
      if (tail !== undefined) query.tailLines = tail;
      const text = await client.request(`/api/v1/namespaces/${encodeSegment(namespace)}/pods/${encodeSegment(args.pod)}/log`, {
        query,
        raw: true,
        headers: { Accept: "text/plain" },
        timeout: 30000,
      });
      return { text: trimmed(text) || "(empty log)", structured: { transport: "kubesphere-rest", namespace } };
    },
    async events(args) {
      const namespace = resolveNamespace(config, args.namespace);
      const response = await client.request(`/api/v1/namespaces/${encodeSegment(namespace)}/events`);
      const items = Array.isArray(response?.items) ? response.items : [];
      return {
        text: items.length ? formatEvents(items) : `No events found in namespace ${namespace}.`,
        structured: { transport: "kubesphere-rest", namespace, events: items },
      };
    },
    async top(args) {
      const namespace = resolveNamespace(config, args.namespace);
      const response = await client.request(`/apis/metrics.k8s.io/v1beta1/namespaces/${encodeSegment(namespace)}/pods`);
      const items = Array.isArray(response?.items) ? response.items : [];
      return {
        text: items.length ? formatMetrics(items) : `No pod metrics found in namespace ${namespace}.`,
        structured: { transport: "kubesphere-rest", namespace, metrics: items },
      };
    },
    async rolloutRestart(args) {
      const namespace = resolveNamespace(config, args.namespace);
      assertConfirmEnv(namespace, args.confirm_env);
      const workload = resolveWorkload(args.workload);
      const restartedAt = new Date().toISOString();
      const result = await client.request(restResourcePath(workload, namespace, workload.name), {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } } },
      });
      return {
        text: `Restart annotation patched on ${workload.kind}/${workload.name} in ${namespace}.`,
        structured: {
          transport: "kubesphere-rest",
          namespace,
          workload: `${workload.kind}/${workload.name}`,
          restartedAt,
          result,
        },
      };
    },
    async rollback(args) {
      resolveNamespace(config, args.namespace);
      throw new Error(
        "k8s_rollback requires kubectl. KubeSphere REST fallback cannot safely reconstruct historical rollout revisions.",
      );
    },
  };
}

// --- transport selection + dispatch (faithful to OE/NE) ----------------------

async function createTransport(config) {
  return (await hasKubectl()) ? createKubectlTransport(config) : createKubeSphereTransport(config);
}

async function runK8sOperation(config, operation, args) {
  const transport = await createTransport(config);
  if (typeof transport[operation] !== "function") {
    throw new Error(`Unsupported k8s operation: ${operation}`);
  }
  return transport[operation](args);
}

// --- KubeSphere DevOps pipelines (faithful to RE/DE/GL/BL/gE/WL) -------------

function normalizeParameters(params) {
  if (Array.isArray(params)) {
    return params
      .filter((entry) => entry && typeof entry === "object" && trimmed(entry.name))
      .map((entry) => ({ name: trimmed(entry.name), value: entry.value }));
  }
  return Object.entries(plainObject(params)).map(([name, value]) => ({ name, value }));
}

function triggerPipelineV3({ project, pipeline, branch, params }) {
  const branchQuery = trimmed(branch) ? `?branch=${encodeURIComponent(trimmed(branch))}` : "";
  return {
    method: "POST",
    path: `/kapis/devops.kubesphere.io/v1alpha3/namespaces/${encodeSegment(project)}/pipelines/${encodeSegment(pipeline)}/pipelineruns${branchQuery}`,
    body: { parameters: normalizeParameters(params) },
  };
}

function triggerPipelineLegacy({ project, pipeline, branch, params }) {
  const projectSeg = encodeSegment(project);
  const pipelineSeg = encodeSegment(pipeline);
  const branchSeg = trimmed(branch) ? encodeSegment(branch) : "";
  const body = { parameters: normalizeParameters(params) };
  return [
    ...(branchSeg
      ? [
          {
            method: "POST",
            path: `/kapis/devops.kubesphere.io/v1alpha2/namespaces/${projectSeg}/pipelines/${pipelineSeg}/branches/${branchSeg}/runs`,
            body,
          },
        ]
      : []),
    { method: "POST", path: `/kapis/devops.kubesphere.io/v1alpha2/namespaces/${projectSeg}/pipelines/${pipelineSeg}/runs`, body },
  ];
}

function pipelineStatusCandidates({ project, pipeline, run_id }) {
  const projectSeg = encodeSegment(project);
  const pipelineSeg = encodeSegment(pipeline);
  const runSeg = encodeSegment(run_id);
  return [
    { method: "GET", path: `/kapis/devops.kubesphere.io/v1alpha3/namespaces/${projectSeg}/pipelineruns/${runSeg}` },
    { method: "GET", path: `/kapis/devops.kubesphere.io/v1alpha2/namespaces/${projectSeg}/pipelines/${pipelineSeg}/runs/${runSeg}` },
  ];
}

async function tryApiCandidates(client, candidates) {
  const attempted = [];
  for (const candidate of candidates) {
    try {
      return { result: await client.request(candidate.path, { method: candidate.method, body: candidate.body }), candidate, attempted };
    } catch (error) {
      attempted.push({
        method: candidate.method,
        path: candidate.path,
        status: error instanceof HttpStatusError ? error.status : undefined,
        message: errMessage(error),
      });
      if (!isRetryableStatus(error)) throw error;
    }
  }
  throw new Error(
    `All KubeSphere API candidates failed: ${attempted.map((a) => `${a.method} ${a.path} -> ${a.status ?? "ERR"} ${a.message}`).join("; ")}`,
  );
}

function createPipelineClient(config) {
  const client = createKubeSphereClient(config);
  return {
    async triggerPipeline(args) {
      const candidates = [triggerPipelineV3(args), ...triggerPipelineLegacy(args)];
      const { result, candidate, attempted } = await tryApiCandidates(client, candidates);
      const runId = trimmed(result?.metadata?.name) || trimmed(result?.id) || trimmed(result?.name);
      return {
        text: runId
          ? `Triggered KubeSphere pipeline ${args.project}/${args.pipeline}; run_id=${runId}.`
          : `Triggered KubeSphere pipeline ${args.project}/${args.pipeline}.`,
        structured: { run_id: runId || null, result, path: candidate.path, attempted },
      };
    },
    async pipelineStatus(args) {
      const candidates = pipelineStatusCandidates(args);
      const { result, candidate, attempted } = await tryApiCandidates(client, candidates);
      return { text: JSON.stringify(result, null, 2), structured: { result, path: candidate.path, attempted } };
    },
  };
}

// --- Nacos client (faithful to D$/XL) ----------------------------------------

function nacosUrl(base, path) {
  const url = normalizeUrl(base, "NACOS_URL");
  if (url.endsWith("/nacos/v1")) return `${url}${path.replace(/^\/v1/, "")}`;
  if (url.endsWith("/v1")) return `${url}${path.replace(/^\/v1/, "")}`;
  if (url.endsWith("/nacos")) return `${url}${path}`;
  return `${url}/nacos${path}`;
}

function createNacosClient(config) {
  let accessToken = "";

  const login = async () => {
    if (accessToken || !config.nacosUsername || !config.nacosPassword) return accessToken;
    const body = new URLSearchParams({ username: config.nacosUsername, password: config.nacosPassword });
    const response = await fetch(nacosUrl(config.nacosUrl, "/v1/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const parsed = await readBody(response);
    if (!response.ok) {
      throw new HttpStatusError(`Nacos login failed: ${responseErrorMessage(response.status, parsed)}`, response.status, parsed);
    }
    accessToken = trimmed(parsed?.accessToken);
    return accessToken;
  };

  const request = async (method, fields) => {
    requiredString(config.nacosUrl, "NACOS_URL");
    const token = await login();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined || value === "") continue;
      params.set(key, String(value));
    }
    if (token) params.set("accessToken", token);
    if (method === "GET") {
      const response = await fetch(`${nacosUrl(config.nacosUrl, "/v1/cs/configs")}?${params.toString()}`, {
        method,
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      if (!response.ok) throw new HttpStatusError(responseErrorMessage(response.status, text), response.status, text);
      return text;
    }
    const response = await fetch(nacosUrl(config.nacosUrl, "/v1/cs/configs"), {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok) throw new HttpStatusError(responseErrorMessage(response.status, text), response.status, text);
    return text;
  };

  return {
    async getConfig(args) {
      const dataId = requiredString(args.data_id, "data_id");
      const group = trimmed(args.group) || DEFAULT_NACOS_GROUP;
      const tenant = trimmed(args.namespace);
      return {
        text: await request("GET", { dataId, group, tenant }),
        structured: { data_id: dataId, group, namespace: tenant || null },
      };
    },
    async publishConfig(args) {
      const dataId = requiredString(args.data_id, "data_id");
      const group = trimmed(args.group) || DEFAULT_NACOS_GROUP;
      const tenant = trimmed(args.namespace) || config.k8sNamespace;
      assertConfirmEnv(tenant, args.confirm_env);
      const response = await request("POST", { dataId, group, tenant, content: stringValue(args.content) });
      return {
        text:
          response.trim() === "true"
            ? `Published Nacos config ${dataId} in ${tenant || "(public)"} / ${group}.`
            : `Nacos publish response: ${response}`,
        structured: { data_id: dataId, group, namespace: tenant || null, response },
      };
    },
  };
}

// --- input schemas (JSON Schema equivalents of the zod shapes) ---------------
// The original registered zod shapes; the SDK wraps each in z.object(...) and
// serializes it to JSON Schema for tools/list. These objects reproduce that
// wire shape (additionalProperties:false to mirror a strict z.object).

function objectSchema(properties, required) {
  return {
    type: "object",
    properties,
    ...(required && required.length ? { required } : {}),
    additionalProperties: false,
  };
}

const namespaceProp = { type: "string", description: "Kubernetes namespace. Defaults to K8S_NAMESPACE." };

// --- tool table --------------------------------------------------------------

function buildTools(config) {
  const k8sOp = (operation, args) => runK8sOperation(config, operation, args);
  // Lazily construct the KubeSphere/Nacos clients on first use: their
  // constructors validate required env (KUBESPHERE_URL / NACOS_URL …) and throw
  // when unset. Constructing eagerly here would crash `initialize`/`tools/list`
  // whenever those integrations are unconfigured. Deferring to first call lets
  // the tool catalog list normally and surfaces a missing-credential error as a
  // graceful `isError` result via runGuarded (matching the gitlab sidecar).
  let pipelineClientRef;
  let nacosClientRef;
  const pipelineClient = () => (pipelineClientRef ??= createPipelineClient(config));
  const nacosClient = () => (nacosClientRef ??= createNacosClient(config));

  const defs = [
    {
      name: "k8s_list_pods",
      description: "List Kubernetes pods for read-only diagnostics. Uses kubectl when available, otherwise KubeSphere REST API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema({
        namespace: namespaceProp,
        selector: { type: "string", description: "Optional label selector, e.g. app=api." },
      }),
      run: (args) => runGuarded("Failed to list pods", () => k8sOp("listPods", args)),
    },
    {
      name: "k8s_describe",
      description:
        "Describe a Kubernetes object for read-only diagnostics. Uses kubectl when available, otherwise KubeSphere REST API for common kinds.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema(
        {
          kind: { type: "string", minLength: 1, description: "Kubernetes kind, e.g. pod, deployment, service." },
          name: { type: "string", minLength: 1, description: "Object name." },
          namespace: { type: "string", description: "Kubernetes namespace. Defaults to K8S_NAMESPACE for namespaced kinds." },
        },
        ["kind", "name"],
      ),
      run: (args) => runGuarded("Failed to describe object", () => k8sOp("describe", args)),
    },
    {
      name: "k8s_logs",
      description: "Fetch pod logs for read-only diagnostics. Uses kubectl when available, otherwise KubeSphere REST API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema(
        {
          pod: { type: "string", minLength: 1, description: "Pod name." },
          namespace: namespaceProp,
          container: { type: "string", description: "Optional container name." },
          tail: { type: "integer", minimum: 1, maximum: 5000, description: "Optional number of trailing log lines." },
        },
        ["pod"],
      ),
      run: (args) => runGuarded("Failed to fetch logs", () => k8sOp("logs", args)),
    },
    {
      name: "k8s_events",
      description: "List namespace events for read-only diagnostics. Uses kubectl when available, otherwise KubeSphere REST API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema({ namespace: namespaceProp }),
      run: (args) => runGuarded("Failed to list events", () => k8sOp("events", args)),
    },
    {
      name: "k8s_top",
      description:
        "Show pod CPU and memory usage for read-only diagnostics. Uses kubectl top when available, otherwise metrics.k8s.io through KubeSphere REST API.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema({ namespace: namespaceProp }),
      run: (args) => runGuarded("Failed to fetch pod metrics", () => k8sOp("top", args)),
    },
    {
      name: "k8s_rollout_restart",
      description:
        "HIGH-RISK Kubernetes write operation; requires confirmation. Restarts a deployment/statefulset/daemonset only when confirm_env exactly matches namespace.",
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: objectSchema(
        {
          workload: { type: "string", minLength: 1, description: "Workload name or kind/name, e.g. order-api or deployment/order-api." },
          namespace: { type: "string", minLength: 1, description: "Target Kubernetes namespace." },
          confirm_env: { type: "string", minLength: 1, description: "Must exactly match namespace, used as second input confirmation." },
        },
        ["workload", "namespace", "confirm_env"],
      ),
      run: (args) => runGuarded("Failed to restart rollout", () => k8sOp("rolloutRestart", args)),
    },
    {
      name: "k8s_rollback",
      description:
        "HIGH-RISK Kubernetes write operation; requires confirmation. Rolls back a workload only when confirm_env exactly matches namespace; kubectl is required.",
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: objectSchema(
        {
          workload: { type: "string", minLength: 1, description: "Workload name or kind/name, e.g. order-api or deployment/order-api." },
          namespace: { type: "string", minLength: 1, description: "Target Kubernetes namespace." },
          revision: { type: "integer", minimum: 1, description: "Optional rollout revision number." },
          confirm_env: { type: "string", minLength: 1, description: "Must exactly match namespace, used as second input confirmation." },
        },
        ["workload", "namespace", "confirm_env"],
      ),
      run: (args) => runGuarded("Failed to roll back workload", () => k8sOp("rollback", args)),
    },
    {
      name: "ks_trigger_pipeline",
      description: "Requires confirmation. Trigger a KubeSphere DevOps pipeline run via KubeSphere REST API.",
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: objectSchema(
        {
          project: { type: "string", minLength: 1, description: "KubeSphere DevOps project namespace." },
          pipeline: { type: "string", minLength: 1, description: "Pipeline name." },
          branch: { type: "string", description: "Optional branch/ref name for multi-branch pipelines." },
          params: { type: "object", additionalProperties: true, description: "Optional pipeline parameters." },
        },
        ["project", "pipeline"],
      ),
      run: (args) => runGuarded("Failed to trigger KubeSphere pipeline", () => pipelineClient().triggerPipeline(args)),
    },
    {
      name: "ks_pipeline_status",
      description: "Requires confirmation. Read KubeSphere DevOps pipeline run status by run_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema(
        {
          project: { type: "string", minLength: 1, description: "KubeSphere DevOps project namespace." },
          pipeline: { type: "string", minLength: 1, description: "Pipeline name, used for legacy API fallback." },
          run_id: { type: "string", minLength: 1, description: "PipelineRun name or legacy run id." },
        },
        ["project", "pipeline", "run_id"],
      ),
      run: (args) => runGuarded("Failed to read KubeSphere pipeline status", () => pipelineClient().pipelineStatus(args)),
    },
    {
      name: "nacos_get_config",
      description: "Read a Nacos config item. Uses NACOS_URL and optional NACOS_USERNAME/NACOS_PASSWORD.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: objectSchema(
        {
          data_id: { type: "string", minLength: 1, description: "Nacos dataId." },
          group: { type: "string", description: "Nacos group. Defaults to DEFAULT_GROUP." },
          namespace: { type: "string", description: "Nacos tenant/namespace." },
        },
        ["data_id"],
      ),
      run: (args) => runGuarded("Failed to read Nacos config", () => nacosClient().getConfig(args)),
    },
    {
      name: "nacos_publish_config",
      description:
        "Requires confirmation. Publish a Nacos config item; confirm_env must exactly match the target namespace/tenant.",
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: objectSchema(
        {
          data_id: { type: "string", minLength: 1, description: "Nacos dataId." },
          content: { type: "string", description: "Full config content to publish." },
          group: { type: "string", description: "Nacos group. Defaults to DEFAULT_GROUP." },
          namespace: { type: "string", description: "Nacos tenant/namespace. Defaults to K8S_NAMESPACE for confirmation." },
          confirm_env: { type: "string", minLength: 1, description: "Must exactly match namespace/tenant, used as second input confirmation." },
        },
        ["data_id", "confirm_env"],
      ),
      run: (args) => runGuarded("Failed to publish Nacos config", () => nacosClient().publishConfig(args)),
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

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
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
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          // logging declared at construction; tools.listChanged added by registerTool.
          capabilities: { logging: {}, tools: { listChanged: true } },
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
        result: {
          tools: [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        },
      });
      return;
    }
    if (method === "tools/call") {
      const tool = tools.get(params?.name);
      if (!tool) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Tool ${params?.name} not found` } });
        return;
      }
      let result;
      try {
        result = await tool.run(params?.arguments ?? {});
      } catch (error) {
        // Faithful to the SDK's createToolError: surface failures as a normal
        // MCP result with isError (not a protocol error).
        result = errorResult(errMessage(error));
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
    console.error("[k8s-mcp] missing --gui-k8s-mcp-server launch flag");
    process.exit(1);
  }
  const config = readConfig();
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
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    let message;
    try {
      message = JSON.parse(trimmedLine);
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
