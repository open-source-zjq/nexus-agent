import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/store.js";
import { useNav } from "../../store/nav.js";
import { api, getToken, setToken } from "../../api/client.js";
import type {
  CapabilitiesConfig,
  McpSearchDiagnostics,
  ModelConfig,
  ProviderConfig,
  NexusConfig,
  TurnItem,
} from "../../api/types.js";
import { useTranslation } from "../../i18n/useTranslation.js";
import { LANGUAGES, type Language } from "../../i18n/resources.js";
import { KeybindingsEditor } from "../KeybindingsEditor.js";
import {
  isTauri,
  pickWorkspaceDir,
  applyAppBehavior,
  openLogDir,
  type AppBehaviorSettings,
} from "../../lib/tauri.js";
import {
  fetchDisabledReason,
  fetchProviderModels,
  isFetchable,
  isHttpUrl,
  isUsableApiKey,
  makeModelConfig,
  modelsForProvider,
} from "../../lib/model-catalog.js";
import {
  usePreferences,
  type ThemePreference,
  type FontSizePreference,
  type DesktopBehaviorKey,
} from "../../store/preferences.js";

type ProviderKind = ProviderConfig["kind"];

/** Settings nav sections — the functional anchors plus static (cosmetic) chrome entries. */
interface NavItem {
  id: string;
  label: string;
  icon: JSX.Element;
  anchor?: string;
}

