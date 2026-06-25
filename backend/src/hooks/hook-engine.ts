import { spawn } from "node:child_process";
import {
  HOOK_BLOCKING_EXIT_CODE,
  DEFAULT_HOOK_TIMEOUT_MS,
  isToolHookPhase,
  isFunctionHook,
  resolveConfiguredHooks,
  type HookConfig,
  type HookCommandConfig,
  type HookFunctionConfig,
  type HookFunctionResult,
  type RuntimeHook,
  type HookPhase,
} from "./hook-config.js";

/**
 * Decision a `PreToolUse` hook can return.
 * - `allow` : auto-approve the tool call (skip the normal approval gate).
 * - `deny`  : refuse the tool call (surface `reason` to the model / user).
 * - `block` : hard-stop the lifecycle action (equivalent to exit code 2).
 */
export type HookDecision = "allow" | "deny" | "block";

/**
 * Payload handed to a command hook. It is serialized to JSON on the child's
 * stdin. Tool phases include the tool name + arguments; other phases pass an
 * arbitrary, phase-specific `payload`.
 */
export interface HookInvocation {
  phase: HookPhase;
  /** Active workspace / cwd the action runs in. */
  cwd: string;
  /** Present for tool phases (`PreToolUse` / `PostToolUse`). */
  toolName?: string;
  /** Tool call arguments (`PreToolUse`) or anything the caller wants to expose. */
  arguments?: Record<string, unknown>;
  /** Tool result output (`PostToolUse`). */
  output?: unknown;
  /** Arbitrary phase-specific data for non-tool phases. */
  payload?: unknown;
}

/**
 * What a single hook decided. The default (no hooks, clean exit, no JSON) is a
 * non-blocking `continue` with `blocked: false`.
 */
export interface HookResult {
  /** True when the phase should be aborted (exit code 2 or decision `block`/`deny`). */
  blocked: boolean;
  /** For tool phases: the hook's explicit decision, if any. */
  decision?: HookDecision;
  /** Human-readable reason (block/deny message); typically the hook's stdout. */
  reason?: string;
  /**
   * Rewritten tool arguments. When a `PreToolUse` hook returns `arguments`, the
   * caller should substitute these before invoking the tool.
   */
  arguments?: Record<string, unknown>;
  /**
   * Rewritten tool output. When a `PostToolUse` hook returns `output`, the
   * caller MUST substitute the tool result's output before persisting it.
   * Present only when at least one PostToolUse hook rewrote the output.
   */
  output?: unknown;
  /** True when the hook explicitly emitted a (rewritten) `output`. */
  outputRewritten?: boolean;
  /**
   * Override for the tool result's `isError` flag. A `PostToolUse` hook may force
   * a result into / out of the error state (e.g. blocking exit code 2 marks the
   * result as an error). Undefined leaves the existing flag untouched.
   */
  isError?: boolean;
  /**
   * True when the hook TIMED OUT. The original (`runCommandHook`/`executeHook` in
   * hooks/hook-engine.dup2.js) throws on timeout, which the tool host turns into a
   * `hook_failed` result; we surface `failed` for the same mapping. Spawn errors
   * and non-zero exits are NON-blocking warnings, not failures.
   */
  failed?: boolean;
  /**
   * A single non-blocking warning from THIS hook (non-zero non-blocking exit or
   * spawn failure). The tool keeps running; the warning is accumulated and
   * surfaced. Confirmed against the original `runCommandHook` (exit ≠0/≠2 returns
   * `{ warning }`) and `runPreToolUseHooks`/`runPostToolUseHooks` (which collect a
   * `warnings[]` and continue); only a timeout (throw) or an explicit deny aborts.
   */
  warning?: string;
  /** Accumulated warnings across all hooks in the phase (set by `run`/`runPost`). */
  warnings?: string[];
  /**
   * Extra context a `UserPromptSubmit` hook injects. The original maps a hook's
   * non-JSON stdout (or an explicit `{ additionalContext }`) to this field so
   * plain stdout is fed back into the prompt as additional context.
   */
  additionalContext?: string;
  /** Raw stdout emitted by the hook (trimmed), for diagnostics. */
  stdout?: string;
  /** Raw stderr emitted by the hook (trimmed), for diagnostics. */
  stderr?: string;
}

/** Shape a hook may emit on stdout as JSON. All fields optional. */
interface HookStdoutPayload {
  decision?: HookDecision;
  reason?: string;
  arguments?: Record<string, unknown>;
  /** PostToolUse rewrite: replacement tool output. */
  output?: unknown;
  hasOutput?: boolean;
  /** PostToolUse override: force the tool result error flag. */
  isError?: boolean;
  /** UserPromptSubmit: extra context to inject back into the prompt. */
  additionalContext?: string;
}

