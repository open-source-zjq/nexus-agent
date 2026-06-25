import type { InsightDetector } from "../types.js";
import { itemText, latestUserText } from "../conversation.js";

/**
 * Bilingual (CJK + EN) alignment-intent keyword set. Matches explicit "let's
 * sync / schedule a meeting / 拉个会 / 对齐" cues and divergence markers.
 */
const ALIGN_WORDS =
  /(对齐|拉齐|对一下|拉个会|开个会|确认一下|沟通一下|碰一下|开会|约个会|align|sync up|let'?s meet|schedule a meeting|分歧|待确认)/i;

/**
 * Fires when the recent turn window contains alignment-intent keywords, i.e. the
 * discussion may warrant a short live meeting to sync people on a topic.
 */
export const meetingAlignmentDetector: InsightDetector = {
  id: "meeting_alignment",
  prefilter(items, sensitivity) {
    const window = sensitivity === "high" ? 12 : sensitivity === "low" ? 6 : 10;
    const recentText = items
      .slice(-window)
      .map((item) => itemText(item))
      .join("\n");
    const matched = ALIGN_WORDS.test(recentText);
    return {
      matched,
      topic: latestUserText(items).slice(0, 48).toLowerCase().trim(),
      hints: "alignment-keywords-detected",
    };
  },
  systemPrompt:
    'You decide whether the conversation calls for a short alignment meeting (a real need to sync people on a topic). Only say yes when there is genuine divergence or an explicit request to meet/align. Respond ONLY with minified JSON: {"type":"meeting_alignment","confidence":0-1,"title":"<meeting title>","draft_payload":{"summary":"...","agenda":"...","durationMinutes":30,"attendees":[]}}.',
  buildUserPrompt({ excerpt, hints }) {
    return `Conversation excerpt:
${excerpt}

Signals: ${hints ?? ""}

Return the JSON now.`;
  },
  buildDraftPayload({ classification }) {
    const payload = classification.draft_payload ?? {};
    const duration = Number(payload.durationMinutes);
    return {
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary
          : classification.title,
      agenda: typeof payload.agenda === "string" ? payload.agenda : "",
      durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
      attendees: Array.isArray(payload.attendees) ? payload.attendees : [],
    };
  },
};
