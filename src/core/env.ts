export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Contexte d'exécution commun à toutes les commandes. */
export interface Env {
  readonly home: string;
  readonly configDir: string;
  /** Racines scannées par défaut par `ch audit`. */
  readonly defaultRoots: readonly string[];
  /** Racine de travail : base des chemins relatifs du registre. */
  readonly workspaceRoot: string;
  /** Dossier `examples` livré avec l'engine (profils génériques). */
  readonly examplesDir: string;
  /** Dossier courant, base des chemins relatifs donnés en argument. */
  readonly cwd: string;
  /** Dossier d'état de l'outil ; les sauvegardes de fichiers modifiés vont dans `backups/`. */
  readonly stateDir: string;
  /** Valeur de CLAUDE_CONFIG_DIR si elle est définie (organisation non vérifiée : l'audit refuse de tourner). */
  readonly claudeConfigDir?: string;
}

/** Une session Claude Code en cours d'exécution sur la machine. */
export interface ClaudeProcess {
  readonly pid: number;
  /** Dossier de travail du processus ; `undefined` s'il n'est pas lisible. */
  readonly cwd: string | undefined;
  /** true si cette session est un ancêtre du processus courant : c'est elle qui exécute `ch`. */
  readonly ancestor: boolean;
}

/** Effets de bord externes, injectés pour que les commandes restent testables. */
export interface Runtime {
  /** Sessions Claude Code actuellement ouvertes, avec leur dossier de travail. */
  claudeProcesses(): readonly ClaudeProcess[];
  /** Lance `claude` dans `cwd` avec les arguments donnés et retourne son code de sortie. */
  launchClaude(cwd: string, args: readonly string[]): number;
}

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 3;
/** Conventions du shell, pour `ch open` quand `claude` ne peut pas être lancé. */
export const EXIT_CANNOT_EXECUTE = 126;
export const EXIT_COMMAND_NOT_FOUND = 127;
