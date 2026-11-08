import { isAbsolute } from "node:path";

/**
 * Claude Code tronque les clés de plus de 200 caractères et leur ajoute un hash
 * dont l'algorithme est inconnu. La limite exacte (200 inclus ou non) n'est pas
 * vérifiée : une clé qui atteint 200 caractères est donc traitée comme peu fiable.
 */
export const MAX_KEY_LENGTH = 200;

export interface ProjectKey {
  readonly key: string;
  /** false si la clé réelle de Claude Code ne peut pas être calculée avec certitude. */
  readonly reliable: boolean;
}

const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;
const OUTSIDE_BMP = /[\u{10000}-\u{10FFFF}]/u;

/** Calcule le nom de dossier de `~/.claude/projects` pour un chemin de projet (comportement observé). */
export function projectKey(absolutePath: string): ProjectKey {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Chemin absolu attendu : ${absolutePath}`);
  }
  const key = absolutePath.replace(NON_ALPHANUMERIC, "-");
  const reliable = key.length < MAX_KEY_LENGTH && !OUTSIDE_BMP.test(absolutePath);
  return { key, reliable };
}
