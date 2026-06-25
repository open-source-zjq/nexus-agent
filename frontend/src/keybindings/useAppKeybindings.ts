/**
 * Installs the global keydown dispatcher and binds each named command to an app
 * action (store / nav). Mounted once at the shell root. Uses `getState()` so the
 * handlers stay stable for the lifetime of the effect.
 */
import { useEffect } from "react";
import { useStore } from "../store/store.js";
import { useNav } from "../store/nav.js";
import { pickWorkspaceDir } from "../lib/tauri.js";
import { registerCommand, installGlobalKeydown } from "./index.js";

export function useAppKeybindings(): void {
  useEffect(() => {
    const uninstall = installGlobalKeydown();
    const unregister = [
      registerCommand("new-chat", () => useStore.getState().newThread()),
      // "Open workspace" — pick a folder (native dialog on the desktop host) and
      // start a project there. On web pickWorkspaceDir() resolves null (the
      // browser can't pick directories), so the chord safely no-ops.
      registerCommand("choose-workspace", () => {
        void pickWorkspaceDir().then((dir) => {
          if (!dir) return;
          useNav.getState().setView("workbench");
          void useStore.getState().newProject(dir);
        });
      }),
      registerCommand("open-settings", () => useNav.getState().setView("settings")),
      registerCommand("go-chat", () => useNav.getState().setView("workbench")),
      registerCommand("go-agents", () => useNav.getState().setView("agents")),
      registerCommand("go-connectors", () => useNav.getState().setView("connectors")),
      registerCommand("go-plugins", () => useNav.getState().setView("plugins")),
      registerCommand("toggle-sidebar", () => useNav.getState().toggleSidebar()),
      registerCommand("toggle-plan-mode", () => {
        const state = useStore.getState();
        state.setComposerMode(state.composerMode === "plan" ? "agent" : "plan");
      }),
      registerCommand("interrupt-turn", () => {
        const state = useStore.getState();
        if (state.running) void state.interrupt();
      }),
      registerCommand("focus-composer", () => {
        document.querySelector<HTMLTextAreaElement>(".ds-composer-shell textarea")?.focus();
      }),
    ];
    return () => {
      uninstall();
      for (const off of unregister) off();
    };
  }, []);
}
