import type { InsightDetector } from "../types.js";
import { latestAssistantText, latestUserText, searchToolCallCount } from "../conversation.js";

/**
 * Fires when a turn looks like finished research: enough search/fetch tool calls
 * plus a substantive assistant answer. Worth saving as a reusable knowledge doc.
 */
export const knowledgeCaptureDetector: InsightDetector = {
  id: "knowledge_capture",
  prefilter(items, sensitivity) {
    const searchCount = searchToolCallCount(items);
    const answer = latestAssistantText(items);
    const minSearches = sensitivity === "high" ? 2 : sensitivity === "low" ? 4 : 3;
    const minAnswerChars = sensitivity === "high" ? 400 : sensitivity === "low" ? 1000 : 600;
    const matched = searchCount >= minSearches && answer.length >= minAnswerChars;
    return {
      matched,
      topic: latestUserText(items).slice(0, 48).toLowerCase().trim(),
      hints: `searchToolCalls=${searchCount}; answerChars=${answer.length}`,
    };
  },
  systemPrompt:
    'You decide whether a finished research conversation is worth saving as a Feishu knowledge doc. Only say yes when the assistant produced a substantive, reusable summary (not a trivial reply). Respond ONLY with minified JSON: {"type":"knowledge_capture","confidence":0-1,"title":"<doc title>","draft_payload":{"title":"...","markdown":"..."}}. The markdown must be a clean meeting/research note distilled from the answer.',
  buildUserPrompt({ excerpt, hints }) {
    return `Conversation excerpt:
${excerpt}

Signals: ${hints ?? ""}

Return the JSON now.`;
  },
  buildDraftPayload({ classification, items }) {
    const answer = latestAssistantText(items);
    const payload = classification.draft_payload ?? {};
    return {
      title:
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title
          : classification.title,
      markdown:
        typeof payload.markdown === "string" && payload.markdown.trim()
          ? payload.markdown
          : answer.slice(0, 8000),
    };
  },
};
