import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat as fsStat } from "node:fs/promises";
import { resolve, isAbsolute, relative, basename, extname, sep, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Max lines returned by {@link LocalWorkspaceInspector.retrieve}. */
const FILE_RETRIEVE_MAX_LINES = 20_000;

/** A path-validated workspace file read for the preview panel (/v1/files/retrieve). */
export interface FileRetrieval {
  path: string;
  absolutePath: string;
  size: number;
  language: string;
  lineCount: number;
  truncated: boolean;
  content: string;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", scss: "scss", html: "html", py: "python", rs: "rust",
  go: "go", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp", rb: "ruby", php: "php",
  sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", swift: "swift",
  kt: "kotlin", lua: "lua", xml: "xml", vue: "vue", svelte: "svelte",
};

function languageFromExt(ext: string): string {
  return LANGUAGE_BY_EXT[ext.replace(/^\./, "").toLowerCase()] ?? "text";
}

/** Hard cap on how long any single git invocation may run. */
const GIT_TIMEOUT_MS = 5_000;
/** Cap captured stdout/stderr so a pathological repo cannot exhaust memory. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface WorkspaceChangedFile {
  /** Repo-relative path as reported by git (rename target when status is "R"). */
  path: string;
  /** Two-character porcelain status code, e.g. " M", "??", "A ", "R ". */
  status: string;
}

export interface WorkspaceInspection {
  /** True when the workspace resolves inside a git work tree. */
  isGitRepo: boolean;
  /** Current branch name, or undefined when detached / unknown. */
  branch?: string;
  /** Number of changed entries (working tree + index + untracked). */
  dirtyCount: number;
  /** Parsed porcelain entries. Empty for a non-git or clean workspace. */
  changedFiles: WorkspaceChangedFile[];
  /** Commits ahead of the upstream, when an upstream is configured. */
  ahead?: number;
  /** Commits behind the upstream, when an upstream is configured. */
  behind?: number;
}

const CLEAN_NON_GIT: WorkspaceInspection = {
  isGitRepo: false,
  dirtyCount: 0,
  changedFiles: [],
};

/**
 * Canonical workspace-status response shape consumed by the GET
 * /v1/workspace/status route. Faithful to the original
 * `LocalWorkspaceInspector.status()` contract: a flat record keyed off the
 * resolved workspace `path` (the route emits this object verbatim).
 */
export interface WorkspaceStatus {
  path: string;
  exists: boolean;
  isGitRepository: boolean;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean | null;
  fileChangeCount: number | null;
  checkedAt: string;
  /**
   * Parsed `git status --porcelain` entries for the workspace. Empty for a
   * non-git or clean workspace. Surfaced additively so the Change Inspector UI
   * can render the real changed-file list (the inspector already computes these
   * via {@link LocalWorkspaceInspector.inspect}).
   */
  changedFiles: WorkspaceChangedFile[];
}

/**
 * Unified diff for a single working-tree file, consumed by the GET
 * /v1/workspace/diff route and rendered by the Change Inspector's DiffViewer
 * pane. `diff` is the raw `git diff` text (empty when there is no change);
 * `untracked` marks a brand-new file rendered against /dev/null; `binary` marks
 * a non-text change git could not diff line-by-line.
 */
export interface WorkspaceFileDiff {
  /** Repo-relative path that was diffed. */
  file: string;
  /** Raw unified diff text (`git diff`), or empty when there is no change. */
  diff: string;
  /** Added line count (diff body `+` lines, excluding the `+++` header). */
  added: number;
  /** Removed line count (diff body `-` lines, excluding the `---` header). */
  removed: number;
  /** True when the file is untracked (diffed against /dev/null as all-added). */
  untracked: boolean;
  /** True when git reported a binary change (no line-level diff available). */
  binary: boolean;
}

/**
 * Inspects a workspace directory for git status without ever throwing.
 *
 * Every git invocation runs via execFile with an explicit argument array (no
 * shell), a timeout, and a bounded output buffer. A directory that is not a git
 * repository - or any failure along the way - yields a clean, non-git result.
 */
