/**
 * Lightweight, dependency-free i18n layer. Mirrors the i18next subset the app
 * uses — `t(key, vars)`, `changeLanguage`, and a localStorage+navigator language
 * detector — without pulling the package in. Translations live in resources.ts.
 */
import { create } from "zustand";
import { resources, type Language } from "./resources.js";

const STORAGE_KEY = "nexus.locale";

/** localStorage → navigator.language → "en". */
export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* localStorage unavailable */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  return nav.startsWith("zh") ? "zh" : "en";
}

interface I18nState {
  language: Language;
  changeLanguage(lang: Language): void;
}

export const useI18n = create<I18nState>((set) => ({
  language: detectLanguage(),
  changeLanguage(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    try {
      if (typeof document !== "undefined") document.documentElement.lang = lang;
    } catch {
      /* ignore */
    }
    set({ language: lang });
  },
}));

function resolveKey(tree: Record<string, unknown>, key: string): string | undefined {
  let current: unknown = tree;
  for (const part of key.split(".")) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}

/**
 * Resolve a key for `language`. Supports `_one`/`_other` plural suffixes when a
 * numeric `count` var is supplied. Falls back to English, then the raw key.
 */
export function translate(language: Language, key: string, vars?: Record<string, string | number>): string {
  const pluralKey =
    vars && typeof vars.count === "number" ? `${key}_${vars.count === 1 ? "one" : "other"}` : undefined;
  const candidates = [pluralKey, key].filter((k): k is string => Boolean(k));
  for (const candidate of candidates) {
    const hit = resolveKey(resources[language], candidate) ?? resolveKey(resources.en, candidate);
    if (hit !== undefined) return interpolate(hit, vars);
  }
  return interpolate(key, vars);
}

export type { Language };
