import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { isRecord } from "./settings.js";

/** Version d'un plugin dans le cache (`<marketplace>/<plugin>/<version>`) qu'aucun plugin installé n'utilise. */
export interface OrphanVersion {
  readonly path: string;
  /** `marketplace/plugin/version`, pour l'affichage. */
  readonly label: string;
  readonly bytes: number;
}

export type GcPlan =
  | { readonly status: "ok"; readonly cacheRoot: string; readonly orphans: readonly OrphanVersion[]; readonly kept: number }
  /** On ne sait pas ce qui est utilisé : rien ne doit être supprimé. */
  | { readonly status: "unknown"; readonly cacheRoot: string; readonly reason: string };

/**
 * Chemin absolu réel, y compris pour un chemin qui n'existe pas : on résout le plus proche ancêtre existant
 * (liens symboliques compris) puis on ajoute le reste. Deux écritures du même endroit donnent la même chaîne.
 */
function canonical(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        return absolute;
      }
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

const realDirectories = (directory: string): string[] => {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
};

/** Taille en octets sans suivre les liens symboliques ; une entrée illisible compte 0. */
function sizeOf(path: string): number {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) {
      return stats.size;
    }
    return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
  } catch {
    return 0;
  }
}

const UNREADABLE = "installed_plugins.json est absent ou illisible : impossible de savoir ce qui est utilisé";
const UNEXPECTED = "installed_plugins.json n'a pas la structure observée (version 2) : impossible de savoir ce qui est utilisé";

/**
 * Chemins d'installation déclarés dans `installed_plugins.json`, tous scopes confondus. Échoue fermé : toute
 * forme inattendue (autre version du fichier, valeur qui n'est pas un tableau, entrée sans `installPath`
 * absolu) donne une raison, jamais une liste partielle.
 */
function installPaths(home: string): { readonly paths: readonly string[] } | { readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8"));
  } catch {
    return { reason: UNREADABLE };
  }
  if (!isRecord(parsed) || parsed["version"] !== 2 || !isRecord(parsed["plugins"])) {
    return { reason: UNEXPECTED };
  }
  const paths: string[] = [];
  for (const entries of Object.values(parsed["plugins"])) {
    if (!Array.isArray(entries)) {
      return { reason: UNEXPECTED };
    }
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry) || typeof entry["installPath"] !== "string" || !isAbsolute(entry["installPath"])) {
        return { reason: UNEXPECTED };
      }
      paths.push(canonical(entry["installPath"]));
    }
  }
  return { paths };
}

/** Lecture seule : repère les versions du cache non référencées par `installed_plugins.json`. */
export function planGc(home: string): GcPlan {
  const cacheRoot = join(home, ".claude/plugins/cache");
  try {
    if (lstatSync(cacheRoot).isSymbolicLink()) {
      return { status: "unknown", cacheRoot, reason: "le cache des plugins est un lien symbolique" };
    }
  } catch {
    return { status: "ok", cacheRoot, orphans: [], kept: 0 };
  }
  const used = installPaths(home);
  if ("reason" in used) {
    return { status: "unknown", cacheRoot, reason: used.reason };
  }
  const inUse = (version: string): boolean =>
    used.paths.some((path) => path === version || path.startsWith(`${version}${sep}`));

  const orphans: OrphanVersion[] = [];
  let kept = 0;
  let found = 0;
  for (const marketplace of realDirectories(cacheRoot)) {
    for (const plugin of realDirectories(join(cacheRoot, marketplace))) {
      for (const version of realDirectories(join(cacheRoot, marketplace, plugin))) {
        const path = join(cacheRoot, marketplace, plugin, version);
        found += 1;
        if (inUse(canonical(path))) {
          kept += 1;
        } else {
          orphans.push({ path, label: `${marketplace}/${plugin}/${version}`, bytes: sizeOf(path) });
        }
      }
    }
  }
  // Aucun plugin déclaré alors que le cache est plein : fichier vidé ou tronqué plutôt que cache entièrement inutile.
  if (used.paths.length === 0 && found > 0) {
    return { status: "unknown", cacheRoot, reason: "installed_plugins.json ne déclare aucun plugin alors que le cache en contient" };
  }
  return { status: "ok", cacheRoot, orphans, kept };
}
