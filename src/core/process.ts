import { spawnSync } from "node:child_process";
import { constants } from "node:os";

import { EXIT_CANNOT_EXECUTE, EXIT_COMMAND_NOT_FOUND, type ClaudeProcess, type Runtime } from "./env.js";
import { listClaudeProcesses } from "./proc.js";
import { findExecutable } from "./which.js";

export interface SpawnResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error | undefined;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio: "inherit" }
) => SpawnResult;

export interface RuntimeDeps {
  readonly spawn: SpawnFn;
  readonly path: string | undefined;
  readonly findBinary?: (name: string, path: string | undefined) => string | undefined;
  readonly report?: (message: string) => void;
  readonly processes?: () => readonly ClaudeProcess[];
}

/** Signaux du terminal que `claude` gère lui-même : `ch` ne doit pas mourir avant lui (Ctrl-C interrompt une génération). */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const ignore = (): void => undefined;
const SIGNAL_EXIT_BASE = 128;

function errorCode(error: Error): string {
  return "code" in error && typeof error.code === "string" ? error.code : "erreur inconnue";
}

/**
 * Seul module autorisé à lancer un processus : démarre `claude` dans un dossier, terminal partagé.
 * Le binaire est résolu sur les seules entrées absolues du PATH et lancé par son chemin absolu.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const findBinary = deps.findBinary ?? findExecutable;
  const report = deps.report ?? ((message: string): void => void process.stderr.write(message));

  return {
    claudeProcesses: deps.processes ?? (() => listClaudeProcesses()),
    launchClaude(cwd, args) {
      const binary = findBinary("claude", deps.path);
      if (binary === undefined) {
        report("ch : `claude` introuvable parmi les entrées absolues du PATH.\n");
        return EXIT_COMMAND_NOT_FOUND;
      }

      FORWARDED_SIGNALS.forEach((signal) => process.on(signal, ignore));
      let result: SpawnResult;
      try {
        result = deps.spawn(binary, args, { cwd, stdio: "inherit" });
      } finally {
        FORWARDED_SIGNALS.forEach((signal) => process.off(signal, ignore));
      }

      if (result.error !== undefined) {
        report(`ch : impossible de lancer claude (${errorCode(result.error)}).\n`);
        return EXIT_CANNOT_EXECUTE;
      }
      if (result.status !== null) {
        return result.status;
      }
      return result.signal === null ? 1 : SIGNAL_EXIT_BASE + (constants.signals[result.signal] ?? 0);
    },
  };
}

export const realRuntime: Runtime = createRuntime({
  spawn: (command, args, options) => spawnSync(command, [...args], options),
  path: process.env["PATH"],
});
