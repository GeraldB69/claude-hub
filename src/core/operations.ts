import type { SettingsPatch } from "./settings.js";

/** Opération d'écriture planifiée ; seule `fs-safe.ts` sait l'exécuter. */
export type Operation =
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | { readonly kind: "append-line"; readonly path: string; readonly line: string }
  /** Copie un fichier existant dans `backupDir` sans le modifier ; sans effet s'il n'existe pas. */
  | { readonly kind: "backup"; readonly path: string; readonly backupDir: string }
  /** Supprime un dossier (et son contenu) ; refuse un lien symbolique ou autre chose qu'un dossier. Sans sauvegarde : réservé à ce qui se régénère. */
  | { readonly kind: "remove-tree"; readonly path: string }
  /** Fusionne le patch dans un JSON existant (créé s'il est absent) ; l'original est sauvegardé dans `backupDir` avant remplacement. */
  | {
      readonly kind: "merge-json";
      readonly path: string;
      readonly patch: SettingsPatch;
      readonly backupDir: string;
    };

/** `skipped` : non tentée parce qu'une opération précédente a échoué. */
export type OperationStatus = "done" | "dry-run" | "conflict" | "error" | "skipped";

export interface OperationResult {
  readonly operation: Operation;
  readonly status: OperationStatus;
  /** Code d'erreur système ou motif de refus (`SYMLINK`, `OUTSIDE_ROOT`, …), jamais un contenu de fichier. */
  readonly detail?: string;
  /** Chemin de la sauvegarde de l'original, quand une opération en a fait une. */
  readonly backup?: string;
}

const DETAIL_TEXT: Readonly<Record<string, string>> = {
  SYMLINK: "un lien symbolique se trouve sur le chemin",
  OUTSIDE_ROOT: "chemin hors du projet",
  NOT_A_FILE: "ce n'est pas un fichier ordinaire",
  READ_ONLY: "fichier protégé en écriture",
  EXISTS: "le fichier existe déjà",
  INVALID_JSON: "JSON invalide",
  INVALID_STRUCTURE: "structure inattendue (une clé gérée n'est pas un objet)",
  BOM: "le fichier commence par un BOM UTF-8, à retirer",
  DEST_EXISTS: "la destination existe déjà",
  SOURCE_MISSING: "le dossier du projet n'existe plus",
  NOT_A_DIRECTORY: "ce n'est pas un dossier",
  KEY_CONFLICT: "un historique Claude existe déjà pour la destination",
  UNDO_INCOMPLETE: "l'annulation n'a pas pu tout défaire",
  SOURCE_OCCUPIED: "l'emplacement d'origine est de nouveau occupé",
  REGISTRY_UNUSABLE: "le registre ne peut pas être réécrit (lien symbolique, autre propriétaire ou type inattendu)",
  CLAUDE_JSON_BUSY: "~/.claude.json est modifié en continu par un autre processus : rien n'a été écrit",
  REGISTRY_INVALID: "le registre est illisible ou le projet y est introuvable",
  REGISTRY_MISMATCH: "la modification du registre n'a pas donné le résultat attendu",
  MODIFIED_BY_OTHER: "fichier modifié par un autre processus depuis l'écriture : restauration manuelle nécessaire",
};

/** Traduit un code de refus ou d'erreur en phrase ; un code système inconnu est rendu tel quel. */
export const describeDetail = (detail: string | undefined): string =>
  detail === undefined ? "raison inconnue" : (DETAIL_TEXT[detail] ?? detail);
