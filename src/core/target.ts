import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { Env } from "./env.js";
import { loadProfile, type Profile } from "./profile.js";
import { protectedReason } from "./protected.js";
import { loadRegistry } from "./registry.js";

/** Erreur d'usage de la ligne de commande (code de sortie 2), par opposition à un échec d'exécution (3). */
export class UsageError extends Error {}

export interface Target {
  readonly projectDir: string;
  readonly profile: Profile;
}

function assertDirectory(path: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new Error(`Dossier introuvable ou illisible : ${path}`);
  }
}

/**
 * Résout l'argument d'une commande qui agit sur un projet : nom exact ou chemin (jamais de préfixe,
 * car la commande écrit). Le profil vient de `--profile`, sinon du registre. Refuse les dossiers protégés.
 */
export function resolveTarget(env: Env, query: string, profileOption: string | undefined): Target {
  const absoluteQuery = resolve(env.cwd, query);
  const registered = loadRegistry(env.configDir, env.workspaceRoot).find(
    (project) => project.name === query || project.path === absoluteQuery
  );
  const profileName = profileOption ?? registered?.profile;
  if (profileName === undefined) {
    throw new UsageError("projet non enregistré, indiquer le profil avec --profile <nom>.");
  }
  const projectDir = registered?.path ?? absoluteQuery;
  const refusal = protectedReason(projectDir, env);
  if (refusal !== undefined) {
    throw new Error(`Refus : ${projectDir} est ${refusal}, pas un projet.`);
  }
  const profile = loadProfile(profileName, { configDir: env.configDir, examplesDir: env.examplesDir });
  assertDirectory(projectDir);
  return { projectDir, profile };
}
