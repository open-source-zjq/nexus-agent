import { useEffect } from "react";
import { useStore } from "./store/store.js";
import { useNav } from "./store/nav.js";
import { AppShell } from "./ui/AppShell.js";

export function App(): JSX.Element {
  const init = useStore((s) => s.init);
  const runtimeInfo = useStore((s) => s.runtimeInfo);
  const setView = useNav((s) => s.setView);

  useEffect(() => {
    void init();
  }, [init]);

  // Nudge first-time users to the Settings view to add an API key.
  useEffect(() => {
    if (runtimeInfo && !Object.values(runtimeInfo.providersConfigured ?? {}).some(Boolean)) {
      setView("settings");
    }
  }, [runtimeInfo, setView]);

  return <AppShell />;
}
