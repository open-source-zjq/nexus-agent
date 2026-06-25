import { resolve, relative, isAbsolute, sep, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export const DEFAULT_IMAGE_MAX_DIMENSION = 2000;
export const DEFAULT_IMAGE_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

/** External search executable candidates, resolved purely from PATH. */
export const FD_EXECUTABLE_CANDIDATES = ["fd"];
export const RG_EXECUTABLE_CANDIDATES = ["rg"];

/** Resource files that should be flagged as compact context resources when read. */
export const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "__pycache__",
  ".nexus-agent",
]);

export function workspaceRoot(workspace: string): string {
  return resolve(workspace || process.cwd());
}

export interface ResolvedPath {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

/**
 * Map the "/workspace" alias to a workspace-relative path. Returns "." for
 * "/workspace", strips the "/workspace/" prefix otherwise (-> "." when empty),
 * and null when the input is not an alias. Faithful port of the original
 * stripWorkspaceAlias.
 */
function stripWorkspaceAlias(inputPath: string): string | null {
  const normalized = inputPath.replace(/\\/g, "/");
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice("/workspace/".length) || ".";
  }
  return null;
}

/**
 * Resolve a tool path against the workspace root, honoring the "/workspace"
 * alias and rejecting paths that escape the workspace root. Faithful port of
 * the original resolveWorkspacePath.
 */
export function resolveToolPath(raw: string, workspace: string): ResolvedPath {
  const root = workspaceRoot(workspace);
  const aliased = isAbsolute(raw) ? stripWorkspaceAlias(raw) : null;
  const candidate = aliased ?? raw;
  const absolutePath = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const relativePath = relative(root, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`path escapes the workspace root: ${raw}`);
  }
  return { workspaceRoot: root, absolutePath, relativePath: relativePath || "." };
}

export function isInsideWorkspace(absolutePath: string, workspace: string): boolean {
  const root = workspaceRoot(workspace);
  const rel = relative(root, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// --- Truncation -------------------------------------------------------------
// Faithful port of the original truncate.js: head/tail line+byte budgeting with
// UTF-8-safe tail slicing.

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
  /** @deprecated alias of outputLines, kept for older callers. */
  shownLines: number;
}

/** Split into lines for counting, dropping the trailing empty element when the content ends with a newline. */
function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** UTF-8-safe slice of the last `maxBytes` bytes of `text`, snapping forward off a continuation byte. */
export function truncateStringToBytesFromEnd(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf-8");
}

export function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
      shownLines: totalLines,
    };
  }
  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
      shownLines: 0,
    };
  }
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }
  const outputContent = outputLines.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
    shownLines: outputLines.length,
  };
}

export function truncateTail(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
      shownLines: totalLines,
    };
  }
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let index = lines.length - 1; index >= 0 && outputLines.length < maxLines; index -= 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLines.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        outputLines.unshift(partial);
        outputBytes = Buffer.byteLength(partial, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    outputLines.unshift(line);
    outputBytes += lineBytes;
  }
  const outputContent = outputLines.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
    shownLines: outputLines.length,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- Glob -------------------------------------------------------------------

/** Convert a glob (supports **, *, ?) to a RegExp anchored at both ends. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

// --- File walking -----------------------------------------------------------

export interface CollectedFile {
  absolutePath: string;
  relativePath: string;
  isDirectory: boolean;
}

/** Recursively collect files under `dir`, skipping common ignored directories. */
export async function collectFiles(
  dir: string,
  root: string,
  options: { limit?: number; includeDirectories?: boolean } = {},
): Promise<{ files: CollectedFile[]; truncated: boolean }> {
  const limit = options.limit ?? 5000;
  const files: CollectedFile[] = [];
  let truncated = false;

  const walk = async (current: string): Promise<void> => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const abs = resolve(current, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        if (options.includeDirectories) files.push({ absolutePath: abs, relativePath: rel, isDirectory: true });
        await walk(abs);
      } else if (entry.isFile()) {
        files.push({ absolutePath: abs, relativePath: rel, isDirectory: false });
      }
    }
  };
  await walk(dir);
  return { files, truncated };
}

