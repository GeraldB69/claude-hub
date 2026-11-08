import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface Reference {
  /** Chemin du fichier, relatif au dossier exploré. */
  readonly file: string;
  readonly line: number;
}

export interface ReferenceSearch {
  readonly hits: readonly Reference[];
  /** true si la recherche s'est arrêtée avant la fin (budget de fichiers ou de résultats atteint). */
  readonly truncated: boolean;
}

export interface ReferenceLimits {
  /** Nombre maximal de fichiers texte lus ; les fichiers trop gros ou binaires ne comptent pas. */
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxHits: number;
}

const DEFAULT_LIMITS: ReferenceLimits = { maxFiles: 5000, maxFileBytes: 1_000_000, maxHits: 20 };
/** Garde-fou sur le nombre total de fichiers parcourus, lus ou non. */
const MAX_VISITED = 50_000;
/** Dossiers que les parcours de fichiers ignorent : dépendances, sorties de build, données de git. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Fichiers ordinaires sous un dossier, dans l'ordre alphabétique, sans suivre de lien ni entrer dans les dossiers ignorés. */
function* walkFiles(directory: string, relativeDir: string): Generator<{ absolute: string; relative: string }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).toSorted(byName);
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
      yield* walkFiles(join(directory, entry.name), relative);
    } else if (entry.isFile()) {
      yield { absolute: join(directory, entry.name), relative };
    }
  }
}

function readTextFile(path: string, maxBytes: number): string | undefined {
  try {
    if (statSync(path).size > maxBytes) {
      return undefined;
    }
    const content = readFileSync(path);
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Cherche les mentions d'un chemin (la mention doit se terminer là : `/a/site-admin` ne compte pas pour
 * `/a/site`). Lecture seule, bornée ; `truncated` dit si la recherche s'est arrêtée avant la fin.
 */
export function findReferences(
  root: string,
  needle: string,
  limits: ReferenceLimits = DEFAULT_LIMITS
): ReferenceSearch {
  const pattern = new RegExp(`${escapeRegExp(needle)}(?![A-Za-z0-9_.-])`);
  const hits: Reference[] = [];
  let visited = 0;
  let read = 0;
  for (const file of walkFiles(root, "")) {
    visited += 1;
    if (visited > MAX_VISITED) {
      return { hits, truncated: true };
    }
    const text = readTextFile(file.absolute, limits.maxFileBytes);
    if (text === undefined) {
      continue;
    }
    if (read >= limits.maxFiles) {
      return { hits, truncated: true };
    }
    read += 1;
    for (const [index, line] of text.split("\n").entries()) {
      if (!pattern.test(line)) {
        continue;
      }
      if (hits.length >= limits.maxHits) {
        return { hits, truncated: true };
      }
      hits.push({ file: file.relative, line: index + 1 });
    }
  }
  return { hits, truncated: false };
}
