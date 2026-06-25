import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend runs on 127.0.0.1:8910 by default. We proxy the REST + SSE
// surface so the SPA can talk to it same-origin (no CORS, Bearer header is
// forwarded transparently — including the streaming /events endpoint).
const BACKEND = process.env.NEXUS_BACKEND_URL ?? "http://127.0.0.1:8910";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: BACKEND, changeOrigin: true },
      "/health": { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
});
