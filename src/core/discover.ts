import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Profondeur par défaut sous la racine : `<catégorie>/<projet>`, plus un niveau de marge. */
export const DEFAULT_DISCOVERY_DEPTH = 3;

const SKIPPED_NAMES = new Set(["node_modules"]);

function subdirectories(directory: string): readonly string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_NAMES.has(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

/**
 * Dépôts git (dossier ou fichier `.git`) sous `root`, triés. Ne descend ni dans un dépôt, ni dans un
 * dossier caché ou `node_modules`, et ne suit pas les liens symboliques.
 */
export function discoverRepos(root: string, maxDepth: number = DEFAULT_DISCOVERY_DEPTH): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    if (depth > 0 && existsSync(join(directory, ".git"))) {
      found.push(directory);
      return;
    }
    for (const name of subdirectories(directory)) {
      walk(join(directory, name), depth + 1);
    }
  };
  walk(root, 0);
  return found.toSorted();
}