/** A non-blocking, do-nothing result. */
const PASS: HookResult = { blocked: false };

/**
 * Executes configured command hooks and in-process function hooks for lifecycle
 * phases.
 *
 * Injectable: construct with the resolved hooks config + a default cwd (the
 * active workspace). Function hooks (`{ run }`) are supplied programmatically
 * via `functionHooks` and run interleaved with command hooks, in the order
 * command-hooks-then-function-hooks per phase. When no hooks match a phase,
 * `run` resolves to a no-op {@link PASS} result without spawning anything.
 */
export class HookEngine {
  private readonly hooks: RuntimeHook[];
  private readonly cwd: string;

  constructor(deps: { hooks?: HookConfig; functionHooks?: HookFunctionConfig[]; cwd: string }) {
    this.hooks = [...resolveConfiguredHooks(deps.hooks), ...(deps.functionHooks ?? [])];
    this.cwd = deps.cwd;
  }

  /** True when at least one hook is configured for the given phase. */
  hasHooks(phase: HookPhase): boolean {
    return this.hooks.some((h) => h.phase === phase);
  }

  /**
   * Run every command hook configured for `phase` (and matching the tool, for
   * tool phases) in order. The first hook that blocks / denies short-circuits
   * and is returned. A `PreToolUse` hook returning rewritten `arguments` feeds
   * them forward to subsequent hooks and into the final result.
   */
  async run(phase: HookPhase, payload: HookInvocation): Promise<HookResult> {
    const matched = this.hooks.filter((h) => h.phase === phase && this.matchesTool(h, payload));
    if (matched.length === 0) return PASS;

    if (phase === "PostToolUse") {
      return this.runPost(matched, { ...payload, phase, cwd: payload.cwd || this.cwd });
    }

    let current: HookInvocation = { ...payload, phase, cwd: payload.cwd || this.cwd };
    let rewritten: Record<string, unknown> | undefined;
    let autoApproved = false;
    const warnings: string[] = [];
    const withWarnings = (result: HookResult): HookResult =>
      warnings.length ? { ...result, warnings: [...warnings] } : result;

    // Mirrors the original `runPreToolUseHooks` (hooks/hook-engine.dup2.js): warnings
    // (non-zero exit / spawn failure) accumulate and the loop CONTINUES; a deny —
    // or a thrown timeout surfaced here as `failed` — short-circuits; an `allow`
    // sets auto-approve but does NOT short-circuit, so a later hook can still deny.
    for (const hook of matched) {
      const result = await this.invoke(hook, current);
      if (result.warning) warnings.push(result.warning);
      if (result.failed) return withWarnings(result);
      if (result.blocked || result.decision === "deny" || result.decision === "block") {
        return withWarnings(result);
      }
      if (result.decision === "allow") autoApproved = true;
      if (result.arguments) {
        rewritten = result.arguments;
        current = { ...current, arguments: result.arguments };
      }
    }

    if (autoApproved) {
      return withWarnings({ blocked: false, decision: "allow", ...(rewritten ? { arguments: rewritten } : {}) });
    }
    return withWarnings(rewritten ? { blocked: false, arguments: rewritten } : PASS);
  }

  /**
   * Fold every matched PostToolUse hook over the tool result. A hook may rewrite
   * the output (`output`), override the error flag (`isError`), or — via blocking
   * exit code 2 — force the result into the error state with its message. The
   * accumulated `{ output, isError }` is returned so the caller can APPLY it.
   * A hook that fails to run (spawn error / timeout) short-circuits with
   * `failed: true` so the caller can produce a `hook_failed` error result.
   */
  private async runPost(matched: RuntimeHook[], payload: HookInvocation): Promise<HookResult> {
    let output = payload.output;
    let isError: boolean | undefined;
    let rewrote = false;
    let lastStdout: string | undefined;
    let lastStderr: string | undefined;
    const warnings: string[] = [];

    for (const hook of matched) {
      const result = await this.invoke(hook, { ...payload, output });
      if (result.warning) warnings.push(result.warning);
      if (result.failed) return warnings.length ? { ...result, warnings: [...warnings] } : result;
      if (result.stdout !== undefined) lastStdout = result.stdout;
      if (result.stderr !== undefined) lastStderr = result.stderr;
      if (result.outputRewritten) {
        output = result.output;
        rewrote = true;
        // A rewrite carries its own (possibly overridden) error flag.
        if (result.isError !== undefined) isError = result.isError;
      } else if (result.isError !== undefined) {
        isError = result.isError;
      }
    }

    const warningsField = warnings.length ? { warnings } : {};
    if (!rewrote && isError === undefined) {
      return { blocked: false, ...warningsField, ...(lastStdout ? { stdout: lastStdout } : {}), ...(lastStderr ? { stderr: lastStderr } : {}) };
    }
    return {
      blocked: false,
      ...warningsField,
      ...(rewrote ? { output, outputRewritten: true } : {}),
      ...(isError !== undefined ? { isError } : {}),
      ...(lastStdout ? { stdout: lastStdout } : {}),
      ...(lastStderr ? { stderr: lastStderr } : {}),
    };
  }

