/**
 * React hook mirroring react-i18next's `useTranslation`. Re-renders on language
 * change (the i18n store is a zustand store). Returns `t` plus the current
 * language and a `changeLanguage` setter.
 */
import { useI18n, translate, type Language } from "./index.js";

export interface UseTranslation {
  t: (key: string, vars?: Record<string, string | number>) => string;
  language: Language;
  changeLanguage: (lang: Language) => void;
  i18n: { language: Language; changeLanguage: (lang: Language) => void };
}

export function useTranslation(): UseTranslation {
  const language = useI18n((s) => s.language);
  const changeLanguage = useI18n((s) => s.changeLanguage);
  const t = (key: string, vars?: Record<string, string | number>): string => translate(language, key, vars);
  return { t, language, changeLanguage, i18n: { language, changeLanguage } };
}
