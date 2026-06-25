import type { LocalTool } from "./types.js";
import { defineTool } from "./types.js";
import type { ThreadTodoList, ThreadTodoStatus, ThreadTodoSource } from "../../contracts/threads.js";

/** A todo as accepted by todo_write, optionally carrying plan provenance. */
interface ToolTodoInput {
  id?: string;
  content: string;
  status: ThreadTodoStatus;
  source?: ThreadTodoSource;
}

export interface TodoToolDeps {
  getTodos(threadId: string): Promise<ThreadTodoList | null>;
  setTodos(threadId: string, todos: ToolTodoInput[]): Promise<ThreadTodoList>;
}

/**
 * Pass every todo through untouched (preserving id/source/any extra fields)
 * except demoting the 2nd+ in_progress item to pending. Faithful to the
 * original normalizeToolTodos: it does NOT rebuild entries, trim content, or
 * drop empty-content items — those flow to the store whose schema rejects them.
 */
function normalizeToolTodos(todos: ToolTodoInput[]): ToolTodoInput[] {
  let activeSeen = false;
  return todos.map((todo) => {
    if (todo.status !== "in_progress") return todo;
    if (!activeSeen) {
      activeSeen = true;
      return todo;
    }
    return { ...todo, status: "pending" as ThreadTodoStatus };
  });
}

/** Wrap the persisted ThreadTodoList object as `{ todos: <list> }`. */
function todoResponse(todos: ThreadTodoList | null): { todos: ThreadTodoList | null } {
  return { todos };
}

export function buildTodoLocalTools(deps: TodoToolDeps): LocalTool[] {
  const todoList = defineTool({
    name: "todo_list",
    description: "Return the current thread todo list. Use this to inspect structured progress state.",
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const todos = await deps.getTodos(context.threadId);
      return { output: todoResponse(todos) };
    },
  });

  const todoWrite = defineTool({
    name: "todo_write",
    description: [
      "Replace the current thread todo list with the supplied full list.",
      "Use it for visible task tracking in both Agent and Plan modes.",
      "At most one item may be in_progress; if more than one is supplied, only the first in_progress item is kept active.",
      "In Plan mode, save implementation plans with the advertised plan-saving tool; todo_write only updates the progress list.",
    ].join(" "),
    toolKind: "tool_call",
    policy: "auto",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        todos: {
          type: "array",
          description: "Complete replacement todo table for this thread.",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              source: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["plan"] },
                  planId: { type: "string" },
                  relativePath: { type: "string" },
                  ordinal: { type: "integer", minimum: 0 },
                  contentHash: { type: "string" },
                },
                required: ["kind", "planId", "relativePath", "ordinal", "contentHash"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args, context) {
      if (!Array.isArray(args.todos)) {
        return { output: { error: "todos must be an array" }, isError: true };
      }
      try {
        const saved = await deps.setTodos(
          context.threadId,
          normalizeToolTodos(args.todos as ToolTodoInput[]),
        );
        return { output: todoResponse(saved) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: { error: message }, isError: true };
      }
    },
  });

  return [todoList, todoWrite];
}
