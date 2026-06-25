import type { ModelHistoryItem, ModelRequest, ToolSpec } from "../ports/model-client.js";

/**
 * Whole-request input-token estimator.
 *
 * Ported from Nexus's `loop/model-request-estimator.js` (which composes the
 * shared `ContextEstimator`). Unlike the history-only estimate used by the
 * compaction planner, this accounts for the ENTIRE model request that will be
 * sent on the wire: system prompt, mode instruction, context instructions,
 * cache-prefix few-shots, conversation history, tool specs (name + description +
 * JSON schema), attachment text fallbacks, the forced `requiredToolName`, and
 * the `reasoningEffort` marker.
 *
 * The estimate is deterministic and provider-agnostic: every text surface is
 * counted at `CHARS_PER_TOKEN` characters per token (matching the rest of the
 * loop's budgeting). It is used as the pre-send budget signal so compaction
 * decisions account for tools + instructions, not just history.
 */

const CHARS_PER_TOKEN = 4;

/**
 * Optional request fields the original estimator summed that are not part of the
 * canonical {@link ModelRequest} in this codebase. Accessed structurally so the
 * estimate stays faithful when a request happens to carry them.
 */
interface RequestExtras {
  prefix?: ModelHistoryItem[];
  attachmentTextFallbacks?: Array<{
    name?: string;
    mimeType?: string;
    byteSize?: number;
    dataBase64?: string;
  }>;
}

/** Estimate the total input tokens for an assembled {@link ModelRequest}. */
export function estimateModelRequestInputTokens(request: ModelRequest): number {
  const extras = request as ModelRequest & RequestExtras;
  let tokens = 0;
  tokens += estimateText(request.systemPrompt);
  tokens += estimateText(request.modeInstruction);
  tokens += estimateText(request.contextInstructions?.join("\n"));
  tokens += estimateItems(extras.prefix);
  tokens += estimateItems(request.history);
  tokens += estimateTools(request.tools);
  tokens += estimateTextFallbacks(extras.attachmentTextFallbacks);
  tokens += estimateText(request.requiredToolName);
  tokens += estimateText(request.reasoningEffort);
  return Math.max(0, tokens);
}

function estimateItems(items: ModelHistoryItem[] | undefined): number {
  if (!items || items.length === 0) return 0;
  return items.reduce((sum, item) => sum + estimateItem(item), 0);
}

function estimateItem(item: ModelHistoryItem): number {
  return Math.max(1, Math.ceil(collectText(item).length / CHARS_PER_TOKEN));
}

/**
 * Render an item to its text surface for estimation. Mirrors the shared
 * `ContextEstimator.collectText`: prose carries its text, tool calls carry the
 * tool name + serialized arguments, tool results carry their serialized output,
 * and compaction summaries carry the summary text.
 */
function collectText(item: ModelHistoryItem): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_text":
    case "assistant_reasoning":
      return item.text;
    case "tool_call":
      return `${item.toolName} ${JSON.stringify(item.arguments)}`;
    case "tool_result":
      return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    case "compaction":
      return item.summary;
    default:
      return "";
  }
}

function estimateTools(tools: ToolSpec[]): number {
  return tools.reduce((sum, tool) => {
    return sum + estimateText([tool.name, tool.description, JSON.stringify(tool.inputSchema)].join("\n"));
  }, 0);
}

function estimateTextFallbacks(fallbacks: RequestExtras["attachmentTextFallbacks"]): number {
  if (!fallbacks?.length) return 0;
  return fallbacks.reduce((sum, attachment) => {
    return (
      sum +
      estimateText(
        [
          attachment.name ?? "",
          attachment.mimeType ?? "",
          String(attachment.byteSize ?? ""),
          attachment.dataBase64 ?? "",
        ].join("\n"),
      )
    );
  }, 0);
}

function estimateText(text: string | undefined): number {
  if (!text?.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
