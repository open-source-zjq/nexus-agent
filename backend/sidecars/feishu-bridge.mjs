#!/usr/bin/env node
/**
 * feishu-bridge — a bidirectional NDJSON-RPC bridge between the Nexus host and
 * Feishu/Lark. Faithful, DEPENDENCY-FREE reimplementation of the original
 * `feishu-bridge.mjs` sidecar, which used the `@larksuiteoapi/node-sdk`
 * (`createLarkChannel` + axios + `ws`). Here the SDK is reimplemented inline
 * against `node:` builtins + global `fetch` + Node 25's native `WebSocket`,
 * so it runs in an offline tree (no npm install).
 *
 * Two channels run at once:
 *   1. INBOUND  — Feishu events over the Feishu long-connection WebSocket
 *      (`/callback/ws/endpoint` → connectUrl, protobuf Frame framing, ping/pong,
 *      auto-reconnect). Inbound IM messages, card-action clicks, and
 *      p2p-chat-entered events are normalized and written to stdout as NDJSON
 *      event lines.
 *   2. COMMANDS — one NDJSON command per stdin line (with an `id` for response
 *      correlation). Each command runs a Feishu OpenAPI call and replies with a
 *      `commandResult` event line.
 *
 * Protocol: this is NOT MCP. Outbound stdout events (newline-delimited JSON):
 *   { type: "message"|"card_action"|"p2p_entered"|"ready"|"reconnecting"
 *          |"reconnected"|"reject"|"error"|"warn"|"commandResult", ... }
 * Inbound stdin commands (newline-delimited JSON):
 *   { id, type, ...payload }
 *
 * Credentials (env, injected by the host — names preserved EXACTLY):
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHANNEL_ID
 *   FEISHU_DOMAIN ("lark" | "feishu"; default feishu)
 *   FEISHU_USER_ACCESS_TOKEN (optional, per-command identity override)
 *   FEISHU_WEB_BASE_URL (optional web-link base override)
 *   TZ (calendar event default timezone)
 *
 * Launch (the app/desktop shell spawns it): `node feishu-bridge.mjs`.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";

const execFileAsync = promisify(execFile);

// ─── stdout event helpers ────────────────────────────────────────────────────

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
function writeError(message, detail = {}) {
  writeEvent({ type: "error", message, detail });
}
function writeCommandResult(id, ok, result = null, message = "") {
  writeEvent({ type: "commandResult", id, ok, result, message });
}

// ─── value helpers (faithful to the original) ────────────────────────────────

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function commandPayload(command) {
  return { ...objectValue(command.input), ...objectValue(command) };
}
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
function boolValue(value) {
  return value === true;
}
function firstString(...values) {
  for (const value of values) {
    const normalized = stringValue(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

// ─── Feishu OpenAPI client (dependency-free; replaces the SDK Client) ─────────

const DOMAIN_BASE = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};

let activeClient = null;

/**
 * Minimal Feishu OpenAPI client. Acquires + caches a self-build tenant access
 * token (POST /open-apis/auth/v3/tenant_access_token/internal) and signs every
 * request with `Bearer <token>` — exactly as the SDK's formatPayload did. A
 * per-request user access token (when provided) overrides the tenant token.
 *
 * `request({ method, url, params, path, data, headers, userAccessToken })`
 * resolves to the parsed JSON body (the SDK's axios interceptor returned
 * `resp.data`, so callers see the raw `{ code, msg, data }` envelope).
 */
function makeClient(appId, appSecret, domainName) {
  const base = DOMAIN_BASE[domainName] || DOMAIN_BASE.feishu;
  let cachedToken = "";
  let cachedExpiry = 0;

  async function getTenantAccessToken() {
    if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
    const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (numberValue(body.code, 0) !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant_access_token failed: ${body.msg || body.message || `code ${body.code}`}`);
    }
    cachedToken = body.tenant_access_token;
    // Refresh 3 minutes early to absorb network latency (matches the SDK).
    cachedExpiry = Date.now() + numberValue(body.expire, 0) * 1000 - 3 * 60 * 1000;
    return cachedToken;
  }

  function fillApiPath(apiPath, pathSupplement = {}) {
    return apiPath.replace(/:([^/]+)/g, (_, key) => {
      if (pathSupplement[key] !== undefined) return String(pathSupplement[key]);
      throw new Error(`request miss ${key} path argument`);
    });
  }

  function buildUrl(url, params) {
    const absolute = /^http/.test(url) ? url : `${base}/${url.replace(/^\//, "")}`;
    const target = new URL(absolute);
    for (const [key, value] of Object.entries(objectValue(params))) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== "") target.searchParams.append(key, String(item));
        }
      } else {
        target.searchParams.set(key, String(value));
      }
    }
    return target.toString();
  }

  async function request({ method = "GET", url, params, path, data, headers, userAccessToken } = {}) {
    const resolvedUrl = path ? fillApiPath(url, path) : url;
    const token = firstString(userAccessToken) || (await getTenantAccessToken());
    const upper = method.toUpperCase();
    const hasBody = data !== undefined && upper !== "GET";
    const response = await fetch(buildUrl(resolvedUrl, params), {
      method: upper,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...objectValue(headers),
      },
      ...(hasBody ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { msg: text.trim() || `HTTP ${response.status}` };
    }
    if (!response.ok && (parsed == null || typeof parsed !== "object")) {
      const error = new Error(`HTTP ${response.status}`);
      error.response = { status: response.status, data: parsed };
      throw error;
    }
    return parsed;
  }

  return { base, domainName, request };
}

function ensureSdkOk(response, action) {
  const body = objectValue(response);
  const code = numberValue(body.code, 0);
  if (code !== 0) {
    throw new Error(`${action} failed: ${body.msg || body.message || `code ${code}`}`);
  }
  return objectValue(body.data);
}

function describeCommandError(error) {
  const base = error?.message || String(error);
  const data = error?.response?.data;
  if (data && typeof data === "object") {
    const code = data.code ?? data.error?.code;
    const msg = data.msg || data.message || data.error?.message;
    if (msg || code !== undefined) {
      return `${base}${msg ? ` — ${msg}` : ""}${code !== undefined ? ` (code ${code})` : ""}`;
    }
  }
  return base;
}

// ─── interactive cards ───────────────────────────────────────────────────────

async function sendInteractiveCard({ chatId, card } = {}) {
  try {
    const targetChatId = firstString(chatId);
    const cardContent = objectValue(card);
    if (!targetChatId) throw new Error("Missing Feishu chatId.");
    if (Object.keys(cardContent).length === 0) throw new Error("Missing Feishu interactive card.");
    const response = await activeClient.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: { receive_id: targetChatId, msg_type: "interactive", content: JSON.stringify(cardContent) },
    });
    const data = ensureSdkOk(response, "send interactive card");
    const messageId = firstString(data.message_id, data.messageId);
    if (!messageId) throw new Error("Feishu interactive card response did not include message_id.");
    return { ok: true, messageId };
  } catch (error) {
    return { ok: false, error: describeCommandError(error) };
  }
}

async function patchInteractiveCard({ messageId, card } = {}) {
  try {
    const targetMessageId = firstString(messageId);
    const cardContent = objectValue(card);
    if (!targetMessageId) throw new Error("Missing Feishu messageId.");
    if (Object.keys(cardContent).length === 0) throw new Error("Missing Feishu interactive card.");
    const response = await activeClient.request({
      method: "PATCH",
      url: "/open-apis/im/v1/messages/:message_id",
      path: { message_id: targetMessageId },
      data: { content: JSON.stringify(cardContent) },
    });
    ensureSdkOk(response, "patch interactive card");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeCommandError(error) };
  }
}

function cardDiv(content) {
  return { tag: "div", text: { tag: "lark_md", content: stringValue(content) } };
}
function cardPlainText(content) {
  return { tag: "plain_text", content: stringValue(content) };
}
function cardActionType(type) {
  const normalized = stringValue(type).toLowerCase();
  return ["primary", "default", "danger"].includes(normalized) ? normalized : "default";
}

function buildApprovalCard({ title, summary, commitMsg, runId, actions, locked, statusText } = {}) {
  const headerTitle = firstString(title, "Approval required");
  const runLabel = firstString(runId);
  const status = firstString(statusText, locked ? "Locked" : "");
  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: locked ? "grey" : "blue", title: cardPlainText(headerTitle) },
    elements: [],
  };
  if (locked) {
    card.elements.push(cardDiv(status));
    return card;
  }
  const summaryText = firstString(summary);
  if (summaryText) card.elements.push(cardDiv(`**Summary**\n${summaryText}`));
  const commitText = firstString(commitMsg);
  if (commitText) card.elements.push(cardDiv(`**Commit**\n${commitText}`));
  if (runLabel) card.elements.push(cardDiv(`**Run**\n${runLabel}`));
  if (status) card.elements.push(cardDiv(status));
  if (card.elements.length === 0) card.elements.push(cardDiv(headerTitle));
  const buttons = arrayValue(actions)
    .map((item) => {
      const value = objectValue(item);
      const action = firstString(value.action);
      if (!action) return null;
      return {
        tag: "button",
        text: cardPlainText(firstString(value.text, action)),
        type: cardActionType(value.type),
        value: { kind: "approval_action", runId, action },
      };
    })
    .filter(Boolean);
  if (buttons.length > 0) {
    card.elements.push({ tag: "action", actions: buttons });
  }
  return card;
}

