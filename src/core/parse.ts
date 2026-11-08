import { parse as parseYaml, YAMLParseError } from "yaml";
import type { ZodError } from "zod";

/**
 * Lit un document YAML sans jamais reprendre d'extrait du texte dans l'erreur : la
 * bibliothèque cite la ligne fautive, qui pourrait contenir une donnée sensible.
 * Un document vide donne un objet vide.
 */
export function parseYamlDocument(yamlText: string): unknown {
  try {
    return parseYaml(yamlText, { logLevel: "error" }) ?? {};
  } catch (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    throw new Error(`YAML invalide${line === undefined ? "" : ` (ligne ${line})`}`);
  }
}

/** Décrit les problèmes de validation par chemin de champ et message, sans reprendre les valeurs reçues. */
export function formatIssues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`).join(" ; ");
}
