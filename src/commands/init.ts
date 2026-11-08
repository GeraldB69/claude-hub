import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Env, type Io } from "../core/env.js";
import { applyOperations } from "../core/fs-safe.js";
import { describeDetail } from "../core/operations.js";
import { planInit } from "../core/plan.js";
import { resolveTarget, UsageError } from "../core/target.js";

interface InitOptions {
  readonly profile?: string | undefined;
  readonly "dry-run"?: boolean | undefined;
  readonly positionals: readonly string[];
}

function parseOptions(argv: readonly string[]): InitOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { profile: { type: "string" }, "dry-run": { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  return { ...values, positionals };
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `ch init <projet|chemin> [--profile <nom>] [--dry-run]` : prépare la configuration Claude d'un projet. */
export function initCommand(argv: readonly string[], env: Env, io: Io): number {
  let options: InitOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.err(`ch init : ${reason(error)}`);
    return EXIT_USAGE;
  }
  const [query, ...extra] = options.positionals;
  if (query === undefined || extra.length > 0) {
    io.err("ch init : un seul projet attendu. Usage : ch init <projet|chemin> [--profile <nom>] [--dry-run]");
    return EXIT_USAGE;
  }

  try {
    const { projectDir, profile } = resolveTarget(env, query, options.profile);
    const dryRun = options["dry-run"] === true;
    const entries = planInit(projectDir, profile);
    io.out(dryRun ? `[simulation] Rien ne sera écrit. Projet : ${projectDir}` : `Projet : ${projectDir}`);
    entries.forEach((entry) => io.out(`${entry.symbol} ${entry.label}`));

    const results = applyOperations(
      entries.flatMap((entry) => entry.operations),
      { dryRun, root: projectDir }
    );
    const failure = results.find((result) => result.status === "error" || result.status === "conflict");
    if (failure !== undefined) {
      io.err(`ch init : échec sur ${failure.operation.path} (${describeDetail(failure.detail ?? failure.status)}) ; état partiel possible.`);
      results.filter((result) => result.status === "done").forEach((result) => io.err(`  fait : ${result.operation.path}`));
      results
        .filter((result) => result.status === "skipped")
        .forEach((result) => io.err(`  non exécuté : ${result.operation.path}`));
      return EXIT_ERROR;
    }

    if (profile.plugins.length > 0) {
      io.out("");
      io.out("Plugins du profil à installer (ch init ne les installe pas ; ch apply le fait) :");
      profile.plugins.forEach((id) => io.out(`  claude plugin install ${id} --scope project`));
    }
    return EXIT_OK;
  } catch (error) {
    io.err(`ch init : ${reason(error)}`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}
