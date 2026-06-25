import { useEffect, useMemo, useState } from "react";
import {
  COMMANDS,
  chordFor,
  eventToChord,
  findConflict,
  formatChord,
  useKeybindingStore,
} from "../keybindings/index.js";

/** Translate function shape (matches useTranslation().t). */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface KeybindingsEditorProps {
  /** i18n translate from the host page's useTranslation(). Falls back to plain English. */
  t?: Translate;
}

/**
 * Rebindable keyboard-shortcut editor. Lists every named command with its
 * effective chord; "Rebind" captures the next keystroke (with conflict
 * detection) and persists the override to the client-side keybindings engine
 * (localStorage `nexus.keybindings`). Mirrors the original settings panel's
 * shortcuts tab — search box, recording state, conflict notice, per-row reset.
 */
export function KeybindingsEditor({ t }: KeybindingsEditorProps = {}): JSX.Element {
  // Plain-text fallback so the component still renders if used without a host t().
  const tr: Translate = t ?? ((_key, _vars) => fallbackString(_key, _vars));

  const overrides = useKeybindingStore((s) => s.overrides);
  const setBinding = useKeybindingStore((s) => s.setBinding);
  const resetBinding = useKeybindingStore((s) => s.resetBinding);
  const resetAll = useKeybindingStore((s) => s.resetAll);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setCapturing(null);
        setConflict(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return; // modifier-only press; keep waiting
      e.preventDefault();
      const clash = findConflict(overrides, chord, capturing);
      if (clash) {
        setConflict(tr("settings.shortcutConflict", { command: labelFor(clash, tr) }));
        return;
      }
      setBinding(capturing, chord);
      setCapturing(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides, setBinding]);

  // Client-side filter: command id + translated label + current chord tokens.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((cmd) => {
      const chord = chordFor(cmd.id, overrides);
      const haystack = `${cmd.id} ${labelFor(cmd.id, tr)} ${formatChord(chord)} ${chord}`.toLowerCase();
      return haystack.includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, overrides]);

  return (
    <div className="flex flex-col gap-2">
      {/* Search + Reset all */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("settings.shortcutSearchPlaceholder")}
            aria-label={tr("settings.shortcutSearchPlaceholder")}
            className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card py-1.5 pl-8 pr-3 text-[13px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </div>
        <button
          type="button"
          onClick={() => resetAll()}
          className="shrink-0 rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[12.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
        >
          {tr("settings.shortcutResetAll")}
        </button>
      </div>

      {/* Capture hint / conflict notice */}
      {capturing && !conflict && (
        <div className="rounded-lg border border-ds-border-muted bg-ds-subtle/40 px-3 py-1.5 text-[12.5px] text-ds-muted">
          {tr("settings.shortcutCaptureHint")}
        </div>
      )}
      {conflict && (
        <div className="rounded-lg border border-red-300/70 bg-red-50/60 px-3 py-1.5 text-[12.5px] text-red-600 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300">
          {conflict}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-ds-border">
        {/* Column header */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-ds-border-muted bg-ds-subtle/40 px-3 py-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ds-faint">
          <span>{tr("settings.shortcutCommandColumn")}</span>
          <span>{tr("settings.shortcutBindingColumn")}</span>
          <span aria-hidden="true" className="w-[5.5rem]" />
        </div>
        <div className="divide-y divide-ds-border-muted">
          {filtered.map((cmd) => {
            const chord = chordFor(cmd.id, overrides);
            const isCapturing = capturing === cmd.id;
            const overridden = Boolean(overrides[cmd.id]);
            const formatted = formatChord(chord);
            return (
              <div
                key={cmd.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
              >
                <span className="min-w-0 truncate text-[13.5px] text-ds-ink">{labelFor(cmd.id, tr)}</span>
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setConflict(null);
                      setCapturing(isCapturing ? null : cmd.id);
                    }}
                    title={isCapturing ? tr("settings.shortcutCancel") : tr("settings.shortcutRebind")}
                    className="inline-flex max-w-full items-center gap-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-left text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover"
                  >
                    {isCapturing ? (
                      <span className="text-ds-muted">{tr("settings.shortcutRecording")}</span>
                    ) : formatted ? (
                      <kbd className="rounded-full bg-ds-subtle px-2 py-0.5 font-mono text-[12px] text-ds-muted">
                        {formatted}
                      </kbd>
                    ) : (
                      <span className="text-ds-faint">{tr("settings.shortcutUnassigned")}</span>
                    )}
                  </button>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-1">
                  {overridden && (
                    <button
                      type="button"
                      onClick={() => resetBinding(cmd.id)}
                      aria-label={tr("settings.shortcutReset")}
                      title={tr("settings.shortcutReset")}
                      className="rounded-lg p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function labelFor(commandId: string, tr: Translate): string {
  const def = COMMANDS.find((c) => c.id === commandId);
  if (!def) return commandId;
  // Prefer a per-command i18n key (settings.shortcutCmd.<id>) when present;
  // otherwise fall back to the engine's plain-text label.
  const key = `settings.shortcutCmd.${commandId}`;
  const translated = tr(key);
  return translated === key ? def.label : translated;
}

/** Plain-English fallback when no host t() is supplied. */
function fallbackString(key: string, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = {
    "settings.shortcutSearchPlaceholder": "Search shortcuts…",
    "settings.shortcutCommandColumn": "Command",
    "settings.shortcutBindingColumn": "Shortcut",
    "settings.shortcutRecording": "Press keys…",
    "settings.shortcutUnassigned": "Unassigned",
    "settings.shortcutCaptureHint": "Press a key combination. Esc cancels.",
    "settings.shortcutConflict": "{{command}} is already using this shortcut",
    "settings.shortcutReset": "Reset to default",
    "settings.shortcutResetAll": "Reset all",
    "settings.shortcutRebind": "Rebind",
    "settings.shortcutCancel": "Cancel",
  };
  const template = table[key];
  if (!template) return key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}