export function SettingsView(): JSX.Element {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const runtimeInfo = useStore((s) => s.runtimeInfo);
  const setView = useNav((s) => s.setView);
  const setOnboardingOpen = useNav((s) => s.setOnboardingOpen);
  const { t, language, changeLanguage } = useTranslation();

  // Native folder picker is only available under the Tauri desktop host (T10.11).
  const tauriHost = isTauri();

  // Appearance / behavior preferences (T10.6) — local, persisted to this device.
  const theme = usePreferences((s) => s.theme);
  const fontSize = usePreferences((s) => s.fontSize);
  const notifyOnReplyComplete = usePreferences((s) => s.notifyOnReplyComplete);
  const setTheme = usePreferences((s) => s.setTheme);
  const setFontSize = usePreferences((s) => s.setFontSize);
  const setNotifyOnReplyComplete = usePreferences((s) => s.setNotifyOnReplyComplete);

  // T10.8 desktop-behavior preferences (Tauri host only; persisted to device).
  const desktopBehavior = usePreferences((s) => s.desktopBehavior);
  const setDesktopBehavior = usePreferences((s) => s.setDesktopBehavior);

  const [draft, setDraft] = useState<NexusConfig | null>(config);
  const [token, setLocalToken] = useState(getToken());
  const [modelsJson, setModelsJson] = useState("");
  // Per-provider headers are edited as JSON text and parsed on save.
  const [headersJson, setHeadersJson] = useState<Record<string, string>>({});

  // --- T10.4 managed model catalog -----------------------------------------
  // Provider names added this session that have not been "Added" (confirmed) yet.
  // A draft provider shows the Unsaved badge + Add/Cancel flow and is purely
  // local until confirmed (it persists like any other provider only on Save).
  const [draftProviders, setDraftProviders] = useState<Set<string>>(new Set());
  // Per-provider "type a model id" chip-editor input buffer.
  const [modelDraftInput, setModelDraftInput] = useState<Record<string, string>>({});
  // Per-provider inline Fetch-from-API status line.
  type FetchState = { mode: "fetching" | "success" | "error"; message: string };
  const [fetchStatus, setFetchStatus] = useState<Record<string, FetchState>>({});
  const [fetching, setFetching] = useState<Record<string, boolean>>({});
  // The provider pending a delete confirmation (null = no dialog open).
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; lines: string[] } | null>(null);
  // MCP servers + skills roots are edited as JSON text and parsed on save.
  const [mcpServersJson, setMcpServersJson] = useState("");
  const [skillsRootsText, setSkillsRootsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Which nav section is active (highlighted). Driven by clicks and a scroll-spy
  // so the sidebar highlight follows the section actually in view, instead of
  // being frozen on the first item.
  const [activeNav, setActiveNav] = useState("settings-general");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // --- T10.9 MCP search diagnostics (read-only) -----------------------------
  // Fed by GET /v1/runtime/tools (mcpSearch) + GET /v1/mcp (indexedToolCount).
  // There is NO backend MCP hot-reload endpoint; "Reload status" is a real
  // client re-fetch of these two read endpoints, never a phantom reload.
  const [mcpDiag, setMcpDiag] = useState<McpSearchDiagnostics | null>(null);
  const [mcpIndexedCount, setMcpIndexedCount] = useState<number | null>(null);
  const [mcpDiagLoading, setMcpDiagLoading] = useState(false);

  const loadMcpDiagnostics = async (): Promise<void> => {
    setMcpDiagLoading(true);
    try {
      const [tools, status] = await Promise.all([api.toolDiagnostics(), api.mcpStatus()]);
      setMcpDiag(tools.mcpSearch ?? null);
      setMcpIndexedCount(status.indexedToolCount ?? tools.mcpSearch?.indexedToolCount ?? null);
    } catch {
      setMcpDiag(null);
      setMcpIndexedCount(null);
    } finally {
      setMcpDiagLoading(false);
    }
  };

  // Fetch diagnostics once on mount (mirrors the original's on-enter refresh).
  useEffect(() => {
    void loadMcpDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (config) {
      setDraft(structuredClone(config));
      setModelsJson(JSON.stringify(config.models, null, 2));
      const hj: Record<string, string> = {};
      for (const [name, provider] of Object.entries(config.providers)) {
        hj[name] = provider.headers && Object.keys(provider.headers).length > 0 ? JSON.stringify(provider.headers, null, 2) : "";
      }
      setHeadersJson(hj);
      const caps = config.capabilities;
      setMcpServersJson(
        caps?.mcp?.servers && caps.mcp.servers.length > 0 ? JSON.stringify(caps.mcp.servers, null, 2) : "",
      );
      setSkillsRootsText((caps?.skills?.roots ?? []).join("\n"));
    }
  }, [config]);
  // First-run auto-show is mounted app-level in AppShell (T10.12); Settings only
  // provides the re-entrant "Run setup wizard" trigger via the shared nav flag.

  const goBack = (): void => setView("workbench");

  // T10.11 — Workspace path controls.
  const browseWorkspace = async (): Promise<void> => {
    const picked = await pickWorkspaceDir(draft?.defaultWorkspace || undefined);
    if (picked && draft) setDraft({ ...draft, defaultWorkspace: picked });
  };
  // Reset to the runtime's default workspace; if unknown, clear so the backend
  // falls back to its own default (process.cwd()).
  const restoreDefaultWorkspace = (): void => {
    if (!draft) return;
    setDraft({ ...draft, defaultWorkspace: runtimeInfo?.defaultWorkspace ?? "" });
  };

  // --- T10.8 desktop behavior ------------------------------------------------
  // Toggle a desktop-behavior flag: persist it to the device (preferences) and
  // re-apply the whole behavior set natively via `apply_app_behavior`. No-op on
  // the plain web build (the controls render disabled there).
  const toggleDesktopBehavior = (key: DesktopBehaviorKey): void => {
    if (!tauriHost) return;
    const next: AppBehaviorSettings = { ...desktopBehavior, [key]: !desktopBehavior[key] };
    setDesktopBehavior(key, next[key]);
    void applyAppBehavior(next);
  };

  if (!draft) {
    return (
      <div className="ds-no-drag flex h-full min-h-0 w-full min-w-0 items-center justify-center bg-ds-main text-[13px] text-ds-faint">
        Loading…
      </div>
    );
  }

  const updateProvider = (name: string, field: string, value: string | undefined): void => {
    setDraft({
      ...draft,
      providers: { ...draft.providers, [name]: { ...draft.providers[name], [field]: value } },
    });
  };

  // Switching protocol also resets base URL + endpoint format to the new kind's
  // defaults, so an OpenAI URL never lingers on an Anthropic provider.
  const changeKind = (name: string, kind: ProviderKind): void => {
    setDraft({
      ...draft,
      providers: {
        ...draft.providers,
        [name]: {
          ...draft.providers[name],
          kind,
          baseUrl: kind === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
          endpointFormat: kind === "anthropic" ? "messages" : "chat_completions",
        },
      },
    });
  };

  /**
   * Seed a fresh DRAFT provider (T10.4 draft flow). It is purely local — it
   * renders with the Unsaved badge + Add/Cancel actions and is treated like a
   * real provider only after the user confirms (Add) or persists via Save.
   */
  const addDraftProvider = (): void => {
    // A neutral, non-colliding default name; the user can rename it inline.
    let index = Object.keys(draft.providers).length + 1;
    let name = t("settings.modelProviderNewName", { index });
    while (draft.providers[name]) {
      index += 1;
      name = t("settings.modelProviderNewName", { index });
    }
    setDraft({
      ...draft,
      providers: {
        ...draft.providers,
        [name]: {
          kind: "openai",
          apiKey: "",
          baseUrl: "https://api.example.com/v1",
          endpointFormat: "chat_completions",
          headers: {},
        },
      },
    });
    setHeadersJson({ ...headersJson, [name]: "" });
    setDraftProviders(new Set([...draftProviders, name]));
    setError(null);
  };

  /** Confirm a draft provider: clear its draft flag and activate it if it has a key. */
  const confirmDraftProvider = (name: string): void => {
    const next = new Set(draftProviders);
    next.delete(name);
    setDraftProviders(next);
    const provider = draft.providers[name];
    // "Add saves the configuration; if it has a key, also switch to it" — map the
    // original activate to the closest faithful target here (the default model).
    if (provider && isUsableApiKey(provider.apiKey)) {
      const first = modelsForProvider(draft.models, name)[0];
      if (first) setDraft({ ...draft, defaultModel: first.id });
    }
  };

  const removeProvider = (name: string): void => {
    const providers = { ...draft.providers };
    delete providers[name];
    // Prune models that reference the removed provider so we never persist a
    // dangling reference, and repoint defaultModel if it pointed at one.
    const models = draft.models.filter((m) => m?.provider !== name);
    const defaultModel = models.some((m) => m.id === draft.defaultModel) ? draft.defaultModel : models[0]?.id;
    setDraft({ ...draft, providers, models, defaultModel });
    setModelsJson(JSON.stringify(models, null, 2));
    const hj = { ...headersJson };
    delete hj[name];
    setHeadersJson(hj);
    const dp = new Set(draftProviders);
    dp.delete(name);
    setDraftProviders(dp);
  };

  /** Cancel/discard a draft provider (same effect as removing the unsaved row). */
  const discardDraftProvider = (name: string): void => {
    removeProvider(name);
  };

  // --- per-provider model chip list (edits the flat draft.models[]) ----------
  // Add a model id under a provider. Mirrors the original chip-list editor: the
  // backend has no per-provider models[], so the flat catalog is grouped by the
  // provider name and a new chip becomes a flat-catalog ModelConfig entry.
  const addProviderModel = (name: string, rawId: string): void => {
    const id = rawId.trim();
    if (!id) return;
    if (draft.models.some((m) => m.id === id)) {
      // The id already exists — don't create a duplicate; just clear the input.
      setModelDraftInput({ ...modelDraftInput, [name]: "" });
      return;
    }
    const models = [...draft.models, makeModelConfig(id, name)];
    setDraft({ ...draft, models, defaultModel: draft.defaultModel ?? id });
    setModelsJson(JSON.stringify(models, null, 2));
    setModelDraftInput({ ...modelDraftInput, [name]: "" });
  };

  const removeProviderModel = (name: string, id: string): void => {
    const models = draft.models.filter((m) => m.id !== id);
    const defaultModel = models.some((m) => m.id === draft.defaultModel) ? draft.defaultModel : models[0]?.id;
    setDraft({ ...draft, models, defaultModel });
    setModelsJson(JSON.stringify(models, null, 2));
  };

  /** Merge fetched ids (deduped) into the provider's model chip list. */
  const mergeFetchedModels = (name: string, ids: string[]): void => {
    const have = new Set(draft.models.map((m) => m.id));
    const fresh = ids.filter((id) => !have.has(id)).map((id) => makeModelConfig(id, name));
    if (fresh.length === 0) return;
    const models = [...draft.models, ...fresh];
    setDraft({ ...draft, models, defaultModel: draft.defaultModel ?? fresh[0]?.id });
    setModelsJson(JSON.stringify(models, null, 2));
  };

  /** REAL client-side fetch to the provider's own /models (no backend route). */
  const fetchModels = async (name: string): Promise<void> => {
    const provider = draft.providers[name];
    if (!provider) return;
    // Functional updaters: a second provider's Fetch can run concurrently, so we
    // must merge into the latest map rather than a snapshot captured at call time.
    setFetching((prev) => ({ ...prev, [name]: true }));
    setFetchStatus((prev) => ({ ...prev, [name]: { mode: "fetching", message: t("settings.modelProviderTesting") } }));
    try {
      const existing = modelsForProvider(draft.models, name).map((m) => m.id);
      const { newIds, allIds } = await fetchProviderModels(provider, existing);
      mergeFetchedModels(name, newIds);
      setFetchStatus((prev) => ({
        ...prev,
        [name]: {
          mode: "success",
          message: t("settings.modelProviderFetchedModels", { total: newIds.length || allIds.length }),
        },
      }));
    } catch (e) {
      setFetchStatus((prev) => ({
        ...prev,
        [name]: { mode: "error", message: t("settings.modelProviderFetchError", { message: (e as Error).message }) },
      }));
    } finally {
      setFetching((prev) => ({ ...prev, [name]: false }));
    }
  };

  /**
   * Derive the read-only in-use warnings for deleting a provider, from the REAL
   * config here: the default model's provider (chat), media endpoints whose base
   * URL matches the provider's, and write inline completion (no per-provider id
   * exists, so it warns whenever inline completion is on).
   */
  const deleteInUseLines = (name: string): string[] => {
    const lines: string[] = [];
    const provider = draft.providers[name];
    const providerBase = (provider?.baseUrl ?? "").trim().replace(/\/+$/, "");
    const defaultProvider = draft.models.find((m) => m.id === draft.defaultModel)?.provider;
    if (defaultProvider === name) lines.push(t("settings.modelProviderDeleteInUseChat"));
    const mediaMatches = (endpoint: string | undefined): boolean => {
      const e = (endpoint ?? "").trim().replace(/\/+$/, "");
      return providerBase !== "" && e !== "" && e === providerBase;
    };
    const m = caps.media;
    if (m?.enabled) {
      if (mediaMatches(m.image?.endpoint)) lines.push(t("settings.modelProviderDeleteInUseImage"));
      if (mediaMatches(m.speech?.endpoint)) lines.push(t("settings.modelProviderDeleteInUseSpeech"));
      if (mediaMatches(m.music?.endpoint)) lines.push(t("settings.modelProviderDeleteInUseMusic"));
      if (mediaMatches(m.video?.endpoint)) lines.push(t("settings.modelProviderDeleteInUseVideo"));
    }
    return lines;
  };

  /** Open the delete-confirm dialog (draft rows discard immediately, no prompt). */
  const requestDeleteProvider = (name: string): void => {
    if (draftProviders.has(name)) {
      discardDraftProvider(name);
      return;
    }
    setDeleteTarget({ name, lines: deleteInUseLines(name) });
  };

  const confirmDeleteProvider = (): void => {
    if (deleteTarget) removeProvider(deleteTarget.name);
    setDeleteTarget(null);
  };

  /** "Use this provider" — set the default model to this provider's first model. */
  const useProvider = (name: string): void => {
    const first = modelsForProvider(draft.models, name)[0];
    if (first) setDraft({ ...draft, defaultModel: first.id });
  };

  /**
   * Rename (re-key) a provider. Re-keying `providers{}` requires repointing every
   * `model.provider` to the new name so the flat catalog never orphans a model.
   * The first (default) provider's id is locked in the UI, so this only fires for
   * custom/draft rows. A blank or colliding name is ignored.
   */
  const renameProvider = (oldName: string, rawNew: string): void => {
    const newName = rawNew;
    if (newName === oldName) return;
    if (newName.trim() === "" || draft.providers[newName]) {
      // Keep the keystroke responsive but never collide/blank: drop silently.
      // (The user can keep typing until the name is unique and non-empty.)
      return;
    }
    // Rebuild providers preserving key order so the row stays put.
    const providers: Record<string, ProviderConfig> = {};
    for (const [key, value] of Object.entries(draft.providers)) {
      providers[key === oldName ? newName : key] = value;
    }
    const models = draft.models.map((m) => (m.provider === oldName ? { ...m, provider: newName } : m));
    setDraft({ ...draft, providers, models });
    setModelsJson(JSON.stringify(models, null, 2));
    const hj = { ...headersJson };
    if (oldName in hj) {
      hj[newName] = hj[oldName];
      delete hj[oldName];
      setHeadersJson(hj);
    }
    if (draftProviders.has(oldName)) {
      const dp = new Set(draftProviders);
      dp.delete(oldName);
      dp.add(newName);
      setDraftProviders(dp);
    }
    setModelDraftInput((prev) => {
      if (!(oldName in prev)) return prev;
      const next = { ...prev };
      next[newName] = next[oldName];
      delete next[oldName];
      return next;
    });
  };

  // --- capabilities ---------------------------------------------------------
  // Shallow-merge a patch into one capability sub-block, preserving other blocks.
  const caps: CapabilitiesConfig = draft.capabilities ?? {};
  const updateCapability = <K extends keyof CapabilitiesConfig>(
    key: K,
    patch: Partial<NonNullable<CapabilitiesConfig[K]>>,
  ): void => {
    const existing = (caps[key] ?? {}) as Record<string, unknown>;
    setDraft({
      ...draft,
      capabilities: { ...caps, [key]: { ...existing, ...patch } },
    });
  };

  // T10.9 — patch the persisted MCP BM25 tuning (capabilities.mcp.search). Only
  // the numeric knobs the backend McpSearchTuningSchema accepts round-trip here
  // ({topKDefault,topKMax,minScore}); `enabled` lives on capabilities.mcp. An
  // empty input is dropped to `undefined` so we never persist a NaN.
  const mcpSearch = caps.mcp?.search;
  const updateMcpSearch = (
    patch: Partial<NonNullable<NonNullable<CapabilitiesConfig["mcp"]>["search"]>>,
  ): void => {
    const existingMcp = caps.mcp ?? { enabled: false };
    const existingSearch = existingMcp.search ?? {};
    setDraft({
      ...draft,
      capabilities: {
        ...caps,
        mcp: { ...existingMcp, search: { ...existingSearch, ...patch } },
      },
    });
  };

  // Patch one media modality sub-block (image/speech/music/video), preserving
  // the other modalities and the media `enabled` flag. Empty strings are dropped
  // to `undefined` so a cleared input never persists an empty field.
  type MediaModality = "image" | "speech" | "music" | "video";
  type MediaEndpoint = NonNullable<NonNullable<CapabilitiesConfig["media"]>["image"]>;
  const media = caps.media;
  const updateMedia = (modality: MediaModality, patch: Partial<MediaEndpoint>): void => {
    const existingMedia = media ?? { enabled: false };
    const existingModality = (existingMedia[modality] ?? {}) as MediaEndpoint;
    setDraft({
      ...draft,
      capabilities: {
        ...caps,
        media: { ...existingMedia, [modality]: { ...existingModality, ...patch } },
      },
    });
  };
  // Coerce a text input to a trimmed string or undefined (so empties are dropped).
  const textOrUndef = (value: string): string | undefined => (value.trim() === "" ? undefined : value);
  // Coerce a number input to a positive number or undefined.
  const numOrUndef = (value: string): number | undefined => (value.trim() === "" ? undefined : Number(value));

  const onSave = async (): Promise<void> => {
    // The managed catalog (per-provider chip lists) is the source of truth for
    // the model list — no raw-JSON parse footgun. `modelsJson` is kept in sync as
    // the read-only advanced view only.
    const models: ModelConfig[] = draft.models;
    const providers = { ...draft.providers };
    for (const [name, text] of Object.entries(headersJson)) {
      if (!providers[name]) continue;
      const trimmed = (text ?? "").trim();
      if (trimmed === "") {
        providers[name] = { ...providers[name], headers: {} };
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        setError(`Invalid headers JSON for "${name}": ${(e as Error).message}`);
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError(`Headers for "${name}" must be a JSON object of string values.`);
        return;
      }
      providers[name] = { ...providers[name], headers: parsed as Record<string, string> };
    }
    // Don't persist a model that points at a provider that no longer exists.
    for (const model of models) {
      if (!model?.provider || !providers[model.provider]) {
        setError(`Model "${model?.id ?? "?"}" references unknown provider "${model?.provider ?? ""}".`);
        return;
      }
    }
    const defaultModel = models.some((m) => m.id === draft.defaultModel) ? draft.defaultModel : models[0]?.id;

    // Fold the JSON/multiline capability editors back into the capabilities block.
    let capabilities = draft.capabilities;
    if (capabilities) {
      let mcpServers: unknown = capabilities.mcp?.servers ?? [];
      const trimmedMcp = mcpServersJson.trim();
      if (trimmedMcp !== "") {
        try {
          mcpServers = JSON.parse(trimmedMcp);
        } catch (e) {
          setError(t("settings.mcpInvalidJson", { message: (e as Error).message }));
          return;
        }
        if (!Array.isArray(mcpServers)) {
          setError(t("settings.mcpMustBeArray"));
          return;
        }
      } else {
        mcpServers = [];
      }
      const roots = skillsRootsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      capabilities = {
        ...capabilities,
        ...(capabilities.mcp ? { mcp: { ...capabilities.mcp, servers: mcpServers as never } } : {}),
        ...(capabilities.skills ? { skills: { ...capabilities.skills, roots } } : {}),
      };
    }

    setError(null);
    setToken(token);
    if (await saveConfig({ ...draft, providers, models, defaultModel, capabilities })) setView("workbench");
  };

  const scrollTo = (anchor?: string): void => {
    if (!anchor) return;
    setActiveNav(anchor);
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scroll-spy: highlight the nav item for the section currently at the top of
  // the scroll container. We pick the last section whose top has crossed a
  // trigger line in the upper quarter of the viewport — deterministic, unlike an
  // IntersectionObserver whose callback only reports the entries that changed.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const sections = Array.from(root.querySelectorAll<HTMLElement>("section[id^='settings-']"));
      if (sections.length === 0) return;
      const rootTop = root.getBoundingClientRect().top;
      const trigger = root.clientHeight * 0.25;
      let current = sections[0].id;
      for (const s of sections) {
        if (s.getBoundingClientRect().top - rootTop <= trigger) current = s.id;
        else break;
      }
      setActiveNav(current);
    };
    const onScroll = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navItems: NavItem[] = [
    {
      id: "general",
      label: t("settings.general"),
      anchor: "settings-general",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      ),
    },
    {
      id: "desktop",
      label: t("settings.desktop"),
      anchor: "settings-desktop",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
      ),
    },
    {
      id: "providers",
      label: "Providers",
      anchor: "settings-providers",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m6.3 20.3 2.4-2.4" /><path d="m2 22 3-3" /><path d="M7.5 13.5 10 11" /><path d="M10.5 16.5 13 14" /><path d="m18 3-4 4h6l-4 4" /></svg>
      ),
    },
    {
      id: "defaults",
      label: "Defaults",
      anchor: "settings-defaults",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></svg>
      ),
    },
    {
      id: "media",
      label: "Media generation",
      anchor: "settings-media",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
      ),
    },
    {
      id: "capabilities",
      label: "Capabilities",
      anchor: "settings-capabilities",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></svg>
      ),
    },
    {
      id: "mcp",
      label: t("settings.mcpAdvanced"),
      anchor: "settings-mcp",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><path d="M14 7h4a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-4" /><path d="M10 17H6a2 2 0 0 1-2-2v0a2 2 0 0 1 2-2h4" /></svg>
      ),
    },
    {
      id: "shortcuts",
      label: t("settings.shortcuts"),
      anchor: "settings-shortcuts",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01" /><path d="M10 8h.01" /><path d="M14 8h.01" /><path d="M18 8h.01" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" /><path d="M7 16h10" /></svg>
      ),
    },
    {
      id: "audit",
      label: t("settings.toolAudit"),
      anchor: "settings-audit",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h2" /><path d="M8 17h6" /></svg>
      ),
    },
    {
      id: "runtime",
      label: "Runtime token",
      anchor: "settings-runtime",
      icon: (
        <svg className="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></svg>
      ),
    },
  ];

  const rowControl =
    "w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";
  const jsonEditor =
    "w-full min-w-0 rounded-xl border border-ds-border bg-ds-main/50 px-3 py-2 font-mono text-[12.5px] leading-5 text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";
  const labelText = "text-[14px] font-semibold text-ds-ink";
  const descText = "mt-0.5 text-[13px] leading-relaxed text-ds-muted";
  const ghostBtn =
    "shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover";

  return (
    <div className="ds-no-drag flex h-full min-h-0 w-full min-w-0 bg-ds-main">

      <aside className="ds-drag flex shrink-0 flex-col border-r border-ds-border bg-ds-sidebar backdrop-blur-md" style={{ width: "248px" }}>
        <div className="px-3 pb-3 pt-3">
          <div aria-hidden="true" className="ds-titlebar-safe-block"></div>
          <button type="button" onClick={goBack} className="ds-no-drag flex items-center gap-2 rounded-xl px-2 py-2 text-[14px] text-ds-muted hover:bg-ds-hover hover:text-ds-ink">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
            Back
          </button>
        </div>

        <nav className="ds-no-drag flex flex-col gap-0.5 px-2">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => scrollTo(item.anchor)}
              className={
                item.anchor === activeNav
                  ? "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition bg-ds-subtle text-ds-ink shadow-sm ring-1 ring-ds-border-muted"
                  : "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition text-ds-muted hover:bg-ds-hover"
              }
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ds-no-drag mt-auto border-t border-ds-border p-3">
          <div className="flex items-center gap-2 rounded-xl px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ds-subtle text-ds-muted">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="4" y1="21" y2="14" /><line x1="4" x2="4" y1="10" y2="3" /><line x1="12" x2="12" y1="21" y2="12" /><line x1="12" x2="12" y1="8" y2="3" /><line x1="20" x2="20" y1="21" y2="16" /><line x1="20" x2="20" y1="12" y2="3" /><line x1="2" x2="6" y1="14" y2="14" /><line x1="10" x2="14" y1="8" y2="8" /><line x1="18" x2="22" y1="16" y2="16" /></svg>
            </div>
            <div className="min-w-0 text-[12px] text-ds-muted">
              <div className="truncate font-medium text-ds-ink">Nexus</div>
              <div className="truncate">Preferences are stored locally.</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="ds-no-drag flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-10 py-10">
        <div className="mx-auto max-w-3xl">

          {/* Only nag when no provider has a key yet. Saved keys come back masked
              ("********"), which is still non-empty, so a configured provider
              correctly dismisses this banner. */}
          {draft && !Object.values(draft.providers).some((p) => (p.apiKey ?? "").trim().length > 0) && (
            <div className="mb-6 rounded-2xl border border-amber-300/80 bg-amber-50/95 px-5 py-4 text-amber-950 shadow-sm dark:border-amber-700/60 dark:bg-amber-950/35 dark:text-amber-100">
              <div className="text-[15px] font-semibold">API key required</div>
              <p className="mt-1 text-[13px] leading-6 text-amber-900/90 dark:text-amber-100/90">Add a provider API key below before starting the local assistant runtime. Keys are stored on the local runtime in ~/.nexus-agent/config.json.</p>
            </div>
          )}

          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight text-ds-ink">Settings</h1>
            <p className="mt-1 text-[14px] text-ds-muted">Manage providers, defaults, models, capabilities, and runtime access.</p>
          </div>

          {error && (
            <div className="mb-6 rounded-2xl border border-red-300/80 bg-red-50/95 px-5 py-3 text-[13px] text-red-900 shadow-sm dark:border-red-700/60 dark:bg-red-950/35 dark:text-red-100">
              {error}
            </div>
          )}

          {/* ========== SECTION: General ========== */}
          <section id="settings-general" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">{t("settings.general")}</h2>
            </div>
            <div className="flex flex-col gap-5 px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("common.language")}</div>
                  <p className={descText}>{t("settings.languageHint")}</p>
                </div>
                <select
                  aria-label={t("common.language")}
                  value={language}
                  onChange={(e) => changeLanguage(e.target.value as Language)}
                  className={`${rowControl} max-w-[12rem]`}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("settings.theme")}</div>
                  <p className={descText}>{t("settings.themeHint")}</p>
                </div>
                <select
                  aria-label={t("settings.theme")}
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as ThemePreference)}
                  className={`${rowControl} max-w-[12rem]`}
                >
                  <option value="system">{t("settings.themeSystem")}</option>
                  <option value="light">{t("settings.themeLight")}</option>
                  <option value="dark">{t("settings.themeDark")}</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("settings.fontSize")}</div>
                  <p className={descText}>{t("settings.fontSizeHint")}</p>
                </div>
                <select
                  aria-label={t("settings.fontSize")}
                  value={fontSize}
                  onChange={(e) => setFontSize(e.target.value as FontSizePreference)}
                  className={`${rowControl} max-w-[12rem]`}
                >
                  <option value="small">{t("settings.fontSizeSmall")}</option>
                  <option value="medium">{t("settings.fontSizeMedium")}</option>
                  <option value="large">{t("settings.fontSizeLarge")}</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("settings.replyNotification")}</div>
                  <p className={descText}>{t("settings.replyNotificationHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifyOnReplyComplete}
                  aria-label={t("settings.replyNotification")}
                  onClick={() => setNotifyOnReplyComplete(!notifyOnReplyComplete)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    notifyOnReplyComplete ? "bg-ds-accent" : "bg-ds-border"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                      notifyOnReplyComplete ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("settings.setupAssistant")}</div>
                  <p className={descText}>{t("settings.setupAssistantHint")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setOnboardingOpen(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" /></svg>
                  {t("settings.runSetupWizard")}
                </button>
              </div>
            </div>
          </section>

          {/* ========== SECTION: Desktop behavior (T10.8) ========== */}
          {/* Window + startup behavior for the Tauri desktop host. Toggles call
              `apply_app_behavior` natively (via the wrapper) and persist to this
              device (preferences). In a plain browser the controls render DISABLED
              with a "desktop app only" tooltip — never a dead no-op. */}
          <section id="settings-desktop" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">{t("settings.desktop")}</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{t("settings.desktopHint")}</p>
            </div>
            <div className="flex flex-col gap-5 px-5 py-4">
              {!tauriHost && (
                <div className="flex items-start gap-2 rounded-xl border border-dashed border-ds-border-muted bg-ds-main/30 px-3 py-2 text-[12.5px] leading-relaxed text-ds-muted">
                  <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                  <span>{t("settings.desktopOnly")}</span>
                </div>
              )}

              {([
                { key: "openAtLogin" as const, label: t("settings.desktopOpenAtLogin"), hint: t("settings.desktopOpenAtLoginHint") },
                { key: "startMinimized" as const, label: t("settings.desktopStartMinimized"), hint: t("settings.desktopStartMinimizedHint") },
                { key: "closeToTray" as const, label: t("settings.desktopCloseToTray"), hint: t("settings.desktopCloseToTrayHint") },
                { key: "autoStart" as const, label: t("settings.desktopAutoStart"), hint: t("settings.desktopAutoStartHint") },
              ]).map(({ key, label, hint }) => {
                const on = desktopBehavior[key];
                return (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className={labelText}>{label}</div>
                      <p className={descText}>{hint}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={label}
                      disabled={!tauriHost}
                      title={tauriHost ? undefined : t("settings.desktopOnly")}
                      onClick={() => toggleDesktopBehavior(key)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        !tauriHost ? "cursor-not-allowed opacity-50 " : ""
                      }${on ? "bg-ds-accent" : "bg-ds-border"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                          on ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                );
              })}

              {/* Open log directory — reveals the app log folder via open_log_dir. */}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className={labelText}>{t("settings.desktopLogs")}</div>
                  <p className={descText}>{t("settings.desktopLogsHint")}</p>
                </div>
                <button
                  type="button"
                  disabled={!tauriHost}
                  title={tauriHost ? undefined : t("settings.desktopOnly")}
                  onClick={() => void openLogDir()}
                  className={
                    "inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium shadow-sm transition " +
                    (!tauriHost ? "cursor-not-allowed text-ds-faint opacity-60" : "text-ds-ink hover:bg-ds-hover")
                  }
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                  {t("settings.desktopOpenLogDir")}
                </button>
              </div>
            </div>
          </section>

          {/* ========== SECTION: Providers — managed model catalog (T10.4) ========== */}
          <section id="settings-providers" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-ds-ink">Providers</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">
                    An OpenAI- or Anthropic-shaped endpoint (API key + base URL). Each provider carries its own model list — add ids by hand or fetch them from the provider's API.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addDraftProvider}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
                  {t("settings.modelProviderAddMenuCustom")}
                </button>
              </div>
            </div>
            <div className="divide-y divide-ds-border-muted px-2 py-1">
              {Object.entries(draft.providers).map(([name, provider], index) => {
                const isDraft = draftProviders.has(name);
                const isDefaultProvider = index === 0;
                const idLocked = isDefaultProvider;
                const providerModels = modelsForProvider(draft.models, name);
                const activeProvider = draft.models.find((m) => m.id === draft.defaultModel)?.provider;
                const inUse = activeProvider === name;
                const missingKey = !isUsableApiKey(provider.apiKey);
                const fetchable = isFetchable(provider);
                const fetchReason = fetchDisabledReason(provider, t);
                const baseUrlInvalid = (provider.baseUrl ?? "").trim() !== "" && !isHttpUrl(provider.baseUrl);
                const status = fetchStatus[name];
                const busy = Boolean(fetching[name]);
                // "Use this provider" maps to setting the default model to this
                // provider's first model, so it needs a key AND at least one model.
                const useDisabled = missingKey || providerModels.length === 0;
                return (
                  <div key={name} className="px-3 py-4">
                    {/* Header: name + status badges */}
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <div className={`${labelText} truncate`}>{name.trim() || name}</div>
                      {isDefaultProvider && (
                        <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[11px] font-medium text-ds-muted">{t("settings.modelProviderDefaultBadge")}</span>
                      )}
                      {isDraft && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{t("settings.modelProviderDraftBadge")}</span>
                      )}
                      {!isDraft && inUse && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{t("settings.modelProviderInUse")}</span>
                      )}
                      {/* Show "No API key" only when the field is genuinely empty.
                          A saved key comes back masked ("********"), which is not
                          "usable" for a client-side fetch (so `missingKey` stays
                          true for fetch/use gating) but absolutely IS a configured
                          key — flagging it as missing falsely alarms the user. */}
                      {!isDraft && (provider.apiKey ?? "").trim() === "" && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{t("settings.modelProviderMissingKey")}</span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {!isDraft && !inUse && (
                          <button
                            type="button"
                            onClick={() => useProvider(name)}
                            disabled={useDisabled}
                            title={
                              missingKey
                                ? t("settings.modelProviderUseDisabledNoKey")
                                : providerModels.length === 0
                                  ? t("settings.modelProviderModelCount", { total: 0 })
                                  : undefined
                            }
                            className={
                              "rounded-lg border px-2.5 py-1 text-[12px] font-medium transition " +
                              (useDisabled
                                ? "cursor-not-allowed border-ds-border bg-ds-card text-ds-faint opacity-60"
                                : "border-ds-border bg-ds-card text-ds-ink hover:bg-ds-hover")
                            }
                          >
                            {t("settings.modelProviderUse")}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Basics */}
                    <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-main/30 p-3">
                      <div className={`${labelText} mb-2 text-[13px]`}>{t("settings.modelProviderSectionBasics")}</div>
                      <div className="grid gap-3">
                        <label className="grid gap-1">
                          <span className={labelText}>{t("settings.modelProviderName")}</span>
                          <input
                            type="text"
                            className={rowControl}
                            value={name}
                            disabled={idLocked}
                            title={idLocked ? t("settings.modelProviderIdLocked") : undefined}
                            onChange={(e) => renameProvider(name, e.target.value)}
                          />
                          {idLocked && <span className={descText}>{t("settings.modelProviderIdLocked")}</span>}
                        </label>
                      </div>
                    </div>

                    {/* Connection */}
                    <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-main/30 p-3">
                      <div className={`${labelText} mb-2 text-[13px]`}>{t("settings.modelProviderSectionConnection")}</div>
                      <div className="grid gap-3">
                        <label className="grid gap-1">
                          <span className={labelText}>Kind</span>
                          <select className={`ds-select ${rowControl}`} value={provider.kind} onChange={(e) => changeKind(name, e.target.value as ProviderKind)}>
                            <option value="openai">openai (Chat Completions)</option>
                            <option value="anthropic">anthropic (Messages)</option>
                          </select>
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>{t("settings.modelProviderApiKey")}</span>
                          <input
                            type="password"
                            className={rowControl}
                            value={provider.apiKey}
                            placeholder={t("settings.modelProviderApiKeyPlaceholder")}
                            onChange={(e) => updateProvider(name, "apiKey", e.target.value)}
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>{t("settings.modelProviderBaseUrl")}</span>
                          <input
                            type="text"
                            className={rowControl}
                            value={provider.baseUrl ?? ""}
                            placeholder={provider.kind === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
                            onChange={(e) => updateProvider(name, "baseUrl", e.target.value)}
                          />
                          {baseUrlInvalid && <span className="text-[12px] text-red-500">{t("settings.modelProviderInvalidUrl")}</span>}
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>{t("settings.modelProviderEndpointFormat")}</span>
                          <select
                            className={`ds-select ${rowControl}`}
                            value={provider.endpointFormat ?? ""}
                            onChange={(e) => updateProvider(name, "endpointFormat", e.target.value || undefined)}
                          >
                            <option value="">default ({provider.kind === "anthropic" ? "messages" : "chat_completions"})</option>
                            <option value="chat_completions">{t("settings.modelEndpointChatCompletions")}</option>
                            <option value="messages">{t("settings.modelEndpointMessages")}</option>
                            <option value="responses">{t("settings.modelEndpointResponses")}</option>
                            <option value="custom_endpoint">{t("settings.modelEndpointCustomEndpoint")}</option>
                          </select>
                          {provider.endpointFormat === "custom_endpoint" && (
                            <span className={descText}>{t("settings.modelEndpointCustomEndpointDesc")}</span>
                          )}
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>Headers (JSON, optional)</span>
                          <textarea
                            className={jsonEditor}
                            rows={2}
                            spellCheck={false}
                            value={headersJson[name] ?? ""}
                            placeholder={'{"x-custom-header": "value"}  — set a value to "" to drop a default header'}
                            onChange={(e) => setHeadersJson({ ...headersJson, [name]: e.target.value })}
                          />
                        </label>
                      </div>
                    </div>

                    {/* Models card — chip-list editor + Fetch from API */}
                    <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-main/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className={`${labelText} text-[13px]`}>
                          {t("settings.modelProviderModelsHeader")} · {providerModels.length}
                        </div>
                        <button
                          type="button"
                          onClick={() => void fetchModels(name)}
                          disabled={!fetchable || busy}
                          title={fetchable ? undefined : fetchReason ?? undefined}
                          className={
                            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition " +
                            (!fetchable || busy
                              ? "cursor-not-allowed border-ds-border bg-ds-card text-ds-faint opacity-60"
                              : "border-ds-border bg-ds-card text-ds-ink hover:bg-ds-hover")
                          }
                        >
                          {busy ? (
                            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" /></svg>
                          ) : (
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
                          )}
                          {t("settings.modelProviderFetchModels")}
                        </button>
                      </div>
                      {/* Chips */}
                      <div className="flex flex-wrap gap-1.5">
                        {providerModels.map((m) => (
                          <span
                            key={m.id}
                            className="inline-flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-[12px] text-ds-ink"
                          >
                            <span className="font-mono">{m.id}</span>
                            <button
                              type="button"
                              aria-label={t("settings.modelProviderModelRemove", { model: m.id })}
                              title={t("settings.modelProviderModelRemove", { model: m.id })}
                              onClick={() => removeProviderModel(name, m.id)}
                              className="text-ds-faint transition hover:text-red-500"
                            >
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                            </button>
                          </span>
                        ))}
                      </div>
                      <input
                        type="text"
                        className={`${rowControl} mt-2`}
                        value={modelDraftInput[name] ?? ""}
                        placeholder={t("settings.modelProviderModelsPlaceholder")}
                        onChange={(e) => setModelDraftInput({ ...modelDraftInput, [name]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addProviderModel(name, modelDraftInput[name] ?? "");
                          }
                        }}
                      />
                      <span className={descText}>{t("settings.modelProviderModels")}</span>
                      {status && (
                        <p
                          className={
                            "mt-1.5 text-[12px] " +
                            (status.mode === "error"
                              ? "text-red-500"
                              : status.mode === "success"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-ds-muted")
                          }
                        >
                          {status.message}
                        </p>
                      )}
                    </div>

                    {/* Capability assignment — no per-provider backend target here, so
                        the assignment is read-only and points at the Media section. */}
                    <div className="mb-3 rounded-xl border border-dashed border-ds-border-muted bg-ds-main/20 p-3">
                      <div className={`${labelText} mb-1 text-[13px]`}>{t("settings.modelProviderImageCapability")} · {t("settings.modelProviderSpeechCapability")}</div>
                      <p className={descText}>{t("settings.modelProviderCapabilityManagedNote")}</p>
                    </div>

                    {/* Draft confirm/discard OR danger zone */}
                    {isDraft ? (
                      <div className="rounded-xl border border-amber-300/70 bg-amber-50/70 p-3 dark:border-amber-700/50 dark:bg-amber-950/20">
                        <div className={`${labelText} mb-1 text-[13px]`}>{t("settings.modelProviderDraftSection")}</div>
                        <p className={descText}>
                          {isUsableApiKey(provider.apiKey)
                            ? t("settings.modelProviderDraftHintReady")
                            : t("settings.modelProviderDraftHintNoKey")}
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => confirmDraftProvider(name)}
                            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-emerald-600"
                          >
                            {t("settings.modelProviderDraftConfirm")}
                          </button>
                          <button
                            type="button"
                            onClick={() => discardDraftProvider(name)}
                            className="rounded-lg border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                          >
                            {t("settings.modelProviderDraftDiscard")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-red-200/70 bg-red-50/40 p-3 dark:border-red-900/50 dark:bg-red-950/20">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className={`${labelText} text-[13px]`}>{t("settings.modelProviderSectionDanger")}</div>
                            <p className={descText}>{t("settings.modelProviderDangerHint")}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => requestDeleteProvider(name)}
                            className="shrink-0 rounded-lg border border-red-300 bg-ds-card px-3 py-1.5 text-[13px] font-medium text-red-600 shadow-sm transition hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                          >
                            {t("settings.modelProviderDeleteAction")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {Object.keys(draft.providers).length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-ds-faint">No providers yet. Use “{t("settings.modelProviderAddMenuCustom")}” above to add one.</div>
              )}
            </div>
          </section>

          {/* Delete-provider confirm dialog (T10.4 in-use protection) */}
          {deleteTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
              <div className="w-full max-w-md rounded-2xl border border-ds-border bg-ds-card p-5 shadow-xl">
                <h3 className="text-[15px] font-semibold text-ds-ink">
                  {t("settings.modelProviderDeleteConfirmTitle", { name: deleteTarget.name })}
                </h3>
                <p className="mt-2 text-[13px] leading-6 text-ds-muted">{t("settings.modelProviderDeleteConfirmDetail")}</p>
                {deleteTarget.lines.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-6 text-amber-700 dark:text-amber-300">
                    {deleteTarget.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(null)}
                    className="rounded-lg border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                  >
                    {t("settings.modelProviderCancel")}
                  </button>
                  <button
                    type="button"
                    onClick={confirmDeleteProvider}
                    className="rounded-lg bg-red-500 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-red-600"
                  >
                    {t("settings.modelProviderDeleteAction")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ========== SECTION: Defaults ========== */}
          <section id="settings-defaults" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">Defaults</h2>
            </div>
            <div className="divide-y divide-ds-border-muted px-2 py-1">

              <div className="flex flex-col gap-3 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <div className={labelText}>Default model</div>
                  <p className={descText}>The model used for new threads.</p>
                </div>
                <div className="flex w-full min-w-0 justify-end sm:max-w-[420px]">
                  <select className={`ds-select ${rowControl}`} value={draft.defaultModel ?? ""} onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}>
                    {draft.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-3 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <div className={labelText}>Default workspace</div>
                  <p className={descText}>The folder new threads open against.</p>
                </div>
                <div className="flex w-full min-w-0 flex-col items-end gap-2 sm:max-w-[420px]">
                  <input
                    type="text"
                    className={rowControl}
                    value={draft.defaultWorkspace ?? ""}
                    placeholder="/path/to/your/project"
                    onChange={(e) => setDraft({ ...draft, defaultWorkspace: e.target.value })}
                  />
                  <div className="flex w-full items-center justify-end gap-2">
                    {tauriHost ? (
                      <button
                        type="button"
                        onClick={() => void browseWorkspace()}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                        {t("settings.browse")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled
                        title={t("settings.browseUnavailable")}
                        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-faint opacity-60 shadow-sm"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                        {t("settings.browse")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={restoreDefaultWorkspace}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                      {t("settings.restoreDefault")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <div className={labelText}>Approval policy</div>
                  <p className={descText}>When the agent must ask before running tools.</p>
                </div>
                <div className="flex w-full min-w-0 justify-end sm:max-w-[420px]">
                  <select className={`ds-select ${rowControl}`} value={draft.approvalPolicy} onChange={(e) => setDraft({ ...draft, approvalPolicy: e.target.value as NexusConfig["approvalPolicy"] })}>
                    <option value="auto">auto (run all tools)</option>
                    <option value="on-request">on-request (approve writes/commands)</option>
                    <option value="untrusted">untrusted (approve untrusted tools)</option>
                    <option value="suggest">suggest (approve, suggest first)</option>
                    <option value="never">never (read-only)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-3 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <div className={labelText}>Sandbox mode</div>
                  <p className={descText}>How much filesystem access tools get.</p>
                </div>
                <div className="flex w-full min-w-0 justify-end sm:max-w-[420px]">
                  <select className={`ds-select ${rowControl}`} value={draft.sandboxMode} onChange={(e) => setDraft({ ...draft, sandboxMode: e.target.value as NexusConfig["sandboxMode"] })}>
                    <option value="workspace-write">workspace-write (confined to workspace)</option>
                    <option value="read-only">read-only</option>
                    <option value="danger-full-access">danger-full-access</option>
                    <option value="external-sandbox">external-sandbox</option>
                  </select>
                </div>
              </div>

            </div>
          </section>

          {/* ========== SECTION: Models (advanced, read-only escape hatch) ========== */}
          {/* The managed per-provider catalog above is the editable source of
              truth. This disclosure stays as a read-only inspector of the
              resolved model JSON — editing it is intentionally disabled so a
              hand-edit can never clobber the catalog or corrupt numeric config. */}
          <section className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-ds-ink">Models (advanced)</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">Resolved model catalog as JSON (read-only). Edit models per provider above.</p>
                </div>
                <svg className="h-4 w-4 shrink-0 text-ds-muted transition group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              </summary>
              <div className="px-2 py-1">
                <div className="px-3 py-4">
                  <textarea
                    className={`${jsonEditor} opacity-80`}
                    value={modelsJson}
                    readOnly
                    rows={10}
                    spellCheck={false}
                  />
                </div>
              </div>
            </details>
          </section>

          {/* ========== SECTION: Media generation ========== */}
          <section id="settings-media" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-ds-ink">Media generation</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">
                    Per-modality endpoints for image, speech, music, and video generation. Leave a Protocol blank for an OpenAI-compatible endpoint.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={media?.enabled ? "true" : "false"}
                  aria-label="Enable media generation"
                  onClick={() => updateCapability("media", { enabled: !media?.enabled })}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition ${media?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                >
                  <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${media?.enabled ? "left-6" : "left-0.5"}`}></span>
                </button>
              </div>
            </div>
            {media?.enabled && (
              <div className="divide-y divide-ds-border-muted px-2 py-1">
                {([
                  { key: "image" as const, label: "Image", protocolPlaceholder: "openai-images | async-image  (empty = OpenAI-compatible)" },
                  { key: "speech" as const, label: "Speech", protocolPlaceholder: "openai-speech | async-t2a | mimo-tts  (empty = OpenAI-compatible)" },
                  { key: "music" as const, label: "Music", protocolPlaceholder: "async-music  (empty = OpenAI-compatible)" },
                  { key: "video" as const, label: "Video", protocolPlaceholder: "async-video  (empty = OpenAI-compatible)" },
                ]).map(({ key, label, protocolPlaceholder }) => {
                  const cfg = (media?.[key] ?? {}) as MediaEndpoint;
                  return (
                    <div key={key} className="px-3 py-4">
                      <div className={`${labelText} mb-3`}>{label}</div>
                      <div className="grid gap-3">
                        <label className="grid gap-1">
                          <span className={labelText}>Protocol</span>
                          <input
                            type="text"
                            className={rowControl}
                            value={cfg.protocol ?? ""}
                            placeholder={protocolPlaceholder}
                            onChange={(e) => updateMedia(key, { protocol: textOrUndef(e.target.value) })}
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>Model</span>
                          <input
                            type="text"
                            className={rowControl}
                            value={cfg.model ?? ""}
                            placeholder="provider model id"
                            onChange={(e) => updateMedia(key, { model: textOrUndef(e.target.value) })}
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>Base URL</span>
                          <input
                            type="text"
                            className={rowControl}
                            value={cfg.endpoint ?? ""}
                            placeholder="https://api.openai.com/v1"
                            onChange={(e) => updateMedia(key, { endpoint: textOrUndef(e.target.value) })}
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className={labelText}>API key</span>
                          <input
                            type="password"
                            className={rowControl}
                            value={cfg.apiKey ?? ""}
                            placeholder="(provider key)"
                            onChange={(e) => updateMedia(key, { apiKey: e.target.value })}
                          />
                        </label>

                        {key === "image" && (
                          <label className="grid gap-1">
                            <span className={labelText}>Default size</span>
                            <input
                              type="text"
                              className={rowControl}
                              value={cfg.defaultSize ?? ""}
                              placeholder="1024x1024"
                              onChange={(e) => updateMedia(key, { defaultSize: textOrUndef(e.target.value) })}
                            />
                          </label>
                        )}

                        {key === "speech" && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1">
                              <span className={labelText}>Voice</span>
                              <input
                                type="text"
                                className={rowControl}
                                value={cfg.voice ?? ""}
                                placeholder="provider voice id (e.g. alloy)"
                                onChange={(e) => updateMedia(key, { voice: textOrUndef(e.target.value) })}
                              />
                            </label>
                            <label className="grid gap-1">
                              <span className={labelText}>Format</span>
                              <input
                                type="text"
                                className={rowControl}
                                value={cfg.format ?? ""}
                                placeholder="mp3"
                                onChange={(e) => updateMedia(key, { format: textOrUndef(e.target.value) })}
                              />
                            </label>
                          </div>
                        )}

                        {key === "music" && (
                          <label className="grid gap-1">
                            <span className={labelText}>Format</span>
                            <input
                              type="text"
                              className={rowControl}
                              value={cfg.format ?? ""}
                              placeholder="mp3"
                              onChange={(e) => updateMedia(key, { format: textOrUndef(e.target.value) })}
                            />
                          </label>
                        )}

                        {key === "video" && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1">
                              <span className={labelText}>Default duration (s)</span>
                              <input
                                type="number"
                                min={1}
                                className={rowControl}
                                value={cfg.defaultDuration ?? ""}
                                placeholder="6"
                                onChange={(e) => updateMedia(key, { defaultDuration: numOrUndef(e.target.value) })}
                              />
                            </label>
                            <label className="grid gap-1">
                              <span className={labelText}>Default resolution</span>
                              <input
                                type="text"
                                className={rowControl}
                                value={cfg.defaultResolution ?? ""}
                                placeholder="1080P"
                                onChange={(e) => updateMedia(key, { defaultResolution: textOrUndef(e.target.value) })}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ========== SECTION: Capabilities ========== */}
          <section id="settings-capabilities" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">Capabilities</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">
                Optional providers — each is off by default. Toggling a capability on adds its tools to the agent.
              </p>
            </div>
            <div className="divide-y divide-ds-border-muted px-2 py-1">

              {/* Web */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Web</div>
                    <p className={descText}>web_fetch + web_search</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.web?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("web", { enabled: !caps.web?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.web?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.web?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
                {caps.web?.enabled && (
                  <div className="mt-4 grid gap-3">
                    <label className="grid gap-1">
                      <span className={labelText}>Search endpoint</span>
                      <input
                        type="text"
                        className={rowControl}
                        value={caps.web.search?.endpoint ?? ""}
                        placeholder="https://api.tavily.com/search"
                        onChange={(e) => updateCapability("web", { search: { ...caps.web?.search, endpoint: e.target.value } })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>Search API key</span>
                      <input
                        type="password"
                        className={rowControl}
                        value={caps.web.search?.apiKey ?? ""}
                        placeholder="(provider key)"
                        onChange={(e) => updateCapability("web", { search: { ...caps.web?.search, apiKey: e.target.value } })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>Search provider</span>
                      <input
                        type="text"
                        className={rowControl}
                        value={caps.web.search?.provider ?? ""}
                        placeholder="tavily | brave | searxng"
                        onChange={(e) => updateCapability("web", { search: { ...caps.web?.search, provider: e.target.value } })}
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* Memory */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Memory</div>
                    <p className={descText}>long-term memory store</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.memory?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("memory", { enabled: !caps.memory?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.memory?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.memory?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
              </div>

              {/* Skills */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Skills</div>
                    <p className={descText}>skill packages</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.skills?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("skills", { enabled: !caps.skills?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.skills?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.skills?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
                {caps.skills?.enabled && (
                  <div className="mt-4 grid gap-1">
                    <span className={labelText}>Skill roots (one path per line)</span>
                    <textarea
                      className={jsonEditor}
                      rows={3}
                      spellCheck={false}
                      value={skillsRootsText}
                      placeholder={"~/.nexus-agent/skills\n./skills"}
                      onChange={(e) => setSkillsRootsText(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* Media */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Media</div>
                    <p className={descText}>image / speech / music / video generation</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.media?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("media", { enabled: !caps.media?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.media?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.media?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
              </div>

              {/* MCP — enable toggle here; servers + tuning live in the dedicated
                  "External tools advanced settings" section below (T10.9). */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>MCP</div>
                    <p className={descText}>Model Context Protocol stdio servers</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.mcp?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("mcp", { enabled: !caps.mcp?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.mcp?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.mcp?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
                {caps.mcp?.enabled && (
                  <button
                    type="button"
                    onClick={() => scrollTo("settings-mcp")}
                    className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent transition hover:underline"
                  >
                    {t("settings.mcpAdvanced")}
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                  </button>
                )}
              </div>

              {/* Delegation */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Delegation</div>
                    <p className={descText}>multi-agent child runs</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.delegation?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("delegation", { enabled: !caps.delegation?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.delegation?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.delegation?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
                {caps.delegation?.enabled && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className={labelText}>Max parallel</span>
                      <input
                        type="number"
                        min={1}
                        className={rowControl}
                        value={caps.delegation.maxParallel ?? ""}
                        placeholder="default"
                        onChange={(e) => updateCapability("delegation", { maxParallel: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>Max child runs</span>
                      <input
                        type="number"
                        min={1}
                        className={rowControl}
                        value={caps.delegation.maxChildRuns ?? ""}
                        placeholder="default"
                        onChange={(e) => updateCapability("delegation", { maxChildRuns: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* Insight */}
              <div className="px-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className={labelText}>Insight</div>
                    <p className={descText}>proactive insight engine</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={caps.insight?.enabled ? "true" : "false"}
                    onClick={() => updateCapability("insight", { enabled: !caps.insight?.enabled })}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${caps.insight?.enabled ? "bg-emerald-500" : "bg-ds-faint"}`}
                  >
                    <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${caps.insight?.enabled ? "left-6" : "left-0.5"}`}></span>
                  </button>
                </div>
                {caps.insight?.enabled && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className={labelText}>Sensitivity</span>
                      <select
                        className={`ds-select ${rowControl}`}
                        value={caps.insight.sensitivity ?? "medium"}
                        onChange={(e) => updateCapability("insight", { sensitivity: e.target.value as "high" | "medium" | "low" })}
                      >
                        <option value="high">high (more suggestions)</option>
                        <option value="medium">medium</option>
                        <option value="low">low (fewer, high-confidence)</option>
                      </select>
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>Min confidence</span>
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        max={1}
                        className={rowControl}
                        value={caps.insight.minConfidence ?? ""}
                        placeholder="default by sensitivity"
                        onChange={(e) => updateCapability("insight", { minConfidence: e.target.value ? Number(e.target.value) : undefined })}
                      />
                    </label>
                    <label className="grid gap-1 sm:col-span-2">
                      <span className={labelText}>Classifier model (optional)</span>
                      <input
                        className={rowControl}
                        value={caps.insight.model ?? ""}
                        placeholder="defaults to the configured default model"
                        onChange={(e) => updateCapability("insight", { model: e.target.value || undefined })}
                      />
                    </label>
                    <div className="sm:col-span-2">
                      <span className={labelText}>Detectors</span>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {([
                          ["knowledge_capture", "Knowledge capture"],
                          ["meeting_alignment", "Meeting alignment"],
                          ["data_to_sheet", "Data → sheet"],
                        ] as const).map(([key, label]) => {
                          const on = caps.insight?.detectors?.[key] !== false;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() =>
                                updateCapability("insight", {
                                  detectors: { ...caps.insight?.detectors, [key]: !on },
                                })
                              }
                              className={
                                "rounded-full border px-3 py-1 text-[12.5px] font-medium transition " +
                                (on ? "border-accent/50 bg-accent/10 text-accent" : "border-ds-border bg-ds-card text-ds-faint")
                              }
                            >
                              {on ? "✓ " : ""}
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </section>

          {/* ========== SECTION: External tools advanced (MCP, T10.9) ========== */}
          {/* Raw mcp.json (capabilities.mcp.servers) editor with JSON validation,
              the persisted BM25 search tuning (capabilities.mcp.search), and a
              read-only search-diagnostics panel. Everything persists through the
              page-level Save (saveConfig → PUT /v1/config, narrow secret mask).
              There is NO backend MCP hot-reload — "Reload status" only re-fetches
              the read endpoints and a static "restart to apply" note is shown. */}
          <section id="settings-mcp" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">{t("settings.mcpAdvanced")}</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{t("settings.mcpAdvancedDesc")}</p>
            </div>

            {!caps.mcp?.enabled ? (
              <div className="px-5 py-5">
                <div className="rounded-xl border border-dashed border-ds-border-muted bg-ds-main/30 px-4 py-3 text-[13px] leading-relaxed text-ds-muted">
                  {t("settings.mcpDisabledNote")}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-ds-border-muted px-2 py-1">

                {/* Smart tool selection (search tuning) */}
                <div className="px-3 py-4">
                  <div className={`${labelText} mb-1`}>{t("settings.mcpSearchEnabled")}</div>
                  <p className={`${descText} mb-3`}>{t("settings.mcpSearchEnabledDesc")}</p>
                  <div className="mb-1 text-[13px] font-semibold text-ds-ink">{t("settings.mcpSearchLimits")}</div>
                  <p className={`${descText} mb-3`}>{t("settings.mcpSearchLimitsDesc")}</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="grid gap-1">
                      <span className={labelText}>{t("settings.mcpSearchTopKDefault")}</span>
                      <input
                        type="number"
                        min={1}
                        className={rowControl}
                        value={mcpSearch?.topKDefault ?? ""}
                        placeholder="5"
                        onChange={(e) =>
                          updateMcpSearch({ topKDefault: e.target.value.trim() === "" ? undefined : Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>{t("settings.mcpSearchTopKMax")}</span>
                      <input
                        type="number"
                        min={1}
                        className={rowControl}
                        value={mcpSearch?.topKMax ?? ""}
                        placeholder="10"
                        onChange={(e) =>
                          updateMcpSearch({ topKMax: e.target.value.trim() === "" ? undefined : Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className={labelText}>{t("settings.mcpSearchMinScore")}</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        className={rowControl}
                        value={mcpSearch?.minScore ?? ""}
                        placeholder="0.15"
                        onChange={(e) =>
                          updateMcpSearch({ minScore: e.target.value.trim() === "" ? undefined : Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                </div>

                {/* Read-only search diagnostics (GET /v1/runtime/tools + /v1/mcp) */}
                <div className="px-3 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className={labelText}>{t("settings.mcpSearchDiagnostics")}</div>
                      <p className={descText}>{t("settings.mcpSearchDiagnosticsDesc")}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadMcpDiagnostics()}
                      disabled={mcpDiagLoading}
                      className={
                        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition " +
                        (mcpDiagLoading
                          ? "cursor-not-allowed border-ds-border bg-ds-card text-ds-faint opacity-60"
                          : "border-ds-border bg-ds-card text-ds-ink hover:bg-ds-hover")
                      }
                    >
                      <svg className={`h-3.5 w-3.5 ${mcpDiagLoading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                      {t("settings.mcpReload")}
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-xl border border-ds-border-muted bg-ds-main/40 px-3 py-2">
                      <div className="text-[12px] text-ds-muted">{t("settings.mcpSearchStatus")}</div>
                      <div className="mt-0.5 font-mono text-[13px] text-ds-ink">
                        {(mcpDiag?.enabled ?? caps.mcp?.enabled) ? t("settings.mcpSearchActive") : t("settings.mcpSearchInactive")}
                      </div>
                    </div>
                    <div className="rounded-xl border border-ds-border-muted bg-ds-main/40 px-3 py-2">
                      <div className="text-[12px] text-ds-muted">{t("settings.mcpSearchIndexed")}</div>
                      <div className="mt-0.5 font-mono text-[13px] text-ds-ink">
                        {mcpDiag?.indexedToolCount ?? mcpIndexedCount ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl border border-ds-border-muted bg-ds-main/40 px-3 py-2">
                      <div className="text-[12px] text-ds-muted">{t("settings.mcpSearchAdvertised")}</div>
                      <div className="mt-0.5 font-mono text-[13px] text-ds-ink">
                        {mcpIndexedCount ?? mcpDiag?.indexedToolCount ?? 0}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Raw mcp servers editor (capabilities.mcp.servers), validated on Save */}
                <div className="px-3 py-4">
                  <div className={`${labelText} mb-1`}>{t("settings.mcpEditor")}</div>
                  <p className={`${descText} mb-3`}>{t("settings.mcpEditorDesc")}</p>
                  <textarea
                    className={jsonEditor}
                    rows={8}
                    spellCheck={false}
                    value={mcpServersJson}
                    placeholder={t("settings.mcpEditorPlaceholder")}
                    onChange={(e) => setMcpServersJson(e.target.value)}
                  />
                  <p className={`${descText} mt-2`}>{t("settings.mcpServersHint")}</p>
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-200">
                    <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                    <span>{t("settings.mcpRuntimeHint")}</span>
                  </div>
                </div>

              </div>
            )}
          </section>

          {/* ========== SECTION: Keyboard shortcuts (T10.10) ========== */}
          {/* Promoted out of the General section into its own dedicated card with
              a nav anchor (mirrors the original `shortcuts` tab). The editor is
              the client-side keybindings engine (localStorage `nexus.keybindings`);
              there is NO backend keyboardShortcuts field, so this never routes
              through saveConfig — every control is a real engine action. */}
          <section id="settings-shortcuts" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">{t("settings.shortcuts")}</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{t("settings.shortcutsHint")}</p>
            </div>
            <div className="px-5 py-4">
              <KeybindingsEditor t={t} />
            </div>
          </section>

          {/* ========== SECTION: Runtime token ========== */}
          <section id="settings-audit" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <ToolCallAuditSection />
          </section>

          <section id="settings-runtime" className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25">
            <div className="border-b border-ds-border-muted px-5 py-3">
              <h2 className="text-[16px] font-semibold text-ds-ink">Runtime token</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">Only needed if the runtime runs with auth enabled (not the loopback dev default).</p>
            </div>
            <div className="divide-y divide-ds-border-muted px-2 py-1">
              <div className="flex flex-col gap-3 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <div className={labelText}>Bearer token</div>
                  <p className={descText}>Sent as an Authorization header on every runtime request.</p>
                </div>
                <div className="flex w-full min-w-0 justify-end sm:max-w-[420px]">
                  <input
                    type="password"
                    className={rowControl}
                    value={token}
                    placeholder="(empty for insecure dev mode)"
                    onChange={(e) => setLocalToken(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

        </div>
        </div>
        {/* Persistent action bar — Save/Cancel stay reachable without scrolling
            to the bottom of the long settings page. */}
        <div className="ds-no-drag shrink-0 border-t border-ds-border bg-ds-main px-10 py-3">
          <div className="mx-auto flex max-w-3xl items-center justify-end gap-3">
            <button type="button" onClick={goBack} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={() => void onSave()} className="rounded-xl bg-emerald-500 px-4 py-2 text-[14px] font-medium text-white shadow-sm transition hover:bg-emerald-600">Save</button>
          </div>
        </div>
      </div>

    </div>
  );
}

/** Best-effort "target" of a tool call, derived from its arguments. */
function toolTarget(args: Record<string, unknown>): string {
  for (const key of ["path", "file_path", "command", "url", "pattern", "query", "name", "id"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return "—";
}

function compact(value: unknown, max = 160): string {
  let s: string;
  if (value == null) s = "";
  else if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Read-only Tool-call Audit: a table of the active thread's tool calls
 * — Tool / Target / Params / Result / Time. Pairs each `tool_call` with its
 * `tool_result` by `callId`. Refresh re-loads the current thread.
 */
function ToolCallAuditSection(): JSX.Element {
  const { t } = useTranslation();
  const items = useStore((s) => s.items);
  const currentThreadId = useStore((s) => s.currentThreadId);
  const selectThread = useStore((s) => s.selectThread);

  const rows = useMemo(() => {
    const results = new Map<string, Extract<TurnItem, { kind: "tool_result" }>>();
    for (const it of items) {
      if (it.kind === "tool_result") results.set(it.callId, it);
    }
    return items
      .filter((it): it is Extract<TurnItem, { kind: "tool_call" }> => it.kind === "tool_call")
      .map((call) => ({ call, result: results.get(call.callId) }))
      .reverse(); // newest first
  }, [items]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-ds-border-muted px-5 py-3">
        <div>
          <h2 className="text-[16px] font-semibold text-ds-ink">{t("settings.toolAudit")}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{t("settings.toolAuditHint")}</p>
        </div>
        <button
          type="button"
          onClick={() => currentThreadId && void selectThread(currentThreadId)}
          className="shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
        >
          {t("common.refresh")}
        </button>
      </div>
      <div className="px-2 py-2">
        {rows.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-ds-faint">{t("settings.toolAuditEmpty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="text-ds-faint">
                  <th className="px-3 py-2 font-medium">Tool</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium">Params</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ call, result }) => (
                  <tr key={call.id} className="border-t border-ds-border-muted align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-ds-ink">{call.toolName}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 font-mono text-ds-muted" title={toolTarget(call.arguments)}>{toolTarget(call.arguments)}</td>
                    <td className="max-w-[220px] truncate px-3 py-2 font-mono text-ds-faint" title={compact(call.arguments, 1000)}>{compact(call.arguments)}</td>
                    <td className={`max-w-[220px] truncate px-3 py-2 font-mono ${result?.isError ? "text-rose-500" : "text-ds-faint"}`} title={result ? compact(result.output, 1000) : "(pending)"}>
                      {result ? compact(result.output) : <span className="italic text-ds-faint">pending…</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ds-faint">{new Date(call.createdAt).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
