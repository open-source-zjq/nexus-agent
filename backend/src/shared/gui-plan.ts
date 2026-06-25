/**
 * Reserved-directory plan-path mechanism for GUI ("draft"/"refine") plans.
 *
 * GUI plans are confined to a single reserved workspace directory
 * (`.nexus-plan/plan`); the relative path must be a direct Markdown file under
 * that dir (no nesting, no `..`). Plan ids are stable, workspaces are matched
 * case-insensitively, and `nextAvailablePlanRelativePath` allocates a
 * non-colliding filename.
 */

/** Reserved directory for GUI plans (relative to the workspace root). */
export const GUI_PLAN_RELATIVE_DIR = ".nexus-plan/plan";

/** Reserved directories accepted by {@link isGuiPlanRelativePath}. */
export const GUI_PLAN_ACCEPTED_RELATIVE_DIRS = [GUI_PLAN_RELATIVE_DIR] as const;

/**
 * True when `value` is a direct Markdown file under the reserved plan dir.
 * Normalizes backslashes/`//`/leading `./` and lowercases; rejects nesting and
 * `..` segments.
 */
export function isGuiPlanRelativePath(value: string): boolean {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  if (!normalized.endsWith(".md")) return false;
  const matchedDir = GUI_PLAN_ACCEPTED_RELATIVE_DIRS.find((dir) => normalized.startsWith(`${dir}/`));
  if (!matchedDir) return false;
  const rest = normalized.slice(matchedDir.length + 1);
  if (!rest || rest.includes("/")) return false;
  return !rest.split("/").some((part) => part === "..");
}

/**
 * Alias of {@link isGuiPlanRelativePath} retained for call sites that asserted
 * the CURRENT reserved dir back when a separate legacy dir also existed.
 */
export function isGuiPlanCurrentRelativePath(value: string): boolean {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  if (!normalized.endsWith(".md")) return false;
  if (!normalized.startsWith(`${GUI_PLAN_RELATIVE_DIR}/`)) return false;
  const rest = normalized.slice(GUI_PLAN_RELATIVE_DIR.length + 1);
  if (!rest || rest.includes("/")) return false;
  return !rest.split("/").some((part) => part === "..");
}

/**
 * Stable plan id derived from the (normalized) workspace root + relative path:
 * `<workspaceRoot>:<relativePath>` (workspace trailing-slash stripped; relative
 * path normalized + lowercased).
 */
export function buildGuiPlanId(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const rel = relativePath
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  return `${root}:${rel}`;
}

/** Case-insensitive (and trailing-slash-insensitive) workspace-root equality. */
export function guiPlanWorkspaceMatches(actual: string, expected: string): boolean {
  return (
    actual.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() ===
    expected.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  );
}

/**
 * Build a plan relative path under the current reserved dir. When `suffix` is a
 * number > 1 it is appended as `-<n>` for collision avoidance.
 */
export function buildPlanRelativePath(featureName: string, suffix?: number): string {
  const safeSuffix = typeof suffix === "number" && suffix > 1 ? `-${Math.floor(suffix)}` : "";
  return `${GUI_PLAN_RELATIVE_DIR}/${featureName}${safeSuffix}.md`;
}

/**
 * Allocate a non-colliding plan relative path for `featureName`, trying
 * `feature.md`, `feature-2.md`, ... up to `maxAttempts`. When all are taken it
 * falls back to a `Date.now()`-suffixed name (which is treated as effectively
 * unique).
 */
export function nextAvailablePlanRelativePath(
  featureName: string,
  existingRelativePaths: Iterable<string>,
  maxAttempts = 50,
): string {
  const existing = new Set<string>([...existingRelativePaths]);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = buildPlanRelativePath(featureName, attempt);
    if (!existing.has(candidate)) return candidate;
  }
  return buildPlanRelativePath(`${featureName}-${Date.now()}`);
}
