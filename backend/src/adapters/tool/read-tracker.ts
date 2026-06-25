import { isAbsolute, resolve, relative } from "node:path";
import type { ToolContext, ToolCall } from "./types.js";

const EDIT_TOOL_NAMES = new Set(["edit", "edit_file", "apply_patch"]);

interface ReadRecord {
  absolutePath: string;
  truncated: boolean;
  turnId: string;
  relativePath?: string;
  content?: string;
}

export interface ReadTrackerOptions {
  enabled: boolean;
  requireOldTextInRead: boolean;
}

export function normalizeReadTrackerOptions(value: boolean | Partial<ReadTrackerOptions> | undefined): ReadTrackerOptions {
  if (value === true) return { enabled: true, requireOldTextInRead: true };
  if (value === false || value === undefined) return { enabled: false, requireOldTextInRead: true };
  return { enabled: value.enabled === true, requireOldTextInRead: value.requireOldTextInRead !== false };
}

/** Enforces "read a file (this turn) before editing it". */
export class ReadTracker {
  private readonly options: ReadTrackerOptions;
  private readonly records = new Map<string, Map<string, ReadRecord>>();

  constructor(options: boolean | Partial<ReadTrackerOptions> | undefined = true) {
    this.options = normalizeReadTrackerOptions(options);
  }

  observeToolResult(input: { context: ToolContext; call: ToolCall; output: unknown; isError: boolean }): void {
    if (!this.options.enabled || input.isError || input.call.toolName !== "read") return;
    if (!input.output || typeof input.output !== "object") return;
    const output = input.output as { path?: unknown; relative_path?: unknown; content?: unknown; truncated?: unknown };
    const rawPath = typeof output.path === "string" ? output.path : "";
    if (!rawPath) return;
    const absolutePath = normalizePath(rawPath, input.context.workspace);
    const record: ReadRecord = {
      absolutePath,
      truncated: output.truncated === true,
      turnId: input.context.turnId,
      ...(typeof output.relative_path === "string" ? { relativePath: output.relative_path } : {}),
      ...(typeof output.content === "string" ? { content: output.content } : {}),
    };
    const threadRecords = this.records.get(input.context.threadId) ?? new Map<string, ReadRecord>();
    threadRecords.set(absolutePath, record);
    this.records.set(input.context.threadId, threadRecords);
  }

  validateBeforeTool(input: { context: ToolContext; call: ToolCall }): { ok: true } | { ok: false; message: string } {
    if (!this.options.enabled || !EDIT_TOOL_NAMES.has(input.call.toolName)) return { ok: true };

    const rawPath = typeof input.call.arguments.path === "string" ? input.call.arguments.path : "";
    if (!rawPath.trim()) return { ok: true };
    const absolutePath = normalizePath(rawPath, input.context.workspace);
    const record = this.records.get(input.context.threadId)?.get(absolutePath);
    if (!record) {
      return {
        ok: false,
        message: `read-before-edit guard blocked edit for ${displayPath(rawPath, input.context.workspace)}. Read the current file contents in this turn before editing so SEARCH text is based on fresh bytes.`,
      };
    }
    if (record.turnId !== input.context.turnId) {
      return {
        ok: false,
        message: `read-before-edit guard blocked edit for ${displayPath(rawPath, input.context.workspace)}. The previous read is from an earlier turn; read the file again before editing.`,
      };
    }
    if (!this.options.requireOldTextInRead) return { ok: true };
    const missing = oldTextFragments(input.call.arguments).filter((fragment) => {
      if (!fragment.trim()) return false;
      return !record.content || !record.content.includes(fragment);
    });
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `read-before-edit guard blocked edit for ${record.relativePath ?? displayPath(rawPath, input.context.workspace)}. At least one oldText fragment was not present in the latest read output; read a narrower range that includes the exact text before editing.`,
    };
  }

  clear(threadId?: string): void {
    if (threadId) {
      this.records.delete(threadId);
      return;
    }
    this.records.clear();
  }
}

function oldTextFragments(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.oldText === "string") out.push(args.oldText);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).oldText === "string") {
        out.push((edit as Record<string, unknown>).oldText as string);
      }
    }
  }
  return out;
}

function normalizePath(path: string, workspace: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspace || ".", path);
}

function displayPath(path: string, workspace: string): string {
  const absolutePath = normalizePath(path, workspace);
  const rel = workspace ? relative(resolve(workspace), absolutePath) : "";
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}
