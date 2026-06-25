#!/usr/bin/env node
/**
 * Standalone `nexus-agent-cli` bin entry — the headless `run` / `chat` / `exec`
 * commands (everything but `serve`).
 *
 * Kept as a SEPARATE thin entry so `agent-cli.ts` stays a pure library. The
 * unified `serve-entry.ts` imports agent-cli for dispatch, and esbuild bundles
 * both into one `backend.mjs`; a self-run guard living inside agent-cli would
 * (wrongly) fire there because the merged bundle IS the process entry, so
 * `import.meta.url === argv[1]` is true. Isolating the self-run here keeps the
 * bundle's only entrypoint `serve-entry`'s `main`.
 */
import process from "node:process";
import { agentCliMain } from "./agent-cli.js";
import { ServeExitCode } from "./serve.js";

agentCliMain(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`nexus-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(ServeExitCode.runtime);
  },
);
