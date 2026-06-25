import type { LocalTool, ToolContext } from "./types.js";
import { GUI_GATE_TOOL_NAMES } from "./types.js";
import { isInsideWorkspace, resolveToolPath } from "./util.js";
import { DEFAULT_SANDBOX_MODE, SandboxModeSchema } from "../../contracts/policy.js";
import type { SandboxMode } from "../../contracts/policy.js";

export interface SandboxBlock {
  code: string;
  message: string;
}

/** Resolve the effective sandbox mode, falling back to the default for unknown values. */
function effectiveSandboxMode(context: Pick<ToolContext, "sandboxMode"> | undefined): SandboxMode {
  const parsed = SandboxModeSchema.safeParse(context?.sandboxMode);
  return parsed.success ? parsed.data : DEFAULT_SANDBOX_MODE;
}

/**
 * Decide whether a tool is blocked by the sandbox mode before it runs.
 * - read-only          : block file_change + command_execution.
 * - workspace-write    : allow file_change (path-confined at write time), but block
 *                        command_execution (host shell cannot be sandboxed in-process).
 * - danger-full-access : allow everything.
 * - external-sandbox   : block in-process file_change/command_execution (sandboxing is
 *                        enforced by an external runtime, not these in-process tools).
 */
export function sandboxBlockForTool(tool: Pick<LocalTool, "toolKind" | "name">, context: ToolContext): SandboxBlock | null {
  const mode = effectiveSandboxMode(context);
  if (mode === "danger-full-access") return null;
  if (GUI_GATE_TOOL_NAMES.has(tool.name)) return null;

  if (tool.toolKind === "file_change") {
    if (mode === "workspace-write") return null;
    return {
      code: mode === "read-only" ? "sandbox_read_only" : "sandbox_write_blocked",
      message:
        mode === "read-only"
          ? `tool ${tool.name} is blocked by the read-only sandbox`
          : `tool ${tool.name} is blocked because ${mode} does not allow in-process file mutation`,
    };
  }
  if (tool.toolKind === "command_execution") {
    return {
      code: "sandbox_command_blocked",
      message:
        mode === "read-only"
          ? `tool ${tool.name} is blocked by the read-only sandbox`
          : `tool ${tool.name} is blocked because ${mode} cannot sandbox host shell commands`,
    };
  }
  return null;
}

/** Catalog-level visibility: hide tools the sandbox would block from advertisement. */
export function isToolAdvertisedInSandbox(tool: Pick<LocalTool, "toolKind" | "name">, context: ToolContext | undefined): boolean {
  if (!context) return true;
  return sandboxBlockForTool(tool, context) === null;
}

export interface WritePathCheck {
  ok: boolean;
  code?: string;
  message?: string;
}

export function canWritePath(rawPath: string, context: ToolContext): WritePathCheck {
  const mode = effectiveSandboxMode(context);
  if (mode === "danger-full-access") return { ok: true };
  if (mode === "read-only") {
    return { ok: false, code: "sandbox_read_only", message: `writing is blocked by the read-only sandbox: ${rawPath}` };
  }
  if (mode === "external-sandbox") {
    return {
      ok: false,
      code: "sandbox_write_blocked",
      message: `writing is blocked because external-sandbox is not enforced by in-process file tools: ${rawPath}`,
    };
  }
  const { absolutePath } = resolveToolPath(rawPath, context.workspace);
  if (!isInsideWorkspace(absolutePath, context.workspace)) {
    return { ok: false, code: "sandbox_write_blocked", message: `writing is limited to the workspace sandbox: ${rawPath}` };
  }
  return { ok: true };
}
