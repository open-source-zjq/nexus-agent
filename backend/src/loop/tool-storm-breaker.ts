import type { ToolCall } from "../adapters/tool/types.js";

const MUTATING_TOOL_NAMES = new Set(["write", "edit", "edit_diff", "apply_patch", "delete", "move"]);
const STORM_EXEMPT_TOOL_NAMES = new Set(["request_user_input", "user_input"]);

export interface ToolStormBreakerConfig {
  windowSize?: number;
  threshold?: number;
}

interface WindowEntry {
  key: string;
  readOnly: boolean;
}

/**
 * Detects a runaway loop of identical tool calls. Counts identical
 * (name, normalized-args) pairs in a sliding window; once a call would be the
 * Nth identical one it is suppressed. A mutating call clears the read-only
 * window (writes reset the read budget).
 */
export class ToolStormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  private recent: WindowEntry[] = [];

  constructor(config: ToolStormBreakerConfig = {}) {
    this.windowSize = Math.max(1, config.windowSize ?? 8);
    this.threshold = Math.max(2, config.threshold ?? 3);
  }

  inspect(call: ToolCall): { suppress: boolean; message?: string } {
    if (STORM_EXEMPT_TOOL_NAMES.has(call.toolName)) return { suppress: false };
    const key = `${call.toolName}::${stableStringify(call.arguments)}`;
    const mutating = call.toolKind === "file_change" || MUTATING_TOOL_NAMES.has(call.toolName);
    if (mutating) this.recent = this.recent.filter((entry) => !entry.readOnly);

    const count = this.recent.filter((entry) => entry.key === key).length;
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        message: `${call.toolName} was called with identical arguments ${count + 1} times in this turn; repeat-loop guard suppressed the duplicate. Choose a narrower query or explain why another identical call is needed.`,
      };
    }
    this.recent.push({ key, readOnly: !mutating });
    if (this.recent.length > this.windowSize) this.recent.splice(0, this.recent.length - this.windowSize);
    return { suppress: false };
  }

  reset(): void {
    this.recent = [];
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
