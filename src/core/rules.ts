import { MAX_KEY_LENGTH, projectKey } from "./project-key.js";
import type { Finding, Policy, Severity, Snapshot } from "./types.js";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2 };

type Rule = (snapshot: Snapshot, policy: Policy) => readonly Finding[];

const pluginUserScope: Rule = (snapshot, policy) =>
  snapshot.plugins
    .filter((plugin) => plugin.scope === "user" && !policy.userPluginAllowlist.includes(plugin.id))
    .map((plugin) => ({
      rule: "plugin-user-scope",
      severity: "warn",
      subject: plugin.id,
      message: "Plugin installé au scope user, absent de la liste autorisée : il se charge dans tous les projets.",
    }));

const pluginUnknownScope: Rule = (snapshot) =>
  snapshot.plugins
    .filter((plugin) => plugin.scope === "unknown")
    .map((plugin) => ({
      rule: "plugin-unknown-scope",
      severity: "info",
      subject: plugin.id,
      message: `Scope de plugin non reconnu par cet outil : « ${plugin.rawScope ?? "?"} » (version de Claude Code plus récente ?).`,
    }));

const pluginLocalStale: Rule = (snapshot) =>
  snapshot.plugins
    .filter((plugin) => plugin.scope === "local" && plugin.projectPathExists === false)
    .map((plugin) => ({
      rule: "plugin-local-stale",
      severity: "warn",
      subject: plugin.id,
      message: `Plugin local rattaché à un dossier disparu : ${plugin.projectPath ?? "chemin inconnu"}.`,
    }));

const agentsSkillsNonEmpty: Rule = (snapshot, policy) => {
  const unlinked = snapshot.agentsSkills.filter((skill) => !skill.linked);
  return policy.agentsSkillsMustBeEmpty && unlinked.length > 0
    ? [
        {
          rule: "agents-skills-nonempty",
          severity: "warn",
          subject: `${snapshot.home}/.agents/skills`,
          message: `${unlinked.length} entrée(s) de ~/.agents/skills sans lien depuis ~/.claude/skills : inertes, Claude Code ne lit pas ce dossier directement.`,
        },
      ]
    : [];
};

const skillBrokenLink: Rule = (snapshot) =>
  snapshot.brokenSkillLinks.map((path) => ({
    rule: "skill-broken-link",
    severity: "warn",
    subject: path,
    message: "Lien symbolique de ~/.claude/skills dont la cible n'existe plus.",
  }));

const strayFolders: Rule = (snapshot) =>
  snapshot.strayDirs.flatMap((dir): readonly Finding[] => {
    if (!dir.hasChildProjects) {
      return [
        {
          rule: "project-without-git",
          severity: "info",
          subject: dir.path,
          message: `Dossier hors dépôt git contenant ${dir.entries.join(", ")} : configuration Claude ni versionnée ni sauvegardée par git.`,
        },
      ];
    }
    const hasConfigDir = dir.entries.some((entry) => entry === ".claude" || entry === ".agents");
    if (hasConfigDir) {
      return [
        {
          rule: "stray-parent-config",
          severity: "warn",
          subject: dir.path,
          message: `Dossier parent hors dépôt git contenant ${dir.entries.join(", ")} : configuration non versionnée, dont les skills et le CLAUDE.md descendent dans les projets non git en dessous.`,
        },
      ];
    }
    return [
      {
        rule: "stray-parent-claude-md",
        severity: "info",
        subject: dir.path,
        message: "CLAUDE.md d'un dossier parent hors dépôt git : il est hérité par tous les projets en dessous.",
      },
    ];
  });

const projectKeyTooLong: Rule = (snapshot) =>
  snapshot.liveProjects
    .filter((path) => !projectKey(path).reliable)
    .map((path) => ({
      rule: "project-key-too-long",
      severity: "error",
      subject: path,
      message: `La clé de projet Claude Code de ce chemin ne peut pas être calculée de façon fiable (clé de ${MAX_KEY_LENGTH} caractères ou plus, ou caractère hors plan de base Unicode) : raccourcir le chemin ou retirer ces caractères.`,
    }));

const orphanProjectKey: Rule = (snapshot) => {
  const keyOf = (path: string): string => projectKey(path).key;
  const exactKeys = new Set(
    [...snapshot.liveProjects, ...snapshot.strayDirs.map((dir) => dir.path), ...snapshot.repoPaths].map(keyOf)
  );
  // Seuls les dépôts git absorbent leurs sous-dossiers : un projet ancêtre comme le home masquerait toutes les autres clés.
  const repoKeys = snapshot.repoPaths.map(keyOf);
  const belongsToKnownProject = (key: string): boolean =>
    exactKeys.has(key) || repoKeys.some((repoKey) => key.startsWith(`${repoKey}-`));
  return snapshot.projectKeys
    .filter((key) => key.length < MAX_KEY_LENGTH && !belongsToKnownProject(key))
    .map((key) => ({
      rule: "orphan-project-key",
      severity: "info",
      subject: key,
      message:
        "Dossier de ~/.claude/projects sans projet connu correspondant. Information seulement : ne pas supprimer sur cette seule base, le projet peut exister hors des racines scannées.",
    }));
};

const accountSyncEnabled: Rule = (snapshot, policy) => {
  if (policy.allowAccountSync) {
    return [];
  }
  const plugins = snapshot.syncSettings.plugins === false ? 0 : snapshot.syncedPlugins.length;
  const skills = snapshot.syncSettings.skills === false ? 0 : snapshot.syncedSkills.length;
  if (plugins + skills === 0) {
    return [];
  }
  const parts = [
    ...(plugins > 0 ? [`${plugins} plugin(s)`] : []),
    ...(skills > 0 ? [`${skills} skill(s)`] : []),
  ];
  const keys = [
    ...(plugins > 0 ? ["syncClaudeAiPlugins"] : []),
    ...(skills > 0 ? ["syncClaudeAiSkills"] : []),
  ];
  return [
    {
      rule: "account-sync-enabled",
      severity: "warn",
      subject: `${snapshot.home}/.claude`,
      message: `${parts.join(" et ")} synchronisé(s) depuis le compte claude.ai, chargé(s) dans tous les projets. Pour les couper : ${keys.join(", ")} à false dans ~/.claude/settings.json.`,
    },
  ];
};

const scanSkipped: Rule = (snapshot) =>
  snapshot.skipped.map((path) => ({
    rule: "scan-skipped",
    severity: "info",
    subject: path,
    message: "Chemin illisible ou de type inattendu, ignoré : l'audit n'est pas exhaustif pour cet emplacement.",
  }));

const RULES: readonly Rule[] = [
  pluginUserScope,
  pluginUnknownScope,
  pluginLocalStale,
  agentsSkillsNonEmpty,
  skillBrokenLink,
  strayFolders,
  projectKeyTooLong,
  orphanProjectKey,
  accountSyncEnabled,
  scanSkipped,
];

/** Applique toutes les règles d'audit ; résultat trié du plus au moins grave (ordre des règles conservé à gravité égale). */
export function runRules(snapshot: Snapshot, policy: Policy): readonly Finding[] {
  return RULES.flatMap((rule) => rule(snapshot, policy)).toSorted(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
}