  /** Does this hook target the payload's tool? Non-tool phases always match. */
  private matchesTool(hook: RuntimeHook, payload: HookInvocation): boolean {
    if (!isToolHookPhase(hook.phase)) return true;
    const toolName = payload.toolName;
    if (!toolName) return true;
    const hasMatcher = hook.matcher != null;
    const hasNames = hook.toolNames != null && hook.toolNames.length > 0;
    if (!hasMatcher && !hasNames) return true; // unscoped tool hook matches all tools
    if (hasNames && hook.toolNames!.includes(toolName)) return true;
    if (hasMatcher && matcherMatches(hook.matcher!, toolName)) return true;
    return false;
  }

  /**
   * Dispatch a single hook. In-process function hooks (`{ run }`) call their
   * handler under a timeout; command hooks spawn the configured command. Both
   * paths converge on the same {@link HookResult} interpretation.
   */
  private invoke(hook: RuntimeHook, payload: HookInvocation): Promise<HookResult> {
    if (isFunctionHook(hook)) return this.invokeFunction(hook, payload);
    return this.invokeCommand(hook, payload);
  }

  /**
   * Run an in-process function hook. Its (possibly async) return value is run
   * under the hook's timeout and interpreted through the same path as a command
   * hook's stdout JSON, so a function hook's `{ decision, arguments, output,
   * isError, additionalContext }` behaves identically to a command hook's.
   */
  private async invokeFunction(hook: HookFunctionConfig, payload: HookInvocation): Promise<HookResult> {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    let value: HookFunctionResult | void;
    try {
      value = await withTimeout(
        Promise.resolve(hook.run(payload)),
        timeoutMs,
        `${payload.phase} hook timed out after ${timeoutMs}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { blocked: false, failed: true, reason: message };
    }
    return interpretFunctionResult(payload.phase, value);
  }

  /** Spawn a single command hook, feed JSON on stdin, interpret its result. */
  private invokeCommand(hook: HookCommandConfig, payload: HookInvocation): Promise<HookResult> {
    const cwd = hook.cwd || payload.cwd || this.cwd;
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const input = JSON.stringify(payload);

    return new Promise<HookResult>((resolvePromise) => {
      const child = spawn(hook.command, {
        cwd,
        shell: true,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (result: HookResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        // A timed-out hook is a hard failure: the original threw, which the tool
        // host turns into a `hook_failed` error result.
        settle({
          blocked: false,
          failed: true,
          reason: `${payload.phase} hook timed out after ${timeoutMs}ms`,
          stderr: stderr.trim() || undefined,
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (error) => {
        // Spawn failure (e.g. command not found) is a NON-blocking warning: the
        // tool keeps running and the warning is accumulated (faithful to the
        // original, where only a timeout aborts the tool).
        settle({
          blocked: false,
          warning: `${payload.phase} command hook failed to start: ${error.message}`,
          stderr: (stderr + `\n${error.message}`).trim() || undefined,
        });
      });

      child.on("close", (code) => {
        settle(interpret(payload.phase, code, stdout, stderr));
      });

      child.stdin?.on("error", () => {
        /* child may close stdin early; ignore EPIPE */
      });
      child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}

/**
 * Translate an exit code + stdout/stderr into a {@link HookResult}.
 *
 * - Exit code 2 => BLOCK (stdout/stderr is the reason).
 * - Otherwise, if stdout parses as JSON with a `decision`/`arguments`, honor it.
 * - A `decision` of `deny`/`block` sets `blocked: true`.
 */
function interpret(phase: HookPhase, code: number | null, rawStdout: string, rawStderr: string): HookResult {
  const stdout = rawStdout.trim();
  const stderr = rawStderr.trim();

  if (code === HOOK_BLOCKING_EXIT_CODE) {
    const reason = stderr || stdout || `${phase} command hook blocked (exit ${HOOK_BLOCKING_EXIT_CODE})`;
    // A blocking exit in PostToolUse cannot deny a call that already ran — it
    // instead forces the result into the error state (matching the original).
    if (phase === "PostToolUse") {
      return {
        blocked: false,
        isError: true,
        reason,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }
    // Non-PostToolUse blocking exit => deny (the original `runCommandHook` returns
    // `{ decision: "deny" }` for exit code 2 outside PostToolUse).
    return {
      blocked: true,
      decision: "deny",
      reason,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  }

  const parsed = parseStdout(stdout);
  if (parsed) {
    if (phase === "PostToolUse") {
      return {
        blocked: false,
        ...(parsed.hasOutput ? { output: parsed.output, outputRewritten: true } : {}),
        ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }
    const decision = parsed.decision;
    const blocked = decision === "deny" || decision === "block";
    return {
      blocked,
      ...(decision ? { decision } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.arguments ? { arguments: parsed.arguments } : {}),
      ...(parsed.additionalContext !== undefined ? { additionalContext: parsed.additionalContext } : {}),
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  }

  // Clean exit with non-empty, non-JSON stdout: the original folds the plain
  // text in. For `UserPromptSubmit` it becomes injected additional context; for
  // any other phase it becomes the result `reason` (the original's `message`).
  if (code === 0 && stdout) {
    if (phase === "UserPromptSubmit") {
      return { blocked: false, additionalContext: stdout, stdout, ...(stderr ? { stderr } : {}) };
    }
    return { blocked: false, reason: stdout, stdout, ...(stderr ? { stderr } : {}) };
  }

  // Non-zero, non-2 exit with no structured output: a non-blocking warning (the
  // tool keeps running; the original surfaces this as a warning, not a failure).
  if (code !== 0) {
    return {
      blocked: false,
      warning: stderr || `${phase} command hook exited with ${code}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  }
  return { blocked: false, stdout: stdout || undefined, stderr: stderr || undefined };
}

function parseStdout(stdout: string): HookStdoutPayload | null {
  if (!stdout || stdout[0] !== "{") return null;
  try {
    const value = JSON.parse(stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return toStdoutPayload(value as Record<string, unknown>);
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Normalize a loose hook-result object into the canonical {@link HookStdoutPayload}. */
function toStdoutPayload(obj: Record<string, unknown>): HookStdoutPayload {
  const decision =
    obj.decision === "allow" || obj.decision === "deny" || obj.decision === "block"
      ? (obj.decision as HookDecision)
      : undefined;
  const args =
    obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
      ? (obj.arguments as Record<string, unknown>)
      : undefined;
  const reason =
    typeof obj.reason === "string"
      ? obj.reason
      : typeof obj.message === "string"
        ? obj.message
        : undefined;
  const hasOutput = Object.prototype.hasOwnProperty.call(obj, "output");
  const isError = typeof obj.isError === "boolean" ? obj.isError : undefined;
  const additionalContext =
    typeof obj.additionalContext === "string" ? obj.additionalContext : undefined;
  return {
    decision,
    arguments: args,
    reason,
    ...(hasOutput ? { output: obj.output, hasOutput: true } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(additionalContext !== undefined ? { additionalContext } : {}),
  };
}

/**
 * Interpret an in-process function hook's return value into a {@link HookResult}.
 *
 * Mirrors the original's `executeHook` for `"run" in hook`: an empty / undefined
 * return is a no-op {@link PASS}; otherwise the returned object is routed through
 * the same field interpretation as a command hook's stdout JSON, honoring the
 * per-phase semantics (PreToolUse decision/arguments, PostToolUse output/isError,
 * UserPromptSubmit additionalContext).
 */
function interpretFunctionResult(phase: HookPhase, value: HookFunctionResult | void): HookResult {
  if (!value || typeof value !== "object") return PASS;
  const parsed = toStdoutPayload(value as Record<string, unknown>);

  if (phase === "PostToolUse") {
    if (!parsed.hasOutput && parsed.isError === undefined && parsed.reason === undefined) return PASS;
    return {
      blocked: false,
      ...(parsed.hasOutput ? { output: parsed.output, outputRewritten: true } : {}),
      ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  }

  const decision = parsed.decision;
  const blocked = decision === "deny" || decision === "block";
  if (
    !decision &&
    !parsed.arguments &&
    parsed.reason === undefined &&
    parsed.additionalContext === undefined
  ) {
    return PASS;
  }
  return {
    blocked,
    ...(decision ? { decision } : {}),
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    ...(parsed.arguments ? { arguments: parsed.arguments } : {}),
    ...(parsed.additionalContext !== undefined ? { additionalContext: parsed.additionalContext } : {}),
  };
}

/**
 * Match a tool name against a matcher pattern supporting `*` wildcards and `|`
 * alternation (e.g. `read_*` or `read_file|write_file`). Anchored at both ends.
 */
function matcherMatches(pattern: string, toolName: string): boolean {
  const alternatives = pattern.split("|").map((p) => p.trim()).filter(Boolean);
  return alternatives.some((alt) => globToRegExp(alt).test(toolName));
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (".+^${}()[]\\/".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Resolve `promise` but reject with `Error(message)` if it does not settle
 * within `timeoutMs`. Used to bound an in-process function hook's `run`
 * (command hooks bound themselves via SIGKILL). Ported from the original.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
