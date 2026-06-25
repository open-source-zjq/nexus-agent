import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../../store/store.js";
import { useNav } from "../../store/nav.js";
import { api, ApiError } from "../../api/client.js";
import { useTranslation } from "../../i18n/useTranslation.js";
import { Markdown } from "../../lib/Markdown.js";
import { PlanPanelView } from "./PlanPanelView.js";
import { ChangeInspectorView } from "./ChangeInspectorView.js";
import { TodoPanelView } from "./TodoPanelView.js";
import { MemoryPanelView, UsagePanelView, LlmRoundsPanelView } from "./RightRailPanels.js";
import type { ImMember, TurnItem, UserInputQuestion } from "../../api/types.js";

/** Image extensions the composer accepts (mirrors the original attachment set). */
// Must match the runtime attachment store's `detectImage` support (png/jpeg/webp);
// other formats are rejected server-side, so don't offer them in the picker.
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const IMAGE_ACCEPT = IMAGE_EXT.map((e) => `image/${e === "jpg" ? "jpeg" : e}`).join(",");

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  return IMAGE_EXT.includes(ext);
}

/** Read a File as a bare base64 payload (strips the `data:...;base64,` prefix). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  preview?: string;
}

/** One row in the composer's unified slash overlay. */
interface SlashItem {
  id: string;
  kind: "builtin" | "skill" | "agent";
  title: string;
  description: string;
  keywords: string[];
  badge?: string;
  insert: string;
}

/**
 * Slash overlay open/query rule (faithful port of the original `ste`): open only
 * when the trimmed text starts with "/" AND has no whitespace; the query is the
 * lowercased text after the slash. Any whitespace closes it.
 */
function slashQueryOf(text: string): string | null {
  const e = text.trimStart();
  if (!e.startsWith("/") || /\s/.test(e)) return null;
  return e.slice(1).toLowerCase();
}

/* ------------------------------------------------------------------ utils */

function fmtK(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

/** A short file path from common tool-argument shapes. */
function argPath(args: Record<string, unknown>): string | undefined {
  return firstString(args.path, args.file_path, args.filename, args.file, args.target_file);
}

/** Render an opaque tool output into readable text (mirrors the runtime shapes). */
function outputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  const o = output as Record<string, unknown>;
  if (typeof o.content === "string") return o.content;
  if (typeof o.output === "string") return o.output;
  if (typeof o.stdout === "string" || typeof o.stderr === "string") {
    return [o.stdout, o.stderr ? `stderr:\n${o.stderr}` : ""].filter(Boolean).join("\n");
  }
  if (typeof o.error === "string") return o.error;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** Find a unified-diff/patch-looking string anywhere in the tool payload. */
function extractDiff(payload: Record<string, unknown>): string | undefined {
  const candidates = [payload.diff, payload.patch, payload.unified_diff, payload.content, payload.new_string, payload.text];
  for (const c of candidates) {
    if (typeof c === "string" && (/^@@|\n@@/.test(c) || /\n[+-]/.test(c))) return c;
  }
  return undefined;
}

interface ToolPresentation {
  title: string;
  subtitle?: string;
  tone: "read" | "edit" | "run" | "tool";
}

function presentTool(name: string, kind: string, args: Record<string, unknown>): ToolPresentation {
  const n = name.toLowerCase();
  if (kind === "file_change" || ["edit", "write", "str_replace", "apply_patch", "create_file"].includes(n)) {
    return { title: "Edit file", subtitle: argPath(args), tone: "edit" };
  }
  if (["read", "read_file", "cat", "open", "view"].includes(n)) {
    return { title: "Read file", subtitle: argPath(args), tone: "read" };
  }
  if (kind === "command_execution" || ["bash", "shell", "run", "exec"].includes(n)) {
    return { title: "Run command", subtitle: firstString(args.command, args.cmd, args.script), tone: "run" };
  }
  return { title: name, subtitle: firstString(args.query, args.pattern, argPath(args)), tone: "tool" };
}

/* ------------------------------------------------------------------ icons */

const Icon = {
  branch: (
    <svg className="h-3.5 w-3.5 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
  ),
  plan: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
  ),
  changes: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><circle cx="12" cy="18" r="3" /><path d="M6 9a3 3 0 0 0 3 3h6" /><circle cx="6" cy="6" r="3" /></svg>
  ),
  todos: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
  ),
  fileRead: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
  ),
  fileEdit: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
  ),
  terminal: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg>
  ),
  wrench: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
  ),
  spinner: (
    <svg className="h-3.5 w-3.5 animate-spin text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
  ),
  chevron: (
    <svg className="h-3.5 w-3.5 shrink-0 opacity-55 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
  ),
};

/* ------------------------------------------------------------- timeline parts */

/** Hover copy button (T3.11): copies `text` to the clipboard with a brief tick. */
function CopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      aria-label="Copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        })
      }
      className={className ?? "rounded-md p-1 text-ds-faint opacity-0 transition hover:bg-ds-hover hover:text-ds-ink group-hover:opacity-100"}
    >
      {copied ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
      )}
    </button>
  );
}

function UserMessage({ item }: { item: Extract<TurnItem, { kind: "user_message" }> }): JSX.Element {
  const text = item.displayText ?? item.text;
  const running = useStore((s) => s.running);
  const rewindAndResend = useStore((s) => s.rewindAndResend);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (editing) {
    return (
      <div className="ds-user-message">
        <div className="ds-user-message-bubble min-w-0">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(1, draft.split("\n").length))}
            className="w-full resize-y bg-transparent text-left focus:outline-none"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" onClick={() => { setEditing(false); setDraft(text); }} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-ds-muted hover:bg-ds-hover">Cancel</button>
            <button
              type="button"
              disabled={!draft.trim() || running}
              onClick={() => { setEditing(false); void rewindAndResend(item.turnId, draft); }}
              className="rounded-full bg-zinc-950 px-3 py-1 text-[12px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50"
            >
              Resend
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-user-message group relative">
      <div className="ds-user-message-bubble min-w-0">
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-left">{text}</div>
      </div>
      <div className="absolute -bottom-1 right-1 flex items-center gap-1">
        {!running && (
          <button
            type="button"
            title="Edit & resend from here"
            aria-label="Edit & resend"
            onClick={() => { setDraft(text); setEditing(true); }}
            className="rounded-md p-1 text-ds-faint opacity-0 transition hover:bg-ds-hover hover:text-ds-ink group-hover:opacity-100"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" /></svg>
          </button>
        )}
        <CopyButton text={text} />
      </div>
    </div>
  );
}

