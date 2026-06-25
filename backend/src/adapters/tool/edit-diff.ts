export interface EditSpec {
  oldText: string;
  newText: string;
}

export interface EditApplyResult {
  ok: boolean;
  content?: string;
  error?: string;
  /** Number of edits applied (the original engine applies one match per edit). */
  replacements?: number;
}

function splitLines2(value: string): string[] {
  return value.split("\n");
}

/**
 * Returns the line ending of the FIRST line break encountered: `\r\n` only when
 * a CRLF appears before the first lone LF. Faithful port of the original
 * detectLineEnding (an earlier lone `\n` wins over a later CRLF).
 */
function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1) return "\n";
  if (crlfIndex === -1) return "\n";
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.charCodeAt(0) === 0xfeff
    ? { bom: "﻿", text: content.slice(1) }
    : { bom: "", text: content };
}

/**
 * NFKC -> per-line trimEnd() -> fold smart quotes/dashes/spaces. Faithful port
 * of the original normalizeForFuzzyMatch (trimEnd strips ALL Unicode trailing
 * whitespace, and the full space range U+2002-U+200A / U+205F / U+3000 folds).
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface FuzzyFindResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

function fuzzyFindText(content: string, oldText: string): FuzzyFindResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent };
}

/** Always counts occurrences over the FUZZY-normalized content/oldText. */
function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);
  }
  return new Error(`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`);
  }
  return new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply a disjoint set of exact-text edits to LF-normalized content, with fuzzy
 * fallback, per-edit uniqueness, and overlap detection. Faithful port of the
 * original applyEditsToNormalizedContent. Throws path/index-aware errors.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: EditSpec[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));
  for (let index = 0; index < normalizedEdits.length; index += 1) {
    if (normalizedEdits[index].oldText.length === 0) {
      throw getEmptyOldTextError(path, index, normalizedEdits.length);
    }
  }
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;
  const matchedEdits: Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }> = [];
  for (let index = 0; index < normalizedEdits.length; index += 1) {
    const edit = normalizedEdits[index];
    const matchResult = fuzzyFindText(baseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(path, index, normalizedEdits.length);
    }
    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, index, normalizedEdits.length, occurrences);
    }
    matchedEdits.push({ editIndex: index, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let index = 1; index < matchedEdits.length; index += 1) {
    const previous = matchedEdits[index - 1];
    const current = matchedEdits[index];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }
  let newContent = baseContent;
  for (let index = matchedEdits.length - 1; index >= 0; index -= 1) {
    const edit = matchedEdits[index];
    newContent = newContent.substring(0, edit.matchIndex) + edit.newText + newContent.substring(edit.matchIndex + edit.matchLength);
  }
  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }
  return { baseContent, newContent };
}

/** 1-based line number of the first differing line, or undefined if identical. */
export function firstChangedLine(oldContent: string, newContent: string): number | undefined {
  const oldLines = splitLines2(oldContent);
  const newLines = splitLines2(newContent);
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count; index += 1) {
    if ((oldLines[index] ?? "") !== (newLines[index] ?? "")) return index + 1;
  }
  return undefined;
}

/**
 * Tool-facing wrapper: strips BOM, detects/normalizes line endings, applies the
 * disjoint multi-edit engine, then restores the BOM and line endings. Returns a
 * result object (errors surface as `error`, never thrown).
 */
export function applyEdits(originalContent: string, edits: EditSpec[], path = ""): EditApplyResult {
  const { bom, text } = stripBom(originalContent);
  const lineEnding = detectLineEnding(text);
  const normalized = normalizeToLF(text);
  try {
    const { newContent } = applyEditsToNormalizedContent(normalized, edits, path);
    const restored = restoreLineEndings(newContent, lineEnding);
    return { ok: true, content: bom + restored, replacements: edits.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Hand-rolled line diff (LCS) --------------------------------------------
// jsdiff-compatible part shape; no external dependency.

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * Split a string into diff tokens. jsdiff's diffLines keeps the trailing
 * newline on each line so that values can be concatenated back losslessly.
 */
function tokenizeLines(text: string): string[] {
  if (text === "") return [];
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      tokens.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) tokens.push(text.slice(start));
  return tokens;
}

/**
 * Longest-common-subsequence line diff. Returns a jsdiff-style list of parts in
 * order, each marked added/removed/unchanged. Equivalent to `diffLines`.
 */
export function diffLines(oldContent: string, newContent: string): DiffPart[] {
  const a = tokenizeLines(oldContent);
  const b = tokenizeLines(newContent);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack into a run-coalesced parts list.
  const parts: DiffPart[] = [];
  const push = (value: string, kind: "added" | "removed" | "common"): void => {
    const last = parts[parts.length - 1];
    const added = kind === "added";
    const removed = kind === "removed";
    if (last && Boolean(last.added) === added && Boolean(last.removed) === removed) {
      last.value += value;
    } else {
      parts.push({ value, ...(added ? { added: true } : {}), ...(removed ? { removed: true } : {}) });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], "common");
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], "removed");
      i += 1;
    } else {
      push(b[j], "added");
      j += 1;
    }
  }
  while (i < n) {
    push(a[i], "removed");
    i += 1;
  }
  while (j < m) {
    push(b[j], "added");
    j += 1;
  }
  return parts;
}