export class LocalWorkspaceInspector {
  /**
   * Canonical workspace status for a resolved `path`. Faithful to the original
   * `LocalWorkspaceInspector.status()`: resolves git membership, branch, head
   * sha, dirtiness, and changed-file count into the flat
   * {@link WorkspaceStatus} record the route emits. Never throws.
   */
  async status(path: string): Promise<WorkspaceStatus> {
    const checkedAt = new Date().toISOString();
    const exists = typeof path === "string" && path.trim() !== "" && existsSync(path);
    if (!exists) {
      return {
        path,
        exists: false,
        isGitRepository: false,
        branch: null,
        headSha: null,
        isDirty: null,
        fileChangeCount: null,
        checkedAt,
        changedFiles: [],
      };
    }
    const inspection = await this.inspect(path);
    if (!inspection.isGitRepo) {
      return {
        path,
        exists: true,
        isGitRepository: false,
        branch: null,
        headSha: null,
        isDirty: null,
        fileChangeCount: null,
        checkedAt,
        changedFiles: [],
      };
    }
    const headSha = await this.headSha(path);
    return {
      path,
      exists: true,
      isGitRepository: true,
      branch: inspection.branch ?? null,
      headSha,
      isDirty: inspection.dirtyCount > 0,
      fileChangeCount: inspection.dirtyCount,
      checkedAt,
      changedFiles: inspection.changedFiles,
    };
  }

