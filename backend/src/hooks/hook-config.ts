import { z } from "zod";

/**
 * Lifecycle phases a hook can subscribe to.
 *
 * - `PreToolUse`        : before a tool call runs; may allow / deny / rewrite args.
 * - `PostToolUse`       : after a tool call completes.
 * - `UserPromptSubmit`  : when the user submits a prompt (start of a turn input).
 * - `TurnStart`         : at the start of an agent turn.
 * - `TurnEnd`           : at the end of an agent turn.
 * - `PreCompact`        : before context compaction runs.
 *
 * The tool-scoped phases (`PreToolUse`, `PostToolUse`) honor `matcher` / `toolNames`.
 */
export const HOOK_PHASES = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "TurnStart",
  "TurnEnd",
  "PreCompact",
] as const;

export const HookPhaseSchema = z.enum(HOOK_PHASES);
export type HookPhase = z.infer<typeof HookPhaseSchema>;

/** Phases that target a specific tool and therefore support matcher rules. */
export const TOOL_HOOK_PHASES: readonly HookPhase[] = ["PreToolUse", "PostToolUse"];

export function isToolHookPhase(phase: HookPhase): boolean {
  return TOOL_HOOK_PHASES.includes(phase);
}

/**
 * A configured command hook. The matched command is invoked with the phase
 * payload serialized as JSON on stdin; it communicates back via stdout JSON
 * and/or its exit code (see {@link HOOK_BLOCKING_EXIT_CODE}).
 */
export const HookCommandConfigSchema = z
  .object({
    phase: HookPhaseSchema,
    /** Glob matched against the tool name (`*` wildcard, `|` alternation). Tool phases only. */
    matcher: z.string().min(1).optional(),
    /** Exact tool-name list; matches when either this or `matcher` matches. Tool phases only. */
    toolNames: z.array(z.string().min(1)).optional(),
    /** Shell command. Receives the invocation as JSON on stdin. */
    command: z.string().min(1),
    /** Working directory; defaults to the active workspace. */
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type HookCommandConfig = z.infer<typeof HookCommandConfigSchema>;

/** A list of configured command hooks. This is the unit stored in config. */
export const HookConfigSchema = z.array(HookCommandConfigSchema);
export type HookConfig = z.infer<typeof HookConfigSchema>;

/**
 * What an in-process function hook may return. All fields optional; an empty /
 * undefined return is a non-blocking no-op.
 *
 * - Tool phases (`PreToolUse`): `decision` (`allow` / `deny` / `block`),
 *   `message` (the deny/block reason), and rewritten `arguments`.
 * - `PostToolUse`: rewritten `output` and/or an `isError` override.
 * - `UserPromptSubmit` (and other phases): `additionalContext` injected text.
 *
 * Mirrors the original's loose function-hook result; the engine routes it
 * through the same interpretation path as a command hook's stdout JSON.
 */
export interface HookFunctionResult {
  decision?: "allow" | "deny" | "block";
  /** Deny/block reason (also accepted as `reason`). */
  message?: string;
  reason?: string;
  /** PreToolUse: rewritten tool arguments. */
  arguments?: Record<string, unknown>;
  /** PostToolUse: replacement tool output. */
  output?: unknown;
  /** PostToolUse: force the tool result error flag. */
  isError?: boolean;
  /** UserPromptSubmit (etc.): extra context to inject. */
  additionalContext?: string;
  [key: string]: unknown;
}

/**
 * An in-process function hook. Instead of spawning a command, the engine calls
 * `run` with the phase invocation and interprets its (possibly async) return
 * value. Function hooks are supplied programmatically (they cannot be loaded
 * from serialized JSON config) and run alongside configured command hooks.
 */
export interface HookFunctionConfig {
  phase: HookPhase;
  /** Glob matched against the tool name (`*` wildcard, `|` alternation). Tool phases only. */
  matcher?: string;
  /** Exact tool-name list; matches when either this or `matcher` matches. Tool phases only. */
  toolNames?: string[];
  /** In-process handler. Receives the invocation; may return a result (sync or async). */
  run: (invocation: unknown) => HookFunctionResult | void | Promise<HookFunctionResult | void>;
  /** Per-hook timeout override (ms). */
  timeoutMs?: number;
}

/**
 * A runtime hook is either a configured command hook or an in-process function
 * hook. The engine distinguishes them at dispatch time via `"run" in hook`,
 * mirroring the original.
 */
export type RuntimeHook = HookCommandConfig | HookFunctionConfig;

/** True when a runtime hook is an in-process function hook (vs. a command hook). */
export function isFunctionHook(hook: RuntimeHook): hook is HookFunctionConfig {
  return "run" in hook && typeof (hook as HookFunctionConfig).run === "function";
}

/**
 * A hook exits with this code to BLOCK the phase (deny the tool call / abort the
 * lifecycle action). Any stdout it emitted is surfaced as the block reason.
 */
export const HOOK_BLOCKING_EXIT_CODE = 2;

/** Default timeout for an individual command hook when none is configured. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * Normalize a (possibly undefined) raw config into a validated, dense list of
 * command hooks. Mirrors the original `resolveConfiguredHooks` contract: only
 * present optional fields are retained.
 */
export function resolveConfiguredHooks(config: HookConfig | undefined): HookCommandConfig[] {
  return HookConfigSchema.parse(config ?? []).map((entry) => ({
    phase: entry.phase,
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    ...(entry.toolNames ? { toolNames: entry.toolNames } : {}),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
    command: entry.command,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
  }));
}
