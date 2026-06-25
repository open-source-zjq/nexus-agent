import { createHash } from "node:crypto";
import type { ToolSpec } from "../ports/model-client.js";
import type { TurnItem } from "../contracts/items.js";

/**
 * Immutable prompt-cache prefix builder.
 *
 * The "immutable prefix" is the portion of a request that is stable across an
 * entire thread (system prompt, tool definitions, pinned constraints, and any
 * deterministic few-shot examples). Providers can cache it, so it must be
 * byte-stable: we canonicalize all inputs (recursive key-sorting + tool
 * normalization) and derive a short content fingerprint from them.
 *
 * Few-shot items are taken from the canonical TurnItem union. Non-deterministic
 * kinds (assistant_reasoning / approval / user_input / compaction / error) are
 * excluded from the cache shape because they cannot be reproduced stably.
 */

/** A deterministic few-shot example for the immutable prefix. */
export type FewShotItem = TurnItem;

export interface ImmutablePrefixInput {
  systemPrompt: string;
  tools: ToolSpec[];
  pinnedConstraints: string[];
  /** Optional; this project currently has no few-shots. */
  fewShots?: FewShotItem[];
}

export interface ImmutablePrefix {
  fingerprint: string;
  tools: ToolSpec[];
  pinnedConstraints: string[];
  /** Verbatim system prompt retained so the prefix can be incrementally mutated. */
  systemPrompt?: string;
  /** Few-shot items retained so the prefix can be incrementally mutated. */
  fewShots?: FewShotItem[];
  /**
   * Monotonic revision counter, bumped on each {@link mutate}. Starts at 1 for a
   * freshly-created prefix. Lets callers cheaply detect that the prefix changed
   * without recomputing/comparing the fingerprint.
   */
  revision?: number;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function hashObject(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/** Recursively sort object keys so structurally-equal values serialize identically. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
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

/** Normalize tool specs into a canonical, name-sorted shape. */
export function normalizeTools(tools: ToolSpec[]): ToolSpec[] {
  return [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeSchema(tool.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Project a few-shot item onto its cache-stable shape, or null if the kind is
 * non-deterministic and must not participate in the prefix fingerprint.
 */
export function fewShotCacheShape(item: FewShotItem): JsonValue | null {
  switch (item.kind) {
    case "user_message":
      return { kind: item.kind, text: item.text };
    case "assistant_text":
      return { kind: item.kind, text: item.text };
    case "tool_call":
      return {
        kind: item.kind,
        callId: item.callId,
        toolName: item.toolName,
        arguments: canonicalize(item.arguments) as JsonValue,
      };
    case "tool_result":
      return {
        kind: item.kind,
        callId: item.callId,
        output: canonicalize(item.output) as JsonValue,
      };
    case "assistant_reasoning":
    case "approval":
    case "user_input":
    case "compaction":
    case "error":
    case "review":
      return null;
  }
}

/** Compute the content fingerprint for a set of immutable-prefix inputs. */
export function buildFingerprint(input: Required<ImmutablePrefixInput>): string {
  return hashObject({
    systemPrompt: input.systemPrompt,
    tools: normalizeTools(input.tools),
    pinned: input.pinnedConstraints,
    fewShots: input.fewShots
      .map(fewShotCacheShape)
      .filter((item): item is JsonValue => item !== null),
  });
}

/**
 * Build an immutable prefix from its inputs. Inputs are canonicalized and a
 * stable fingerprint is derived; the returned prefix is safe to reuse/cache as
 * long as its fingerprint matches a freshly-rebuilt input.
 */
export function createImmutablePrefix(input: ImmutablePrefixInput): ImmutablePrefix {
  const systemPrompt = input?.systemPrompt ?? "";
  const tools = normalizeTools(input?.tools ?? []);
  const pinnedConstraints = [...(input?.pinnedConstraints ?? [])];
  const fewShots = [...(input?.fewShots ?? [])];
  return {
    systemPrompt,
    tools,
    pinnedConstraints,
    fewShots,
    fingerprint: buildFingerprint({ systemPrompt, tools, pinnedConstraints, fewShots }),
    revision: 1,
  };
}

/**
 * Incrementally mutate an immutable prefix, recomputing its fingerprint +
 * prefix text and bumping the revision counter. Faithful to the original
 * `mutate`: patched fields are canonicalized (tools normalized, arrays copied)
 * and unspecified fields are carried over.
 */
export function mutate(
  prefix: ImmutablePrefix,
  patch: Partial<ImmutablePrefixInput>,
): ImmutablePrefix {
  const tools = patch.tools ? normalizeTools(patch.tools) : prefix.tools;
  const pinnedConstraints = patch.pinnedConstraints
    ? [...patch.pinnedConstraints]
    : prefix.pinnedConstraints;
  const fewShots = patch.fewShots ? [...patch.fewShots] : [...(prefix.fewShots ?? [])];
  const systemPrompt = patch.systemPrompt ?? prefix.systemPrompt ?? "";
  return {
    ...prefix,
    ...patch,
    systemPrompt,
    tools,
    pinnedConstraints,
    fewShots,
    fingerprint: buildFingerprint({ systemPrompt, tools, pinnedConstraints, fewShots }),
    revision: (prefix.revision ?? 1) + 1,
  };
}

/** Convenience over {@link mutate}: replace only the system prompt. */
export function setSystemPrompt(prefix: ImmutablePrefix, systemPrompt: string): ImmutablePrefix {
  return mutate(prefix, { systemPrompt });
}

/**
 * Env flag forcing the immutable-prefix integrity verification even in
 * production (`NEXUS_VERIFY_IMMUTABLE_PREFIX === "1"`). Faithful to the original
 * `VERIFY_IMMUTABLE_PREFIX_IN_PROD`.
 */
export const VERIFY_IMMUTABLE_PREFIX_IN_PROD = process.env.NEXUS_VERIFY_IMMUTABLE_PREFIX === "1";

/**
 * Whether the per-step immutable-prefix integrity check should run: always
 * outside production, and in production only when the env flag is set. Faithful
 * to the original `shouldVerifyImmutablePrefix`.
 */
export function shouldVerifyImmutablePrefix(): boolean {
  return process.env.NODE_ENV !== "production" || VERIFY_IMMUTABLE_PREFIX_IN_PROD;
}

/**
 * Self-verify a prefix by re-fingerprinting ITSELF; throws on drift. Faithful to
 * the original throwing `verifyImmutablePrefix(prefix)` integrity assertion used
 * at the top of each model step: re-derives the fingerprint from the prefix's
 * own fields and throws `immutable prefix fingerprint drift: expected <stored>,
 * actual <recomputed>` on mismatch, otherwise returns the (matching) fingerprint.
 */
export function verifyImmutablePrefix(prefix: ImmutablePrefix): string {
  const expected = buildFingerprint({
    systemPrompt: prefix.systemPrompt ?? "",
    tools: prefix.tools,
    pinnedConstraints: prefix.pinnedConstraints,
    fewShots: [...(prefix.fewShots ?? [])],
  });
  if (expected !== prefix.fingerprint) {
    throw new Error(
      `immutable prefix fingerprint drift: expected ${prefix.fingerprint}, actual ${expected}`,
    );
  }
  return expected;
}

/**
 * Alias for {@link verifyImmutablePrefix}, kept for call sites that import the
 * self-verify name. Both refer to the same throwing, re-fingerprinting check.
 */
export const verifyImmutablePrefixSelf = verifyImmutablePrefix;
