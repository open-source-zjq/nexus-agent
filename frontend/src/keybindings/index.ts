/**
 * Rebindable keyboard-shortcut engine (dependency-free). Provides a set of named
 * default bindings, modifier normalization (`mod` = Cmd on macOS, Ctrl else), a
 * persisted user-override store, conflict detection, and a global keydown
 * dispatcher that routes a matched chord to a registered command handler.
 */
import { create } from "zustand";

const STORAGE_KEY = "nexus.keybindings";
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");

export interface CommandDef {
  id: string;
  /** i18n-able label (plain text fallback). */
  label: string;
  /** Normalized default chord, e.g. "mod+n", "shift+tab". */
  defaultChord: string;
}

/** Named default bindings (20+ commands; `mod` resolves per platform). */
export const COMMANDS: CommandDef[] = [
  { id: "new-chat", label: "New chat", defaultChord: "mod+n" },
  { id: "choose-workspace", label: "Open workspace", defaultChord: "mod+o" },
  { id: "open-settings", label: "Settings", defaultChord: "mod+," },
  { id: "toggle-plan-mode", label: "Toggle plan mode", defaultChord: "shift+tab" },
  { id: "toggle-sidebar", label: "Toggle sidebar", defaultChord: "mod+b" },
  { id: "focus-composer", label: "Focus composer", defaultChord: "mod+l" },
  { id: "interrupt-turn", label: "Interrupt turn", defaultChord: "mod+." },
  { id: "go-chat", label: "Go to chat", defaultChord: "mod+1" },
  { id: "go-agents", label: "Go to agents", defaultChord: "mod+2" },
  { id: "go-connectors", label: "Go to connectors", defaultChord: "mod+3" },
  { id: "go-plugins", label: "Go to plugins", defaultChord: "mod+4" },
  { id: "undo", label: "Undo", defaultChord: "mod+z" },
  { id: "redo", label: "Redo", defaultChord: "mod+shift+z" },
  { id: "zoom-in", label: "Zoom in", defaultChord: "mod+=" },
  { id: "zoom-out", label: "Zoom out", defaultChord: "mod+-" },
  { id: "zoom-reset", label: "Reset zoom", defaultChord: "mod+0" },
  { id: "toggle-devtools", label: "Toggle devtools", defaultChord: "mod+alt+i" },
  { id: "minimize-window", label: "Minimize window", defaultChord: "mod+m" },
  { id: "toggle-fullscreen", label: "Toggle fullscreen", defaultChord: "mod+ctrl+f" },
  { id: "reload", label: "Reload", defaultChord: "mod+r" },
];

/** Lowercase + alias a KeyboardEvent.key to a stable token. */
function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  switch (k) {
    case " ":
      return "space";
    case "arrowup":
      return "up";
    case "arrowdown":
      return "down";
    case "arrowleft":
      return "left";
    case "arrowright":
      return "right";
    case "escape":
      return "esc";
    case "+":
      return "=";
    default:
      return k;
  }
}

const MODIFIER_KEYS = new Set(["control", "meta", "alt", "shift"]);

/** Canonical modifier order: mod (ctrl/cmd) → alt → shift → key. */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = normalizeKey(e.key);
  if (MODIFIER_KEYS.has(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** Re-order an authored chord into canonical form (so "shift+mod+z" matches). */
export function normalizeChord(chord: string): string {
  const tokens = chord
    .toLowerCase()
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  const has = (m: string): boolean => tokens.includes(m);
  const key = tokens.find((t) => !["mod", "ctrl", "cmd", "meta", "alt", "option", "shift"].includes(t)) ?? "";
  const parts: string[] = [];
  if (has("mod") || has("ctrl") || has("cmd") || has("meta")) parts.push("mod");
  if (has("alt") || has("option")) parts.push("alt");
  if (has("shift")) parts.push("shift");
  if (key) parts.push(normalizeKey(key));
  return parts.join("+");
}

/** Human-readable chord for display, platform-aware. */
export function formatChord(chord: string): string {
  return normalizeChord(chord)
    .split("+")
    .map((t) => {
      if (t === "mod") return isMac ? "⌘" : "Ctrl";
      if (t === "alt") return isMac ? "⌥" : "Alt";
      if (t === "shift") return isMac ? "⇧" : "Shift";
      if (t === "esc") return "Esc";
      if (t === "space") return "Space";
      return t.length === 1 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join(isMac ? "" : "+");
}

interface KeybindingState {
  /** Sparse user overrides: commandId → chord (defaults live in COMMANDS). */
  overrides: Record<string, string>;
  setBinding(commandId: string, chord: string): void;
  resetBinding(commandId: string): void;
  resetAll(): void;
}

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {};
}

function persist(overrides: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

export const useKeybindingStore = create<KeybindingState>((set, get) => ({
  overrides: loadOverrides(),
  setBinding(commandId, chord) {
    const overrides = { ...get().overrides, [commandId]: normalizeChord(chord) };
    persist(overrides);
    set({ overrides });
  },
  resetBinding(commandId) {
    const overrides = { ...get().overrides };
    delete overrides[commandId];
    persist(overrides);
    set({ overrides });
  },
  resetAll() {
    persist({});
    set({ overrides: {} });
  },
}));

/** Effective chord for a command (override or default). */
export function chordFor(commandId: string, overrides: Record<string, string>): string {
  const override = overrides[commandId];
  if (override) return override;
  const def = COMMANDS.find((c) => c.id === commandId);
  return def ? normalizeChord(def.defaultChord) : "";
}

/** Resolve every command → its effective chord. */
export function effectiveBindings(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cmd of COMMANDS) out[cmd.id] = chordFor(cmd.id, overrides);
  return out;
}

/** The command currently bound to `chord` (excluding `excludeId`), if any. */
export function findConflict(overrides: Record<string, string>, chord: string, excludeId?: string): string | undefined {
  const normalized = normalizeChord(chord);
  for (const cmd of COMMANDS) {
    if (cmd.id === excludeId) continue;
    if (chordFor(cmd.id, overrides) === normalized) return cmd.id;
  }
  return undefined;
}

// --- global dispatch --------------------------------------------------------

const handlers = new Map<string, () => void>();

/** Register a handler for a command id; returns an unregister fn. */
export function registerCommand(commandId: string, handler: () => void): () => void {
  handlers.set(commandId, handler);
  return () => {
    if (handlers.get(commandId) === handler) handlers.delete(commandId);
  };
}

/** Whether the event originates from a text input where shortcuts should defer. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Install the global keydown dispatcher. Matches the event's chord against the
 * effective bindings and invokes the registered handler (preventing default).
 * `shift+tab` is allowed through even from the composer (plan-mode toggle).
 */
export function installGlobalKeydown(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const chord = eventToChord(e);
    if (!chord) return;
    // Let plain typing and most chords pass inside text fields, except a small
    // allowlist (modifier combos are still global; bare keys in inputs defer).
    const editable = isEditableTarget(e.target);
    const hasModifier = chord.startsWith("mod") || chord.includes("alt");
    const isPlanToggle = chord === "shift+tab";
    if (editable && !hasModifier && !isPlanToggle) return;

    const overrides = useKeybindingStore.getState().overrides;
    for (const cmd of COMMANDS) {
      if (chordFor(cmd.id, overrides) === chord) {
        const handler = handlers.get(cmd.id);
        if (handler) {
          e.preventDefault();
          handler();
        }
        return;
      }
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
