import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { discoverRepos } from "../core/discover.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Env, type Io } from "../core/env.js";
import { loadRegistry, type Project } from "../core/registry.js";

const OUTSIDE = "(hors workspace)";

interface Entry {
  readonly name: string;
  readonly folder: string;
  readonly path: string;
  readonly profile: string;
  readonly exists: boolean;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Premier segment du chemin sous la racine de travail ; `(hors workspace)` si le projet est ailleurs. */
function folderOf(path: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, path);
  if (rel === "" || rel.startsWith("..")) {
    return OUTSIDE;
  }
  const [first] = rel.split(sep);
  return rel.includes(sep) ? (first ?? OUTSIDE) : "(racine)";
}

function toEntry(project: Project, workspaceRoot: string): Entry {
  return {
    name: project.name,
    folder: folderOf(project.path, workspaceRoot),
    path: project.path,
    profile: project.profile,
    exists: existsSync(project.path),
  };
}

function groupByFolder(entries: readonly Entry[]): ReadonlyMap<string, readonly Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries.toSorted((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))) {
    groups.set(entry.folder, [...(groups.get(entry.folder) ?? []), entry]);
  }
  return groups;
}

function render(entries: readonly Entry[], unregistered: readonly string[], io: Io): void {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  for (const [folder, group] of groupByFolder(entries)) {
    io.out(folder);
    for (const entry of group) {
      const suffix = entry.exists ? entry.profile : `${entry.profile}  (introuvable)`;
      io.out(`  ${entry.name.padEnd(width)}  ${suffix}`);
    }
  }
  if (unregistered.length > 0) {
    io.out("");
    io.out("Hors registre (dépôts git présents sur le disque, à ajouter à projects.yaml) :");
    for (const path of unregistered) {
      io.out(`  ${path}`);
    }
  }
}

/**
 * `ch ls [--json]` : liste les projets du registre classés par dossier, signale ceux dont le dossier a
 * disparu et les dépôts git de la racine de travail qui ne sont pas dans le registre. Lecture seule.
 */
export function lsCommand(argv: readonly string[], env: Env, io: Io): number {
  let json: boolean;
  try {
    const { values } = parseArgs({ args: [...argv], options: { json: { type: "boolean" } }, strict: true });
    json = values.json === true;
  } catch (error) {
    io.err(`ch ls : ${reason(error)}. Usage : ch ls [--json]`);
    return EXIT_USAGE;
  }

  let projects: readonly Project[];
  try {
    projects = loadRegistry(env.configDir, env.workspaceRoot);
  } catch (error) {
    io.err(`ch ls : ${reason(error)}`);
    return EXIT_ERROR;
  }

  const entries = projects.map((project) => toEntry(project, env.workspaceRoot));
  const registered = new Set(projects.map((project) => project.path));
  const unregistered = discoverRepos(env.workspaceRoot)
    .filter((path) => !registered.has(path))
    .map((path) => relative(env.workspaceRoot, path));

  if (json) {
    io.out(JSON.stringify({ projects: entries, unregistered }, null, 2));
  } else {
    render(entries, unregistered, io);
  }
  return EXIT_OK;
}
