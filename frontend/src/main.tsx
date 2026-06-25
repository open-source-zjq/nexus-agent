import React from "react";
import { createRoot } from "react-dom/client";
// Order matters: the recovered production stylesheet (Tailwind preflight + base
// + utilities + the .ds-* design system) first, then the supplement that fills
// the few utility classes the original bundle never JIT-compiled, then the light
// highlight.js theme for markdown code, then app glue.
import "./styles/nexus-ds.css";
import "./styles/nexus-supplement.css";
import "highlight.js/styles/github.css";
import "./styles/index.css";
import { App } from "./App.js";
import { setupTauriDrag } from "./lib/tauri.js";

// Bridge the UI's `-webkit-app-region` drag chrome to Tauri's native dragging
// (no-op on the plain web build).
void setupTauriDrag();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