// ─── per-command identity ────────────────────────────────────────────────────

function identityToken(command) {
  const payload = commandPayload(command);
  return firstString(
    payload.userAccessToken,
    objectValue(payload.options).userAccessToken,
    process.env.FEISHU_USER_ACCESS_TOKEN,
  );
}

// ─── web link builders ───────────────────────────────────────────────────────

function webBaseUrl(domainName) {
  return firstString(
    process.env.FEISHU_WEB_BASE_URL,
    domainName === "lark" ? "https://www.larksuite.com" : "https://www.feishu.cn",
  ).replace(/\/+$/, "");
}
function docxUrl(domainName, documentId) {
  return documentId ? `${webBaseUrl(domainName)}/docx/${encodeURIComponent(documentId)}` : "";
}
function sheetUrl(domainName, spreadsheetToken) {
  return spreadsheetToken ? `${webBaseUrl(domainName)}/sheets/${encodeURIComponent(spreadsheetToken)}` : "";
}
function bitableUrl(domainName, appToken) {
  return appToken ? `${webBaseUrl(domainName)}/base/${encodeURIComponent(appToken)}` : "";
}

// ─── contact / chat-member normalization ─────────────────────────────────────

function normalizeAvatar(avatar) {
  const value = objectValue(avatar);
  return firstString(value.avatar_origin, value.avatar_640, value.avatar_240, value.avatar_72);
}
function normalizeDepartment(user) {
  const departmentPath = arrayValue(user.department_path)
    .map((item) => {
      const departmentName = objectValue(item).department_name;
      const i18n = objectValue(objectValue(departmentName).i18n_name);
      return firstString(objectValue(departmentName).name, i18n.zh_cn, i18n.en_us);
    })
    .filter(Boolean);
  if (departmentPath.length > 0) return departmentPath.join(" / ");
  return arrayValue(user.department_ids).join(",");
}
function normalizeContactUser(user) {
  const value = objectValue(user);
  return {
    openId: firstString(value.open_id, value.user_id, value.union_id),
    name: firstString(value.name, value.nickname, value.en_name),
    avatar: normalizeAvatar(value.avatar),
    dept: normalizeDepartment(value),
  };
}
function memberMatchesQuery(user, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [user.openId, user.name, user.dept].some((value) => stringValue(value).toLowerCase().includes(needle));
}
function normalizeChatMember(member) {
  const value = objectValue(member);
  return { openId: firstString(value.member_id), name: firstString(value.name), avatar: "", dept: "" };
}

// ─── markdown → docx blocks ──────────────────────────────────────────────────

function textRun(content, style = {}) {
  return {
    text_run: {
      content: stringValue(content),
      ...(Object.keys(style).length > 0 ? { text_element_style: style } : {}),
    },
  };
}
function richTextBlock(blockType, field, content, style = {}) {
  return { block_type: blockType, [field]: { elements: [textRun(content, style)] } };
}
function cleanInlineMarkdown(value) {
  return stringValue(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}
function parseMarkdownTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (!/^\s*\|.*\|\s*$/.test(header) || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) {
    return null;
  }
  const rows = [];
  let index = startIndex;
  while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
    if (index !== startIndex + 1) {
      rows.push(
        lines[index]
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cleanInlineMarkdown(cell)),
      );
    }
    index += 1;
  }
  const columnSize = rows.reduce((size, row) => Math.max(size, row.length), 0);
  if (rows.length === 0 || columnSize === 0) return null;
  const blocks = rows.map((row) =>
    richTextBlock(2, "text", row.map((cell) => stringValue(cell).trim()).join("  |  ")),
  );
  return { blocks, nextIndex: index };
}
function markdownToDocxBlocks(markdown) {
  const lines = stringValue(markdown).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let index = 0;
  const flushParagraph = () => {
    const content = paragraph.map(cleanInlineMarkdown).filter(Boolean).join("\n");
    paragraph = [];
    if (content) blocks.push(richTextBlock(2, "text", content));
  };
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }
    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      flushParagraph();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(richTextBlock(14, "code", codeLines.join("\n").trimEnd()));
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table) {
      flushParagraph();
      for (const tableBlock of table.blocks) blocks.push(tableBlock);
      index = table.nextIndex;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 6);
      blocks.push(richTextBlock(2 + level, `heading${level}`, cleanInlineMarkdown(heading[2])));
      index += 1;
      continue;
    }
    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      blocks.push(richTextBlock(12, "bullet", cleanInlineMarkdown(unordered[1])));
      index += 1;
      continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      blocks.push(richTextBlock(13, "ordered", cleanInlineMarkdown(ordered[1])));
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}
function normalizeDocBlocks(command) {
  const blocks = arrayValue(command.blocks);
  if (blocks.length > 0) return blocks;
  const markdown = firstString(command.markdown, command.content);
  if (markdown) return markdownToDocxBlocks(markdown);
  return [];
}

// ─── sheet / bitable / calendar normalization ────────────────────────────────

