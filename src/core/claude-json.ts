import { isAbsolute } from "node:path";

import { isRecord } from "./settings.js";

export type RenameResult =
  | { readonly kind: "renamed"; readonly text: string }
  /** Aucune entrée à renommer : rien à faire. */
  | { readonly kind: "absent" }
  /** Réécriture refusée : le fichier reste tel quel et il faudra le corriger à la main si nécessaire. */
  | { readonly kind: "unsafe"; readonly reason: string };

const unsafe = (reason: string): RenameResult => ({ kind: "unsafe", reason });

/**
 * Renomme dans `projects` de `~/.claude.json` (indexé par chemin absolu) l'entrée du projet et celles de
 * ses sous-dossiers (`<from>/…`), en conservant le suffixe et la position. Ne réécrit que si le fichier se
 * ré-sérialise à l'identique (JSON indenté de deux espaces, comme Claude Code l'écrit) : le diff se limite
 * alors aux clés renommées. Les messages ne reprennent jamais le contenu du fichier (jetons du compte).
 * Seules les clés de `projects` sont touchées : les autres champs qui mentionnent l'ancien chemin restent tels quels.
 */
export function renameProjectKey(jsonText: string, from: string, to: string): RenameResult {
  if (!isAbsolute(from) || !isAbsolute(to)) {
    return unsafe("les chemins doivent être absolus");
  }
  const ending = jsonText.endsWith("\n") ? "\n" : "";
  const body = ending === "" ? jsonText : jsonText.slice(0, -1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unsafe("JSON invalide");
  }
  if (!isRecord(parsed)) {
    return unsafe("la racine n'est pas un objet");
  }
  if (JSON.stringify(parsed, null, 2) !== body) {
    return unsafe("le formatage changerait à la réécriture (fichier non standard)");
  }
  const projects = parsed["projects"];
  if (!isRecord(projects)) {
    return { kind: "absent" };
  }
  const entries = Object.entries(projects);
  const prefix = `${from}/`;
  const keys = entries.map(([key]) =>
    key === from ? to : key.startsWith(prefix) ? `${to}${key.slice(from.length)}` : key
  );
  if (keys.every((key, index) => key === entries[index]?.[0])) {
    return { kind: "absent" };
  }
  if (new Set(keys).size !== keys.length) {
    return unsafe("une entrée de destination existe déjà");
  }
  const renamed = Object.fromEntries(entries.map(([, value], index) => [keys[index] ?? "", value]));
  return { kind: "renamed", text: `${JSON.stringify({ ...parsed, projects: renamed }, null, 2)}${ending}` };
}
