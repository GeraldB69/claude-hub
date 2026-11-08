export type PluginScope = "user" | "project" | "local" | "managed" | "unknown";

export interface PluginEntry {
  readonly id: string;
  readonly scope: PluginScope;
  /** Valeur brute du scope quand il n'est pas reconnu (`scope: "unknown"`). */
  readonly rawScope?: string;
  /** Renseigné pour le scope local : dossier du projet auquel le plugin est rattaché. */
  readonly projectPath?: string;
  readonly projectPathExists?: boolean;
}

/** Entrée de `~/.agents/skills` et état de son lien depuis `~/.claude/skills`. */
export interface AgentsSkill {
  readonly name: string;
  /** true si un symlink de `~/.claude/skills` pointe vers elle : seul cas où Claude Code la voit. */
  readonly linked: boolean;
}

/** Dossier hors dépôt git contenant de la configuration Claude. */
export interface StrayDir {
  readonly path: string;
  readonly entries: readonly string[];
  /**
   * true si un sous-dossier direct est un projet (dépôt git, ou dossier portant lui-même de la
   * configuration Claude) : ce dossier est alors un parent dont les enfants héritent. Faux pour
   * un projet feuille dont les sous-dossiers ne sont que du contenu.
   */
  readonly hasChildProjects: boolean;
}

/** Photographie en lecture seule de l'état du poste, seule entrée des règles d'audit. */
export interface Snapshot {
  readonly home: string;
  readonly plugins: readonly PluginEntry[];
  readonly agentsSkills: readonly AgentsSkill[];
  /** Symlinks de `~/.claude/skills` dont la cible n'existe plus. */
  readonly brokenSkillLinks: readonly string[];
  /** Noms des dossiers de `~/.claude/projects`. */
  readonly projectKeys: readonly string[];
  /** Chemins absolus de projets connus de `~/.claude.json` qui existent encore sur le disque. */
  readonly liveProjects: readonly string[];
  /** Dépôts git trouvés sous les racines scannées. */
  readonly repoPaths: readonly string[];
  readonly strayDirs: readonly StrayDir[];
  /** Identifiants des plugins synchronisés depuis le compte claude.ai (`~/.claude/plugins/synced`). */
  readonly syncedPlugins: readonly string[];
  /** Noms des skills synchronisés depuis le compte claude.ai (`~/.claude/skills/synced`). */
  readonly syncedSkills: readonly string[];
  /** Réglages de synchronisation posés dans `~/.claude/settings.json` ; absent = comportement par défaut (activé). */
  readonly syncSettings: { readonly plugins?: boolean; readonly skills?: boolean };
  /** Chemins que le scan n'a pas pu lire (droits, type inattendu) : l'audit n'est alors pas exhaustif. */
  readonly skipped: readonly string[];
}

export interface Policy {
  readonly userPluginAllowlist: readonly string[];
  readonly agentsSkillsMustBeEmpty: boolean;
  /** true si les plugins et skills synchronisés depuis le compte claude.ai sont voulus dans tous les projets. */
  readonly allowAccountSync: boolean;
}

export type Severity = "error" | "warn" | "info";

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly subject: string;
  readonly message: string;
}