function normalizeRows(rows) {
  return arrayValue(rows).map((row) =>
    arrayValue(row).map((cell) => {
      if (cell == null) return "";
      if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return cell;
      return JSON.stringify(cell);
    }),
  );
}
function columnName(index) {
  let value = Math.max(1, index);
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}
function sheetRange(sheetId, rows) {
  const rowCount = Math.max(rows.length, 1);
  const columnCount = Math.max(
    rows.reduce((max, row) => Math.max(max, row.length), 0),
    1,
  );
  return `${sheetId}!A1:${columnName(columnCount)}${rowCount}`;
}
function timestampSeconds(value) {
  if (typeof value === "number") {
    return String(value > 1e12 ? Math.floor(value / 1e3) : Math.floor(value));
  }
  const raw = stringValue(value).trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return String(numeric > 1e12 ? Math.floor(numeric / 1e3) : numeric);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid calendar time: ${raw || "(empty)"}`);
  }
  return String(Math.floor(parsed / 1e3));
}
function normalizeAttendees(attendees) {
  return arrayValue(attendees)
    .map((attendee) => {
      if (typeof attendee === "string") {
        const value2 = attendee.trim();
        if (!value2) return null;
        if (value2.includes("@")) return { type: "third_party", third_party_email: value2 };
        if (value2.startsWith("oc_")) return { type: "chat", chat_id: value2 };
        return { type: "user", user_id: value2 };
      }
      const value = objectValue(attendee);
      const type = firstString(value.type);
      if (type === "chat" || value.chatId || value.chat_id) {
        return { type: "chat", chat_id: firstString(value.chatId, value.chat_id) };
      }
      if (type === "third_party" || value.email || value.third_party_email) {
        return { type: "third_party", third_party_email: firstString(value.email, value.third_party_email) };
      }
      const userId = firstString(value.openId, value.open_id, value.userId, value.user_id, value.id);
      return userId ? { type: "user", user_id: userId } : null;
    })
    .filter((attendee) => attendee && (attendee.user_id || attendee.chat_id || attendee.third_party_email));
}
function normalizeBitableFields(fields, records) {
  const normalized = arrayValue(fields)
    .map((field) => {
      if (typeof field === "string") return { field_name: field, type: 1 };
      const value = objectValue(field);
      const name = firstString(value.field_name, value.name, value.title);
      if (!name) return null;
      const typeMap = {
        text: 1,
        number: 2,
        single_select: 3,
        multi_select: 4,
        date: 5,
        checkbox: 7,
        user: 11,
        url: 15,
      };
      const type = Number.isFinite(Number(value.type))
        ? Number(value.type)
        : typeMap[firstString(value.type).toLowerCase()] || 1;
      return {
        field_name: name,
        type,
        ...(value.ui_type ? { ui_type: value.ui_type } : {}),
        ...(value.property ? { property: value.property } : {}),
      };
    })
    .filter(Boolean);
  if (normalized.length > 0) return normalized;
  const firstRecord = objectValue(arrayValue(records)[0]);
  return Object.keys(firstRecord).map((fieldName) => ({ field_name: fieldName, type: 1 }));
}
function normalizeBitableRecords(records, fields) {
  const names = fields.map((field) => field.field_name);
  return arrayValue(records)
    .map((record) => {
      if (Array.isArray(record)) {
        return Object.fromEntries(record.map((value, index) => [names[index] || `Field ${index + 1}`, value]));
      }
      return objectValue(record);
    })
    .filter((record) => Object.keys(record).length > 0)
    .map((fields2) => ({ fields: fields2 }));
}

// ─── inbound message normalization (mirrors the SDK channel "message" shape) ──

function applyStyle(text, style) {
  if (!style || style.length === 0) return text;
  let out = text;
  if (style.includes("bold")) out = `**${out}**`;
  if (style.includes("italic")) out = `*${out}*`;
  if (style.includes("underline")) out = `<u>${out}</u>`;
  if (style.includes("lineThrough") || style.includes("strikethrough")) out = `~~${out}~~`;
  if (style.includes("codeInline") || style.includes("code")) out = `\`${out}\``;
  return out;
}
function safeParse(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function escapeAttr(s) {
  return s.replace(/"/g, "&quot;");
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const LOCALE_PRIORITY = ["zh_cn", "en_us", "ja_jp"];
function unwrapLocale(parsed) {
  if ("title" in parsed || "content" in parsed) return parsed;
  for (const loc of LOCALE_PRIORITY) {
    const hit = parsed[loc];
    if (hit != null && typeof hit === "object") return hit;
  }
  const firstKey = Object.keys(parsed)[0];
  if (firstKey) {
    const first = parsed[firstKey];
    if (first != null && typeof first === "object") return first;
  }
  return undefined;
}
function renderPostElement(el, ctx, resources) {
  switch (el.tag) {
    case "text":
      return applyStyle(el.text ?? "", el.style);
    case "a": {
      const label = el.text ?? el.href ?? "";
      return el.href ? `[${label}](${el.href})` : label;
    }
    case "at": {
      const userId = el.user_id ?? "";
      if (userId === "all" || userId === "all_members") return "@all";
      const info = ctx.mentionsByOpenId.get(userId);
      if (info) return info.key;
      return el.user_name ? `@${el.user_name}` : `@${userId}`;
    }
    case "img":
      if (el.image_key) {
        resources.push({ type: "image", fileKey: el.image_key });
        return `![image](${el.image_key})`;
      }
      return "";
    case "media":
      if (el.file_key) {
        resources.push({ type: "file", fileKey: el.file_key });
        return `<file key="${el.file_key}"/>`;
      }
      return "";
    case "code_block": {
      const lang = el.language ?? "";
      const code = el.text ?? "";
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case "hr":
      return "\n---\n";
    default:
      return el.text ?? "";
  }
}
function convertContent(raw, msgType, ctx) {
  const resources = [];
  const parsed = safeParse(raw);
  switch (msgType) {
    case "text":
      return { content: parsed?.text ?? "", resources };
    case "post": {
      if (parsed == null || typeof parsed !== "object") return { content: "[rich text message]", resources };
      const body = unwrapLocale(parsed);
      if (!body) return { content: "[rich text message]", resources };
      const lines = [];
      if (body.title) {
        lines.push(`**${body.title}**`);
        lines.push("");
      }
      for (const paragraph of body.content ?? []) {
        if (!Array.isArray(paragraph)) continue;
        let line = "";
        for (const el of paragraph) line += renderPostElement(el, ctx, resources);
        lines.push(line);
      }
      const content = lines.join("\n").trim() || "[rich text message]";
      return { content, resources };
    }
    case "image": {
      const imageKey = parsed?.image_key;
      if (!imageKey) return { content: "[image]", resources };
      resources.push({ type: "image", fileKey: imageKey });
      return { content: `![image](${imageKey})`, resources };
    }
    case "file": {
      const fileKey = parsed?.file_key;
      if (!fileKey) return { content: "[file]", resources };
      const fileName = parsed?.file_name;
      const nameAttr = fileName ? ` name="${escapeAttr(fileName)}"` : "";
      resources.push({ type: "file", fileKey, fileName });
      return { content: `<file key="${fileKey}"${nameAttr}/>`, resources };
    }
    case "audio": {
      const fileKey = parsed?.file_key;
      if (!fileKey) return { content: "[audio]", resources };
      resources.push({ type: "audio", fileKey, durationMs: parsed?.duration });
      return { content: `<audio key="${fileKey}"/>`, resources };
    }
    case "media":
    case "video": {
      const fileKey = parsed?.file_key;
      if (!fileKey) return { content: "[video]", resources };
      const nameAttr = parsed?.file_name ? ` name="${escapeAttr(parsed.file_name)}"` : "";
      resources.push({ type: "video", fileKey, fileName: parsed?.file_name, coverImageKey: parsed?.image_key });
      return { content: `<video key="${fileKey}"${nameAttr}/>`, resources };
    }
    case "sticker": {
      const fileKey = parsed?.file_key;
      if (!fileKey) return { content: "[sticker]", resources };
      resources.push({ type: "sticker", fileKey });
      return { content: `<sticker key="${fileKey}"/>`, resources };
    }
    case "interactive": {
      if (parsed == null || typeof parsed !== "object") return { content: "[interactive card]", resources };
      const pieces = walkCard(parsed);
      if (pieces.length === 0) return { content: "[interactive card]", resources };
      const seen = new Set();
      const out = [];
      for (const p of pieces) {
        const key = p.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
      return { content: out.join("\n"), resources };
    }
    case "share_chat":
      return { content: `<group_card id="${parsed?.chat_id ?? ""}"/>`, resources };
    case "share_user":
      return { content: `<contact_card id="${parsed?.user_id ?? ""}"/>`, resources };
    case "location": {
      const name = parsed?.name;
      const lat = parsed?.latitude;
      const lng = parsed?.longitude;
      const nameAttr = name ? ` name="${escapeAttr(name)}"` : "";
      const coordsAttr = lat && lng ? ` coords="lat:${lat},lng:${lng}"` : "";
      return { content: `<location${nameAttr}${coordsAttr}/>`, resources };
    }
    case "system": {
      if (!parsed || !parsed.template) return { content: "[system message]", resources };
      const out = parsed.template.replace(/\{([a-z_]+)\}/g, (match, name) => {
        const val = parsed[name];
        if (Array.isArray(val)) return val.join(", ");
        if (typeof val === "string") return val;
        if (val == null) return "";
        return match;
      });
      return { content: out.trim() || "[system message]", resources };
    }
    default:
      if (parsed && typeof parsed.text === "string") return { content: parsed.text, resources };
      return { content: "[unsupported message]", resources };
  }
}
function walkCard(node) {
  const out = [];
  visitCard(node, out);
  return out.filter((s) => s && s.trim().length > 0);
}
function visitCard(node, out) {
  if (node == null) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) visitCard(child, out);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node;
  const tag = obj.tag;
  if (typeof tag === "string" && (tag === "plain_text" || tag === "lark_md" || tag === "markdown")) {
    if (typeof obj.content === "string") out.push(obj.content);
    return;
  }
  if (obj.header && typeof obj.header === "object" && obj.header.title) visitCard(obj.header.title, out);
  if (obj.text) visitCard(obj.text, out);
  if (typeof tag === "string" && tag === "button" && obj.text) visitCard(obj.text, out);
  if (obj.label) visitCard(obj.label, out);
  if (Array.isArray(obj.options)) for (const opt of obj.options) if (opt?.text) visitCard(opt.text, out);
  if (Array.isArray(obj.elements)) for (const el of obj.elements) visitCard(el, out);
  if (Array.isArray(obj.fields)) for (const f of obj.fields) visitCard(f, out);
  if (Array.isArray(obj.actions)) for (const a of obj.actions) visitCard(a, out);
  if (Array.isArray(obj.columns)) for (const c of obj.columns) visitCard(c, out);
  if (obj.body) visitCard(obj.body, out);
}
function isMentionAll(m) {
  return m.key === "@_all";
}
function extractMentions(raw, botOpenId) {
  const mentions = new Map();
  const mentionsByOpenId = new Map();
  const mentionList = [];
  let mentionAll = false;
  let mentionedBot = false;
  for (const m of raw ?? []) {
    if (isMentionAll(m)) {
      mentionAll = true;
      mentions.set(m.key, { key: m.key, name: m.name, isBot: false });
      continue;
    }
    const openId = m.id?.open_id ?? "";
    const userId = m.id?.user_id;
    const isBot = Boolean(botOpenId && openId === botOpenId);
    if (isBot) mentionedBot = true;
    const info = { key: m.key, openId: openId || undefined, userId, name: m.name, isBot };
    mentions.set(m.key, info);
    if (openId) mentionsByOpenId.set(openId, info);
    mentionList.push(info);
  }
  return { mentions, mentionsByOpenId, mentionList, mentionAll, mentionedBot };
}
function detectMentionAllInContent(content) {
  if (!content) return false;
  return /@_all\b/.test(content);
}
function resolveMentions(content, ctx) {
  if (!content || ctx.mentions.size === 0) return content;
  let out = content;
  for (const [key, info] of ctx.mentions) {
    if (info.isBot && ctx.stripBotMentions) {
      const re = new RegExp(`\\s?${escapeRegex(key)}\\s?`, "g");
      out = out.replace(re, " ");
      continue;
    }
    const replacement = info.name ? `@${info.name}` : key;
    out = out.split(key).join(replacement);
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Normalize an inbound `im.message.receive_v1` event into the bridge's shape. */
function normalizeReceiveEvent(event, botOpenId) {
  const msg = objectValue(event.message);
  const sender = objectValue(event.sender);
  const senderIdObj = objectValue(sender.sender_id);
  const { mentions, mentionsByOpenId, mentionList, mentionAll: mentionAllFromRaw, mentionedBot } = extractMentions(
    msg.mentions,
    botOpenId,
  );
  const mentionAll = mentionAllFromRaw || detectMentionAllInContent(msg.content);
  const ctx = { mentions, mentionsByOpenId, stripBotMentions: true };
  const { content: rawContent } = convertContent(msg.content, msg.message_type, ctx);
  const content = resolveMentions(rawContent, ctx);
  const senderOpenId = senderIdObj.open_id;
  const senderFallbackId = senderIdObj.user_id ?? senderIdObj.union_id ?? "";
  const senderId = senderOpenId ?? senderFallbackId;
  const createMs = msg.create_time ? parseInt(msg.create_time, 10) : 0;
  return {
    messageId: stringValue(msg.message_id),
    chatId: stringValue(msg.chat_id),
    chatType: stringValue(msg.chat_type),
    senderId: stringValue(senderId),
    senderName: "",
    content: stringValue(content),
    rawContentType: stringValue(msg.message_type),
    mentions: mentionList,
    mentionAll,
    mentionedBot,
    rootId: stringValue(msg.root_id),
    threadId: stringValue(msg.thread_id),
    replyToMessageId: stringValue(msg.parent_id),
    createTime: Number.isFinite(createMs) ? createMs : 0,
  };
}
function normalizeCardActionEvent(event) {
  const context = objectValue(event.context);
  const operator = objectValue(event.operator);
  const action = objectValue(event.action);
  const messageId = context.open_message_id ?? event.open_message_id;
  const chatId = context.open_chat_id ?? event.open_chat_id;
  const operatorOpenId = operator.open_id;
  if (!messageId || !chatId || !operatorOpenId) return null;
  return {
    messageId,
    chatId,
    operator: { openId: operatorOpenId, userId: operator.user_id, name: operator.name },
    action: { value: action.value, tag: action.tag ?? "unknown", name: action.name, option: action.option },
  };
}
function normalizeP2pChatEntered(event) {
  const operator = objectValue(event.operator_id ?? event.operatorId ?? event.operator);
  return {
    eventId: firstString(event.event_id, event.uuid),
    chatId: firstString(event.chat_id, event.chatId),
    operatorId: firstString(operator.open_id, operator.openId, operator.user_id, operator.userId),
    lastMessageId: firstString(event.last_message_id, event.lastMessageId),
    createTime: firstString(event.create_time, event.createTime, event.ts),
  };
}
function botIsMentioned(mentions, botOpenId, appId) {
  if (!Array.isArray(mentions)) return false;
  const expected = new Set([botOpenId, appId].filter(Boolean));
  if (expected.size === 0) return false;
  return mentions.some((m) => {
    if (!m) return false;
    const id = m.id;
    const candidates = [
      typeof m === "string" ? m : null,
      typeof id === "string" ? id : null,
      id?.open_id,
      id?.app_id,
      id?.user_id,
      id?.union_id,
      m.open_id,
      m.app_id,
    ].filter(Boolean);
    return candidates.some((c) => expected.has(c));
  });
}

// ─── protobuf Frame codec (pbbp2.Frame / pbbp2.Header) ───────────────────────
//
// The Feishu long-connection wraps every WS frame in a protobuf `Frame` message.
// We hand-encode/decode only the fields the protocol uses (varint, length-delim
// bytes/strings); this is a faithful port of the SDK's $protobuf-generated codec.

function writeVarint(bytes, value) {
  let v = BigInt(value);
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
}
function writeTag(bytes, fieldNumber, wireType) {
  writeVarint(bytes, (fieldNumber << 3) | wireType);
}
function writeLengthDelimited(bytes, payload) {
  writeVarint(bytes, payload.length);
  for (let i = 0; i < payload.length; i += 1) bytes.push(payload[i]);
}
function encodeHeader(header) {
  const bytes = [];
  const keyBuf = Buffer.from(String(header.key), "utf8");
  writeTag(bytes, 1, 2);
  writeLengthDelimited(bytes, keyBuf);
  const valueBuf = Buffer.from(String(header.value), "utf8");
  writeTag(bytes, 2, 2);
  writeLengthDelimited(bytes, valueBuf);
  return bytes;
}
function encodeFrame(frame) {
  const bytes = [];
  // SeqID (1, varint), LogID (2, varint)
  writeTag(bytes, 1, 0);
  writeVarint(bytes, frame.SeqID ?? 0);
  writeTag(bytes, 2, 0);
  writeVarint(bytes, frame.LogID ?? 0);
  // service (3, varint), method (4, varint)
  writeTag(bytes, 3, 0);
  writeVarint(bytes, frame.service ?? 0);
  writeTag(bytes, 4, 0);
  writeVarint(bytes, frame.method ?? 0);
  // headers (5, repeated length-delimited Header)
  for (const header of frame.headers ?? []) {
    writeTag(bytes, 5, 2);
    writeLengthDelimited(bytes, encodeHeader(header));
  }
  // payloadEncoding (6, string), payloadType (7, string)
  if (frame.payloadEncoding != null) {
    writeTag(bytes, 6, 2);
    writeLengthDelimited(bytes, Buffer.from(String(frame.payloadEncoding), "utf8"));
  }
  if (frame.payloadType != null) {
    writeTag(bytes, 7, 2);
    writeLengthDelimited(bytes, Buffer.from(String(frame.payloadType), "utf8"));
  }
  // payload (8, bytes)
  if (frame.payload != null) {
    writeTag(bytes, 8, 2);
    writeLengthDelimited(bytes, frame.payload);
  }
  // LogIDNew (9, string)
  if (frame.LogIDNew != null) {
    writeTag(bytes, 9, 2);
    writeLengthDelimited(bytes, Buffer.from(String(frame.LogIDNew), "utf8"));
  }
  return Uint8Array.from(bytes);
}
function readVarint(buf, state) {
  let shift = 0n;
  let result = 0n;
  while (true) {
    const byte = buf[state.pos];
    state.pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return result;
}
function decodeFrame(buf) {
  const state = { pos: 0 };
  const frame = { headers: [] };
  while (state.pos < buf.length) {
    const tag = Number(readVarint(buf, state));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const value = readVarint(buf, state);
      if (fieldNumber === 1) frame.SeqID = value;
      else if (fieldNumber === 2) frame.LogID = value;
      else if (fieldNumber === 3) frame.service = Number(value);
      else if (fieldNumber === 4) frame.method = Number(value);
    } else if (wireType === 2) {
      const length = Number(readVarint(buf, state));
      const slice = buf.subarray(state.pos, state.pos + length);
      state.pos += length;
      if (fieldNumber === 5) frame.headers.push(decodeHeader(slice));
      else if (fieldNumber === 6) frame.payloadEncoding = Buffer.from(slice).toString("utf8");
      else if (fieldNumber === 7) frame.payloadType = Buffer.from(slice).toString("utf8");
      else if (fieldNumber === 8) frame.payload = slice;
      else if (fieldNumber === 9) frame.LogIDNew = Buffer.from(slice).toString("utf8");
    } else if (wireType === 5) {
      state.pos += 4;
    } else if (wireType === 1) {
      state.pos += 8;
    }
  }
  return frame;
}
function decodeHeader(buf) {
  const state = { pos: 0 };
  const header = { key: "", value: "" };
  while (state.pos < buf.length) {
    const tag = Number(readVarint(buf, state));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      const length = Number(readVarint(buf, state));
      const slice = buf.subarray(state.pos, state.pos + length);
      state.pos += length;
      if (fieldNumber === 1) header.key = Buffer.from(slice).toString("utf8");
      else if (fieldNumber === 2) header.value = Buffer.from(slice).toString("utf8");
    } else if (wireType === 0) {
      readVarint(buf, state);
    }
  }
  return header;
}

// ─── Feishu long-connection WebSocket client (replaces SDK WSClient) ──────────

const FrameType = { control: 0, data: 1 };
const ErrorCodeOk = 0;

/**
 * Reassembles multi-frame events keyed by message_id, then JSON-parses the
 * merged payload (faithful to the SDK DataCache).
 */
class DataCache {
  constructor() {
    this.cache = new Map();
    const timer = setInterval(() => this.sweep(), 10000);
    timer.unref?.();
  }
  mergeData({ message_id, sum, seq, data }) {
    let entry = this.cache.get(message_id);
    if (!entry) {
      entry = { buffer: new Array(sum).fill(undefined), create_time: Date.now() };
      this.cache.set(message_id, entry);
    }
    entry.buffer[seq] = data;
    if (entry.buffer.every((item) => !!item)) {
      const merged = entry.buffer.reduce((acc, cur) => {
        const combined = new Uint8Array(acc.byteLength + cur.byteLength);
        combined.set(acc, 0);
        combined.set(cur, acc.length);
        return combined;
      }, new Uint8Array([]));
      this.cache.delete(message_id);
      return JSON.parse(new TextDecoder("utf-8").decode(merged));
    }
    return null;
  }
  sweep() {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (now - value.create_time > 10000) this.cache.delete(key);
    }
  }
}

/**
 * Faithful, dependency-free port of the SDK WSClient: pulls the connect config
 * via the gateway endpoint, opens the WebSocket, runs the ping loop, decodes
 * protobuf data frames, hands merged JSON events to `onEvent`, and acks each
 * event back to the gateway. Auto-reconnects on close.
 */
class LongConnClient {
  constructor({ appId, appSecret, base, onEvent, onReady, onError, onReconnecting, onReconnected }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.base = base;
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.onError = onError;
    this.onReconnecting = onReconnecting;
    this.onReconnected = onReconnected;
    this.dataCache = new DataCache();
    this.ws = null;
    this.serviceId = "";
    this.pingIntervalMs = 120 * 1000;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.hasEverConnected = false;
    this.closed = false;
  }

  get wsConfigUrl() {
    return `${this.base}/callback/ws/endpoint`;
  }

  async pullConnectConfig() {
    const response = await fetch(this.wsConfigUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    const code = numberValue(body.code, -1);
    if (code !== ErrorCodeOk) {
      const reason = code === 1 ? "system busy" : body.msg;
      return { ok: false, error: `pullConnectConfig failed: code=${code}, msg=${reason}` };
    }
    const data = objectValue(body.data);
    const url = stringValue(data.URL);
    const clientConfig = objectValue(data.ClientConfig);
    const parsedUrl = new URL(url);
    this.connectUrl = url;
    this.serviceId = parsedUrl.searchParams.get("service_id") || "";
    if (Number.isFinite(Number(clientConfig.PingInterval))) {
      this.pingIntervalMs = Number(clientConfig.PingInterval) * 1000;
    }
    return { ok: true };
  }

  start() {
    this.closed = false;
    void this.connectOnce(true);
  }

  async connectOnce(isStart) {
    if (this.closed) return;
    let pull;
    try {
      pull = await this.pullConnectConfig();
    } catch (error) {
      pull = { ok: false, error: error?.message || String(error) };
    }
    if (!pull.ok) {
      if (isStart && !this.hasEverConnected) {
        this.onError?.(new Error(pull.error || "WebSocket connect failed"));
      }
      this.scheduleReconnect();
      return;
    }
    let ws;
    try {
      ws = new WebSocket(this.connectUrl);
    } catch (error) {
      this.onError?.(error);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.startPingLoop();
      if (!this.hasEverConnected) {
        this.hasEverConnected = true;
        this.onReady?.();
      } else {
        this.onReconnected?.();
      }
    });
    ws.addEventListener("message", (ev) => {
      try {
        this.handleFrame(new Uint8Array(ev.data));
      } catch {
        // ignore malformed frames
      }
    });
    ws.addEventListener("error", () => {
      // close handler runs the reconnect flow
    });
    ws.addEventListener("close", () => {
      this.clearPing();
      if (this.closed) return;
      this.onReconnecting?.();
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce(false);
    }, 5000);
    this.reconnectTimer.unref?.();
  }

  startPingLoop() {
    this.clearPing();
    const loop = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const frame = {
          headers: [{ key: "type", value: "ping" }],
          service: Number(this.serviceId),
          method: FrameType.control,
          SeqID: 0,
          LogID: 0,
        };
        try {
          this.ws.send(encodeFrame(frame));
        } catch {
          // ignore send failures; close handler will reconnect
        }
      }
      this.pingTimer = setTimeout(loop, this.pingIntervalMs);
      this.pingTimer.unref?.();
    };
    loop();
  }

  clearPing() {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  handleFrame(buf) {
    const frame = decodeFrame(buf);
    if (frame.method === FrameType.control) return; // ping/pong control frames
    if (frame.method !== FrameType.data) return;
    const headers = (frame.headers ?? []).reduce((acc, cur) => {
      acc[cur.key] = cur.value;
      return acc;
    }, {});
    if (headers.type !== "event") return;
    const merged = this.dataCache.mergeData({
      message_id: headers.message_id,
      sum: Number(headers.sum),
      seq: Number(headers.seq),
      data: frame.payload,
    });
    if (!merged) return;
    void this.dispatchEvent(merged, frame, headers);
  }

  async dispatchEvent(merged, frame, headers) {
    const respPayload = { code: 200 };
    const startTime = Date.now();
    try {
      await this.onEvent?.(merged);
    } catch {
      respPayload.code = 500;
    }
    const endTime = Date.now();
    // Ack the event back to the gateway (faithful to handleEventData).
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const ackFrame = {
        ...frame,
        headers: [...(frame.headers ?? []), { key: "biz_rt", value: String(startTime - endTime) }],
        payload: new TextEncoder().encode(JSON.stringify(respPayload)),
      };
      try {
        this.ws.send(encodeFrame(ackFrame));
      } catch {
        // ignore
      }
    }
  }

  disconnect() {
    this.closed = true;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

// ─── inbound safety: stale-drop + dedup + in-flight lock ──────────────────────

const STALE_WINDOW_MS = 5 * 60 * 1000;
const seenIds = new Map(); // id -> expiry
const inFlightLocks = new Set();
function seenHas(id) {
  const expiry = seenIds.get(id);
  if (expiry && expiry > Date.now()) return true;
  return false;
}
function seenAdd(id) {
  seenIds.set(id, Date.now() + 60 * 60 * 1000);
}
function isStale(createTimeMs) {
  if (!createTimeMs || !Number.isFinite(createTimeMs)) return false;
  return Date.now() - createTimeMs > STALE_WINDOW_MS;
}

// ─── parse a raw WS event payload into { eventType, event } ───────────────────

function parseEventEnvelope(merged) {
  const data = objectValue(merged);
  if ("schema" in data) {
    const header = objectValue(data.header);
    const event = objectValue(data.event);
    return { eventType: stringValue(header.event_type), event };
  }
  const event = objectValue(data.event);
  return { eventType: stringValue(event.type), event };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

let botIdentity = null;

async function fetchBotIdentity(client) {
  try {
    const response = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
    const bot = objectValue(response).bot;
    if (bot?.open_id) {
      return { openId: bot.open_id, name: bot.app_name ?? "bot" };
    }
  } catch (error) {
    throw new Error(
      `could not resolve bot identity via /open-apis/bot/v3/info: ${error?.message || String(error)}`,
    );
  }
  throw new Error("bot/v3/info response missing open_id");
}

async function main() {
  const appId = stringValue(process.env.FEISHU_APP_ID).trim();
  const appSecret = stringValue(process.env.FEISHU_APP_SECRET).trim();
  const channelId = stringValue(process.env.FEISHU_CHANNEL_ID).trim();
  const domainName = stringValue(process.env.FEISHU_DOMAIN).trim().toLowerCase() === "lark" ? "lark" : "feishu";
  if (!appId || !appSecret || !channelId) {
    writeError("Missing Feishu bridge environment.");
    process.exit(2);
  }

  const client = makeClient(appId, appSecret, domainName);
  activeClient = client;

  botIdentity = await fetchBotIdentity(client);
  const botOpenId = botIdentity?.openId ?? "";

  const onEvent = async (merged) => {
    const { eventType, event } = parseEventEnvelope(merged);
    if (eventType === "im.message.receive_v1") {
      const normalized = normalizeReceiveEvent(event, botOpenId);
      if (isStale(normalized.createTime)) return;
      if (!normalized.messageId || seenHas(normalized.messageId)) return;
      const mentioned =
        normalized.mentionedBot ||
        normalized.mentionAll ||
        botIsMentioned(normalized.mentions, botOpenId, appId);
      process.stderr.write(
        `[bridge-diag] inbound chatType=${normalized.chatType} sender=${normalized.senderId} botOpenId=${botOpenId} sdkMentioned=${normalized.mentionedBot} ownMentioned=${botIsMentioned(normalized.mentions, botOpenId, appId)} mentionAll=${normalized.mentionAll} mentions=${JSON.stringify(normalized.mentions).slice(0, 300)} contentLen=${normalized.content.length}\n`,
      );
      if (botOpenId && normalized.senderId === botOpenId) {
        process.stderr.write("[bridge-diag] drop: own message\n");
        return;
      }
      if (normalized.chatType === "group" && !mentioned) {
        process.stderr.write("[bridge-diag] drop: group without mention\n");
        return;
      }
      if (inFlightLocks.has(normalized.messageId)) return;
      inFlightLocks.add(normalized.messageId);
      try {
        process.stderr.write("[bridge-diag] emit message event\n");
        writeEvent({ type: "message", channelId, message: normalized });
      } finally {
        seenAdd(normalized.messageId);
        inFlightLocks.delete(normalized.messageId);
      }
      return;
    }
    if (eventType === "card.action.trigger") {
      const normalized = normalizeCardActionEvent(event);
      if (!normalized) return;
      const dedupKey = `card:${normalized.messageId}:${normalized.operator.openId}`;
      if (seenHas(dedupKey)) return;
      seenAdd(dedupKey);
      writeEvent({
        type: "card_action",
        channelId,
        messageId: stringValue(normalized.messageId),
        chatId: stringValue(normalized.chatId),
        operatorId: firstString(normalized.operator.openId, normalized.operator.userId),
        operatorName: firstString(normalized.operator.name),
        value: normalized.action.value ?? null,
      });
      return;
    }
    if (eventType === "im.chat.access_event.bot_p2p_chat_entered_v1") {
      const normalized = normalizeP2pChatEntered(event);
      process.stderr.write(
        `[bridge-diag] p2p-enter chat=${normalized.chatId} operator=${normalized.operatorId} lastMessage=${normalized.lastMessageId}\n`,
      );
      if (!normalized.chatId) return;
      writeEvent({ type: "p2p_entered", channelId, event: normalized });
    }
  };

  const conn = new LongConnClient({
    appId,
    appSecret,
    base: client.base,
    onEvent,
    onReady: () => {
      writeEvent({ type: "ready", channelId, botIdentity: botIdentity ?? null });
    },
    onError: (error) => {
      writeError(error?.message || String(error), { code: error?.code, channelId });
    },
    onReconnecting: () => {
      writeEvent({ type: "reconnecting", channelId });
    },
    onReconnected: () => {
      writeEvent({ type: "reconnected", channelId });
    },
  });
  conn.start();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleCommand(client, domainName, trimmed);
  });

  let shuttingDown = false;
  const gracefulExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      conn.disconnect();
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 200);
  };
  rl.on("close", gracefulExit);
  process.stdin.on("end", gracefulExit);
  process.on("SIGTERM", gracefulExit);
  process.on("SIGINT", gracefulExit);
  process.stdin.resume();
}

// ─── outbound message send (markdown → post pipeline, faithful to the SDK) ────

const DEFAULT_CHUNK_LIMIT = 3500;

function detectReceiveIdType(to) {
  if (!to) throw new Error("empty receive_id");
  if (to.startsWith("oc_")) return "chat_id";
  if (to.startsWith("ou_")) return "open_id";
  if (to.startsWith("on_")) return "union_id";
  if (to.includes("@")) return "email";
  return "user_id";
}
function composeMentionsTextPrefix(mentions) {
  if (!mentions?.length) return "";
  const parts = [];
  for (const m of mentions) {
    if (!m.openId) continue;
    parts.push(`<at user_id="${m.openId}">${m.name ?? ""}</at>`);
  }
  return parts.length > 0 ? parts.join(" ") + " " : "";
}
function optimizeMarkdownStyle(text) {
  try {
    const MARK = "___CB_";
    const codeBlocks = [];
    let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = "") => {
      const block = m.slice(String(prefix).length);
      return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`;
    });
    const hasH1toH3 = /^#{1,3} /m.test(text);
    if (hasH1toH3) {
      r = r.replace(/^#{2,6} (.+)$/gm, "##### $1");
      r = r.replace(/^# (.+)$/gm, "#### $1");
    }
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
    r = r.replace(/\n{3,}/g, "\n\n");
    return r;
  } catch {
    return text;
  }
}
function markdownToPost(md, opts) {
  const prefix = composeMentionsTextPrefix(opts?.mentions ?? []);
  const text = optimizeMarkdownStyle(prefix + md);
  return { zh_cn: { title: opts?.title ?? "", content: [[{ tag: "md", text }]] } };
}
function postToPlainText(post) {
  const body = post?.zh_cn;
  if (!body?.content) return "";
  const lines = [];
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];
    for (const el of paragraph) {
      switch (el.tag) {
        case "md":
        case "text":
        case "a":
          parts.push(el.text ?? "");
          break;
        case "at":
          parts.push(el.user_name ? `@${el.user_name}` : "");
          break;
        case "img":
          parts.push(el.image_key ? `[image]` : "");
          break;
      }
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}
function splitPlain(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}
function splitWithCodeFences(text, limit) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const out = [];
  let buf = [];
  let bufLen = 0;
  let fenceLang = null;
  const flush = () => {
    if (buf.length === 0) return;
    let chunk = buf.join("\n");
    if (fenceLang !== null) chunk += "\n```";
    out.push(chunk);
    buf = [];
    bufLen = 0;
    if (fenceLang !== null) {
      buf.push("```" + fenceLang);
      bufLen = buf[0].length;
    }
  };
  for (const line of lines) {
    const m = line.match(/^```(\w*)$/);
    const lineLen = line.length + (buf.length > 0 ? 1 : 0);
    const isHeading = /^#{1,6}\s/.test(line);
    const nearFull = bufLen > limit * 0.75;
    if (bufLen + lineLen > limit || (isHeading && nearFull && buf.length > 0)) flush();
    buf.push(line);
    bufLen += lineLen;
    if (m) fenceLang = fenceLang === null ? m[1] || "" : null;
  }
  flush();
  return out;
}

async function rawSend(client, { to, idType, msgType, content, replyTo, replyInThread, userAccessToken }) {
  const payloadContent = JSON.stringify(content);
  if (replyTo) {
    const response = await client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages/:message_id/reply",
      path: { message_id: replyTo },
      data: { content: payloadContent, msg_type: msgType, reply_in_thread: replyInThread },
      userAccessToken,
    });
    const id = ensureSdkOk(response, "reply message").message_id;
    if (!id) throw new Error("message_id missing from reply response");
    return id;
  }
  const response = await client.request({
    method: "POST",
    url: "/open-apis/im/v1/messages",
    params: { receive_id_type: idType },
    data: { receive_id: to, msg_type: msgType, content: payloadContent },
    userAccessToken,
  });
  const id = ensureSdkOk(response, "send message").message_id;
  if (!id) throw new Error("message_id missing from create response");
  return id;
}

async function sendMessage(client, command) {
  const to = stringValue(command.to).trim();
  if (!to) throw new Error("Missing Feishu message recipient.");
  const input = objectValue(command.input);
  const opts = objectValue(command.options);
  const userAccessToken = identityToken(command) || undefined;
  const idType = detectReceiveIdType(to);
  const ids = [];

  if ("markdown" in input) {
    const chunks = splitWithCodeFences(stringValue(input.markdown), DEFAULT_CHUNK_LIMIT);
    for (let i = 0; i < chunks.length; i += 1) {
      const post = markdownToPost(chunks[i], { mentions: i === 0 ? opts.mentions : undefined });
      ids.push(
        await rawSend(client, {
          to,
          idType,
          msgType: "post",
          content: post,
          replyTo: i === 0 ? opts.replyTo : undefined,
          replyInThread: opts.replyInThread,
          userAccessToken,
        }),
      );
    }
  } else if ("text" in input) {
    const prefix = composeMentionsTextPrefix(arrayValue(opts.mentions));
    const chunks = splitPlain(prefix + stringValue(input.text), DEFAULT_CHUNK_LIMIT);
    for (let i = 0; i < chunks.length; i += 1) {
      ids.push(
        await rawSend(client, {
          to,
          idType,
          msgType: "text",
          content: { text: chunks[i] },
          replyTo: i === 0 ? opts.replyTo : undefined,
          replyInThread: opts.replyInThread,
          userAccessToken,
        }),
      );
    }
  } else if ("post" in input) {
    ids.push(
      await rawSend(client, {
        to,
        idType,
        msgType: "post",
        content: input.post,
        replyTo: opts.replyTo,
        replyInThread: opts.replyInThread,
        userAccessToken,
      }),
    );
  } else if ("card" in input) {
    ids.push(
      await rawSend(client, {
        to,
        idType,
        msgType: "interactive",
        content: input.card,
        replyTo: opts.replyTo,
        replyInThread: opts.replyInThread,
        userAccessToken,
      }),
    );
  } else {
    throw new Error("unrecognized SendInput shape");
  }

  return { messageId: ids[0], chunkIds: ids.length > 1 ? ids : undefined };
}

async function addReaction(client, command) {
  const messageId = stringValue(command.messageId).trim();
  const emojiType = stringValue(command.emojiType).trim();
  if (!messageId || !emojiType) throw new Error("Missing Feishu reaction target or emoji type.");
  const response = await client.request({
    method: "POST",
    url: "/open-apis/im/v1/messages/:message_id/reactions",
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  });
  const data = ensureSdkOk(response, "add reaction");
  const reactionId = firstString(data.reaction_id);
  if (!reactionId) throw new Error("messageReaction.create returned no reaction_id");
  return reactionId;
}

// ─── org member search / chat members ────────────────────────────────────────

async function searchOrgMembers(client, command) {
  const payload = commandPayload(command);
  const query = firstString(payload.query);
  const pageSize = Math.min(Math.max(numberValue(payload.pageSize, 50), 1), 100);
  const userAccessToken = identityToken(command) || undefined;
  const usersById = new Map();

  if (query.includes("@")) {
    const idResponse = await client.request({
      method: "POST",
      url: "/open-apis/contact/v3/users/batch_get_id",
      params: { user_id_type: "open_id" },
      data: { emails: [query], include_resigned: false },
      userAccessToken,
    });
    const userIds = arrayValue(ensureSdkOk(idResponse, "search contact user ids").user_list)
      .map((item) => firstString(item.user_id))
      .filter(Boolean);
    if (userIds.length > 0) {
      const batchResponse = await client.request({
        method: "GET",
        url: "/open-apis/contact/v3/users/batch",
        params: { user_ids: userIds, user_id_type: "open_id", department_id_type: "open_department_id" },
        userAccessToken,
      });
      for (const user of arrayValue(ensureSdkOk(batchResponse, "batch get contact users").items)) {
        const normalized = normalizeContactUser(user);
        if (normalized.openId) usersById.set(normalized.openId, normalized);
      }
    }
  }
  if (/^ou_|^on_|^un_/.test(query)) {
    const userResponse = await client.request({
      method: "GET",
      url: "/open-apis/contact/v3/users/:user_id",
      path: { user_id: query },
      params: { user_id_type: "open_id", department_id_type: "open_department_id" },
      userAccessToken,
    });
    const normalized = normalizeContactUser(ensureSdkOk(userResponse, "get contact user").user);
    if (normalized.openId) usersById.set(normalized.openId, normalized);
  }
  const listResponse = await client.request({
    method: "GET",
    url: "/open-apis/contact/v3/users",
    params: {
      user_id_type: "open_id",
      department_id_type: "open_department_id",
      department_id: firstString(payload.departmentId, payload.department_id, "0"),
      page_size: pageSize,
    },
    userAccessToken,
  });
  for (const user of arrayValue(ensureSdkOk(listResponse, "list contact users").items)) {
    const normalized = normalizeContactUser(user);
    if (normalized.openId && memberMatchesQuery(normalized, query)) {
      usersById.set(normalized.openId, normalized);
    }
  }
  return [...usersById.values()].slice(0, pageSize);
}

async function listChatMembers(client, command) {
  const payload = commandPayload(command);
  const chatId = firstString(payload.chatId, payload.chat_id);
  if (!chatId) throw new Error("Missing Feishu chatId.");
  const pageSize = Math.min(Math.max(numberValue(payload.pageSize, 100), 1), 100);
  const userAccessToken = identityToken(command) || undefined;
  const members = [];
  let pageToken = "";
  do {
    const response = await client.request({
      method: "GET",
      url: "/open-apis/im/v1/chats/:chat_id/members",
      path: { chat_id: chatId },
      params: {
        member_id_type: "open_id",
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      userAccessToken,
    });
    const data = ensureSdkOk(response, "list chat members");
    members.push(...arrayValue(data.items).map(normalizeChatMember).filter((member) => member.openId));
    pageToken = data.has_more ? stringValue(data.page_token) : "";
  } while (pageToken);
  return members;
}

// ─── lark-cli user-identity doc creation (config-gated) ──────────────────────

let larkCliAuthorizedCache;
function larkCliAuthorized() {
  if (larkCliAuthorizedCache !== undefined) return larkCliAuthorizedCache;
  larkCliAuthorizedCache = false;
  try {
    const config = JSON.parse(readFileSync(resolve(homedir(), ".lark-cli", "config.json"), "utf8"));
    const apps = Array.isArray(config.apps) ? config.apps : [];
    const current = config.currentApp ? apps.find((app) => objectValue(app).name === config.currentApp) : apps[0];
    const users = objectValue(current).users;
    larkCliAuthorizedCache = Array.isArray(users) && users.length > 0;
  } catch {
    larkCliAuthorizedCache = false;
  }
  return larkCliAuthorizedCache;
}
async function larkCliApi(method, path, data) {
  const args = ["api", method, path, "--as", "user", "--format", "json"];
  if (data !== undefined) args.push("--data", JSON.stringify(data));
  const { stdout } = await execFileAsync("lark-cli", args, {
    timeout: 3e4,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
  });
  const parsed = JSON.parse(stdout);
  const code = numberValue(parsed?.code, 0);
  if (code !== 0) {
    throw new Error(`lark-cli ${method} ${path} failed: ${parsed?.msg || `code ${code}`}`);
  }
  return objectValue(parsed?.data);
}
async function larkCliCreateDoc(title, blocks, domainName) {
  const created = objectValue(await larkCliApi("POST", "/open-apis/docx/v1/documents", { title }));
  const document2 = objectValue(created.document);
  const documentId = firstString(document2.document_id, document2.documentId, created.document_id);
  if (!documentId) throw new Error("lark-cli docx create returned no document_id.");
  if (Array.isArray(blocks) && blocks.length > 0) {
    await larkCliApi(
      "POST",
      `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      { index: 0, children: blocks },
    );
  }
  return {
    ok: true,
    id: documentId,
    documentId,
    title,
    url: docxUrl(domainName, documentId),
    via: "user",
  };
}

// ─── doc / sheet / bitable / calendar creation ───────────────────────────────

async function createDoc(client, domainName, command) {
  const payload = commandPayload(command);
  const title = firstString(payload.title, "Untitled");
  const blocks = normalizeDocBlocks(payload);
  const userAccessToken =
    firstString(payload.userAccessToken, objectValue(payload.options).userAccessToken, process.env.FEISHU_USER_ACCESS_TOKEN) || undefined;
  const preferUser =
    firstString(payload.identity) !== "bot" &&
    !firstString(payload.userAccessToken, objectValue(payload.options).userAccessToken) &&
    larkCliAuthorized();
  if (preferUser) {
    try {
      return await larkCliCreateDoc(title, blocks, domainName);
    } catch (error) {
      writeEvent({ type: "warn", message: `lark-cli user-doc failed, falling back to bot: ${describeCommandError(error)}` });
    }
  }
  const createResponse = await client.request({
    method: "POST",
    url: "/open-apis/docx/v1/documents",
    data: {
      title,
      ...(payload.folderToken || payload.folder_token
        ? { folder_token: firstString(payload.folderToken, payload.folder_token) }
        : {}),
    },
    userAccessToken,
  });
  const document2 = objectValue(ensureSdkOk(createResponse, "create doc").document);
  const documentId = firstString(document2.document_id, document2.documentId);
  if (!documentId) throw new Error("Feishu docx create response did not include document_id.");
  if (blocks.length > 0) {
    const blockResponse = await client.request({
      method: "POST",
      url: "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children",
      path: { document_id: documentId, block_id: documentId },
      data: { index: 0, children: blocks },
      userAccessToken,
    });
    ensureSdkOk(blockResponse, "write doc blocks");
  }
  return { ok: true, id: documentId, documentId, title, url: docxUrl(domainName, documentId) };
}

async function createCalendarEvent(client, command) {
  const payload = commandPayload(command);
  const summary = firstString(payload.summary, payload.title);
  const start = firstString(payload.start, payload.startTime, payload.start_time);
  const end = firstString(payload.end, payload.endTime, payload.end_time);
  if (!summary || !start || !end) {
    throw new Error("Missing Feishu calendar event summary/start/end.");
  }
  const userAccessToken = identityToken(command) || undefined;
  const calendarId = firstString(payload.calendarId, payload.calendar_id, "primary");
  let reserve = null;
  let vchat;
  if (boolValue(payload.needVideo) || boolValue(payload.need_video)) {
    const reserveResponse = await client.request({
      method: "POST",
      url: "/open-apis/vc/v1/reserves/apply",
      params: { user_id_type: "open_id" },
      data: { end_time: timestampSeconds(end), meeting_settings: { topic: summary, meeting_connect: true } },
      userAccessToken,
    });
    reserve = objectValue(ensureSdkOk(reserveResponse, "reserve video meeting").reserve);
    vchat = {
      vc_type: "vc",
      icon_type: "vc",
      description: firstString(reserve.meeting_no),
      meeting_url: firstString(reserve.url, reserve.app_link),
    };
  }
  const eventResponse = await client.request({
    method: "POST",
    url: "/open-apis/calendar/v4/calendars/:calendar_id/events",
    path: { calendar_id: calendarId },
    params: { user_id_type: "open_id" },
    data: {
      summary,
      description: firstString(payload.description),
      start_time: {
        timestamp: timestampSeconds(start),
        timezone: firstString(payload.timezone, process.env.TZ, "Asia/Shanghai"),
      },
      end_time: {
        timestamp: timestampSeconds(end),
        timezone: firstString(payload.timezone, process.env.TZ, "Asia/Shanghai"),
      },
      ...(vchat ? { vchat } : {}),
    },
    userAccessToken,
  });
  const event = objectValue(ensureSdkOk(eventResponse, "create calendar event").event);
  const eventId = firstString(event.event_id, event.eventId);
  const attendees = normalizeAttendees(payload.attendees);
  let attendeeResult = null;
  if (attendees.length > 0) {
    const attendeeResponse = await client.request({
      method: "POST",
      url: "/open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees",
      path: { calendar_id: calendarId, event_id: eventId },
      params: { user_id_type: "open_id" },
      data: { attendees, need_notification: payload.needNotification !== false },
      userAccessToken,
    });
    attendeeResult = ensureSdkOk(attendeeResponse, "add calendar attendees");
  }
  const eventVchat = objectValue(event.vchat);
  const eventLink = firstString(event.link, event.url, event.app_link, event.html_link);
  const result = {
    ok: true,
    id: eventId,
    eventId,
    calendarId,
    title: summary,
    meetingUrl: firstString(eventVchat.meeting_url, reserve?.url, reserve?.app_link),
    reserveId: firstString(reserve?.id),
    attendees: arrayValue(attendeeResult?.attendees),
  };
  if (eventLink) result.url = eventLink;
  return result;
}

async function createSheet(client, domainName, command) {
  const payload = commandPayload(command);
  const title = firstString(payload.title, "Untitled Sheet");
  const rows = normalizeRows(payload.rows);
  const userAccessToken = identityToken(command) || undefined;
  const createResponse = await client.request({
    method: "POST",
    url: "/open-apis/sheets/v3/spreadsheets",
    data: {
      title,
      ...(payload.folderToken || payload.folder_token
        ? { folder_token: firstString(payload.folderToken, payload.folder_token) }
        : {}),
    },
    userAccessToken,
  });
  const spreadsheet = objectValue(ensureSdkOk(createResponse, "create sheet").spreadsheet);
  const token = firstString(spreadsheet.spreadsheet_token, spreadsheet.token);
  if (!token) throw new Error("Feishu sheet create response did not include spreadsheet_token.");
  if (rows.length > 0) {
    const queryResponse = await client.request({
      method: "GET",
      url: "/open-apis/sheets/v3/spreadsheets/:spreadsheet_token/sheets/query",
      path: { spreadsheet_token: token },
      userAccessToken,
    });
    const sheets = arrayValue(ensureSdkOk(queryResponse, "query sheet tabs").sheets);
    const sheetId = firstString(sheets[0]?.sheet_id, payload.sheetId, payload.sheet_id);
    if (!sheetId) throw new Error("Feishu sheet did not include a writable sheet_id.");
    const writeResponse = await client.request({
      method: "PUT",
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`,
      data: { valueRange: { range: sheetRange(sheetId, rows), values: rows } },
      userAccessToken,
    });
    ensureSdkOk(writeResponse, "write sheet rows");
  }
  return { ok: true, id: token, token, title, url: sheetUrl(domainName, token) };
}

async function createBitable(client, domainName, command) {
  const payload = commandPayload(command);
  const title = firstString(payload.title, "Untitled Bitable");
  const userAccessToken = identityToken(command) || undefined;
  const appResponse = await client.request({
    method: "POST",
    url: "/open-apis/bitable/v1/apps",
    data: {
      name: title,
      ...(payload.folderToken || payload.folder_token
        ? { folder_token: firstString(payload.folderToken, payload.folder_token) }
        : {}),
      ...(payload.timezone ? { time_zone: stringValue(payload.timezone) } : {}),
    },
    userAccessToken,
  });
  const app = objectValue(ensureSdkOk(appResponse, "create bitable").app);
  const appToken = firstString(app.app_token, app.token);
  if (!appToken) throw new Error("Feishu bitable create response did not include app_token.");
  const fields = normalizeBitableFields(payload.fields, payload.records);
  let tableId = firstString(app.default_table_id, app.defaultTableId);
  if (fields.length > 0) {
    const tableResponse = await client.request({
      method: "POST",
      url: "/open-apis/bitable/v1/apps/:app_token/tables",
      path: { app_token: appToken },
      data: { table: { name: title, default_view_name: "Grid", fields } },
      userAccessToken,
    });
    tableId = firstString(ensureSdkOk(tableResponse, "create bitable table").table_id, tableId);
  }
  if (!tableId) throw new Error("Feishu bitable create response did not include table_id.");
  const records = normalizeBitableRecords(payload.records, fields);
  if (records.length > 0) {
    const recordResponse = await client.request({
      method: "POST",
      url: "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_create",
      path: { app_token: appToken, table_id: tableId },
      params: { user_id_type: "open_id" },
      data: { records },
      userAccessToken,
    });
    ensureSdkOk(recordResponse, "write bitable records");
  }
  return { ok: true, id: appToken, appToken, tableId, title, url: bitableUrl(domainName, appToken) };
}

// ─── inbound command dispatch ────────────────────────────────────────────────

async function handleCommand(client, domainName, line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    writeError("Failed to parse Feishu bridge command.", { message: error?.message || String(error) });
    return;
  }
  const id = stringValue(command.id);
  if (!id) {
    writeError("Feishu bridge command is missing an id.");
    return;
  }
  try {
    const type = stringValue(command.type);
    if (type === "send") {
      writeCommandResult(id, true, await sendMessage(client, command));
      return;
    }
    if (type === "reaction") {
      const reactionId = await addReaction(client, command);
      writeCommandResult(id, true, { raw: { reaction_id: reactionId } });
      return;
    }
    if (type === "search_org_members" || type === "searchOrgMembers") {
      writeCommandResult(id, true, await searchOrgMembers(client, command));
      return;
    }
    if (type === "list_chat_members" || type === "listChatMembers") {
      writeCommandResult(id, true, await listChatMembers(client, command));
      return;
    }
    if (type === "create_doc" || type === "createDoc") {
      writeCommandResult(id, true, await createDoc(client, domainName, command));
      return;
    }
    if (type === "create_calendar_event" || type === "createCalendarEvent") {
      writeCommandResult(id, true, await createCalendarEvent(client, command));
      return;
    }
    if (type === "create_sheet" || type === "createSheet") {
      writeCommandResult(id, true, await createSheet(client, domainName, command));
      return;
    }
    if (type === "create_bitable" || type === "createBitable") {
      writeCommandResult(id, true, await createBitable(client, domainName, command));
      return;
    }
    if (type === "send_interactive_card" || type === "sendInteractiveCard") {
      writeCommandResult(id, true, await sendInteractiveCard(commandPayload(command)));
      return;
    }
    if (type === "patch_interactive_card" || type === "patchInteractiveCard") {
      writeCommandResult(id, true, await patchInteractiveCard(commandPayload(command)));
      return;
    }
    if (type === "build_approval_card" || type === "buildApprovalCard") {
      writeCommandResult(id, true, buildApprovalCard(commandPayload(command)));
      return;
    }
    throw new Error(`Unsupported Feishu bridge command: ${type || "(empty)"}`);
  } catch (error) {
    writeCommandResult(id, false, null, describeCommandError(error));
  }
}

// ─── exports + entrypoint ────────────────────────────────────────────────────

export { buildApprovalCard, markdownToDocxBlocks, patchInteractiveCard, sendInteractiveCard };

function isBridgeEntrypoint() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked.endsWith("feishu-bridge.mjs") || invoked.endsWith("feishu-bridge.cjs");
}

if (isBridgeEntrypoint()) {
  main().catch((error) => {
    writeError(error?.message || String(error), { stack: error?.stack });
    process.exit(1);
  });
}
