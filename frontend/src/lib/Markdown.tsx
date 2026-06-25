import { useEffect, useId, useRef, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import mermaid from "mermaid";
import { useStore } from "../store/store.js";
import { usePreferences } from "../store/preferences.js";

/** Extensions that make a bare token (in inline code) look like a source file. */
const FILE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|c|h|cpp|cc|cs|rb|php|sh|bash|ya?ml|toml|sql|swift|kt|lua|xml|vue|svelte|txt)$/i;

/** A `path[:line]` reference rendered as a clickable file-preview link (T3.10). */
function FileLink({ path, line, children }: { path: string; line?: number; children: React.ReactNode }): JSX.Element {
  return (
    <code
      role="button"
      tabIndex={0}
      title={`Open ${path}${line ? `:${line}` : ""}`}
      onClick={() => useStore.getState().openFilePreview(path, line)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          useStore.getState().openFilePreview(path, line);
        }
      }}
      className="ds-file-ref cursor-pointer rounded bg-accent/10 px-1 text-accent underline decoration-dotted underline-offset-2 hover:bg-accent/20"
    >
      {children}
    </code>
  );
}

/** Parse an inline-code token as a workspace file reference, or null. */
function parseFileRef(text: string): { path: string; line?: number } | null {
  const m = /^([\w./@~-]+?)(?::(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const path = m[1] ?? "";
  if (!path.includes("/") && !FILE_EXT_RE.test(path)) return null;
  if (!FILE_EXT_RE.test(path)) return null; // require a file extension to avoid false positives
  return { path, ...(m[2] ? { line: Number(m[2]) } : {}) };
}

// `strict` makes mermaid sanitize the rendered SVG (HTML tags/scripts in the
// diagram source are escaped) — important since the diagram text comes from the
// model. The theme is (re)applied per render below so diagrams follow the
// workbench's light/dark surface (mermaid's default theme paints message text
// near-black, which is unreadable on the dark canvas).
mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });

function Mermaid({ code }: { code: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "");
  const [invalid, setInvalid] = useState(false);
  // Re-render the diagram whenever the theme preference changes (Light/Dark/System).
  const themePref = usePreferences((s) => s.theme);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Follow the resolved app theme (data-theme on <html>). All diagrams on
        // a surface share one theme, so re-initializing the global config per
        // render is safe — concurrent renders set identical values.
        const isDark = document.documentElement.getAttribute("data-theme") === "dark";
        mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default", securityLevel: "strict" });
        // Validate FIRST with suppressErrors: this returns false for bad input
        // instead of throwing — and, crucially, avoids mermaid injecting its
        // "bomb" error diagram into the DOM. Only render when the source parses,
        // so a model that emits non-mermaid inside a ```mermaid fence degrades to
        // showing the raw code rather than a stack of orphaned error SVGs.
        const ok = await mermaid.parse(code, { suppressErrors: true });
        if (cancelled) return;
        if (!ok) {
          setInvalid(true);
          return;
        }
        const { svg } = await mermaid.render(`m${id}`, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setInvalid(false);
        }
      } catch {
        if (!cancelled) setInvalid(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id, themePref]);

  if (invalid) {
    return (
      <pre className="ds-code-block-html mermaid-error whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-5 text-ds-muted">
        {code}
      </pre>
    );
  }
  return <div className="mermaid" ref={ref} />;
}

/** Fenced code block with a language header + per-block copy button (T3.9). */
function CodeBlock({ language, children }: { language: string; children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const text = ref.current?.innerText ?? "";
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="ds-code-block group relative my-2 overflow-hidden rounded-lg border border-ds-border-muted">
      <div className="ds-code-block-language flex items-center justify-between bg-ds-subtle px-3 py-1 text-[11px] text-ds-faint">
        <span className="font-mono">{language || "code"}</span>
        <button
          type="button"
          onClick={copy}
          className="ds-code-block-action rounded px-1.5 py-0.5 text-[11px] opacity-0 transition hover:bg-ds-hover hover:text-ds-ink group-hover:opacity-100"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto px-3 py-2 text-[12.5px] leading-5">
        {children}
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          code(props) {
            const { className, children } = props as { className?: string; children?: React.ReactNode };
            const text = String(children ?? "");
            if (className?.includes("language-mermaid")) {
              return <Mermaid code={text.replace(/\n$/, "")} />;
            }
            // Inline code that looks like a `path[:line]` becomes a clickable
            // file-preview link (T3.10). Block code (language-*) is left as-is.
            if (!className) {
              const ref = parseFileRef(text);
              if (ref) {
                return (
                  <FileLink path={ref.path} line={ref.line}>
                    {children}
                  </FileLink>
                );
              }
            }
            return <code className={className}>{children}</code>;
          },
          pre(props) {
            const node = props.node as { children?: Array<{ properties?: { className?: string[] } }> } | undefined;
            const codeClass = node?.children?.[0]?.properties?.className?.join(" ") ?? "";
            const lang = /language-([\w-]+)/.exec(codeClass)?.[1] ?? "";
            // Mermaid blocks are rendered by the `code` renderer as a diagram; do
            // not wrap them in a <pre> code shell.
            if (lang === "mermaid") return <>{props.children}</>;
            return <CodeBlock language={lang}>{props.children}</CodeBlock>;
          },
          a(props) {
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
          img(props) {
            return <img {...props} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
