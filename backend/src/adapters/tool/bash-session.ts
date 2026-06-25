import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalTool, ToolContext, ToolResult, ToolUpdate } from "./types.js";
import { defineTool } from "./types.js";
import { workspaceRoot, truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "./util.js";

// --- constants --------------------------------------------------------------

const DEFAULT_BASH_YIELD_SECONDS = 10;
const MAX_BASH_YIELD_SECONDS = 60;
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
/** Brief grace after a kill to let buffered output flush before finalizing. */
const SESSION_EXIT_FLUSH_MS = 50;
/** How long to wait for a process tree to die after a stop request. */
const STOP_GRACE_MS = 1000;
/** Keep finished sessions around ~10 minutes so the model can still poll them. */
const FINISHED_SESSION_RETENTION_MS = 10 * 60 * 1000;

type SessionStatus = "running" | "completed" | "failed" | "stopped";

interface BashSession {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  child: ChildProcess;
  /** Streaming accumulator: encoding-aware, temp-file-spilled, tail-truncating. */
  output: OutputAccumulator;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  status: SessionStatus;
  stopRequested: boolean;
  finalized: boolean;
  error?: string;
  /** Resolvers woken when the process exits. */
  exitWaiters: Set<() => void>;
}

// --- shell detection --------------------------------------------------------
// Faithful port of shellConfig/shellRuntimeInfo/shellCommandArgs. Prefer a
// login bash on unix; prefer pwsh/powershell (UTF-8 via -EncodedCommand) on
// win32; fall back to cmd.exe / sh.

/**
 * PowerShell preamble forcing UTF-8 console encoding so the spawned shell's
 * stdout/stderr are decoded correctly by the OutputAccumulator. Sent as the
 * head of the -EncodedCommand payload.
 */
const POWERSHELL_UTF8_OUTPUT_PREAMBLE = [
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = $OutputEncoding",
  "try { [Console]::InputEncoding = $OutputEncoding } catch {}",
].join("; ");

interface ShellConfig {
  shell: string;
  args: string[];
}

export interface ShellRuntime extends ShellConfig {
  name: string;
  syntax: string;
}

/** First non-empty trimmed stdout line of a synchronous lookup (where/which), or "". */
function firstLookupResult(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ""
    : "";
}

/**
 * Select the host shell. On win32 prefer pwsh, then powershell (both invoked
 * with -Command, later rewritten to -EncodedCommand), then bash, then cmd.exe.
 * On unix prefer /bin/bash -lc, else `which bash` -lc, else sh -lc.
 */
function shellConfig(platform: NodeJS.Platform = process.platform): ShellConfig {
  if (platform === "win32") {
    const pwsh = firstLookupResult("where", ["pwsh.exe"]);
    if (pwsh) {
      return { shell: pwsh, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"] };
    }
    const powershell = firstLookupResult("where", ["powershell.exe"]);
    if (powershell) {
      return { shell: powershell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"] };
    }
    const bash = firstLookupResult("where", ["bash.exe"]);
    if (bash) return { shell: bash, args: ["-lc"] };
    return { shell: "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-lc"] };
  const candidate = firstLookupResult("which", ["bash"]);
  if (candidate) return { shell: candidate, args: ["-lc"] };
  return { shell: "sh", args: ["-lc"] };
}

/** Strip the directory and a trailing ".exe" (keeping "cmd.exe" intact) and lowercase. */
function shellDisplayName(shell: string): string {
  const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? shell.toLowerCase();
  if (name === "cmd.exe") return "cmd.exe";
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

/** Human-readable syntax hint embedded in the tool description for the detected shell. */
function shellSyntaxHint(name: string): string {
  switch (name) {
    case "bash":
    case "sh":
    case "zsh":
      return "POSIX shell";
    case "pwsh":
    case "powershell":
      return "PowerShell";
    case "cmd.exe":
      return "cmd.exe batch";
    default:
      return `${name} shell`;
  }
}

export function shellRuntimeInfo(config: ShellConfig = shellConfig()): ShellRuntime {
  const name = shellDisplayName(config.shell);
  return { ...config, name, syntax: shellSyntaxHint(name) };
}

/**
 * Build the argv for the detected shell. For pwsh/powershell the command is
 * UTF-16LE base64-encoded (-EncodedCommand) with a UTF-8 output preamble so
 * non-ASCII output round-trips; every other shell receives the command as a
 * trailing argument (e.g. `-lc <command>`, `/d /s /c <command>`).
 */
export function shellCommandArgs(config: ShellConfig, command: string): string[] {
  const name = shellDisplayName(config.shell);
  if (name === "pwsh" || name === "powershell") {
    const baseArgs = config.args.filter((arg) => arg.toLowerCase() !== "-command");
    const encodedCommand = Buffer.from(`${POWERSHELL_UTF8_OUTPUT_PREAMBLE}\n${command}`, "utf16le").toString(
      "base64",
    );
    return [...baseArgs, "-EncodedCommand", encodedCommand];
  }
  return [...config.args, command];
}

function nextSessionId(): string {
  return `bash_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Process-tree kill: SIGKILL the whole group on unix, taskkill /T on win32. */
function terminateSpawnTree(child: ChildProcess): void {
  const isWindows = process.platform === "win32";
  try {
    if (isWindows) {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
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
}

// --- streaming output accumulator -------------------------------------------
// Faithful port of the source OutputAccumulator: encoding detection
// (UTF-8 / UTF-16LE BOM + heuristic), a rolling tail window for snapshots, full
// line/byte counting against the TRUE totals, and a temp-file spill of the
// complete raw output exposed as full_output_path. The temp-file spill is what
// lets the truncation notice report TRUE totals (resolving the H2 caveat) rather
// than just the rolling-window total.

function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function startsWithUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function startsWithUtf16LeBom(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
}

interface TextStats {
  total: number;
  ascii: number;
  han: number;
  privateUse: number;
  replacement: number;
  control: number;
}

function isHanCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ebef)
  );
}

function isPrivateUseCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

function textStats(text: string): TextStats {
  const stats: TextStats = { total: 0, ascii: 0, han: 0, privateUse: 0, replacement: 0, control: 0 };
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    stats.total += 1;
    if (codePoint <= 127) stats.ascii += 1;
    if (isHanCodePoint(codePoint)) stats.han += 1;
    if (isPrivateUseCodePoint(codePoint)) stats.privateUse += 1;
    if (codePoint === 0xfffd) stats.replacement += 1;
    if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) {
      stats.control += 1;
    }
  }
  return stats;
}

/**
 * Heuristic for UTF-16LE Han text whose bytes contain no NUL (e.g. CJK output
 * that lacks the high-byte zeros usually used to detect UTF-16). Compares
 * UTF-16LE vs UTF-8 decodings and accepts UTF-16LE only when it is clean,
 * Han-dominant text and the UTF-8 reading is clearly worse.
 */
function looksLikeHanUtf16LeWithoutNuls(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer.length % 2 !== 0 || buffer.includes(0)) return false;
  const utf16Text = new TextDecoder("utf-16le").decode(buffer);
  const utf8Text = new TextDecoder("utf-8").decode(buffer);
  const utf16 = textStats(utf16Text);
  const utf8 = textStats(utf8Text);
  if (utf16.total === 0 || utf16.han < 2) return false;
  if (utf16.replacement > 0 || utf16.control > 0 || utf16.privateUse > 0) return false;
  if (utf16.han / utf16.total < 0.6) return false;
  if (utf8.replacement > 0) return true;
  if (utf8.han > 0) return false;
  return utf8.ascii > 0 && utf8.ascii < utf8.total;
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let pairs = 0;
  let oddNuls = 0;
  let evenNuls = 0;
  for (let index = 0; index + 1 < sample.length; index += 2) {
    pairs += 1;
    if (sample[index] === 0) evenNuls += 1;
    if (sample[index + 1] === 0) oddNuls += 1;
  }
  if (pairs < 2) return false;
  if (oddNuls / pairs >= 0.45 && oddNuls > evenNuls * 2) return true;
  return looksLikeHanUtf16LeWithoutNuls(sample);
}

/**
 * Decide the decoding for the buffered bytes: UTF-16LE when a BOM or the
 * heuristic indicates it, UTF-8 on a UTF-8 BOM, and otherwise UTF-8 once at
 * least 32 bytes have arrived (or on the final flush). Returns null while too
 * few bytes are available to decide.
 */
function chooseOutputEncoding(buffer: Buffer, final: boolean): "utf-8" | "utf-16le" | null {
  if (startsWithUtf16LeBom(buffer) || looksLikeUtf16Le(buffer)) return "utf-16le";
  if (startsWithUtf8Bom(buffer)) return "utf-8";
  if (buffer.length >= 32 || final) return "utf-8";
  return null;
}

function stripKnownBom(buffer: Buffer, encoding: "utf-8" | "utf-16le"): Buffer {
  if (encoding === "utf-16le" && startsWithUtf16LeBom(buffer)) return buffer.subarray(2);
  if (encoding === "utf-8" && startsWithUtf8Bom(buffer)) return buffer.subarray(3);
  return buffer;
}

export interface AccumulatorSnapshot {
  content: string;
  truncation: {
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
  };
  fullOutputPath: string | undefined;
}

export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private decoder: InstanceType<typeof TextDecoder> | undefined;
  private decodeBuffer = Buffer.alloc(0);
  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: { maxLines: number; maxBytes: number; tempFilePrefix: string }) {
    this.maxLines = options.maxLines;
    this.maxBytes = options.maxBytes;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix;
  }

  append(data: Buffer): void {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");
    this.totalRawBytes += data.length;
    this.appendDecodedBytes(data, false);
    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedBytes(Buffer.alloc(0), true);
    if (this.decoder) {
      this.appendDecodedText(this.decoder.decode());
    }
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): AccumulatorSnapshot {
    const pendingPreview = this.pendingDecodePreview();
    const snapshotText = this.getSnapshotText(pendingPreview);
    const totalDecodedBytes = this.totalDecodedBytes + byteLength(pendingPreview);
    const totalLines = this.totalLinesAfterPreview(pendingPreview);
    const tailTruncation = truncateTail(snapshotText, { maxLines: this.maxLines, maxBytes: this.maxBytes });
    const truncated = totalLines > this.maxLines || totalDecodedBytes > this.maxBytes;
    const truncation = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated
        ? tailTruncation.truncatedBy ?? (totalDecodedBytes > this.maxBytes ? ("bytes" as const) : ("lines" as const))
        : null,
      totalLines,
      totalBytes: totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return;
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = (): void => {
        stream.off("error", onError);
        resolvePromise();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();
    let newlines = 0;
    let lastNewline = -1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      newlines += 1;
      lastNewline = index;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private appendDecodedBytes(data: Buffer, final: boolean): void {
    if (!this.decoder) {
      if (data.length > 0) this.decodeBuffer = Buffer.concat([this.decodeBuffer, data]);
      const encoding = chooseOutputEncoding(this.decodeBuffer, final);
      if (!encoding) return;
      this.decoder = new TextDecoder(encoding);
      const buffered = stripKnownBom(this.decodeBuffer, encoding);
      this.decodeBuffer = Buffer.alloc(0);
      this.appendDecodedText(this.decoder.decode(buffered, { stream: !final }));
      return;
    }
    if (data.length > 0) {
      this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    }
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start += 1;
    }
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 10;
    this.tailText = buffer.subarray(start).toString("utf8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(pendingPreview = ""): string {
    const text = this.tailText + pendingPreview;
    if (this.tailStartsAtLineBoundary) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  }

  private pendingDecodePreview(): string {
    if (this.decoder || this.decodeBuffer.length === 0) return "";
    if (startsWithUtf16LeBom(this.decodeBuffer) || looksLikeUtf16Le(this.decodeBuffer)) {
      return new TextDecoder("utf-16le").decode(stripKnownBom(this.decodeBuffer, "utf-16le"));
    }
    return new TextDecoder("utf-8").decode(this.decodeBuffer);
  }

  private totalLinesAfterPreview(pendingPreview: string): number {
    if (!pendingPreview) return this.totalLines;
    let newlines = 0;
    let lastNewline = -1;
    for (let index = pendingPreview.indexOf("\n"); index !== -1; index = pendingPreview.indexOf("\n", index + 1)) {
      newlines += 1;
      lastNewline = index;
    }
    if (newlines === 0) {
      return this.completedLines + (this.hasOpenLine || pendingPreview.length > 0 ? 1 : 0);
    }
    const tail = pendingPreview.slice(lastNewline + 1);
    return this.completedLines + newlines + (tail.length > 0 ? 1 : 0);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    );
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}

function createOutputAccumulator(): OutputAccumulator {
  return new OutputAccumulator({
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    tempFilePrefix: "nexus-bash",
  });
}

// --- truncation notice ------------------------------------------------------

interface TextSlice {
  text: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  totalBytes: number;
  shownBytes: number;
  firstLineExceedsLimit: boolean;
  truncatedBy?: "lines" | "bytes" | null;
  lastLinePartial: boolean;
}

function textSliceFromSnapshot(snapshot: AccumulatorSnapshot): TextSlice {
  return {
    text: snapshot.content,
    truncated: snapshot.truncation.truncated,
    totalLines: snapshot.truncation.totalLines,
    shownLines: snapshot.truncation.outputLines,
    totalBytes: snapshot.truncation.totalBytes,
    shownBytes: snapshot.truncation.outputBytes,
    firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
    truncatedBy: snapshot.truncation.truncatedBy ?? undefined,
    lastLinePartial: snapshot.truncation.lastLinePartial,
  };
}

function truncationPayload(truncated: TextSlice): Record<string, unknown> | null {
  return truncated.truncated
    ? {
        total_lines: truncated.totalLines,
        output_lines: truncated.shownLines,
        total_bytes: truncated.totalBytes,
        output_bytes: truncated.shownBytes,
        truncated_by: truncated.truncatedBy ?? null,
        last_line_partial: truncated.lastLinePartial === true,
      }
    : null;
}

/**
 * Append a visible truncation notice to the LLM-facing output, faithful to the
 * source `appendTruncationNotice(text, truncated, mode)`. `mode` is "tail" for
 * bash output (describeKind("tail") === "last"). The line/byte totals now
 * reflect the TRUE counts from the accumulator, not just the rolling window.
 */
function appendTruncationNotice(text: string, truncated: TextSlice, mode: "head" | "tail"): string {
  if (!truncated.truncated) return text;
  const prefix = text.trimEnd();
  const describeKind = mode === "head" ? "first" : "last";
  const notice = truncated.firstLineExceedsLimit
    ? `[first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}; refine the read range or use bash for a byte-limited slice]`
    : `[truncated: showing ${describeKind} ${truncated.shownLines} of ${truncated.totalLines} lines, ${truncated.shownBytes} of ${truncated.totalBytes} bytes]`;
  return prefix ? `${prefix}\n\n${notice}` : notice;
}

// --- session lifecycle ------------------------------------------------------

function scheduleSessionCleanup(session: BashSession): void {
  const timer = setTimeout(() => {
    if (session.status !== "running") bashSessions.delete(session.id);
  }, FINISHED_SESSION_RETENTION_MS);
  timer.unref?.();
}

function settleSession(
  session: BashSession,
  status: SessionStatus,
  exitCode: number | null,
  error?: string,
): void {
  if (session.status !== "running") return;
  session.status = status;
  session.exitCode = exitCode;
  session.finishedAt = new Date().toISOString();
  if (error) session.error = error;
  for (const waiter of session.exitWaiters) waiter();
  session.exitWaiters.clear();
  scheduleSessionCleanup(session);
}

/** Resolve true if the process exits within `ms`, false if the delay elapses first. */
function waitForSessionExitOrDelay(session: BashSession, ms: number): Promise<boolean> {
  if (session.status !== "running") return Promise.resolve(true);
  return new Promise((res) => {
    const onExit = (): void => {
      clearTimeout(timer);
      res(true);
    };
    const timer = setTimeout(() => {
      session.exitWaiters.delete(onExit);
      res(false);
    }, Math.max(0, ms));
    session.exitWaiters.add(onExit);
  });
}

function stopSession(session: BashSession): void {
  if (session.status !== "running") return;
  session.stopRequested = true;
  terminateSpawnTree(session.child);
}

async function finalizeSessionOutput(session: BashSession): Promise<void> {
  if (session.finalized) return;
  await sleep(SESSION_EXIT_FLUSH_MS);
  session.output.finish();
  await session.output.closeTempFile();
  session.finalized = true;
}

// --- module-level session manager -------------------------------------------

const bashSessions = new Map<string, BashSession>();

// --- payloads ---------------------------------------------------------------

interface SessionPayloadOptions {
  stopSent?: boolean;
}

async function sessionPayload(
  session: BashSession,
  options: SessionPayloadOptions = {},
): Promise<Record<string, unknown>> {
  if (session.status !== "running") {
    await finalizeSessionOutput(session);
  }
  const snap = session.output.snapshot({ persistIfTruncated: true });
  const truncated = textSliceFromSnapshot(snap);
  return {
    command: session.command,
    cwd: session.cwd,
    shell: session.shell,
    exit_code: session.exitCode,
    output: appendTruncationNotice(snap.content, truncated, "tail"),
    full_output_path: snap.fullOutputPath ?? null,
    truncation: truncationPayload(truncated),
    session_id: session.id,
    status: session.status,
    started_at: session.startedAt,
    ...(session.finishedAt ? { finished_at: session.finishedAt } : {}),
    ...(typeof session.child.pid === "number" ? { pid: session.child.pid } : {}),
    ...(session.status === "running" ? { partial: true } : { partial: false }),
    ...(options.stopSent ? { stop_sent: true } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function normalizeYieldSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  const raw = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BASH_YIELD_SECONDS;
  return Math.max(1, Math.min(MAX_BASH_YIELD_SECONDS, raw));
}

function normalizeTimeoutSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BASH_TIMEOUT_SECONDS;
}

function sessionById(sessionId: unknown): BashSession | null {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  return id ? bashSessions.get(id) ?? null : null;
}

// --- run: spawn + cooperative yield -----------------------------------------

interface StartInput {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSeconds: number;
  yieldSeconds: number;
}

async function startBashSession(
  input: StartInput,
  onUpdate?: ToolUpdate,
): Promise<{ payload: Record<string, unknown>; isError?: boolean }> {
  await mkdir(input.cwd, { recursive: true });
  const shellRuntime = shellRuntimeInfo();
  const child = spawn(shellRuntime.shell, shellCommandArgs(shellRuntime, input.command), {
    cwd: input.cwd,
    env: process.env,
    // detached so we can kill the whole process group on unix
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const session: BashSession = {
    id: nextSessionId(),
    command: input.command,
    cwd: input.cwd,
    shell: shellRuntime.name,
    child,
    output: createOutputAccumulator(),
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    exitCode: null,
    status: "running",
    stopRequested: false,
    finalized: false,
    exitWaiters: new Set(),
  };
  bashSessions.set(session.id, session);

  // Throttled live updates while running.
  let liveUpdates = true;
  let updateDirty = false;
  let updateTimer: NodeJS.Timeout | undefined;
  let lastUpdateAt = 0;
  const emitUpdate = async (): Promise<void> => {
    if (!liveUpdates || !onUpdate || !updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    onUpdate({ output: await sessionPayload(session) });
  };
  const scheduleUpdate = (): void => {
    if (!liveUpdates || !onUpdate) return;
    updateDirty = true;
    const delay = 100 - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      void emitUpdate();
      return;
    }
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      void emitUpdate();
    }, delay);
  };

  const handleData = (chunk: Buffer): void => {
    if (session.finalized) return;
    session.output.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    scheduleUpdate();
  };
  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);
  child.once("error", (error: Error) => {
    settleSession(session, "failed", null, error.message);
  });
  child.once("exit", (code) => {
    settleSession(session, session.stopRequested ? "stopped" : "completed", code);
  });

  const onAbort = (): void => stopSession(session);
  input.signal.addEventListener("abort", onAbort, { once: true });

  const timeoutMs = input.timeoutSeconds * 1000;
  const yieldMs = Math.min(input.yieldSeconds * 1000, timeoutMs);
  const exited = await waitForSessionExitOrDelay(session, yieldMs);
  input.signal.removeEventListener("abort", onAbort);
  if (updateTimer) clearTimeout(updateTimer);

  if (input.signal.aborted) {
    liveUpdates = false;
    stopSession(session);
    await waitForSessionExitOrDelay(session, STOP_GRACE_MS);
    return { payload: await sessionPayload(session, { stopSent: true }), isError: true };
  }

  // Hard timeout: yield window covers (or exceeds) the timeout and we still didn't exit.
  if (!exited && timeoutMs <= yieldMs) {
    liveUpdates = false;
    stopSession(session);
    await waitForSessionExitOrDelay(session, STOP_GRACE_MS);
    const payload = await sessionPayload(session, { stopSent: true });
    payload.timed_out = true;
    payload.error = `command timed out after ${input.timeoutSeconds} seconds`;
    return { payload, isError: true };
  }

  if (exited) {
    await emitUpdate();
    liveUpdates = false;
    const payload = await sessionPayload(session);
    payload.timed_out = false;
    if (session.status === "failed") return { payload, isError: true };
    return { payload, isError: session.exitCode !== null && session.exitCode !== 0 };
  }

  // Still running: hand back a session_id so the caller can poll/write/stop.
  await emitUpdate();
  liveUpdates = false;
  return { payload: await sessionPayload(session) };
}

// --- tool -------------------------------------------------------------------

function err(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { output: { error: message, ...extra }, isError: true };
}

export function buildBashSessionTool(): LocalTool {
  const shellRuntime = shellRuntimeInfo();
  return defineTool({
    name: "bash",
    description:
      `Run a shell command in the workspace using the host platform shell. Current shell: ${shellRuntime.name}. Use ${shellRuntime.syntax} syntax. ` +
      `Returns combined stdout/stderr and the exit code. ` +
      `A short command completes inline. A command still running after yield_seconds (default ${DEFAULT_BASH_YIELD_SECONDS}s, max ${MAX_BASH_YIELD_SECONDS}s) ` +
      `returns a session_id with partial:true; use action="poll" to block for more output or exit, action="write" with input to send stdin, ` +
      `or action="stop" to terminate it. Commands are killed after timeout seconds (default ${DEFAULT_BASH_TIMEOUT_SECONDS}).`,
    toolKind: "command_execution",
    policy: "on-request",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Shell command to run (required for action=run)." },
        action: {
          type: "string",
          enum: ["run", "poll", "write", "stop"],
          description: "Defaults to 'run'. Use poll/write/stop with a session_id from a previous run.",
        },
        session_id: { type: "string", description: "Session to poll/write/stop." },
        input: { type: "string", description: "Stdin text to send for action=write." },
        yield_seconds: {
          type: "number",
          description: `How long to block waiting for output/exit (default ${DEFAULT_BASH_YIELD_SECONDS}, max ${MAX_BASH_YIELD_SECONDS}).`,
        },
        timeout: { type: "number", description: `Hard timeout in seconds (default ${DEFAULT_BASH_TIMEOUT_SECONDS}).` },
      },
      required: [],
    },
    async execute(args, context: ToolContext, onUpdate) {
      const action = typeof args.action === "string" ? args.action.trim() : "";

      // --- session actions on an existing session -----------------------------
      if (action && action !== "run") {
        if (action !== "poll" && action !== "write" && action !== "stop") {
          return err(`unsupported bash session action: ${action}`);
        }
        const session = sessionById(args.session_id);
        if (!session) {
          return err("bash session not found", { session_id: args.session_id ?? null });
        }

        if (action === "write") {
          if (session.status !== "running") {
            return { output: await sessionPayload(session), isError: true };
          }
          const input = typeof args.input === "string" ? args.input : "";
          session.child.stdin?.write(input);
          await waitForSessionExitOrDelay(session, normalizeYieldSeconds(args.yield_seconds) * 1000);
          const payload = await sessionPayload(session);
          return { output: payload, isError: payload.status === "failed" };
        }

        if (action === "stop") {
          stopSession(session);
          await waitForSessionExitOrDelay(session, STOP_GRACE_MS);
          const payload = await sessionPayload(session, { stopSent: true });
          return { output: payload, isError: session.status === "running" || session.status === "failed" };
        }

        // poll
        await waitForSessionExitOrDelay(session, normalizeYieldSeconds(args.yield_seconds) * 1000);
        const payload = await sessionPayload(session);
        return { output: payload, isError: session.status === "failed" };
      }

      // --- run (default) ------------------------------------------------------
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return err("bash requires a command");
      const timeoutSeconds = normalizeTimeoutSeconds(args.timeout);
      const yieldSeconds = normalizeYieldSeconds(args.yield_seconds);
      const cwd = workspaceRoot(context.workspace);
      try {
        const result = await startBashSession(
          { command, cwd, signal: context.abortSignal, timeoutSeconds, yieldSeconds },
          onUpdate,
        );
        return { output: result.payload, isError: result.isError };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error), { command, cwd });
      }
    },
  });
}