/** Normalize a path for tool output: forward slashes, "." for the root. */
export function normalizeToolPath(p: string): string {
  return (p || ".").split(sep).join("/");
}

/**
 * Recursively collect absolute file (and optionally directory) paths under `dir`,
 * used as the in-process search fallback. Walks ALL directories (no ignore-dir
 * filtering) so matches inside node_modules/.git/dist/etc. are not silently
 * dropped, capping at `limit`. Faithful port of the original collectPaths
 * (breadth-first queue walk, capped at limit).
 */
export async function collectPaths(
  dir: string,
  options: { limit?: number; includeDirectories?: boolean } = {},
): Promise<string[]> {
  const limit = options.limit ?? 5000;
  const results: string[] = [];
  const queue: string[] = [dir];
  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (options.includeDirectories) results.push(next);
        queue.push(next);
      } else {
        results.push(next);
      }
      if (results.length >= limit) break;
    }
  }
  return results;
}

/** Resolve the first usable executable from a candidate list (absolute paths must exist; bare names are accepted as PATH lookups). */
export function resolveExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // Bare command name: defer to the OS PATH resolution at spawn time.
    return candidate;
  }
  return null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Spawn an executable directly (no shell) with an argv array, capturing output.
 * Honors an optional AbortSignal and byte cap. Used for external rg/fd/sips.
 */
export function spawnExec(
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = { cwd: process.cwd() },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: process.env });
    } catch (error) {
      resolvePromise({ stdout: "", stderr: (error as Error).message, exitCode: null, signal: null });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, exitCode, signal });
    };
    const onAbort = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null, "SIGTERM");
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          finish(null, "SIGTERM");
        }, options.timeoutMs)
      : null;

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin?.end();
  });
}

/**
 * Classification for a read target: skill manifests (SKILL.md), compact context
 * resources (AGENTS.md/CLAUDE.md), and documentation (README.md, docs/, examples/).
 * `label` is the parent directory name for skills and a workspace-relative posix
 * path for resources/docs. Returns undefined when the file is none of these.
 */
export interface ReadClassification {
  kind: "skill" | "resource" | "docs";
  label: string;
}

export function getReadClassification(absolutePath: string, workspace: string): ReadClassification | undefined {
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
  }
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return {
      kind: "resource",
      label: normalizeToolPath(relative(workspaceRoot(workspace), absolutePath) || fileName),
    };
  }
  const relativePath = normalizeToolPath(relative(workspaceRoot(workspace), absolutePath));
  if (relativePath === "README.md" || relativePath.startsWith("docs/") || relativePath.startsWith("examples/")) {
    return { kind: "docs", label: relativePath };
  }
  return undefined;
}

