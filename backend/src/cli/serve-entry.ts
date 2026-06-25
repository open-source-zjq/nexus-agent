#!/usr/bin/env node
/**
 * Unified Nexus CLI entry. Dispatches the first token via `splitNexusCliCommand`:
 *   serve  → start the HTTP/SSE runtime (bare `--flags` also imply serve)
 *   run / chat / exec → headless agent commands (see agent-cli.ts)
 *   help / --help / unknown → usage
 *
 * Faithful to the original `serve-entry` dispatcher: installs process guards
 * (unhandled rejection / uncaught exception are logged to stderr and the process
 * is kept alive), and exits with the command's status code.
 */
import process from "node:process";
import { parseServeOptionsSafe, startServer, SERVE_USAGE, ServeExitCode } from "./serve.js";
import { splitNexusCliCommand, runAgentCommand, NEXUS_CLI_USAGE } from "./agent-cli.js";

let processGuardsInstalled = false;
function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`nexus-agent: unhandled rejection (kept alive): ${detail}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`nexus-agent: uncaught exception (kept alive): ${error.stack ?? error.message}\n`);
  });
}

async function serveMain(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(SERVE_USAGE);
    return ServeExitCode.ok;
  }
  const parsed = parseServeOptionsSafe(argv, process.env);
  if (!parsed.ok) {
    process.stderr.write(`nexus-agent serve: ${parsed.message}\n`);
    if (parsed.issues) process.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`);
    process.stderr.write(SERVE_USAGE);
    return parsed.exitCode;
  }
  await startServer(parsed.options);
  // The HTTP server holds the event loop open; await a termination signal so the
  // outer process.exit fires cleanly on Ctrl-C / SIGTERM.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return ServeExitCode.ok;
}

async function main(argv: string[]): Promise<number> {
  installProcessGuards();
  const command = splitNexusCliCommand(argv);
  if (command.command === "help") {
    if (command.error) {
      process.stderr.write(`nexus-agent: ${command.error}\n`);
      process.stderr.write(NEXUS_CLI_USAGE);
      return ServeExitCode.usage;
    }
    process.stdout.write(NEXUS_CLI_USAGE);
    return ServeExitCode.ok;
  }
  if (command.command === "serve") {
    return serveMain(command.args);
  }
  return runAgentCommand(command.command, command.args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd(),
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`nexus-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(ServeExitCode.runtime);
  },
);
