import { z } from "zod";

/**
 * Thread-level approval strategy.
 * - `on-request` : prompt the user for mutating / untrusted tools (the secure default).
 * - `untrusted`  : prompt for anything not on the trusted list.
 * - `never`      : deny anything that would need approval (read-only effectively).
 * - `auto`       : auto-approve every tool call (frictionless; opt-in).
 * - `suggest`    : suggest commands but require approval before running.
 *
 * Default is `on-request` per the security baseline: tightened by
 * default, loosened only by explicit config.
 */
export const APPROVAL_POLICIES = ["on-request", "untrusted", "never", "auto", "suggest"] as const;
export const ApprovalPolicySchema = z.enum(APPROVAL_POLICIES);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "on-request";

/**
 * Sandbox mode applied to in-process tools.
 * - `read-only`          : block all file mutations and shell commands.
 * - `workspace-write`    : allow file mutations confined to the workspace root,
 *                          but still block host shell commands (cannot sandbox them in-process).
 * - `danger-full-access` : no restrictions.
 * - `external-sandbox`   : sandboxing is enforced by an external runtime, not the
 *                          in-process file tools; in-process writes/mutations are blocked.
 *
 * Default is `workspace-write` per the security baseline: file
 * mutations stay confined to the workspace root and host shell stays blocked
 * unless the operator explicitly opts into `danger-full-access`.
 */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access", "external-sandbox"] as const;
export const SandboxModeSchema = z.enum(SANDBOX_MODES);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";

/** Per-tool policy advertised by a tool provider. */
export const ToolPolicySchema = z.enum(["auto", "on-request", "untrusted", "never"]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** Whether a turn runs as an autonomous agent or a read-only planner. */
export const TurnModeSchema = z.enum(["agent", "plan"]);
export type TurnMode = z.infer<typeof TurnModeSchema>;

/** Reasoning/thinking effort requested for a turn. `auto` lets the router decide. */
export const ReasoningEffortSchema = z.enum(["auto", "off", "low", "medium", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
