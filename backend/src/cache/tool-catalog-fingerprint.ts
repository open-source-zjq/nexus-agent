import { createHash } from "node:crypto";
import type { ToolSpec } from "../ports/model-client.js";

/** Recursively sort object keys so structurally-equal values serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function canonicalizeSchema(value: unknown): Record<string, unknown> {
  const canonical = canonicalize(value);
  return canonical && typeof canonical === "object" && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : {};
}

interface CanonicalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function normalizeToolSpecs(tools: ToolSpec[]): CanonicalTool[] {
  return [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeSchema(tool.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** sha256(JSON.stringify(value)) truncated to 16 hex chars. */
function hashObject(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export interface ToolCatalogFingerprint {
  fingerprint: string;
  toolCount: number;
  toolNames: string[];
  toolHashes: Map<string, string>;
}

/** A deterministic fingerprint of the advertised tool catalog (for drift detection). */
export function computeToolCatalogFingerprint(tools: ToolSpec[]): ToolCatalogFingerprint {
  const canonicalTools = normalizeToolSpecs(tools);
  const toolHashes = new Map<string, string>();
  for (const tool of canonicalTools) {
    toolHashes.set(tool.name, hashObject(tool));
  }
  return {
    fingerprint: hashObject(canonicalTools),
    toolCount: canonicalTools.length,
    toolNames: canonicalTools.map((tool) => tool.name),
    toolHashes,
  };
}

export type CatalogChangeKind = "none" | "additive" | "breaking";

/**
 * Faithful port of `isAdditiveToolCatalogChange`: a change is additive only when
 * at least one NEW tool appears AND every previously-advertised tool is still
 * present with an identical hash. Removing, editing, or reordering a tool's
 * schema is therefore breaking (it can invalidate prompt-cache assumptions).
 */
export function isAdditiveToolCatalogChange(
  previous: ToolCatalogFingerprint,
  current: ToolCatalogFingerprint,
): boolean {
  let added = false;
  for (const name of current.toolNames) {
    if (!previous.toolHashes.has(name)) added = true;
  }
  if (!added) return false;
  for (const name of previous.toolNames) {
    const previousHash = previous.toolHashes.get(name);
    const currentHash = current.toolHashes.get(name);
    if (!previousHash || !currentHash || previousHash !== currentHash) return false;
  }
  return true;
}

export function classifyCatalogChange(
  previous: ToolCatalogFingerprint | undefined,
  next: ToolCatalogFingerprint,
): CatalogChangeKind {
  if (!previous) return "none";
  if (previous.fingerprint === next.fingerprint) return "none";
  return isAdditiveToolCatalogChange(previous, next) ? "additive" : "breaking";
}

/**
 * Composite snapshot key for per-thread catalog-drift tracking. Faithful to the
 * original `recordToolCatalogFingerprint`: drift is scoped to the
 * (thread, model, active skills, allowed tool names, user-input-disabled) tuple,
 * with skill ids + allowed names sorted for stability.
 */
export function buildToolCatalogSnapshotKey(input: {
  threadId: string;
  model: string;
  activeSkillIds?: string[];
  allowedToolNames?: string[] | undefined;
  userInputDisabled?: boolean;
}): string {
  return JSON.stringify({
    threadId: input.threadId,
    model: input.model,
    activeSkillIds: [...(input.activeSkillIds ?? [])].sort(),
    allowedToolNames: input.allowedToolNames ? [...input.allowedToolNames].sort() : [],
    userInputDisabled: input.userInputDisabled === true,
  });
}

/**
 * Human-readable drift instruction injected into the prompt + the transcript
 * error item. Faithful to the original `buildToolCatalogDriftMessage`: additive
 * drift continues with the refreshed list; breaking drift explains the
 * prompt-cache risk and that the turn was stopped.
 */
export function buildToolCatalogDriftMessage(
  catalog: ToolCatalogFingerprint,
  changeKind: Exclude<CatalogChangeKind, "none">,
): string {
  const sample = catalog.toolNames.slice(0, 12).join(", ");
  const suffix = catalog.toolNames.length > 12 ? `, +${catalog.toolNames.length - 12} more` : "";
  const policy =
    changeKind === "additive"
      ? "Only additive tool changes are allowed in-place; Nexus will continue with the refreshed tool list."
      : "Non-additive tool changes can invalidate prompt-cache assumptions; Nexus stopped this turn. Start a new thread after editing, removing, or reordering tool schemas.";
  return [
    `Tool catalog changed for this thread (${catalog.toolCount} tools, fingerprint ${catalog.fingerprint}).`,
    policy,
    sample ? `Current tools: ${sample}${suffix}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
