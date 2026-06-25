import type { Thread, ThreadSummary } from "../../contracts/threads.js";
import type { ListThreadsOptions } from "./types.js";

export function toThreadSummary(thread: Thread): ThreadSummary {
  const { turns: _turns, ...summary } = thread;
  return summary;
}

/**
 * The lowercased, newline-joined search corpus for a thread. Faithfully ported
 * from the original hybrid-thread-store `searchTextForThread`/`searchTextForSummary`:
 * id, title, workspace, model, mode, fork origin, plus every todo's content.
 */
export function searchTextForThread(thread: Pick<Thread, "id" | "title" | "workspace" | "model" | "mode"> & {
  forkedFromTitle?: string;
  forkedFromThreadId?: string;
  todos?: Thread["todos"];
}): string {
  return [
    thread.id,
    thread.title,
    thread.workspace,
    thread.model,
    thread.mode,
    thread.forkedFromTitle,
    thread.forkedFromThreadId,
    ...(thread.todos?.items.map((item) => item.content) ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function matchesThreadFilter(thread: Thread, options?: ListThreadsOptions): boolean {
  const archived = thread.status === "archived";
  if (options?.archivedOnly) {
    if (!archived) return false;
  } else if (!options?.includeArchived && archived) {
    return false;
  }
  // Side conversations are hidden unless explicitly requested.
  if (!options?.includeSide && (thread.relation ?? "primary") === "side") {
    return false;
  }
  if (options?.search) {
    const needle = options.search.trim().toLowerCase();
    if (needle && !searchTextForThread(thread).includes(needle)) {
      return false;
    }
  }
  return true;
}
