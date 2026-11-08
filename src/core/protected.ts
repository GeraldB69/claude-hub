import { join, resolve, sep } from "node:path";

import type { Env } from "./env.js";

/**
 * Dossiers où `ch init` et `ch open` ne doivent jamais agir : y écrire changerait la configuration
 * de tous les projets, et y lancer Claude va à l'encontre de la raison d'être de l'outil.
 * Retourne la raison du refus, ou `undefined` si le dossier est acceptable.
 */
export function protectedReason(path: string, env: Env): string | undefined {
  const target = resolve(path);
  const exact: readonly (readonly [string, string])[] = [
    [env.home, "le dossier personnel"],
    [env.workspaceRoot, "la racine de travail"],
    ...(env.claudeConfigDir === undefined ? [] : ([[env.claudeConfigDir, "le dossier de configuration de Claude"]] as const)),
    ["/", "la racine du système"],
  ];
  const match = exact.find(([folder]) => resolve(folder) === target);
  if (match !== undefined) {
    return match[1];
  }
  const claudeUser = join(resolve(env.home), ".claude");
  return target === claudeUser || target.startsWith(`${claudeUser}${sep}`)
    ? "le dossier de configuration de Claude (~/.claude)"
    : undefined;
}
