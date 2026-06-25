import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js";
import { useStore } from "../store/store.js";
import { api } from "../api/client.js";
import type { FileRetrieval } from "../api/types.js";

/**
 * Workspace file preview (T4.4). A modal overlay opened via store.openFilePreview
 * — path breadcrumb, size/language, a 20k-line Truncated banner, highlight.js
 * syntax highlighting, a line-number gutter with current-line highlight.
 */
export function FilePreviewPanel(): JSX.Element | null {
  const filePreview = useStore((s) => s.filePreview);
  const closeFilePreview = useStore((s) => s.closeFilePreview);
  const workspace = useStore((s) => s.thread?.workspace);
  const [file, setFile] = useState<FileRetrieval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lineRef = useRef<HTMLDivElement>(null);

  const path = filePreview?.path;
  const line = filePreview?.line;

  useEffect(() => {
    if (!path) return;
    setFile(null);
    setError(null);
    setLoading(true);
    let cancelled = false;
    void api
      .retrieveFile(path, workspace)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspace]);

  // Scroll the requested line into view once the file renders.
  useEffect(() => {
    if (file && line) lineRef.current?.scrollIntoView({ block: "center" });
  }, [file, line]);

  const lines = useMemo(() => (file ? file.content.split("\n") : []), [file]);
  const highlightedLines = useMemo(() => {
    if (!file) return [];
    const lang = hljs.getLanguage(file.language) ? file.language : undefined;
    // Highlight per line so each row can carry its own current-line background.
    // highlight.js escapes its input, so the resulting HTML is safe token markup.
    return lines.map((ln) => {
      try {
        return (lang ? hljs.highlight(ln, { language: lang, ignoreIllegals: true }) : hljs.highlightAuto(ln)).value;
      } catch {
        return escapeHtml(ln);
      }
    });
  }, [file, lines]);

  if (!filePreview) return null;

  return (
    <div className="ds-no-drag fixed inset-0 z-[85] flex items-center justify-center bg-black/40 p-6" onClick={closeFilePreview}>
      <div
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-[18px] border border-ds-border bg-ds-card shadow-[var(--ds-shadow-card-soft)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ds-border-muted px-4 py-2.5">
          <svg className="h-4 w-4 shrink-0 text-ds-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px] text-ds-ink">{path}</div>
            {file && (
              <div className="text-[11px] text-ds-faint">
                {file.language} · {file.lineCount} lines · {formatBytes(file.size)}
              </div>
            )}
          </div>
          <button type="button" onClick={closeFilePreview} aria-label="Close" className="rounded-md p-1 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink">✕</button>
        </div>

        {file?.truncated && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-800">
            Truncated to the first 20,000 lines.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto bg-ds-main/40">
          {loading ? (
            <div className="px-4 py-8 text-[13px] text-ds-faint">Loading…</div>
          ) : error ? (
            <div className="px-4 py-8 text-[13px] text-red-500">{error}</div>
          ) : (
            <div className="flex font-mono text-[12.5px] leading-5">
              <div className="select-none border-r border-ds-border-muted px-3 py-2 text-right text-ds-faint">
                {lines.map((_, i) => (
                  <div key={i} ref={line === i + 1 ? lineRef : undefined} className={line === i + 1 ? "bg-accent/15 -mx-3 px-3" : ""}>
                    {i + 1}
                  </div>
                ))}
              </div>
              <div className="min-w-0 flex-1 overflow-x-auto px-3 py-2">
                {highlightedLines.map((html, i) => (
                  <div key={i} className={line === i + 1 ? "bg-accent/10 -mx-3 px-3" : ""}>
                    <code className="hljs whitespace-pre" dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
