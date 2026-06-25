import type { InsightDetector } from "../types.js";
import {
  extractMarkdownTable,
  jsonArrayRowCount,
  latestAssistantText,
  latestUserText,
  markdownTableRowCount,
} from "../conversation.js";

/**
 * Fires when the assistant's answer contains a substantive structured dataset
 * (markdown table or JSON array of objects) worth capturing into a sheet,
 * bitable, or doc. Prefilter is a row-count threshold scaled by sensitivity.
 */
export const dataToSheetDetector: InsightDetector = {
  id: "data_to_sheet",
  prefilter(items, sensitivity) {
    const answer = latestAssistantText(items);
    const rows = Math.max(markdownTableRowCount(answer), jsonArrayRowCount(answer));
    const minRows = sensitivity === "high" ? 3 : sensitivity === "low" ? 8 : 5;
    return {
      matched: rows >= minRows,
      topic: latestUserText(items).slice(0, 48).toLowerCase().trim(),
      hints: `structuredRows=${rows}`,
    };
  },
  systemPrompt:
    'You decide how structured content in the answer should be captured in Feishu. Pick the target that fits: "sheet" for a genuine multi-row dataset worth tabulating; "bitable" when that dataset benefits from a structured database (typed fields, many records); "doc" when the content reads better as a write-up than a strict grid — e.g. it mixes prose/explanation with a small table, or is really a report/notes that happens to contain tabular bits. Say no when there is nothing worth saving. When target is "doc", put the full markdown write-up (keep any tables inline) in draft_payload.markdown. Otherwise put the table in draft_payload.markdownTable. Respond ONLY with minified JSON: {"type":"data_to_sheet","confidence":0-1,"title":"<title>","draft_payload":{"title":"...","target":"sheet|bitable|doc","markdownTable":"...","markdown":"..."}}.',
  buildUserPrompt({ excerpt, hints }) {
    return `Conversation excerpt:
${excerpt}

Signals: ${hints ?? ""}

Return the JSON now.`;
  },
  buildDraftPayload({ classification, items }) {
    const answer = latestAssistantText(items);
    const payload = classification.draft_payload ?? {};
    const target =
      payload.target === "bitable" ? "bitable" : payload.target === "doc" ? "doc" : "sheet";
    const title =
      typeof payload.title === "string" && payload.title.trim() ? payload.title : classification.title;
    if (target === "doc") {
      return {
        title,
        target,
        markdown:
          typeof payload.markdown === "string" && payload.markdown.trim()
            ? payload.markdown
            : answer.slice(0, 8000),
      };
    }
    return {
      title,
      target,
      markdownTable:
        typeof payload.markdownTable === "string" && payload.markdownTable.trim()
          ? payload.markdownTable
          : extractMarkdownTable(answer),
    };
  },
};