function AssistantAnswer({ text, running }: { text: string; running: boolean }): JSX.Element {
  return (
    <div className="ds-markdown ds-chat-answer group relative min-w-0 max-w-full text-[14px] leading-6 text-ds-ink">
      <Markdown content={text} />
      {running && <span className="ds-shiny-text">▍</span>}
      {!running && text.trim() && (
        <div className="mt-1 flex">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  );
}

function ReasoningChip({ text, running, durationSec }: { text: string; running: boolean; durationSec?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = running ? "Thinking…" : durationSec && durationSec > 0 ? `Thought for ${durationSec}s` : "Reasoning";
  return (
    <div className="ds-work-timeline-detail">
      <div className="group">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-1 py-1 text-left text-[13px] text-ds-muted">
          <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5"><span className="h-2 w-2 rounded-full bg-accent" /></span>
          <span className={running ? "ds-shiny-text" : ""}>{label}</span>
          {Icon.chevron}
        </button>
        {open && (
          <div className="mt-1 border-l-2 border-ds-border-muted/35 pl-3 ml-1">
            <div className="ds-markdown text-[13.5px] leading-6 text-ds-muted"><Markdown content={text} /></div>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffBody({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split("\n").slice(0, 60);
  return (
    <div className="ds-code-block-body">
      <div className="ds-code-block-html font-mono text-[12px] leading-6">
        {lines.map((ln, i) => {
          if (ln.startsWith("@@")) return <div key={i} className="px-3 text-ds-faint">{ln}</div>;
          if (ln.startsWith("+")) return <div key={i} className="bg-ds-diff-added-soft text-ds-diff-added px-3">{ln}</div>;
          if (ln.startsWith("-")) return <div key={i} className="bg-ds-diff-removed-soft text-ds-diff-removed px-3">{ln}</div>;
          return <div key={i} className="px-3"><span className="text-ds-faint">{ln || " "}</span></div>;
        })}
      </div>
    </div>
  );
}

function ToolCard({ item }: { item: Extract<TurnItem, { kind: "tool_call" | "tool_result" }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const args = (item.kind === "tool_call" ? item.arguments : {}) as Record<string, unknown>;
  const pres = presentTool(item.toolName, item.toolKind, args);
  const diffSource = item.kind === "tool_call" ? args : ((item.output as Record<string, unknown> | undefined) ?? {});
  const diff = extractDiff(diffSource);
  const isError = item.kind === "tool_result" && item.isError;
  const detail = item.kind === "tool_result" ? outputText(item.output) : JSON.stringify(item.arguments, null, 2);

  const iconWrap =
    pres.tone === "edit" ? "bg-amber-400/15 text-amber-600"
    : pres.tone === "read" ? "bg-emerald-500/10 text-emerald-600"
    : pres.tone === "run" ? "bg-ds-hover text-ds-muted"
    : "bg-accent/10 text-accent";
  const glyph = pres.tone === "edit" ? Icon.fileEdit : pres.tone === "read" ? Icon.fileRead : pres.tone === "run" ? Icon.terminal : Icon.wrench;

  return (
    <div className={"ds-card-strong overflow-hidden rounded-[20px] border " + (isError ? "border-ds-diff-removed-soft" : "border-ds-border-muted")}>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 rounded-[14px] text-left transition hover:bg-ds-hover/35">
          <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-xl " + iconWrap}>{glyph}</span>
          <span className="min-w-0">
            <span className="block text-[13.5px] font-semibold text-ds-ink">{pres.title}</span>
            {pres.subtitle && <span className="mt-0.5 block truncate text-[12px] text-ds-faint font-mono">{pres.subtitle}</span>}
          </span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ds-faint">{item.status === "running" ? "running" : isError ? "error" : ""}</span>
      </div>
      {diff && <DiffBody diff={diff} />}
      {open && !diff && (
        <div className="ds-code-block-body border-t border-ds-border-muted">
          <pre className="ds-code-block-html whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-ds-muted">{detail.slice(0, 4000)}</pre>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item }: { item: Extract<TurnItem, { kind: "approval" }> }): JSX.Element {
  const approve = useStore((s) => s.approve);
  const pending = item.status === "pending";
  return (
    <div className="ds-card-strong overflow-hidden rounded-[20px] border border-amber-500/16">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 text-amber-600">{Icon.wrench}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-ds-ink">Approval requested</span>
          <span className="mt-0.5 block truncate text-[12px] text-ds-faint">{item.summary}</span>
        </span>
        {pending ? (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void approve(item.approvalId, "deny")} className="inline-flex h-8 items-center rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted transition hover:bg-ds-hover">Deny</button>
            <button type="button" onClick={() => void approve(item.approvalId, "allow")} className="inline-flex h-8 items-center rounded-full bg-zinc-950 px-3 text-[12.5px] font-medium text-white transition hover:bg-zinc-800">Allow</button>
          </div>
        ) : (
          <span className="shrink-0 rounded-full bg-ds-hover px-2.5 py-1 text-[11.5px] font-semibold text-ds-muted">{item.status}</span>
        )}
      </div>
    </div>
  );
}

function UserInputCard({ item }: { item: Extract<TurnItem, { kind: "user_input" }> }): JSX.Element {
  const submit = useStore((s) => s.submitUserInput);
  const cancel = useStore((s) => s.cancelUserInput);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  const pending = item.status === "pending";
  return (
    <div className="ds-card-strong overflow-hidden rounded-[20px] border border-ds-border-muted">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="text-[13.5px] font-semibold text-ds-ink">{item.prompt}</div>
        {item.questions.map((q: UserInputQuestion) => (
          <div key={q.id} className="flex flex-col gap-1.5">
            <div className="text-[12.5px] text-ds-muted">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={!pending}
                    title={opt.description}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt.label }))}
                    className={"inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-medium transition " + (answers[q.id] === opt.label ? "border-accent/60 bg-accent/10 text-accent" : "border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover")}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {pending ? (
          <div className="flex flex-col gap-2">
            <textarea value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="Type an answer…" className="w-full resize-none rounded-[12px] border border-ds-border bg-ds-surface-subtle px-3 py-2 text-[13px] text-ds-ink placeholder:text-ds-faint focus:outline-none focus:border-accent/40" rows={2} />
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => void cancel(item.inputId)} className="inline-flex h-8 items-center rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted transition hover:bg-ds-hover">Cancel</button>
              <button type="button" onClick={() => void submit(item.inputId, answers, freeText || undefined)} className="inline-flex h-8 items-center rounded-full bg-zinc-950 px-3 text-[12.5px] font-medium text-white transition hover:bg-zinc-800">Submit</button>
            </div>
          </div>
        ) : (
          <span className="self-start rounded-full bg-ds-hover px-2.5 py-1 text-[11.5px] font-semibold text-ds-muted">{item.status}</span>
        )}
      </div>
    </div>
  );
}

function MessageNode({ item }: { item: TurnItem }): JSX.Element | null {
  switch (item.kind) {
    case "user_message":
      return <UserMessage item={item} />;
    case "assistant_text":
      return <AssistantAnswer text={item.text} running={item.status === "running"} />;
    case "assistant_reasoning": {
      const durationSec =
        item.finishedAt && item.createdAt
          ? Math.max(0, Math.round((Date.parse(item.finishedAt) - Date.parse(item.createdAt)) / 1000))
          : undefined;
      return <ReasoningChip text={item.text} running={item.status === "running"} durationSec={durationSec} />;
    }
    case "tool_call":
    case "tool_result":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} />;
    case "user_input":
      return <UserInputCard item={item} />;
    case "compaction":
      return (
        <div className="flex items-center gap-2 px-1 text-[12px] text-ds-faint">
          <span className="h-px flex-1 bg-ds-border-muted" />
          <span>context folded · {item.replacedTokens} tokens summarized</span>
          <span className="h-px flex-1 bg-ds-border-muted" />
        </div>
      );
    case "error":
      return (
        <div className="rounded-[14px] border border-ds-diff-removed-soft bg-ds-diff-removed-soft px-4 py-2.5 text-[13px] text-ds-diff-removed">{item.message}</div>
      );
    default:
      return null;
  }
}

/* ----------------------------------------------------- runtime status blocks */

// The four runtime-status SSE kinds the store funnels into `activity`, rendered
// as compact icon/colored timeline blocks (T3.12). Other activity kinds (stage,
// compaction, insight) have their own rendering and are excluded here.
const RUNTIME_STATUS_STYLE: Record<string, { label: string; tone: string; dot: string }> = {
  tool_storm: { label: "Tool storm suppressed", tone: "border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  tool_catalog: { label: "Tool catalog changed", tone: "border-indigo-400/30 bg-indigo-400/10 text-indigo-700 dark:text-indigo-300", dot: "bg-indigo-500" },
  upload: { label: "Uploading tool result", tone: "border-sky-400/30 bg-sky-400/10 text-sky-700 dark:text-sky-300", dot: "bg-sky-500" },
  compaction_fallback: { label: "Compaction summary fell back", tone: "border-orange-400/30 bg-orange-400/10 text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
};
const RUNTIME_STATUS_KINDS = Object.keys(RUNTIME_STATUS_STYLE);

function RuntimeStatusBlocks(): JSX.Element | null {
  const activity = useStore((s) => s.activity);
  const blocks = useMemo(
    // `activity` is newest-first; show the most recent few in chronological order.
    () => activity.filter((a) => RUNTIME_STATUS_KINDS.includes(a.kind)).slice(0, 6).reverse(),
    [activity],
  );
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-label="runtime status">
      {blocks.map((b) => {
        const style = RUNTIME_STATUS_STYLE[b.kind];
        return (
          <div
            key={b.id}
            className={`flex items-center gap-2.5 rounded-[12px] border px-3 py-1.5 text-[12.5px] ${style?.tone ?? "border-ds-border bg-ds-card text-ds-muted"}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style?.dot ?? "bg-ds-faint"}`} />
            <span className="font-medium">{style?.label ?? b.label}</span>
            {b.detail ? <span className="min-w-0 truncate opacity-80">· {b.detail}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- model picker */

// Custom grouped model dropdown (T2.9), replacing the native <select> overlay:
// a floating panel grouped by provider with an "Auto" item, active-row
// highlight, unconfigured rows disabled, and Esc / click-outside dismissal.
function ModelPicker(): JSX.Element {
  const runtimeInfo = useStore((s) => s.runtimeInfo);
  const composerModel = useStore((s) => s.composerModel);
  const setComposerModel = useStore((s) => s.setComposerModel);
  // Only list models whose provider has a key (same rule as Settings: a masked
  // key counts as configured, a blank one does not). Seeded-but-unconfigured
  // presets (qwen/glm/minimax before the user picks them) stay out of the picker
  // instead of showing as disabled "no API key" rows.
  const models = (runtimeInfo?.models ?? []).filter((m) => m.configured);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, typeof models>();
    for (const m of models) {
      const key = m.provider || "other";
      const list = map.get(key);
      if (list) list.push(m);
      else map.set(key, [m]);
    }
    return [...map.entries()];
  }, [models]);

  const activeLabel = composerModel
    ? models.find((m) => m.id === composerModel)?.label ?? composerModel
    : "Auto";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string): void => {
    setComposerModel(id);
    setOpen(false);
  };
  const rowBase =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition rounded-lg";

  return (
    <div
      ref={ref}
      className="ds-composer-model-picker ds-no-drag relative flex h-9 items-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
      title={activeLabel}
    >
      <button
        type="button"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 min-w-0 flex-1 items-center justify-end gap-1 rounded-full py-2 pl-3 pr-1 text-[13px] font-medium text-current"
      >
        <span className="min-w-0 truncate text-right max-w-[12rem]">{activeLabel}</span>
        <span className="mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ds-faint">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Model"
          className="absolute bottom-full right-0 z-50 mb-2 max-h-80 w-64 overflow-y-auto rounded-2xl border border-ds-border bg-ds-card p-1.5 shadow-lg shadow-black/10 dark:shadow-black/40"
        >
          <button
            type="button"
            role="option"
            aria-selected={composerModel === ""}
            onClick={() => pick("")}
            className={`${rowBase} ${composerModel === "" ? "bg-ds-accent/12 text-ds-ink" : "text-ds-muted hover:bg-ds-hover"}`}
          >
            <span className="font-medium">Auto</span>
            <span className="ml-auto text-[11px] text-ds-faint">defer to default</span>
          </button>
          {groups.map(([provider, ms]) => (
            <div key={provider}>
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ds-faint">{provider}</div>
              {ms.map((m) => {
                const active = composerModel === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={!m.configured}
                    onClick={() => m.configured && pick(m.id)}
                    className={`${rowBase} ${
                      active ? "bg-ds-accent/12 text-ds-ink" : "text-ds-muted hover:bg-ds-hover"
                    } ${m.configured ? "" : "cursor-not-allowed opacity-50"}`}
                  >
                    <span className="min-w-0 truncate">{m.label}</span>
                    {!m.configured && <span className="ml-auto shrink-0 text-[11px] text-ds-faint">no API key</span>}
                    {active && (
                      <svg className="ml-auto h-3.5 w-3.5 shrink-0 text-ds-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {models.length === 0 && <div className="px-3 py-2 text-[13px] text-ds-muted">no models configured</div>}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- composer */

function Composer(): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const running = useStore((s) => s.running);
  const composerMode = useStore((s) => s.composerMode);
  const usage = useStore((s) => s.usage);
  const sendMessage = useStore((s) => s.sendMessage);
  const interrupt = useStore((s) => s.interrupt);
  const setComposerMode = useStore((s) => s.setComposerMode);
  const reasoningEffort = useStore((s) => s.reasoningEffort);
  const setReasoningEffort = useStore((s) => s.setReasoningEffort);
  const queuedMessages = useStore((s) => s.queuedMessages);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const skills = useStore((s) => s.skills);
  const agents = useStore((s) => s.agents);
  const currentThreadId = useStore((s) => s.currentThreadId);
  const workspace = useStore((s) => s.thread?.workspace);
  const composerModel = useStore((s) => s.composerModel);
  const runtimeInfo = useStore((s) => s.runtimeInfo);

  // --- attachments (T2.2) ---------------------------------------------------
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: File[]): Promise<void> => {
    const images = files.filter(isImageFile);
    if (images.length === 0) {
      // Attachments are image-only (the runtime's attachment store validates by
      // magic bytes). Tell the user instead of silently doing nothing.
      if (files.length > 0) setUploadError(t("composer.attachImagesOnly"));
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of images) {
        if (file.size === 0) continue;
        const dataUrl = await fileToDataUrl(file);
        const dataBase64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
        if (!dataBase64) continue;
        const { attachment } = await api.uploadAttachment({
          name: file.name || "image",
          ...(file.type ? { mimeType: file.type } : {}),
          dataBase64,
          ...(currentThreadId ? { threadId: currentThreadId } : {}),
          ...(workspace ? { workspace } : {}),
        });
        setAttachments((prev) => [
          ...prev,
          { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, preview: dataUrl },
        ]);
      }
    } catch (error) {
      setUploadError((error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const imgs = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f) && isImageFile(f as File));
    if (imgs.length) {
      e.preventDefault();
      void uploadFiles(imgs);
    }
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    void uploadFiles(Array.from(e.dataTransfer.files));
  };

  // --- voice input / speech-to-text (T2.7) ----------------------------------
  // Records mic audio via MediaRecorder, base64-encodes the captured blob and
  // POSTs it to /v1/audio/transcribe, inserting the returned text at the cursor.
  // STT is OFF by default — the route answers 503 (capability_unavailable). On
  // the first 503 we latch `micUnavailable` so the button renders DISABLED with
  // a tooltip (never a repeated dead click). MediaRecorder unsupported (e.g. no
  // secure context) latches the same way.
  const recordSupported =
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micUnavailable, setMicUnavailable] = useState(!recordSupported);
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Stop the recorder and release the mic if the composer unmounts mid-capture.
  useEffect(() => {
    return () => {
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stream.getTracks().forEach((track) => track.stop());
          rec.stop();
        } catch {
          /* best-effort cleanup */
        }
      }
    };
  }, []);

  const insertTranscript = (transcript: string): void => {
    const value = transcript.trim();
    if (!value) return;
    const ta = taRef.current;
    const cursor = ta?.selectionStart ?? text.length;
    setText((prev) => {
      const before = prev.slice(0, cursor);
      const after = prev.slice(cursor);
      const sep = before && !/\s$/.test(before) ? " " : "";
      return `${before}${sep}${value}${after}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const transcribeBlob = async (blob: Blob): Promise<void> => {
    if (blob.size === 0) {
      setMicState("idle");
      return;
    }
    setMicState("transcribing");
    setMicError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(blob);
      });
      const audioBase64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      if (!audioBase64) {
        setMicState("idle");
        return;
      }
      const { text: transcript } = await api.transcribeAudio({
        audioBase64,
        mimeType: blob.type || "audio/webm",
      });
      insertTranscript(transcript);
    } catch (error) {
      // 503 => STT not configured: latch disabled so it stops being clickable.
      if (error instanceof ApiError && error.status === 503) {
        setMicUnavailable(true);
        setMicError(t("composer.micUnavailable"));
      } else {
        setMicError(t("composer.micFailed"));
      }
    } finally {
      setMicState("idle");
    }
  };

  const startRecording = async (): Promise<void> => {
    if (!recordSupported || micUnavailable) return;
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Permission denied / no device — surface a hint, don't latch unavailable.
      setMicError(t("composer.micNoDevice"));
      return;
    }
    try {
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        recorderRef.current = null;
        void transcribeBlob(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setMicState("recording");
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setMicError(t("composer.micFailed"));
      setMicState("idle");
    }
  };

  const stopRecording = (): void => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const onMicClick = (): void => {
    if (micUnavailable) return;
    if (micState === "recording") stopRecording();
    else if (micState === "idle") void startRecording();
  };

  // --- unified slash overlay (T2.1) -----------------------------------------
  const slashQuery = useMemo(() => slashQueryOf(text), [text]);
  const [slashIdx, setSlashIdx] = useState(0);

  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    items.push({ id: "plan", kind: "builtin", title: "Plan", description: "Draft a read-only implementation plan", keywords: ["plan", "planner", "planning"], insert: "/plan " });
    const skillRows = skills
      .filter((s) => s.id?.trim() && s.name?.trim())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40)
      .map<SlashItem>((s) => ({
        id: `skill:${s.id}`,
        kind: "skill",
        title: s.name,
        description: s.description?.trim() || "Skill",
        keywords: [s.id, s.name, s.root ?? "", "skill", "技能", ...(s.triggers?.commands ?? []), ...(s.triggers?.fileTypes ?? []), ...(s.triggers?.promptPatterns ?? [])],
        badge: `/skill:${s.id}`,
        insert: `/skill:${s.id} `,
      }));
    items.push(...skillRows);
    for (const a of agents) {
      const slash = a.triggers.find((t) => t.kind === "command")?.value;
      if (!slash) continue;
      const cmd = slash.startsWith("/") ? slash : `/${slash}`;
      items.push({ id: `agent:${a.id}`, kind: "agent", title: a.name, description: a.subtitle || a.description, keywords: [a.id, a.name, slash, "agent", "智能体"], badge: cmd, insert: `${cmd} ` });
    }
    for (const b of [
      { id: "goal", title: "Goal", description: "Set or update the thread goal" },
      { id: "btw", title: "By the way", description: "Add a side note for the current turn" },
      { id: "review", title: "Review", description: "Run a code review of the workspace changes" },
      { id: "compact", title: "Compact", description: "Summarize and compact the conversation" },
      { id: "fork", title: "Fork", description: "Fork this thread into a new one" },
      { id: "archive", title: "Archive", description: "Archive this thread" },
    ]) {
      items.push({ id: b.id, kind: "builtin", title: b.title, description: b.description, keywords: [b.id, b.title.toLowerCase()], insert: `/${b.id} ` });
    }
    return items;
  }, [skills, agents]);

  const slashFiltered = useMemo<SlashItem[]>(() => {
    if (slashQuery == null) return [];
    if (!slashQuery) return slashItems;
    return slashItems.filter((i) => [i.id, i.title, i.description, ...i.keywords].some((k) => String(k).toLowerCase().includes(slashQuery)));
  }, [slashItems, slashQuery]);

  useEffect(() => setSlashIdx(0), [slashQuery]);
  const slashOpen = slashFiltered.length > 0;
  const selectSlash = (item: SlashItem): void => {
    setText(item.insert);
    setUploadError(null);
  };

  // --- @ references: workspace files (T2.3) + channel members (T2.8) --------
  // The same `@` trigger drives two sources in one overlay: the bound IM
  // channel's member roster (T2.8) and workspace files (T2.3). Members are the
  // more specific intent on this trigger, so they sort first. When the thread
  // has no bound phone channel / no members / the relay is down, the member
  // section is simply empty and `@` keeps working for files — never a dead
  // click.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [wsFiles, setWsFiles] = useState<string[]>([]);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atIdx, setAtIdx] = useState(0);

  // Channel-member roster + the mentions attached to the next StartTurn (T2.8).
  const [channelMembers, setChannelMembers] = useState<ImMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  // True once we have resolved (or failed to resolve) a bound channel for this
  // thread; `hasBinding` records whether a phone channel is actually bound, so
  // the empty/loading hint only shows for a bound-but-empty roster (never for
  // the common no-binding case, which silently falls back to the file picker).
  const [membersResolved, setMembersResolved] = useState(false);
  const [hasBinding, setHasBinding] = useState(false);
  const [pendingAtMembers, setPendingAtMembers] = useState<Array<{ id: string; name: string }>>([]);

  const computeAt = (value: string, cursor: number): string | null => {
    const upto = value.slice(0, cursor);
    const m = /(?:^|\s)@([\w./@-]*)$/.exec(upto);
    return m ? (m[1] ?? "") : null;
  };

  // Lazily crawl the workspace the first time an @ trigger appears.
  useEffect(() => {
    if (atQuery !== null && wsFiles.length === 0) {
      void api.listWorkspaceFiles(workspace).then((r) => setWsFiles(r.files)).catch(() => undefined);
    }
  }, [atQuery, wsFiles.length, workspace]);

  // Lazily resolve the bound channel's member roster the first time an @ trigger
  // appears for this thread: GET /v1/phone/bindings?threadId= → bound channel →
  // GET /v1/phone/channels/:id/members. Any failure (no binding, 503 relay down)
  // degrades to an empty member section.
  useEffect(() => {
    if (atQuery === null || membersResolved || !currentThreadId) return;
    let cancelled = false;
    setMembersLoading(true);
    void (async () => {
      try {
        const { bindings } = await api.listPhoneBindings({ threadId: currentThreadId });
        const channelId = bindings[0]?.channelId;
        if (!channelId) return;
        if (!cancelled) setHasBinding(true);
        const { members } = await api.listPhoneMembers(channelId);
        if (!cancelled) setChannelMembers(members);
      } catch {
        /* no binding / relay unavailable → empty member section, no dead click */
      } finally {
        if (!cancelled) {
          setMembersResolved(true);
          setMembersLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [atQuery, membersResolved, currentThreadId]);

  // Re-resolve members whenever the active thread changes.
  useEffect(() => {
    setChannelMembers([]);
    setMembersResolved(false);
    setHasBinding(false);
    setPendingAtMembers([]);
  }, [currentThreadId]);

  useEffect(() => setAtIdx(0), [atQuery]);

  const memberFiltered = useMemo<ImMember[]>(() => {
    if (atQuery === null) return [];
    const q = atQuery.toLowerCase();
    return (q ? channelMembers.filter((m) => (m.name || m.providerMemberId).toLowerCase().includes(q)) : channelMembers).slice(0, 20);
  }, [atQuery, channelMembers]);

  const atFiltered = useMemo<string[]>(() => {
    if (atQuery === null) return [];
    const q = atQuery.toLowerCase();
    return (q ? wsFiles.filter((f) => f.toLowerCase().includes(q)) : wsFiles).slice(0, 40);
  }, [atQuery, wsFiles]);

  // One flat, navigable list (members first, then files) sharing `atIdx`.
  type AtEntry = { key: string; kind: "member"; member: ImMember } | { key: string; kind: "file"; file: string };
  const atEntries = useMemo<AtEntry[]>(
    () => [
      ...memberFiltered.map<AtEntry>((m) => ({ key: `member:${m.id}`, kind: "member", member: m })),
      ...atFiltered.map<AtEntry>((f) => ({ key: `file:${f}`, kind: "file", file: f })),
    ],
    [memberFiltered, atFiltered],
  );
  // `atOpen` gates keyboard nav/selection (needs ≥1 selectable entry). The
  // overlay itself also opens to show the member loading/empty hint while the
  // `@` trigger is active, so the picker is never a silent dead click.
  const atOpen = atEntries.length > 0;
  // The bound-but-empty roster hint (only when a channel is actually bound).
  const membersBoundEmpty = membersResolved && hasBinding && channelMembers.length === 0;
  const atOverlayOpen = atOpen || (atQuery !== null && (membersLoading || membersBoundEmpty));

  const selectAtFile = (file: string): void => {
    const cursor = taRef.current?.selectionStart ?? text.length;
    const upto = text.slice(0, cursor);
    const m = /(?:^|\s)@([\w./@-]*)$/.exec(upto);
    if (!m) return;
    const at = upto.lastIndexOf("@");
    const next = `${text.slice(0, at)}@${file} ${text.slice(cursor)}`;
    setText(next);
    setAtQuery(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // Insert `@<name>` at the trigger and record the provider-native member id so
  // it rides along on the next StartTurn as `atMembers`.
  const selectAtMember = (member: ImMember): void => {
    const cursor = taRef.current?.selectionStart ?? text.length;
    const upto = text.slice(0, cursor);
    const m = /(?:^|\s)@([\w./@-]*)$/.exec(upto);
    if (!m) return;
    const at = upto.lastIndexOf("@");
    const label = (member.name || member.providerMemberId || "member").replace(/\s+/g, " ").trim();
    const next = `${text.slice(0, at)}@${label} ${text.slice(cursor)}`;
    const id = member.providerMemberId || member.id;
    setText(next);
    setPendingAtMembers((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, name: label }]));
    setAtQuery(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const selectAtEntry = (entry: AtEntry): void => {
    if (entry.kind === "member") selectAtMember(entry.member);
    else selectAtFile(entry.file);
  };

  const onChangeText = (value: string, cursor: number): void => {
    setText(value);
    setAtQuery(computeAt(value, cursor));
  };

  const send = (): void => {
    const value = text;
    const ids = attachments.map((a) => a.id);
    if (!value.trim() && ids.length === 0 && !running) return;
    const mentions = pendingAtMembers;
    setText("");
    setAttachments([]);
    setPendingAtMembers([]);
    void sendMessage(value, ids, mentions);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (atOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => Math.min(i + 1, atEntries.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = atEntries[Math.min(atIdx, atEntries.length - 1)];
        if (pick) selectAtEntry(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtQuery(null);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = slashFiltered[Math.min(slashIdx, slashFiltered.length - 1)];
        if (pick) selectSlash(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText((t) => `${t} `);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const savings = usage && usage.promptTokens > 0 ? Math.round((usage.cacheReadTokens / usage.promptTokens) * 100) : 0;
  const canSend = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="ds-no-drag flex shrink-0 justify-center px-2 pb-3 pt-0">
      <div className="ds-floating-composer ds-no-drag ds-chat-column-inset pointer-events-auto relative w-full mx-auto max-w-4xl">
        {/* @ overlay: channel members (T2.8) + workspace files (T2.3) */}
        {atOverlayOpen && (
          <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[18rem] overflow-y-auto rounded-[16px] border border-ds-border bg-ds-card p-1.5 shadow-[var(--ds-shadow-card-soft)]">
            {/* members section */}
            {(memberFiltered.length > 0 || membersLoading || membersBoundEmpty) && (
              <>
                <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ds-faint">{t("composer.memberMentionMenuTitle")}</div>
                {membersLoading && memberFiltered.length === 0 && (
                  <div className="px-2.5 py-1.5 text-[12px] text-ds-faint">{t("composer.memberMentionLoading")}</div>
                )}
                {!membersLoading && memberFiltered.length === 0 && membersBoundEmpty && (
                  <div className="px-2.5 py-1.5 text-[12px] text-ds-faint">{t("composer.memberMentionEmpty")}</div>
                )}
                {atEntries.map((entry, idx) =>
                  entry.kind === "member" ? (
                    <button
                      key={entry.key}
                      type="button"
                      onMouseEnter={() => setAtIdx(idx)}
                      onClick={() => selectAtMember(entry.member)}
                      className={"flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left transition " + (idx === atIdx ? "bg-ds-hover" : "hover:bg-ds-hover")}
                    >
                      {entry.member.avatar ? (
                        <img src={entry.member.avatar} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-semibold text-accent">
                          {(entry.member.name || entry.member.providerMemberId || "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ds-ink">{entry.member.name || entry.member.providerMemberId}</span>
                    </button>
                  ) : null,
                )}
              </>
            )}
            {/* files section */}
            {atFiltered.length > 0 && (
              <>
                {memberFiltered.length > 0 && <div className="my-1 h-px bg-ds-border-muted" />}
                {atEntries.map((entry, idx) =>
                  entry.kind === "file" ? (
                    <button
                      key={entry.key}
                      type="button"
                      onMouseEnter={() => setAtIdx(idx)}
                      onClick={() => selectAtFile(entry.file)}
                      className={"flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left transition " + (idx === atIdx ? "bg-ds-hover" : "hover:bg-ds-hover")}
                    >
                      <svg className="h-3.5 w-3.5 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ds-ink">{entry.file}</span>
                    </button>
                  ) : null,
                )}
              </>
            )}
          </div>
        )}
        {/* unified slash overlay (skills / commands / agents) */}
        {slashOpen && (
          <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[18rem] overflow-y-auto rounded-[16px] border border-ds-border bg-ds-card p-1.5 shadow-[var(--ds-shadow-card-soft)]">
            {slashFiltered.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setSlashIdx(idx)}
                onClick={() => selectSlash(item)}
                className={
                  "flex w-full items-center gap-2 rounded-[12px] px-2.5 py-2 text-left transition " +
                  (idx === slashIdx ? "bg-ds-hover" : "hover:bg-ds-hover")
                }
              >
                <span className="shrink-0 rounded-md bg-ds-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ds-faint">{item.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ds-ink">{item.title}</span>
                  <span className="block truncate text-[11.5px] text-ds-faint">{item.description}</span>
                </span>
                {item.badge && <span className="shrink-0 rounded bg-ds-subtle px-1.5 py-0.5 font-mono text-[11px] text-ds-muted">{item.badge}</span>}
              </button>
            ))}
          </div>
        )}
        <div
          className="ds-composer-shell ds-chat-composer ds-frosted ds-no-drag flex flex-col gap-1 px-3 pb-2 pt-2 transition"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {/* queued-message pills (T2.5): sent one-per-turn after completion */}
          {queuedMessages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
              <span className="text-[11px] font-medium text-ds-faint">Queued:</span>
              {queuedMessages.map((m, i) => (
                <span key={i} className="ds-no-drag inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-card px-2 py-1 text-[12px] text-ds-muted">
                  <span className="truncate">{m}</span>
                  <button type="button" aria-label="Remove queued message" className="text-ds-faint hover:text-ds-ink" onClick={() => removeQueuedMessage(i)}>✕</button>
                </span>
              ))}
            </div>
          )}
          {/* inline attachment pills */}
          {(attachments.length > 0 || uploading || uploadError) && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
              {attachments.map((a) => (
                <span key={a.id} className="ds-no-drag inline-flex items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-card px-2 py-1 text-[12px] text-ds-muted">
                  {a.preview && <img src={a.preview} alt="" className="h-5 w-5 rounded object-cover" />}
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                  <button type="button" aria-label="Remove attachment" className="text-ds-faint hover:text-ds-ink" onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}>
                    ✕
                  </button>
                </span>
              ))}
              {uploading && <span className="text-[12px] text-ds-faint">uploading…</span>}
              {uploadError && <span className="text-[12px] text-red-500">{uploadError}</span>}
              {attachments.length > 0 &&
                composerModel !== "" &&
                runtimeInfo?.models.find((m) => m.id === composerModel)?.supportsImages === false && (
                  <span className="text-[12px] text-amber-600">{t("composer.modelNoVision")}</span>
                )}
            </div>
          )}
          {/* @-mention chips (T2.8): rides along on the next StartTurn as atMembers */}
          {pendingAtMembers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
              {pendingAtMembers.map((m) => (
                <span key={m.id} className="ds-no-drag inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-1 text-[12px] font-medium text-accent">
                  <span className="max-w-[12rem] truncate">@{m.name}</span>
                  <button
                    type="button"
                    aria-label={t("composer.removeMention")}
                    title={t("composer.removeMention")}
                    className="text-accent/70 hover:text-accent"
                    onClick={() => setPendingAtMembers((prev) => prev.filter((x) => x.id !== m.id))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => onChangeText(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="ds-no-drag block w-full min-w-0 resize-none break-words bg-transparent px-1 py-2.5 text-[15px] leading-[1.45] text-ds-ink placeholder:text-ds-faint focus:outline-none min-h-[40px]"
            placeholder={running ? t("composer.steerPlaceholder") : t("composer.placeholder")}
          />

          <div className="ds-composer-toolbar flex min-h-9 items-center gap-2 justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden">
              <button
                type="button"
                onClick={() => setComposerMode(composerMode === "plan" ? "agent" : "plan")}
                title="Toggle plan mode"
                className={"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition " + (composerMode === "plan" ? "bg-accent/10 text-accent" : "bg-ds-hover text-ds-muted hover:text-ds-ink")}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
                <span>{t("composer.plan")}</span>
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title={t("composer.attachImage")}
                aria-label={t("composer.attachImage")}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ds-hover text-ds-muted transition hover:text-ds-ink"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  void uploadFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              {/* voice input / speech-to-text (T2.7) — disabled with a tooltip
                  when MediaRecorder is unsupported or STT is unconfigured (503). */}
              <button
                type="button"
                onClick={onMicClick}
                disabled={micUnavailable || micState === "transcribing"}
                aria-pressed={micState === "recording"}
                title={
                  micUnavailable
                    ? t("composer.micUnavailable")
                    : micState === "recording"
                      ? t("composer.micRecording")
                      : micState === "transcribing"
                        ? t("composer.micTranscribing")
                        : t("composer.mic")
                }
                aria-label={t("composer.mic")}
                className={
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 " +
                  (micState === "recording"
                    ? "bg-red-500/15 text-red-500"
                    : "bg-ds-hover text-ds-muted hover:text-ds-ink")
                }
              >
                {micState === "transcribing" ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                ) : micState === "recording" ? (
                  <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
                )}
              </button>
              {micState === "recording" && (
                <span className="ds-no-drag inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-red-500">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                  {t("composer.micRecording")}
                </span>
              )}
              {micError && micState !== "recording" && (
                <span className="ds-no-drag shrink-0 truncate text-[12px] text-ds-faint">{micError}</span>
              )}
            </div>

            <div className="flex min-w-0 items-center justify-end gap-1.5 shrink-0">
              <ModelPicker />

              {/* reasoning effort (T2.6) — backend resolves it against the model's
                  supported efforts; "auto" defers to the model default. */}
              <div className="ds-composer-effort-picker ds-no-drag relative flex h-9 items-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink" title="Reasoning effort">
                <span className="flex h-9 items-center gap-1 rounded-full py-2 pl-3 pr-1 text-[13px] font-medium capitalize">
                  {reasoningEffort}
                  <span className="mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ds-faint">
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                  </span>
                </span>
                <select
                  aria-label="Reasoning effort"
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  {["auto", "off", "low", "medium", "high", "max"].map((eff) => (
                    <option key={eff} value={eff}>
                      {eff}
                    </option>
                  ))}
                </select>
              </div>

              {running ? (
                <button type="button" onClick={() => void interrupt()} title="Interrupt" aria-label="Interrupt" className="ds-no-drag flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white shadow-[0_10px_22px_rgba(15,23,42,0.22)] transition hover:bg-zinc-800">
                  <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              ) : (
                <button type="button" onClick={send} disabled={!canSend} title="Send" aria-label="Send" className="ds-no-drag flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white shadow-[0_10px_22px_rgba(15,23,42,0.22)] transition hover:bg-zinc-800 disabled:opacity-40">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
                </button>
              )}
            </div>
          </div>

          <div className="ds-composer-footer mt-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 px-3">
            <div className="ds-composer-footer-left flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {usage && usage.totalTokens > 0 && (
                <span className="ds-composer-usage ds-no-drag inline-flex min-h-7 max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-visible rounded-lg border border-ds-border-muted bg-ds-card/72 px-2.5 py-0.5 text-[12.5px] font-medium leading-5 text-ds-muted shadow-sm">
                  <span className="ds-composer-usage-tokens shrink-0 truncate tabular-nums">{fmtK(usage.totalTokens)} tokens</span>
                  {usage.cacheReadTokens > 0 && (
                    <>
                      <span className="text-ds-faint">·</span>
                      <span className="shrink-0 truncate tabular-nums">{fmtK(usage.cacheReadTokens)} cached</span>
                      <span className="text-ds-faint">·</span>
                      <span className="shrink-0 tabular-nums text-emerald-700">{savings}% saved</span>
                    </>
                  )}
                  {usage.costUsd != null && (
                    <>
                      <span className="text-ds-faint">·</span>
                      <span className="shrink-0 truncate tabular-nums">${usage.costUsd.toFixed(2)}</span>
                    </>
                  )}
                  <span className="text-ds-faint">·</span>
                  <span className="shrink-0 truncate tabular-nums">{usage.requests} {usage.requests === 1 ? "turn" : "turns"}</span>
                </span>
              )}
            </div>
            <div className="ds-composer-footer-hint min-w-0 flex-1 text-right text-[12.5px] font-medium text-ds-faint">
              <span className="ds-kbd">Enter</span> {t("composer.enterToSend")} · <span className="ds-kbd">Shift</span>+<span className="ds-kbd">Enter</span> {t("composer.shiftEnterNewline")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- view */

/* --------------------------------------------------- side conversation panel */

// Docked column beside the main chat that streams a forked SIDE thread (T3.2,
// 并排分叉副线程). It reuses the same <MessageNode> timeline; the main chat stays
// fully visible and usable. Its own SSE subscription (sideStreamHandle in the
// store) keeps `sideItems` live concurrently with the main stream.
function SidePanel(): JSX.Element {
  const sideThread = useStore((s) => s.sideThread);
  const sideItems = useStore((s) => s.sideItems);
  const promoteSideToMain = useStore((s) => s.promoteSideToMain);
  const closeSidePanel = useStore((s) => s.closeSidePanel);
  const refreshSidePanel = useStore((s) => s.refreshSidePanel);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sideItems.length]);

  const sideTitle = sideThread?.title || "Side conversation";

  return (
    <aside className="ds-no-drag flex h-full min-h-0 w-[380px] shrink-0 flex-col border-l border-ds-border-muted bg-white dark:bg-ds-canvas">
      <header className="flex shrink-0 items-center gap-2 border-b border-ds-border-muted px-3 py-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">{Icon.branch}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ds-ink">{sideTitle}</span>
        <button
          type="button"
          onClick={() => void refreshSidePanel()}
          title="Refresh side conversation"
          aria-label="Refresh side conversation"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
        </button>
        <button
          type="button"
          onClick={() => void promoteSideToMain()}
          title="Open as main thread"
          className="inline-flex h-7 items-center rounded-full border border-ds-border bg-ds-card px-2.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => closeSidePanel()}
          title="Close side conversation"
          aria-label="Close side conversation"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sideItems.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-ds-muted">No messages yet in this side conversation.</div>
        ) : (
          <div className="flex w-full min-w-0 flex-col gap-6 px-4 pb-8 pt-5">
            {sideItems.map((item) => (
              <div key={item.id} className="ds-work-stack flex min-w-0 flex-col gap-3">
                <MessageNode item={item} />
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Compact a workspace path for the header chip: keep the trailing segments so
 * the project folder stays visible (the full path is the tooltip). "" for empty.
 */
function prettyWorkspace(path: string): string {
  const trimmed = (path || "").replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const segs = trimmed.split(/[\\/]/).filter(Boolean);
  return segs.length <= 2 ? trimmed : `…/${segs.slice(-2).join("/")}`;
}

export function WorkbenchView(): JSX.Element {
  const { t } = useTranslation();
  const items = useStore((s) => s.items);
  const thread = useStore((s) => s.thread);
  const running = useStore((s) => s.running);
  const workspaceStatus = useStore((s) => s.workspaceStatus);
  const currentThreadId = useStore((s) => s.currentThreadId);
  const sidePanelOpen = useStore((s) => s.sidePanel.open);
  const forkToSide = useStore((s) => s.forkToSide);
  const pendingWorkspace = useStore((s) => s.pendingWorkspace);
  const defaultWorkspace = useStore((s) => s.runtimeInfo?.defaultWorkspace) ?? "";
  const renameThread = useStore((s) => s.renameThread);
  // The workspace the active (or about-to-be-created) thread belongs to, so the
  // header always shows which path this agent operates in — including right
  // after "New Agent", before the first message lazily creates the thread.
  const workspacePath = thread?.workspace || pendingWorkspace || defaultWorkspace || "";

  // Inline rename of the thread title from the header (double-click the title).
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const beginRename = (): void => {
    if (!thread) return;
    setDraftTitle(thread.title || "");
    setEditingTitle(true);
  };
  const commitRename = (): void => {
    setEditingTitle(false);
    const next = draftTitle.trim();
    if (thread && next && next !== thread.title) void renameThread(thread.id, next);
  };

  // Right rail: a single docked panel beside the chat (faithful to the original
  // Nexus `rightPanelMode`), toggled by the topbar buttons (clicking the open
  // one closes it) and resizable via the divider.
  const workbenchPanel = useNav((s) => s.workbenchPanel);
  const toggleWorkbenchPanel = useNav((s) => s.toggleWorkbenchPanel);
  const closeWorkbenchPanel = useNav((s) => s.closeWorkbenchPanel);
  const railWidth = useNav((s) => s.railWidth);
  const setRailWidth = useNav((s) => s.setRailWidth);
  // When the sidebar is collapsed, AppShell floats an "expand" button over the
  // top-left of this stage; inset the topbar so the branch/title don't sit under it.
  const sidebarCollapsed = useNav((s) => s.sidebarCollapsed);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length, running]);

  const branch = workspaceStatus?.branch ?? null;
  const title = thread?.title || "New thread";
  const empty = !thread && items.length === 0;

  const lastItem = items[items.length - 1];
  const showWorking = running && lastItem?.kind !== "assistant_text";

  const stream = useMemo(() => items, [items]);

  // Drag the divider to resize the rail. The rail is right-docked, so moving the
  // pointer left widens it (start width + how far left the pointer travelled).
  const startResize = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = railWidth;
    const onMove = (ev: PointerEvent): void => setRailWidth(startWidth + (startX - ev.clientX));
    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const panelBtn = (active: boolean): string =>
    "inline-flex h-8 w-8 items-center justify-center rounded-full border transition " +
    (active
      ? "border-accent/40 bg-accent/10 text-accent"
      : "border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink");

  return (
    <div className="ds-drag flex min-h-0 min-w-0 flex-1">
    <section className="ds-chat-stage ds-drag flex min-h-0 min-w-0 flex-1 flex-col">
      {/* top bar */}
      <header className="chat-topbar group relative z-10 flex min-h-[46px] w-full shrink-0 items-stretch overflow-visible">
        <div className="chat-topbar-grid grid w-full min-w-0 items-start gap-2.5 px-3 py-2 sm:px-4 md:pl-5 md:pr-2" style={{ gridTemplateColumns: "1fr auto", ...(sidebarCollapsed ? { paddingLeft: 56 } : {}) }}>
          <div className="chat-topbar-session flex min-w-0 items-center gap-2.5">
            {branch && (
              <span className="inline-flex h-9 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-surface-subtle px-3 text-[12.5px] font-semibold text-ds-ink">
                {Icon.branch}
                <span className="min-w-0 flex-1 truncate">{branch}</span>
              </span>
            )}
            <div className="flex min-w-0 flex-col justify-center">
              {editingTitle ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="ds-no-drag min-w-0 max-w-[22rem] rounded-md border border-ds-border bg-ds-card px-1.5 py-0.5 text-[15px] font-semibold text-ds-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  spellCheck={false}
                />
              ) : (
                <span
                  className={"ds-no-drag truncate text-[15px] font-semibold text-ds-ink " + (thread ? "cursor-text" : "")}
                  title={thread ? "Double-click to rename" : undefined}
                  onDoubleClick={beginRename}
                >
                  {title}
                </span>
              )}
              {workspacePath && (
                <span className="ds-no-drag flex min-w-0 items-center gap-1 text-[11.5px] leading-tight text-ds-faint" title={workspacePath}>
                  <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                  <span className="min-w-0 truncate">{prettyWorkspace(workspacePath)}</span>
                </span>
              )}
            </div>
          </div>
          <div className="chat-topbar-actions flex min-w-0 flex-wrap items-center justify-end gap-2 self-start">
            {running && <span className="inline-flex shrink-0 rounded-full bg-amber-500/16 px-2.5 py-1 text-[11.5px] font-semibold text-amber-950">Running</span>}
            {currentThreadId && (
              <button
                type="button"
                onClick={() => void forkToSide()}
                aria-pressed={sidePanelOpen}
                className={panelBtn(sidePanelOpen)}
                aria-label="Fork to side conversation"
                title="Fork to side conversation"
              >
                {Icon.branch}
              </button>
            )}
            <button type="button" onClick={() => toggleWorkbenchPanel("plan")} aria-pressed={workbenchPanel === "plan"} className={panelBtn(workbenchPanel === "plan")} aria-label="Plan" title="Plan">{Icon.plan}</button>
            <button type="button" onClick={() => toggleWorkbenchPanel("changes")} aria-pressed={workbenchPanel === "changes"} className={panelBtn(workbenchPanel === "changes")} aria-label="Changes" title="Changes">{Icon.changes}</button>
            <button type="button" onClick={() => toggleWorkbenchPanel("todos")} aria-pressed={workbenchPanel === "todos"} className={panelBtn(workbenchPanel === "todos")} aria-label="Todos" title="Todos">{Icon.todos}</button>
            <button type="button" onClick={() => toggleWorkbenchPanel("memory")} aria-pressed={workbenchPanel === "memory"} className={panelBtn(workbenchPanel === "memory")} aria-label="Memory" title="Memory">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /></svg>
            </button>
            <button type="button" onClick={() => toggleWorkbenchPanel("usage")} aria-pressed={workbenchPanel === "usage"} className={panelBtn(workbenchPanel === "usage")} aria-label="Usage" title="Usage">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg>
            </button>
            <button type="button" onClick={() => toggleWorkbenchPanel("rounds")} aria-pressed={workbenchPanel === "rounds"} className={panelBtn(workbenchPanel === "rounds")} aria-label="LLM rounds" title="LLM rounds">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
            </button>
          </div>
        </div>
      </header>

      {/* message timeline */}
      <main className="ds-drag ds-stage-surface ds-stage-surface--chat relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {empty ? (
            <div className="ds-empty-hero mx-auto flex w-full max-w-3xl flex-col items-center px-6 text-center">
              <h1 className="ds-empty-hero-title">What should we build?</h1>
              <p className="ds-empty-hero-sub mt-3 max-w-xl text-[14px] text-ds-muted">
                A GUI-native coding agent. Describe a goal — it reads, searches and edits files and runs commands in your workspace, streaming reasoning and tool calls live. Switch to Plan for a read-only implementation plan.
              </p>
              {workspacePath && (
                <div
                  className="mt-5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-ds-border-muted bg-ds-surface-subtle px-3 py-1 text-[12.5px] text-ds-muted"
                  title={workspacePath}
                >
                  <svg className="h-3.5 w-3.5 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                  <span className="min-w-0 truncate">Workspace: {workspacePath}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="ds-message-timeline-content ds-chat-column-inset mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-8 pb-10 pt-8 px-6">
              {stream.map((item) => (
                <div key={item.id} className="ds-work-stack flex min-w-0 flex-col gap-3">
                  <MessageNode item={item} />
                </div>
              ))}
              <RuntimeStatusBlocks />
              {showWorking && (
                <div className="flex items-center gap-2 px-1 text-[13px] text-ds-muted">
                  {Icon.spinner}
                  <span className="ds-shiny-text">Working…</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <Composer />
      </main>
    </section>

      {/* docked side conversation (T3.2) — a forked thread streaming beside the
          main chat, which stays fully visible and usable */}
      {sidePanelOpen && <SidePanel />}

      {/* docked right rail — Goal / Changes / Todo, resizable, beside the chat */}
      {workbenchPanel && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
            className="ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
            title="Drag to resize"
          />
          <div className="ds-no-drag h-full min-h-0 shrink-0" style={{ width: railWidth }}>
            {workbenchPanel === "plan" ? (
              <PlanPanelView onCollapse={closeWorkbenchPanel} />
            ) : workbenchPanel === "changes" ? (
              <ChangeInspectorView onCollapse={closeWorkbenchPanel} />
            ) : workbenchPanel === "memory" ? (
              <MemoryPanelView onCollapse={closeWorkbenchPanel} />
            ) : workbenchPanel === "usage" ? (
              <UsagePanelView onCollapse={closeWorkbenchPanel} />
            ) : workbenchPanel === "rounds" ? (
              <LlmRoundsPanelView onCollapse={closeWorkbenchPanel} />
            ) : (
              <TodoPanelView onCollapse={closeWorkbenchPanel} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