export interface ResizedImage {
  dataBase64: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

/**
 * Coordinate-mapping note for a resized image, or "" when unchanged/unknown.
 * Reports the original and displayed dimensions plus the scale factor to map
 * displayed coordinates back to the original. Faithful port of the original
 * formatDimensionNote (which returns undefined; "" is the falsy equivalent here).
 */
export function formatDimensionNote(resized: ResizedImage): string {
  if (!resized.wasResized || !resized.originalWidth || !resized.originalHeight) return "";
  const scale = resized.originalWidth / resized.width;
  return `[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "img";
  }
}

/**
 * Iteratively downscale an image with macOS `sips` until it fits within the
 * dimension and base64-byte budgets. Returns null when sips is unavailable or
 * the image cannot be reduced below the byte limit. Faithful port of the
 * original resizeImageWithSips.
 */
export async function resizeImageWithSips(
  buffer: Buffer,
  mimeType: string,
  options: { maxWidth?: number; maxHeight?: number; maxBytes?: number } = {},
): Promise<ResizedImage | null> {
  const sips = resolveExecutable(["/usr/bin/sips", "sips"]);
  if (!sips) return null;
  const maxWidth = options.maxWidth ?? DEFAULT_IMAGE_MAX_DIMENSION;
  const maxHeight = options.maxHeight ?? DEFAULT_IMAGE_MAX_DIMENSION;
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_MAX_BASE64_BYTES;
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tempDir = await mkdtemp(join(tmpdir(), "nexus-read-image-"));
  const inputPath = join(tempDir, `input.${imageExtension(mimeType)}`);
  const outputPath = join(tempDir, `output.${imageExtension(mimeType)}`);
  try {
    await writeFile(inputPath, buffer);
    const info = await spawnExec(sips, ["-g", "pixelWidth", "-g", "pixelHeight", inputPath], { cwd: tempDir });
    const originalWidth = Number(info.stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
    const originalHeight = Number(info.stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0);
    const originalBase64 = buffer.toString("base64");
    const originalSize = Buffer.byteLength(originalBase64, "utf-8");
    if (
      originalWidth > 0 &&
      originalHeight > 0 &&
      originalWidth <= maxWidth &&
      originalHeight <= maxHeight &&
      originalSize < maxBytes
    ) {
      return {
        dataBase64: originalBase64,
        mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }
    let currentMax = Math.max(maxWidth, maxHeight);
    while (currentMax >= 1) {
      const result = await spawnExec(
        sips,
        ["--resampleHeightWidthMax", String(currentMax), inputPath, "--out", outputPath],
        { cwd: tempDir },
      );
      if (result.exitCode !== 0) return null;
      const resizedBuffer = await readFile(outputPath);
      const resizedBase64 = resizedBuffer.toString("base64");
      const resizedSize = Buffer.byteLength(resizedBase64, "utf-8");
      const detected = detectImageMime(resizedBuffer);
      const resizedInfo = await spawnExec(sips, ["-g", "pixelWidth", "-g", "pixelHeight", outputPath], { cwd: tempDir });
      const resizedWidth = Number(resizedInfo.stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
      const resizedHeight = Number(resizedInfo.stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0);
      if (resizedSize < maxBytes && resizedWidth > 0 && resizedHeight > 0) {
        return {
          dataBase64: resizedBase64,
          mimeType: detected?.mimeType ?? mimeType,
          originalWidth,
          originalHeight,
          width: resizedWidth,
          height: resizedHeight,
          wasResized: resizedWidth !== originalWidth || resizedHeight !== originalHeight,
        };
      }
      currentMax = Math.floor(currentMax * 0.75);
    }
    return null;
  } catch {
    return null;
  } finally {
    await rmDir(tempDir);
  }
}

async function rmDir(dir: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

/**
 * Detected image header info: a recognized MIME type plus optional pixel
 * dimensions when they can be read directly from the header. Faithful to the
 * original `detectImageMimeType` ({ mimeType, width?, height? }).
 */
export interface DetectedImageMime {
  mimeType: string;
  width?: number;
  height?: number;
}

/**
 * Magic-byte image sniffing returning { mimeType, width?, height? }. PNG yields
 * dimensions from the IHDR chunk (bytes 16-23); JPEG scans SOF markers (0xC0-0xC3)
 * for height/width; GIF reads little-endian dims at bytes 6-9; WEBP reads VP8X
 * dims when present. Faithful port of the original `detectImageMimeType` so the
 * read tool can emit detected width/height.
 */
export function detectImageMime(buffer: Buffer): DetectedImageMime | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.length >= 24) {
      return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    return { mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && size >= 7) {
        return {
          mimeType: "image/jpeg",
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + size;
    }
    return { mimeType: "image/jpeg" };
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      if (buffer.length >= 10) {
        return { mimeType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      }
      return { mimeType: "image/gif" };
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    if (buffer.length >= 30 && buffer.subarray(12, 16).toString("ascii") === "VP8X") {
      return { mimeType: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    return { mimeType: "image/webp" };
  }
  return null;
}

// --- Subprocess -------------------------------------------------------------

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export function spawnCapture(
  command: string,
  options: { cwd: string; signal: AbortSignal; timeoutMs: number; input?: string; shell?: boolean; maxBytes?: number },
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : (process.env.SHELL || "/bin/sh");
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: process.env,
      // detached so we can kill the whole process group on unix
      detached: !isWindows,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, exitCode, signal, timedOut });
    };

    const killTree = (): void => {
      try {
        if (isWindows) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    const onAbort = (): void => {
      killTree();
      finish(null, "SIGTERM");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish(null, "SIGTERM");
    }, options.timeoutMs);

    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (options.input != null) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

export const PATH_SEP = sep;
