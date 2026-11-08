const CONTROL_KEEPING_LAYOUT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Neutralise les caractères de contrôle (séquences d'échappement du terminal comprises) avant affichage,
 * en gardant sauts de ligne et tabulations. Un nom de fichier issu d'un dépôt non fiable ne doit pas pouvoir
 * piloter le terminal.
 */
export const printable = (text: string): string => text.replace(CONTROL_KEEPING_LAYOUT, "?");

/** Comme `printable`, mais neutralise aussi sauts de ligne et tabulations : pour un fragment qui doit rester sur une ligne. */
export const singleLine = (text: string): string => text.replace(CONTROL_ALL, "?");
