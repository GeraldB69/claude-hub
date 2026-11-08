import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { formatIssues, parseYamlDocument } from "./parse.js";
import { NAME_PATTERN } from "./profile.js";

/** Nom de projet : comme un nom de profil, avec un `_` initial permis pour les projets d'outillage (`_engine`, `_config`). */
const PROJECT_NAME_PATTERN = /^_?[a-z0-9][a-z0-9-]*$/;

export const isValidProjectName = (name: string): boolean => PROJECT_NAME_PATTERN.test(name);

export const REGISTRY_FILE_NAME = "projects.yaml";

const entrySchema = z.strictObject({
  name: z.string().regex(PROJECT_NAME_PATTERN),
  path: z.string().min(1),
  profile: z.string().regex(NAME_PATTERN),
  remote: z.string().min(1).optional(),
});

const registrySchema = z.strictObject({
  projects: z.array(entrySchema).default([]),
});

export interface Project {
  readonly name: string;
  /** Chemin absolu et normalisé du dossier du projet. */
  readonly path: string;
  readonly profile: string;
  readonly remote?: string | undefined;
}

export type Resolution =
  | { readonly kind: "found"; readonly project: Project }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "unknown" };

/**
 * Un chemin relatif est confiné sous la racine de travail ; un chemin absolu est accepté tel quel
 * (le registre est un fichier privé de confiance). Dans les deux cas, un projet ne peut pas être la racine elle-même.
 */
function resolveProjectPath(path: string, workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot, path);
  const isRelative = !path.startsWith("/");
  const root = resolve(workspaceRoot);
  if (absolute === root) {
    throw new Error(`Le chemin d'un projet ne peut pas être la racine de travail : ${path}`);
  }
  if (isRelative && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`Chemin hors de la racine de travail : ${path}`);
  }
  return absolute;
}

function assertUnique(projects: readonly Project[]): void {
  const seenNames = new Set<string>();
  const seenPaths = new Map<string, string>();
  for (const project of projects) {
    if (seenNames.has(project.name)) {
      throw new Error(`Nom de projet en double : ${project.name}`);
    }
    seenNames.add(project.name);
    const other = seenPaths.get(project.path);
    if (other !== undefined) {
      throw new Error(`Deux projets partagent le même chemin : ${other} et ${project.name}`);
    }
    seenPaths.set(project.path, project.name);
  }
}

/** Valide le texte YAML du registre ; les chemins relatifs sont résolus contre la racine de travail. */
export function parseRegistry(yamlText: string, workspaceRoot: string): readonly Project[] {
  const result = registrySchema.safeParse(parseYamlDocument(yamlText));
  if (!result.success) {
    throw new Error(`Registre invalide : ${formatIssues(result.error)}`);
  }
  const projects = result.data.projects.map(
    (entry): Project => ({
      name: entry.name,
      path: resolveProjectPath(entry.path, workspaceRoot),
      profile: entry.profile,
      ...(entry.remote === undefined ? {} : { remote: entry.remote }),
    })
  );
  assertUnique(projects);
  return projects;
}

/** Charge `projects.yaml` du dossier de configuration ; absent, le registre est vide. */
export function loadRegistry(configDir: string, workspaceRoot: string): readonly Project[] {
  const file = join(configDir, REGISTRY_FILE_NAME);
  if (!existsSync(file)) {
    return [];
  }
  try {
    return parseRegistry(readFileSync(file, "utf8"), workspaceRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} : ${reason}`, { cause: error });
  }
}

export interface ResolveOptions {
  /** N'accepter qu'un nom exact ou un chemin absolu enregistré : pas de préfixe. */
  readonly exactOnly?: boolean;
}

/** Retrouve un projet par nom exact, chemin absolu, puis (sauf `exactOnly`) préfixe de nom unique. */
export function resolveProject(
  projects: readonly Project[],
  query: string,
  options: ResolveOptions = {}
): Resolution {
  if (query === "") {
    return { kind: "unknown" };
  }
  const exact =
    projects.find((project) => project.name === query) ??
    (query.startsWith("/") ? projects.find((project) => project.path === resolve(query)) : undefined);
  if (exact !== undefined) {
    return { kind: "found", project: exact };
  }
  if (options.exactOnly === true) {
    return { kind: "unknown" };
  }
  const matches = projects.filter((project) => project.name.startsWith(query));
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    return { kind: "found", project: only };
  }
  return matches.length > 1
    ? { kind: "ambiguous", candidates: matches.map((project) => project.name).toSorted() }
    : { kind: "unknown" };
}
