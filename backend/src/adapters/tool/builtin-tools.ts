import { readFile, writeFile, mkdir, stat, lstat, readdir } from "node:fs/promises";
import { dirname, resolve as resolvePath, relative as relativePath, basename, join as joinPath } from "node:path";
import type { Stats } from "node:fs";
import type { LocalTool, ToolContext, ToolResult } from "./types.js";
import { defineTool } from "./types.js";
import {
  resolveToolPath,
  truncateHead,
  formatSize,
  globToRegExp,
  collectPaths,
  isProbablyBinary,
  detectImageMime,
  resolveExecutable,
  spawnExec,
  normalizeToolPath,
  getReadClassification,
  resizeImageWithSips,
  formatDimensionNote,
  RG_EXECUTABLE_CANDIDATES,
  FD_EXECUTABLE_CANDIDATES,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "./util.js";
import { canWritePath } from "./sandbox.js";
import {
  applyEdits,
  generateDisplayDiff,
  generateUnifiedPatch,
  firstChangedLine,
  type EditSpec,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { buildBashSessionTool } from "./bash-session.js";

const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_FIND_LIMIT = 1000;
const AUTO_RESIZE_IMAGES = true;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
/** Coerce truthy booleans/strings/numbers (e.g. "true"/"1"/"yes"/"on"/1) to a boolean. */
function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}
function err(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { output: { error: message, ...extra }, isError: true };
}

// --- read -------------------------------------------------------------------

const readTool = defineTool({
  name: "read",
  description: "Read a file from the workspace. Supports optional line offset and limit for large files.",
  toolKind: "tool_call",
  policy: "auto",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = asString(args.path);
    if (!path) return err("read requires a non-empty path");
    const { absolutePath, relativePath } = resolveToolPath(path, context.workspace);
    let buffer: Buffer;
    try {
      const info = await stat(absolutePath);
      if (info.isDirectory()) return err(`${path} is a directory; use ls`, { path });
      buffer = await readFile(absolutePath);
    } catch (error) {
      return err(`could not read ${path}: ${(error as Error).message}`, { path });
    }

    const classification = getReadClassification(absolutePath, context.workspace);

    const imageMime = detectImageMime(buffer);
    if (imageMime) {
      if (AUTO_RESIZE_IMAGES) {
        const resized = await resizeImageWithSips(buffer, imageMime.mimeType);
        if (!resized) {
          // sips unavailable or the image could not be reduced below the limit:
          // always omit the inline data (faithful to the original).
          return {
            output: {
              path: absolutePath,
              relative_path: relativePath,
              kind: "image",
              mime_type: imageMime.mimeType,
              width: imageMime.width ?? null,
              height: imageMime.height ?? null,
              byte_size: buffer.length,
              note: `Read image file [${imageMime.mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
              classification: classification ?? null,
            },
          };
        }
        const dimensionNote = formatDimensionNote(resized);
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            kind: "image",
            mime_type: resized.mimeType,
            width: resized.width,
            height: resized.height,
            byte_size: buffer.length,
            data_base64: resized.dataBase64,
            note: dimensionNote
              ? `Read image file [${resized.mimeType}]\n${dimensionNote}`
              : `Read image file [${resized.mimeType}]`,
            classification: classification ?? null,
            resized: resized.wasResized === true,
          },
        };
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          kind: "image",
          mime_type: imageMime.mimeType,
          width: imageMime.width ?? null,
          height: imageMime.height ?? null,
          byte_size: buffer.length,
          data_base64: buffer.toString("base64"),
          note: `Read image file [${imageMime.mimeType}]`,
          classification: classification ?? null,
        },
      };
    }

    if (isProbablyBinary(buffer)) {
      return err("read only supports text files in Nexus serve mode", { path: absolutePath });
    }

    const text = buffer.toString("utf-8").replace(/\r\n/g, "\n");
    const allLines = text.split("\n");
    const totalLines = allLines.length;
    const offset = asPositiveInt(args.offset, 1);
    const limit = asPositiveInt(args.limit, DEFAULT_MAX_LINES);
    const selected = allLines.slice(offset - 1, offset - 1 + limit).join("\n");
    const truncation = truncateHead(selected, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

    const shownLines = truncation.outputLines;
    const endLine = Math.max(offset, offset + shownLines - 1);
    let content = truncation.content;
    if (truncation.firstLineExceedsLimit) {
      content = `[first line exceeds ${formatSize(DEFAULT_MAX_BYTES)} at line ${offset}. Use bash for a byte-limited slice of this line.]`;
    } else if (truncation.truncated) {
      const nextOffset = endLine + 1;
      if (truncation.truncatedBy === "lines") {
        content = `${truncation.content}\n\n[showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        content = `${truncation.content}\n\n[showing lines ${offset}-${endLine} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
    } else if (offset - 1 + limit < totalLines) {
      const nextOffset = offset + limit;
      const remaining = totalLines - (offset - 1 + limit);
      content = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    }

    return {
      output: {
        path: absolutePath,
        relative_path: relativePath,
        content,
        classification: classification ?? null,
        start_line: offset,
        end_line: endLine,
        total_lines: totalLines,
        truncated: truncation.truncated,
        truncation_by: truncation.truncatedBy ?? null,
        first_line_exceeds_limit: truncation.firstLineExceedsLimit === true,
      },
    };
  },
});

// --- ls ---------------------------------------------------------------------

/** Per-entry shape returned by ls. Faithful to the original makeListEntry. */
interface ListEntry {
  path: string;
  relative_path: string;
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
}

/**
 * Build a single ls entry from a stat result. `kind` is directory/file/symlink
 * with "other" as the fallback. Faithful port of the original makeListEntry.
 */
function makeListEntry(path: string, root: string, fileStat: Stats): ListEntry {
  return {
    path,
    relative_path: normalizeToolPath(relativePath2(root, path)),
    name: basename(path),
    kind: fileStat.isDirectory()
      ? "directory"
      : fileStat.isFile()
        ? "file"
        : fileStat.isSymbolicLink()
          ? "symlink"
          : "other",
    size: Number(fileStat.size),
  };
}

const lsTool = defineTool({
  name: "ls",
  description: "List directory contents. Returns entries sorted alphabetically and marks directories.",
  toolKind: "tool_call",
  policy: "auto",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args, context) {
    const rawPath = asString(args.path) && asString(args.path)!.trim() ? asString(args.path)! : ".";
    const limit = asPositiveInt(args.limit, DEFAULT_LIST_LIMIT);
    const { absolutePath, relativePath, workspaceRoot } = resolveToolPath(rawPath, context.workspace);
    let dirEntries;
    try {
      const info = await stat(absolutePath);
      if (!info.isDirectory()) return err(`not a directory: ${absolutePath}`, { path: absolutePath });
      dirEntries = await readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      return err(`not a directory: ${absolutePath}`, { path: absolutePath, detail: (error as Error).message });
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    const sliced = dirEntries.slice(0, limit);
    const entries: ListEntry[] = [];
    for (const dirEntry of sliced) {
      const entryPath = joinPath(absolutePath, dirEntry.name);
      let fileStat: Stats;
      try {
        fileStat = await lstat(entryPath);
      } catch {
        continue;
      }
      entries.push(makeListEntry(entryPath, workspaceRoot, fileStat));
    }
    return {
      output: {
        path: absolutePath,
        relative_path: relativePath,
        entries: entries.map((entry) => ({
          ...entry,
          display_name: entry.kind === "directory" ? `${entry.name}/` : entry.name,
        })),
        names: entries.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name)),
        truncated: dirEntries.length >= limit,
        entry_limit_reached: dirEntries.length >= limit ? limit : null,
      },
    };
  },
});

// --- find -------------------------------------------------------------------

const findTool = defineTool({
  name: "find",
  description: "Find workspace files by glob pattern, similar to pi find.",
  toolKind: "tool_call",
  policy: "auto",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const pattern = asString(args.pattern) ? asString(args.pattern)!.trim() : "";
    if (!pattern) return err("pattern is required");
    const path = asString(args.path) && asString(args.path)!.trim() ? asString(args.path)! : ".";
    const limit = asPositiveInt(args.limit, DEFAULT_FIND_LIMIT);
    const { absolutePath, relativePath, workspaceRoot } = resolveToolPath(path, context.workspace);
    const matcher = globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);

    const fd = resolveExecutable(FD_EXECUTABLE_CANDIDATES);
    const rg = resolveExecutable(RG_EXECUTABLE_CANDIDATES);
    let matches: Array<{ path: string; relative_path: string }>;
    let backend: "fd" | "rg" | "scan";

    if (fd) {
      backend = "fd";
      const fdArgs = [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results",
        String(limit),
        "--",
        pattern,
        absolutePath,
      ];
      const result = await spawnExec(fd, fdArgs, { cwd: workspaceRoot, signal: context.abortSignal });
      const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      matches = candidates
        .map((p) => {
          const abs = resolvePath(p);
          return { path: abs, relative_path: normalizeToolPath(relativePath2(workspaceRoot, abs)) };
        })
        .slice(0, limit);
    } else if (rg) {
      backend = "rg";
      const result = await spawnExec(rg, ["--files", "--hidden", "-g", pattern, absolutePath], {
        cwd: workspaceRoot,
        signal: context.abortSignal,
      });
      const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      matches = candidates
        .map((p) => {
          const abs = resolvePath(p);
          return { path: abs, relative_path: normalizeToolPath(relativePath2(workspaceRoot, abs)) };
        })
        .slice(0, limit);
    } else {
      backend = "scan";
      const paths = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 });
      matches = paths
        .map((p) => ({ path: p, relative_path: normalizeToolPath(relativePath2(workspaceRoot, p)) }))
        .filter((entry) => matcher.test(entry.relative_path))
        .slice(0, limit);
    }

    return {
      output: {
        path: absolutePath,
        relative_path: relativePath,
        pattern,
        matches,
        backend,
        truncated: matches.length >= limit,
        result_limit_reached: matches.length >= limit ? limit : null,
      },
    };
  },
});

/** relative(root, abs) || "." */
function relativePath2(root: string, abs: string): string {
  return relativePath(root, abs) || ".";
}

// --- grep -------------------------------------------------------------------

const grepTool = defineTool({
  name: "grep",
  description: "Search file contents for a pattern and return matching lines with paths and line numbers.",
  toolKind: "tool_call",
  policy: "auto",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      ignoreCase: { type: "boolean" },
      literal: { type: "boolean" },
      context: { type: "number" },
      limit: { type: "number" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const pattern = asString(args.pattern);
    if (!pattern || !pattern.trim()) return err("pattern is required");
    const path = asString(args.path) && asString(args.path)!.trim() ? asString(args.path)! : ".";
    const limit = asPositiveInt(args.limit, DEFAULT_SEARCH_LIMIT);
    const literal = normalizeBoolean(args.literal);
    const ignoreCase = normalizeBoolean(args.ignoreCase);
    const ctxLines = typeof args.context === "number" && Number.isFinite(args.context) && args.context > 0 ? Math.floor(args.context) : 0;
    const glob = asString(args.glob) && asString(args.glob)!.trim() ? asString(args.glob)!.trim() : null;
    const flags = ignoreCase ? "i" : "";
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    let regex: RegExp;
    try {
      regex = new RegExp(source, flags);
    } catch (error) {
      return err(`invalid regex: ${(error as Error).message}`);
    }
    const globMatcher = glob ? globToRegExp(glob.includes("/") ? glob : `**/${glob}`) : null;
    const { absolutePath, relativePath, workspaceRoot } = resolveToolPath(path, context.workspace);

    const matches: Array<Record<string, unknown>> = [];
    const rg = resolveExecutable(RG_EXECUTABLE_CANDIDATES);
    const backend: "rg" | "scan" = rg ? "rg" : "scan";

    if (rg) {
      const rgArgs = ["--hidden", "--line-number", "--with-filename", "--color", "never"];
      if (ignoreCase) rgArgs.push("--ignore-case");
      if (literal) rgArgs.push("--fixed-strings");
      if (glob) rgArgs.push("-g", glob);
      rgArgs.push(pattern, absolutePath);
      const result = await spawnExec(rg, rgArgs, { cwd: workspaceRoot, signal: context.abortSignal });
      const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const row of rows) {
        if (matches.length >= limit) break;
        const parsed = row.match(/^(.*?):(\d+):(.*)$/);
        if (!parsed) continue;
        const candidatePath = resolvePath(parsed[1] ?? "");
        const lineNumber = Number(parsed[2] ?? "0");
        const lineText = parsed[3] ?? "";
        const candidateRelative = normalizeToolPath(relativePath2(workspaceRoot, candidatePath));
        if (globMatcher && !globMatcher.test(candidateRelative)) continue;
        regex.lastIndex = 0;
        const columnMatch = regex.exec(lineText);
        let buffer: Buffer;
        try {
          buffer = await readFile(candidatePath);
        } catch {
          continue;
        }
        if (isProbablyBinary(buffer)) continue;
        const lines = buffer.toString("utf-8").replace(/\r\n/g, "\n").split("\n");
        matches.push({
          path: candidatePath,
          relative_path: candidateRelative,
          line: lineNumber,
          column: (columnMatch?.index ?? 0) + 1,
          text: lineText,
          ...(ctxLines > 0
            ? {
                context_before: lines.slice(Math.max(0, lineNumber - 1 - ctxLines), lineNumber - 1),
                context_after: lines.slice(lineNumber, lineNumber + ctxLines),
              }
            : {}),
        });
      }
    } else {
      const candidates = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 });
      for (const candidatePath of candidates) {
        if (matches.length >= limit) break;
        if (context.abortSignal.aborted) break;
        const candidateRelative = normalizeToolPath(relativePath2(workspaceRoot, candidatePath));
        if (globMatcher && !globMatcher.test(candidateRelative)) continue;
        let buffer: Buffer;
        try {
          buffer = await readFile(candidatePath);
        } catch {
          continue;
        }
        if (isProbablyBinary(buffer)) continue;
        const lines = buffer.toString("utf-8").replace(/\r\n/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (matches.length >= limit) break;
          const line = lines[index] ?? "";
          regex.lastIndex = 0;
          const result = regex.exec(line);
          if (!result) continue;
          matches.push({
            path: candidatePath,
            relative_path: candidateRelative,
            line: index + 1,
            column: (result.index ?? 0) + 1,
            text: line,
            ...(ctxLines > 0
              ? {
                  context_before: lines.slice(Math.max(0, index - ctxLines), index),
                  context_after: lines.slice(index + 1, index + 1 + ctxLines),
                }
              : {}),
          });
        }
      }
    }

    return {
      output: {
        path: absolutePath,
        relative_path: relativePath,
        pattern,
        glob,
        ignore_case: ignoreCase,
        literal,
        context: ctxLines,
        backend,
        matches,
        truncated: matches.length >= limit,
        match_limit_reached: matches.length >= limit ? limit : null,
      },
    };
  },
});

// --- write ------------------------------------------------------------------

const writeTool = defineTool({
  name: "write",
  description: "Create or overwrite a workspace file with the provided content.",
  toolKind: "file_change",
  policy: "on-request",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(args, context) {
    const path = asString(args.path);
    const content = asString(args.content);
    if (!path) return err("write requires a path");
    if (content == null) return err("write requires content");
    const check = canWritePath(path, context);
    if (!check.ok) return err(check.message ?? "write blocked", { code: check.code });
    const { absolutePath, relativePath } = resolveToolPath(path, context.workspace);
    return withFileMutationQueue(absolutePath, async () => {
      try {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf-8");
      } catch (error) {
        return err(`could not write ${path}: ${(error as Error).message}`, { path });
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          bytes_written: Buffer.byteLength(content, "utf-8"),
        },
      };
    });
  },
});

// --- mkdir ------------------------------------------------------------------

const mkdirTool = defineTool({
  name: "mkdir",
  description:
    "Create a directory (and any missing parent directories) inside the workspace. Idempotent — succeeds if it already exists. Use this to make folders; the shell `mkdir` is blocked by the workspace-write sandbox.",
  toolKind: "file_change",
  policy: "on-request",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Directory path to create (relative to the workspace, or an absolute path inside it)." },
    },
    required: ["path"],
  },
  async execute(args, context) {
    const path = asString(args.path);
    if (!path) return err("mkdir requires a path");
    const check = canWritePath(path, context);
    if (!check.ok) return err(check.message ?? "mkdir blocked", { code: check.code });
    const { absolutePath, relativePath } = resolveToolPath(path, context.workspace);
    return withFileMutationQueue(absolutePath, async () => {
      try {
        await mkdir(absolutePath, { recursive: true });
      } catch (error) {
        return err(`could not create directory ${path}: ${(error as Error).message}`, { path });
      }
      return { output: { path: absolutePath, relative_path: relativePath, created: true } };
    });
  },
});

// --- edit -------------------------------------------------------------------

/**
 * Build the disjoint edit list from the tool args. The `edits` array of
 * {oldText, newText} takes precedence; when it is empty, fall back to a single
 * top-level oldText/newText (mutually exclusive). Faithful to the original
 * parseEditInstructions.
 */
function parseEditInstructions(args: Record<string, unknown>): EditSpec[] {
  if (Array.isArray(args.edits)) {
    const edits = args.edits
      .map((value): EditSpec | null => {
        if (!value || typeof value !== "object") return null;
        const raw = value as Record<string, unknown>;
        return typeof raw.oldText === "string" && typeof raw.newText === "string"
          ? { oldText: raw.oldText, newText: raw.newText }
          : null;
      })
      .filter((value): value is EditSpec => value !== null);
    if (edits.length > 0) return edits;
  }
  return typeof args.oldText === "string" && typeof args.newText === "string"
    ? [{ oldText: args.oldText, newText: args.newText }]
    : [];
}

const editTool = defineTool({
  name: "edit",
  description: "Edit a workspace file using exact text replacement. Supports multiple disjoint edits in one call.",
  toolKind: "file_change",
  policy: "on-request",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = asString(args.path);
    if (!path) return err("edit requires a path");
    const edits = parseEditInstructions(args);
    if (edits.length === 0) return err("oldText and newText are required");
    const check = canWritePath(path, context);
    if (!check.ok) return err(check.message ?? "edit blocked", { code: check.code });
    const { absolutePath, relativePath } = resolveToolPath(path, context.workspace);
    return withFileMutationQueue(absolutePath, async () => {
      let original: string;
      try {
        original = await readFile(absolutePath, "utf-8");
      } catch (error) {
        return err(`could not read ${path}: ${(error as Error).message}`, { path: absolutePath });
      }
      const result = applyEdits(original, edits, relativePath);
      if (!result.ok || result.content == null) return err(result.error ?? "edit failed", { path: absolutePath });
      try {
        await writeFile(absolutePath, result.content, "utf-8");
      } catch (error) {
        return err(`could not write ${path}: ${(error as Error).message}`, { path: absolutePath });
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          replacements: result.replacements ?? edits.length,
          patch: generateUnifiedPatch(relativePath, original, result.content),
          bytes_written: Buffer.byteLength(result.content, "utf-8"),
          first_changed_line: firstChangedLine(original, result.content) ?? null,
          diff: generateDisplayDiff(original, result.content),
        },
      };
    });
  },
});

// --- bash -------------------------------------------------------------------

// The bash tool is the cooperative-yield session tool (run/poll/write/stop).
// It keeps the same name/toolKind/policy as the legacy one-shot tool.
const bashTool = buildBashSessionTool();

// --- echo (diagnostic) ------------------------------------------------------

const echoTool = defineTool({
  name: "echo",
  description: "Echo text back. Useful as a connectivity check.",
  toolKind: "tool_call",
  policy: "auto",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(args) {
    return { output: { echoed: asString(args.text) ?? "" } };
  },
});

// --- user_input (GUI gate) --------------------------------------------------

function buildUserInputTool(name: string): LocalTool {
  return defineTool({
    name,
    description:
      "Ask the user a question and wait for their answer. Use when you genuinely need a decision or missing information from the user.",
    toolKind: "tool_call",
    policy: "auto",
    shouldAdvertise: (context) => typeof context.awaitUserInput === "function",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "What to ask the user." },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              header: { type: "string" },
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
            },
            required: ["question"],
          },
        },
      },
    },
    async execute(args, context) {
      if (!context.awaitUserInput) return err("user input is not available in this turn");
      const prompt = asString(args.prompt) ?? "";
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      const questions = rawQuestions.map((raw, index) => {
        const q = (raw ?? {}) as Record<string, unknown>;
        const options = Array.isArray(q.options) ? q.options : [];
        return {
          header: asString(q.header) ?? `Question ${index + 1}`,
          id: asString(q.id) ?? `q${index + 1}`,
          question: asString(q.question) ?? prompt,
          options: options.map((opt) =>
            typeof opt === "string"
              ? { label: opt, description: "" }
              : { label: asString((opt as any)?.label) ?? "", description: asString((opt as any)?.description) ?? "" },
          ),
        };
      });
      const resolution = await context.awaitUserInput({
        id: `input_${context.turnId}_${Date.now()}`,
        itemId: `item_input_${context.turnId}_${Date.now()}`,
        threadId: context.threadId,
        turnId: context.turnId,
        prompt: prompt || questions[0]?.question || "Please choose:",
        questions,
      });
      return {
        output: { status: resolution.status, answers: resolution.answers, text: resolution.text },
        isError: resolution.status === "cancelled",
      };
    },
  });
}

// --- exports ----------------------------------------------------------------

export function buildBuiltinLocalTools(): LocalTool[] {
  return [readTool, bashTool, editTool, writeTool, mkdirTool, grepTool, findTool, lsTool];
}

export function buildReadOnlyBuiltinLocalTools(): LocalTool[] {
  return [readTool, grepTool, findTool, lsTool];
}

export function buildDefaultLocalTools(): LocalTool[] {
  return [
    ...buildBuiltinLocalTools(),
    echoTool,
    buildUserInputTool("user_input"),
    buildUserInputTool("request_user_input"),
  ];
}

export { readTool, lsTool, findTool, grepTool, writeTool, mkdirTool, editTool, bashTool, echoTool };
