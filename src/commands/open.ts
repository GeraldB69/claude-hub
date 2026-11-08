import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_USAGE, type Env, type Io, type Runtime } from "../core/env.js";
import { protectedReason } from "../core/protected.js";
import { loadRegistry, resolveProject, type Project, type Resolution } from "../core/registry.js";

interface OpenOptions {
  readonly force?: boolean | undefined;
  readonly "add-dir"?: string[] | undefined;
  readonly positionals: readonly string[];
}

function parseOptions(argv: readonly string[]): OpenOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { force: { type: "boolean" }, "add-dir": { type: "string", multiple: true } },
    allowPositionals: true,
    strict: true,
  });
  return { ...values, positionals };
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const projectOf = (resolution: Resolution): Project | undefined =>
  resolution.kind === "found" ? resolution.project : undefined;

/** Explique pourquoi une recherche de projet n'a pas abouti ; `hint` complète le cas « inconnu ». */
function failureMessage(resolution: Resolution, query: string, hint = ""): string {
  return resolution.kind === "ambiguous"
    ? `ch open : « ${query} » est ambigu : ${resolution.candidates.join(", ")}.`
    : `ch open : projet inconnu : ${query}.${hint}`;
}

/**
 * `ch open <projet> [--add-dir <projet>]... [--force] [-- <arguments de claude>]` : lance `claude`
 * dans le dossier du projet, jamais depuis la racine de travail ni le dossier personnel. Les
 * `--add-dir` ne sont acceptés que s'ils désignent un projet du registre.
 */
export function openCommand(argv: readonly string[], env: Env, io: Io, runtime: Runtime): number {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  let options: OpenOptions;
  try {
    options = parseOptions(own);
  } catch (error) {
    io.err(`ch open : ${reason(error)}`);
    return EXIT_USAGE;
  }
  const [query, ...extra] = options.positionals;
  if (query === undefined || extra.length > 0) {
    io.err("ch open : un seul projet attendu. Usage : ch open <projet> [--add-dir <projet>]... [--force] [-- <arguments de claude>]");
    return EXIT_USAGE;
  }

  let projects: readonly Project[];
  try {
    projects = loadRegistry(env.configDir, env.workspaceRoot);
  } catch (error) {
    io.err(`ch open : ${reason(error)}`);
    return EXIT_ERROR;
  }

  const force = options.force === true;
  const resolution = resolveProject(projects, query, { exactOnly: force });
  const main = projectOf(resolution);
  if (main === undefined && !(force && resolution.kind === "unknown")) {
    io.err(failureMessage(resolution, query, " Utiliser --force pour ouvrir un dossier hors registre."));
    return EXIT_USAGE;
  }
  const directory = main?.path ?? resolve(env.cwd, query);

  const refusal = protectedReason(directory, env);
  if (refusal !== undefined) {
    io.err(`ch open : Refus : ${directory} est ${refusal} ; lancer claude directement si c'est voulu.`);
    return EXIT_ERROR;
  }
  if (!isDirectory(directory)) {
    io.err(`ch open : dossier introuvable pour « ${query} » : ${directory}`);
    return EXIT_ERROR;
  }

  const requested = (options["add-dir"] ?? []).map((name) => ({ name, resolution: resolveProject(projects, name) }));
  const unresolved = requested.find((entry) => projectOf(entry.resolution) === undefined);
  if (unresolved !== undefined) {
    io.err(failureMessage(unresolved.resolution, unresolved.name));
    return EXIT_USAGE;
  }
  const addDirs = [
    ...new Set(requested.flatMap((entry) => projectOf(entry.resolution)?.path ?? []).filter((path) => path !== directory)),
  ];
  const missing = addDirs.find((path) => !isDirectory(path));
  if (missing !== undefined) {
    io.err(`ch open : dossier de --add-dir introuvable : ${missing}`);
    return EXIT_ERROR;
  }

  if (!existsSync(join(directory, ".claude", "settings.json"))) {
    io.err(`ch open : ${directory} n'a pas encore de .claude/settings.json ; lancer « ch init » pour appliquer son profil.`);
  }
  return runtime.launchClaude(directory, [...addDirs.flatMap((path) => ["--add-dir", path]), ...passthrough]);
}
