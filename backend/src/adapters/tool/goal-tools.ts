import type { LocalTool } from "./types.js";
import { defineTool } from "./types.js";
import type { ThreadGoal } from "../../contracts/threads.js";

export interface GoalToolDeps {
  getGoal(threadId: string): Promise<ThreadGoal | null>;
  setGoal(
    threadId: string,
    request: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null },
  ): Promise<ThreadGoal>;
}

export function buildGoalLocalTools(deps: GoalToolDeps): LocalTool[] {
  const getGoal = defineTool({
    name: "get_goal",
    description:
      "Get the current goal for this thread, including status, budgets, usage, and remaining token budget.",
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const goal = await deps.getGoal(context.threadId);
      return { output: goalResponse(goal) };
    },
  });

  const createGoal = defineTool({
    name: "create_goal",
    description: [
      "Create a goal only when explicitly requested by the user or system/developer instructions;",
      "do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget",
      "is requested. Fails if a goal exists; use update_goal only for status.",
    ].join(" "),
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        objective: {
          type: "string",
          description:
            "Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined.",
        },
        token_budget: {
          type: "integer",
          description: "Optional positive token budget for the new active goal.",
        },
      },
      required: ["objective"],
    },
    async execute(args, context) {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      const tokenBudget = normalizeTokenBudget(args.token_budget);
      if (!objective) return { output: { error: "objective is required" }, isError: true };
      if (tokenBudget === false) {
        return { output: { error: "token_budget must be a positive integer" }, isError: true };
      }
      const existing = await deps.getGoal(context.threadId);
      if (existing) {
        return {
          output: {
            error:
              "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
          },
          isError: true,
        };
      }
      const goal = await deps.setGoal(context.threadId, {
        objective,
        status: "active",
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
      });
      return { output: goalResponse(goal) };
    },
  });

  const updateGoal = defineTool({
    name: "update_goal",
    description: [
      "Update the existing goal. Use this tool only to mark the goal achieved or blocked.",
      "Set status to complete only when the objective has actually been achieved and no required work remains.",
      "Set status to blocked only when the goal cannot currently proceed until something external changes.",
      "Do not mark a goal complete merely because the budget is nearly exhausted or because you are stopping work.",
      "You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system.",
    ].join(" "),
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["complete", "blocked"],
          description: "Required. Set to complete only when achieved; set to blocked only when externally blocked.",
        },
      },
      required: ["status"],
    },
    async execute(args, context) {
      const status = args.status;
      if (status !== "complete" && status !== "blocked") {
        return {
          output: {
            error:
              "update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system",
          },
          isError: true,
        };
      }
      const existing = await deps.getGoal(context.threadId);
      if (!existing) {
        return {
          output: { error: "cannot update goal because this thread does not have a goal" },
          isError: true,
        };
      }
      const goal = await deps.setGoal(context.threadId, { status });
      return {
        output: goalResponse(
          goal,
          status === "complete"
            ? "Goal achieved. Report final usage from this tool result if relevant."
            : undefined,
        ),
      };
    },
  });

  return [getGoal, createGoal, updateGoal];
}

/**
 * Validate an optional token budget: undefined/null -> undefined (omit),
 * a positive integer -> the value, anything else -> false (reject). Faithful
 * port of the original normalizeTokenBudget.
 */
function normalizeTokenBudget(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return false;
  return value;
}

function goalResponse(
  goal: ThreadGoal | null,
  completionBudgetReport?: string,
): Record<string, unknown> {
  const remainingTokens =
    goal?.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);
  return {
    goal,
    remainingTokens,
    ...(completionBudgetReport && goal?.status === "complete" ? { completionBudgetReport } : {}),
  };
}
