import { isMap, isSeq, parseDocument, YAMLParseError } from "yaml";

/**
 * Change le chemin d'un projet (et son nom, si `newName` est donné) dans le texte du registre en conservant
 * commentaires, ordre et style du fichier. Lève une erreur si le YAML est invalide (sans en citer d'extrait)
 * ou si le projet est absent.
 */
export function setProjectPath(yamlText: string, name: string, newPath: string, newName?: string): string {
  const document = parseDocument(yamlText, { logLevel: "error" });
  const [firstError] = document.errors;
  if (firstError !== undefined) {
    const line = firstError instanceof YAMLParseError ? firstError.linePos?.[0]?.line : undefined;
    throw new Error(`YAML invalide${line === undefined ? "" : ` (ligne ${line})`}`);
  }
  const projects = document.get("projects", true);
  const entry = isSeq(projects) ? projects.items.find((item) => isMap(item) && item.get("name") === name) : undefined;
  if (!isMap(entry)) {
    throw new Error(`Projet introuvable dans le registre : ${name}`);
  }
  entry.set("path", newPath);
  if (newName !== undefined && newName !== name) {
    entry.set("name", newName);
  }
  return document.toString({ lineWidth: 0 });
}
