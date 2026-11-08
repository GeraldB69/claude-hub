import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cherche un exécutable dans le PATH en ignorant les entrées vides ou relatives : elles se résoudraient
 * dans le dossier du projet, où un dépôt non fiable pourrait avoir déposé un faux exécutable.
 * Un nom contenant un séparateur de chemin est refusé.
 */
export function findExecutable(name: string, pathVariable: string | undefined): string | undefined {
  if (name === "" || name.includes(sep) || name.includes("/")) {
    return undefined;
  }
  return (pathVariable ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry))
    .map((entry) => join(entry, name))
    .find(isExecutableFile);
}
