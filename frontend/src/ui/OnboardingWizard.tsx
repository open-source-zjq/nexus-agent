import { useMemo, useState } from "react";
import { useStore } from "../store/store.js";
import { useTranslation } from "../i18n/useTranslation.js";
import { LANGUAGES, type Language } from "../i18n/resources.js";
import type { NexusConfig } from "../api/types.js";

export const ONBOARDING_FLAG = "nexus.onboarding.completed";

/** Mark the first-run wizard as completed so it won't auto-show again. */
export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_FLAG, "1");
  } catch {
    /* storage unavailable (private mode) — auto-show simply repeats; harmless */
  }
}

/** True when the wizard should auto-show: never completed AND no provider has a key yet. */
export function shouldAutoShowOnboarding(config: NexusConfig | null): boolean {
  let completed = false;
  try {
    completed = localStorage.getItem(ONBOARDING_FLAG) === "1";
  } catch {
    completed = false;
  }
  if (completed) return false;
  if (!config) return false;
  const anyKey = Object.values(config.providers ?? {}).some((p) => Boolean(p?.apiKey?.trim()));
  return !anyKey;
}

interface OnboardingWizardProps {
  /** Close the wizard without marking complete (dismiss / skip). */
  onClose: () => void;
}

/**
 * First-run setup wizard (T10.12). Two real steps:
 *   1. choose interface language (reuses changeLanguage)
 *   2. enter an API key for a provider (writes into config + saves)
 * Re-entrant: mounted from Settings → General; auto-shown on first run.
 * Every control advances or persists real state — no dead clicks.
 */
export function OnboardingWizard({ onClose }: OnboardingWizardProps): JSX.Element {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const { t, language, changeLanguage } = useTranslation();

  const providerNames = useMemo(() => Object.keys(config?.providers ?? {}), [config]);
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<string>(providerNames[0] ?? "");
  // Seed the field with the existing key (if any) so re-entry shows current state.
  const [apiKey, setApiKey] = useState<string>(() =>
    provider && config?.providers?.[provider]?.apiKey ? config.providers[provider].apiKey : "",
  );
  const [saving, setSaving] = useState(false);

  const onPickProvider = (name: string): void => {
    setProvider(name);
    setApiKey(config?.providers?.[name]?.apiKey ?? "");
  };

  const totalSteps = 2;

  const finish = async (): Promise<void> => {
    // Persist the API key into the chosen provider, if one was entered.
    if (config && provider && config.providers?.[provider]) {
      const trimmed = apiKey.trim();
      if (trimmed && trimmed !== config.providers[provider].apiKey) {
        setSaving(true);
        const next: NexusConfig = {
          ...config,
          providers: {
            ...config.providers,
            [provider]: { ...config.providers[provider], apiKey: trimmed },
          },
        };
        const ok = await saveConfig(next);
        setSaving(false);
        if (!ok) return; // surfaced via the store banner; keep the wizard open
      }
    }
    markOnboardingComplete();
    onClose();
  };

  const overlay =
    "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm";
  const card =
    "ds-no-drag w-full max-w-md overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl";
  const rowControl =
    "w-full min-w-0 rounded-xl border border-ds-border bg-ds-main/40 px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";
  const ghostBtn =
    "rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover";
  const primaryBtn =
    "rounded-xl bg-emerald-500 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-emerald-600 disabled:opacity-50";

  return (
    <div className={overlay} role="dialog" aria-modal="true" aria-label={t("onboarding.title")}>
      <div className={card}>
        <div className="flex items-start justify-between gap-4 border-b border-ds-border-muted px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ds-ink">{t("onboarding.title")}</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{t("onboarding.subtitle")}</p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-5">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-wide text-ds-faint">
            {t("onboarding.step", { current: step + 1, total: totalSteps })}
          </div>

          {step === 0 && (
            <div className="grid gap-2">
              <div className="text-[14px] font-semibold text-ds-ink">{t("onboarding.stepLanguage")}</div>
              <p className="text-[13px] leading-relaxed text-ds-muted">{t("onboarding.stepLanguageHint")}</p>
              <select
                aria-label={t("onboarding.stepLanguage")}
                value={language}
                onChange={(e) => changeLanguage(e.target.value as Language)}
                className={`${rowControl} mt-1`}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {step === 1 && (
            <div className="grid gap-2">
              <div className="text-[14px] font-semibold text-ds-ink">{t("onboarding.stepApiKey")}</div>
              <p className="text-[13px] leading-relaxed text-ds-muted">{t("onboarding.stepApiKeyHint")}</p>
              {providerNames.length > 1 && (
                <label className="mt-1 grid gap-1">
                  <span className="text-[13px] font-medium text-ds-ink">{t("onboarding.providerLabel")}</span>
                  <select
                    aria-label={t("onboarding.providerLabel")}
                    value={provider}
                    onChange={(e) => onPickProvider(e.target.value)}
                    className={rowControl}
                  >
                    {providerNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mt-1 grid gap-1">
                <span className="text-[13px] font-medium text-ds-ink">
                  {t("onboarding.apiKeyLabel")}
                  {provider ? <span className="font-normal text-ds-muted"> ({provider})</span> : null}
                </span>
                <input
                  type="password"
                  className={rowControl}
                  value={apiKey}
                  placeholder={t("onboarding.apiKeyPlaceholder")}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ds-border-muted px-5 py-4">
          <button type="button" onClick={onClose} className="text-[13px] font-medium text-ds-muted transition hover:text-ds-ink">
            {t("onboarding.skip")}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button type="button" onClick={() => setStep((s) => s - 1)} className={ghostBtn}>
                {t("onboarding.back")}
              </button>
            )}
            {step < totalSteps - 1 ? (
              <button type="button" onClick={() => setStep((s) => s + 1)} className={primaryBtn}>
                {t("onboarding.next")}
              </button>
            ) : (
              <button type="button" disabled={saving} onClick={() => void finish()} className={primaryBtn}>
                {saving ? t("common.loading") : t("onboarding.finish")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