/**
 * A line diff for display in the GUI: padded line numbers, +/- /space prefixes,
 * and collapsing of unchanged runs to `contextLines` with "..." skip markers.
 * Faithful port of the original generateDisplayDiff.
 */
export function generateDisplayDiff(oldContent: string, newContent: string, contextLines = 4): string {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    const nextPartIsChange =
      index < parts.length - 1 && (Boolean(parts[index + 1].added) || Boolean(parts[index + 1].removed));
    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum += 1;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum += 1;
        }
      }
      lastWasChange = true;
      continue;
    }
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;
    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum += 1;
          newLineNum += 1;
        }
      } else {
        const leading = raw.slice(0, contextLines);
        const trailing = raw.slice(raw.length - contextLines);
        const skipped = raw.length - leading.length - trailing.length;
        for (const line of leading) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum += 1;
          newLineNum += 1;
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const line of trailing) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum += 1;
          newLineNum += 1;
        }
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      const skipped = raw.length - shown.length;
      for (const line of shown) {
        output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
        oldLineNum += 1;
        newLineNum += 1;
      }
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
      for (const line of raw.slice(skipped)) {
        output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
        oldLineNum += 1;
        newLineNum += 1;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }
  return output.join("\n");
}

// --- Unified patch (hand-rolled) --------------------------------------------

interface HunkLine {
  prefix: " " | "+" | "-";
  text: string;
}

/**
 * Produce a unified diff patch (a/path b/path headers, @@ hunks) from a line
 * diff, collapsing unchanged runs to `contextLines`. Equivalent to jsdiff's
 * createTwoFilesPatch with file-headers-only. No external dependency.
 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
  const parts = diffLines(oldContent, newContent);

  // Flatten parts into a per-line operation stream.
  type Op = { kind: "common" | "add" | "del"; text: string };
  const ops: Op[] = [];
  for (const part of parts) {
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    for (const line of raw) {
      if (part.added) ops.push({ kind: "add", text: line });
      else if (part.removed) ops.push({ kind: "del", text: line });
      else ops.push({ kind: "common", text: line });
    }
  }

  interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: HunkLine[];
  }
  const hunks: Hunk[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let current: Hunk | null = null;
  let trailingCommon = 0;

  const closeHunk = (): void => {
    if (!current) return;
    // Trim trailing common context beyond contextLines.
    while (trailingCommon > contextLines) {
      const last = current.lines[current.lines.length - 1];
      if (!last || last.prefix !== " ") break;
      current.lines.pop();
      current.oldLines -= 1;
      current.newLines -= 1;
      trailingCommon -= 1;
    }
    hunks.push(current);
    current = null;
    trailingCommon = 0;
  };

  // Sliding window of pending leading-context lines.
  const pendingContext: { old: number; new: number; text: string }[] = [];

  for (let idx = 0; idx < ops.length; idx += 1) {
    const op = ops[idx];
    if (op.kind === "common") {
      if (current) {
        current.lines.push({ prefix: " ", text: op.text });
        current.oldLines += 1;
        current.newLines += 1;
        trailingCommon += 1;
        // If we've accumulated more than 2*context of trailing common with no
        // upcoming change soon, close the hunk.
        if (trailingCommon > contextLines) {
          const hasUpcomingChange = ops.slice(idx + 1, idx + 1 + contextLines).some((o) => o.kind !== "common");
          if (!hasUpcomingChange) closeHunk();
        }
      } else {
        pendingContext.push({ old: oldLineNum, new: newLineNum, text: op.text });
        if (pendingContext.length > contextLines) pendingContext.shift();
      }
      oldLineNum += 1;
      newLineNum += 1;
    } else {
      if (!current) {
        const lead = pendingContext.slice();
        const oldStart = lead.length > 0 ? lead[0].old : oldLineNum;
        const newStart = lead.length > 0 ? lead[0].new : newLineNum;
        current = { oldStart, oldLines: 0, newStart, newLines: 0, lines: [] };
        for (const c of lead) {
          current.lines.push({ prefix: " ", text: c.text });
          current.oldLines += 1;
          current.newLines += 1;
        }
        pendingContext.length = 0;
      }
      trailingCommon = 0;
      if (op.kind === "add") {
        current.lines.push({ prefix: "+", text: op.text });
        current.newLines += 1;
        newLineNum += 1;
      } else {
        current.lines.push({ prefix: "-", text: op.text });
        current.oldLines += 1;
        oldLineNum += 1;
      }
    }
  }
  closeHunk();

  if (hunks.length === 0) return "";

  const out: string[] = [];
  out.push(`--- a/${path}`);
  out.push(`+++ b/${path}`);
  for (const hunk of hunks) {
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    out.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.prefix}${line.text}`);
    }
  }
  return `${out.join("\n")}\n`;
}
