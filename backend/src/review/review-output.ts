import {
  ReviewOutputSchema,
  type ReviewOutput,
  type ReviewFinding,
} from "../contracts/review.js";

/**
 * Robust parser for the model's review JSON. Faithful port of the original
 * `parseReviewOutput`/`renderReviewOutput`:
 * - balanced-brace JSON extraction (handles models that wrap JSON in prose)
 * - camel/snake key normalization
 * - [P0..P3] priority inference from the title when `priority` is missing
 * - benign fallback (empty findings, "patch is correct") on parse failure
 *
 * `parseReviewOutput` returns the raw {@link ReviewOutput} object unchanged
 * (findings keep their full codeLocation/lineRange.end and per-finding
 * confidenceScore); `renderReviewOutput` projects that raw object into the
 * human-readable review text the GUI shows.
 */

export type { ReviewOutput, ReviewFinding } from "../contracts/review.js";

export function parseReviewOutput(rawText: string): ReviewOutput {
  const text = rawText.trim();
  const direct = parseJsonCandidate(text);
  if (direct) return direct;
  const embedded = firstJsonObject(text);
  if (embedded) {
    const parsed = parseJsonCandidate(embedded);
    if (parsed) return parsed;
  }
  return {
    findings: [],
    overallCorrectness: "patch is correct",
    overallExplanation: text || "Reviewer did not return a structured response.",
    overallConfidenceScore: 0,
  };
}

/**
 * Render a {@link ReviewOutput} into the human-readable review text the GUI
 * shows. Faithful to the original `renderReviewOutput`: a header (explanation,
 * overall correctness, overall confidence) followed by either "No review
 * findings." or each finding's `- title -- absoluteFilePath:start-end` header
 * and 2-space-indented body ("No details provided." for an empty body).
 */
export function renderReviewOutput(output: ReviewOutput): string {
  const lines = [
    output.overallExplanation.trim() || output.overallCorrectness,
    "",
    `Overall correctness: ${output.overallCorrectness}`,
    `Overall confidence: ${formatConfidence(output.overallConfidenceScore)}`,
  ];
  if (output.findings.length === 0) {
    lines.push("", "No review findings.");
    return lines.join("\n").trim();
  }
  lines.push("", "Full review comments:");
  for (const finding of output.findings) {
    lines.push("", formatFindingHeader(finding), indentBody(finding.body));
  }
  return lines.join("\n").trim();
}

function formatFindingHeader(finding: ReviewFinding): string {
  const { absoluteFilePath, lineRange } = finding.codeLocation;
  return `- ${finding.title} -- ${absoluteFilePath}:${lineRange.start}-${lineRange.end}`;
}

function indentBody(body: string): string {
  const text = body.trim();
  if (!text) return "  No details provided.";
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatConfidence(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function parseJsonCandidate(candidate: string): ReviewOutput | null {
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    const result = ReviewOutputSchema.safeParse(normalizeReviewOutputKeys(parsed));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function normalizeReviewOutputKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const findings = Array.isArray(raw.findings)
    ? raw.findings.map((finding) => normalizeFindingKeys(finding))
    : [];
  return {
    findings,
    overallCorrectness: raw.overallCorrectness ?? raw.overall_correctness ?? "patch is correct",
    overallExplanation: raw.overallExplanation ?? raw.overall_explanation ?? "",
    overallConfidenceScore: raw.overallConfidenceScore ?? raw.overall_confidence_score ?? 0,
  };
}

function normalizeFindingKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const location = raw.codeLocation ?? raw.code_location;
  return {
    title: raw.title,
    body: raw.body ?? "",
    confidenceScore: raw.confidenceScore ?? raw.confidence_score ?? 0,
    priority: raw.priority ?? priorityFromTitle(raw.title),
    codeLocation: normalizeCodeLocation(location),
  };
}

function normalizeCodeLocation(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const lineRange = raw.lineRange ?? raw.line_range;
  return {
    absoluteFilePath: raw.absoluteFilePath ?? raw.absolute_file_path,
    lineRange: normalizeLineRange(lineRange),
  };
}

function normalizeLineRange(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  return {
    start: raw.start,
    end: raw.end ?? raw.start,
  };
}

function priorityFromTitle(value: unknown): number {
  if (typeof value !== "string") return 2;
  const match = value.match(/\[P([0-3])\]/i);
  return match?.[1] ? Number(match[1]) : 2;
}

/** Extract the first balanced-brace JSON object embedded in `text`. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
