import type { Stats } from "node:fs";

/**
 * Pourquoi un fichier ne peut pas être réécrit en toute sécurité par cet outil, ou `undefined` s'il le peut :
 * absent, lien symbolique (non suivi), type inattendu, ou propriétaire différent de l'utilisateur courant
 * (le remplacement atomique crée un nouveau fichier à son nom).
 */
export function unusableReason(stats: Stats | undefined): string | undefined {
  if (stats === undefined) {
    return "fichier absent";
  }
  if (stats.isSymbolicLink()) {
    return "lien symbolique, non suivi";
  }
  if (!stats.isFile()) {
    return "ce n'est pas un fichier ordinaire";
  }
  return typeof process.getuid === "function" && stats.uid !== process.getuid()
    ? "le fichier appartient à un autre utilisateur"
    : undefined;
}