  /**
   * Unified diff for a single repo-relative `file` in `workspace`. Returns the
   * combined working-tree-vs-HEAD diff for a tracked file (covers both staged
   * and unstaged hunks), falling back to a `--no-index` diff against /dev/null
   * for an untracked file so a brand-new file shows as all-added. Never throws:
   * a non-repo / missing file / git failure yields an empty diff.
   */
  /**
   * Crawl the workspace for file paths (relative), for the composer's `@`
   * file-reference autocomplete. Bounded by maxDepth (6) and maxFiles (1200);
   * skips heavy/vendored dirs. Faithful to the original crawl limits.
   */
  async listFiles(workspace: string, maxDepth = 6, maxFiles = 1200): Promise<string[]> {
    const root = resolve(workspace || ".");
    const skip = new Set([
      "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache",
      "target", ".venv", "venv", "__pycache__", ".idea", ".vscode", "coverage",
    ]);
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= maxFiles || depth > maxDepth) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= maxFiles) return;
        if (entry.name.startsWith(".") && entry.name !== ".env.example") {
          if (entry.isDirectory()) continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          await walk(abs, depth + 1);
        } else if (entry.isFile()) {
          out.push(relative(root, abs));
        }
      }
    };
    await walk(root, 0).catch(() => undefined);
    return out.sort();
  }

  /**
   * Read a workspace file's content for the preview panel, validated to live
   * inside the workspace root (rejects path traversal / out-of-tree absolutes).
   * Truncates to {@link FILE_RETRIEVE_MAX_LINES} lines.
   */
  async retrieve(workspace: string, file: string): Promise<FileRetrieval> {
    const root = resolve(workspace || ".");
    const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("file is outside the workspace");
    }
    const stats = await fsStat(abs);
    if (!stats.isFile()) throw new Error("not a file");
    const raw = await readFile(abs, "utf8");
    const lines = raw.split("\n");
    const truncated = lines.length > FILE_RETRIEVE_MAX_LINES;
    const content = truncated ? lines.slice(0, FILE_RETRIEVE_MAX_LINES).join("\n") : raw;
    return {
      path: relative(root, abs) || basename(abs),
      absolutePath: abs,
      size: stats.size,
      language: languageFromExt(extname(abs)),
      lineCount: lines.length,
      truncated,
      content,
    };
  }

  async diff(workspace: string, file: string): Promise<WorkspaceFileDiff> {
    const empty: WorkspaceFileDiff = { file, diff: "", added: 0, removed: 0, untracked: false, binary: false };
    if (typeof workspace !== "string" || workspace.trim() === "") return empty;
    if (typeof file !== "string" || file.trim() === "") return empty;
    if (!existsSync(workspace)) return empty;
    if (!(await this.isInsideWorkTree(workspace))) return empty;

    // Tracked changes (staged + unstaged) against HEAD. `--` guards the path so a
    // file that looks like a revision is never misinterpreted.
    let text = await this.diffText(workspace, ["diff", "HEAD", "--", file]);
    let untracked = false;
    if (text.trim() === "") {
      // No tracked diff — maybe an untracked file. Diff it against /dev/null so
      // its full contents render as additions (git diff --no-index exits 1).
      const added = await this.diffText(workspace, ["diff", "--no-index", "--", "/dev/null", file]);
      if (added.trim() !== "") {
        text = added;
        untracked = true;
      }
    }
    const binary = /^Binary files /m.test(text) || /^GIT binary patch/m.test(text);
    const { added, removed } = countDiffLines(text);
    return { file, diff: text, added, removed, untracked, binary };
  }

  /**
   * Run `git diff …` capturing stdout even on a non-zero exit. `git diff
   * --no-index` (and `--exit-code`) exit 1 when the files differ while still
   * writing the diff to stdout, so — unlike {@link git} — we recover stdout from
   * the thrown error instead of treating it as a failure. Never throws.
   */
  private async diffText(workspace: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspace,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf-8",
      });
      return stdout ?? "";
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      return typeof stdout === "string" ? stdout : "";
    }
  }

  /** Resolve the current HEAD commit sha, or null when unavailable. */
  private async headSha(workspace: string): Promise<string | null> {
    const out = await this.git(workspace, ["rev-parse", "HEAD"]);
    if (out === null) return null;
    const sha = out.trim();
    return sha === "" ? null : sha;
  }

  async inspect(workspace: string): Promise<WorkspaceInspection> {
    if (typeof workspace !== "string" || workspace.trim() === "") {
      return { ...CLEAN_NON_GIT, changedFiles: [] };
    }

    const isGitRepo = await this.isInsideWorkTree(workspace);
    if (!isGitRepo) {
      return { ...CLEAN_NON_GIT, changedFiles: [] };
    }

    const [branch, statusEntries, tracking] = await Promise.all([
      this.currentBranch(workspace),
      this.changedFiles(workspace),
      this.aheadBehind(workspace),
    ]);

    const result: WorkspaceInspection = {
      isGitRepo: true,
      dirtyCount: statusEntries.length,
      changedFiles: statusEntries,
    };
    if (branch !== undefined) result.branch = branch;
    if (tracking?.ahead !== undefined) result.ahead = tracking.ahead;
    if (tracking?.behind !== undefined) result.behind = tracking.behind;
    return result;
  }

  /** Resolve `true` when the workspace sits inside a git work tree. */
  private async isInsideWorkTree(workspace: string): Promise<boolean> {
    const out = await this.git(workspace, ["rev-parse", "--is-inside-work-tree"]);
    return out !== null && out.trim() === "true";
  }

  /** Current branch name, or undefined when detached / unavailable. */
  private async currentBranch(workspace: string): Promise<string | undefined> {
    const out = await this.git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (out === null) return undefined;
    const branch = out.trim();
    if (branch === "" || branch === "HEAD") return undefined;
    return branch;
  }

  /** Parse `git status --porcelain` into changed-file entries. */
  private async changedFiles(workspace: string): Promise<WorkspaceChangedFile[]> {
    const out = await this.git(workspace, ["status", "--porcelain", "--untracked-files=all"]);
    if (out === null) return [];
    return parsePorcelain(out);
  }

  /** Ahead/behind counts relative to the configured upstream, if any. */
  private async aheadBehind(workspace: string): Promise<{ ahead?: number; behind?: number } | null> {
    const out = await this.git(workspace, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    if (out === null) return null;
    // Output is "<behind>\t<ahead>" (left = upstream-only, right = HEAD-only).
    const parts = out.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const behind = Number.parseInt(parts[0], 10);
    const ahead = Number.parseInt(parts[1], 10);
    const result: { ahead?: number; behind?: number } = {};
    if (Number.isFinite(behind)) result.behind = behind;
    if (Number.isFinite(ahead)) result.ahead = ahead;
    return result;
  }

  /**
   * Run a single git command. Returns stdout on success, or null when git is
   * absent, the directory is not a repo, the command times out, or it exits
   * non-zero. Never throws.
   */
  private async git(workspace: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspace,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf-8",
      });
      return stdout;
    } catch {
      return null;
    }
  }
}

/**
 * Count added/removed lines in a unified diff body. Excludes the `+++`/`---`
 * file headers and the `@@` hunk headers so the counts reflect real content.
 */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Parse porcelain v1 output. Each line is `XY<space>path`, where XY is the
 * two-character status code. Rename/copy entries are `XY orig -> dest`; we keep
 * the destination path.
 */
function parsePorcelain(stdout: string): WorkspaceChangedFile[] {
  const entries: WorkspaceChangedFile[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) {
      path = path.slice(arrow + 4);
    }
    path = unquotePath(path);
    if (path === "") continue;
    entries.push({ path, status });
  }
  return entries;
}

/**
 * Git quotes paths containing special characters with surrounding double quotes
 * and C-style escapes. Undo that so callers see the literal path.
 */
function unquotePath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') {
    return path;
  }
  const inner = path.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    i += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      default:
        out += next ?? "";
        break;
    }
  }
  return out;
}
