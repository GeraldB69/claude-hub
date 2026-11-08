import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { renameProjectKey } from "./claude-json.js";
import { unusableReason } from "./file-state.js";
import type { ClaudeProcess, Env } from "./env.js";
import { projectKey } from "./project-key.js";
import { singleLine } from "./printable.js";
import { protectedReason } from "./protected.js";
import { findReferences, IGNORED_DIRECTORIES } from "./references.js";
import { isValidProjectName, loadRegistry, resolveProject, type Project } from "./registry.js";
import { isRecord } from "./settings.js";

export interface SubfolderKey {
  readonly from: string;
  readonly to: string;
}

/** Tout ce que `executeMove` a besoin de savoir ; calculé en lecture seule par `planMove`. */
export interface MovePlan {
  readonly project: Project;
  readonly source: string;
  readonly destination: string;
  readonly oldKey: string;
  readonly newKey: string;
  /** Historique de sous-dossiers du projet (sessions lancées depuis un sous-dossier), à renommer aussi. */
  readonly subfolderKeys: readonly SubfolderKey[];
  readonly projectsDir: string;
  readonly claudeJsonPath: string;
  readonly registryPath: string;
  /** Racine de travail : base des chemins relatifs du registre. */
  readonly workspaceRoot: string;
  /** Chemin à inscrire dans le registre, relatif à la racine de travail. */
  readonly newRegistryPath: string;
  /**
   * Nom à inscrire dans le registre : celui du dossier de destination quand le projet portait le nom de son
   * dossier (convention du registre), sinon le nom actuel.
   */
  readonly newName: string;
  readonly backupDir: string;
}

export interface ClaudeJsonStatus {
  readonly status: "renamed" | "absent" | "unsafe";
  readonly reason?: string;
}

export type MovePlanResult =
  | {
      readonly kind: "ok";
      readonly plan: MovePlan;
      readonly warnings: readonly string[];
      readonly claudeJson: ClaudeJsonStatus;
      /** true si `~/.claude/projects` contient déjà un dossier d'historique pour le projet. */
      readonly historyPresent: boolean;
    }
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  | { readonly kind: "usage"; readonly message: string };

/** Qui possède déjà une clé d'historique : un autre projet du registre ou une autre entrée de `~/.claude.json`. */
interface KeyOwner {
  readonly key: string;
  readonly label: string;
}

const SCAN_DEPTH = 4;
const REFERENCE_PREVIEW = 5;

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function notWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

const isInside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

function nearestExisting(path: string): string {
  let current = path;
  while (lstatOrUndefined(current) === undefined && dirname(current) !== current) {
    current = dirname(current);
  }
  return current;
}

function checkSource(source: string, env: Env): string[] {
  const stats = lstatOrUndefined(source);
  const refusal = protectedReason(source, env);
  const real = realOf(source);
  return [
    ...(stats === undefined ? [`Dossier du projet introuvable : ${source}`] : []),
    ...(stats?.isSymbolicLink() === true ? [`Le dossier du projet est un lien symbolique : ${source}`] : []),
    ...(stats !== undefined && !stats.isSymbolicLink() && !stats.isDirectory() ? [`${source} n'est pas un dossier`] : []),
    ...(stats !== undefined && stats.isDirectory() && notWritable(source)
      ? [`${source} n'est pas inscriptible : impossible de le déplacer sous un autre parent`]
      : []),
    ...(stats !== undefined && notWritable(dirname(source))
      ? [`${dirname(source)} n'est pas inscriptible : impossible d'en retirer le projet`]
      : []),
    ...(real !== undefined && real !== source
      ? [`Le chemin du projet traverse un lien symbolique (chemin réel : ${real}) : enregistrer le chemin réel dans le registre.`]
      : []),
    ...(refusal === undefined ? [] : [`${source} est ${refusal}, pas un projet`]),
  ];
}

/** Un dossier de support est « dans » un chemin si l'un de ses chemins, brut ou réel, y est. */
const holds = (folder: string, path: string): boolean =>
  [resolve(folder), realOf(folder)].some((candidate) => candidate !== undefined && isInside(candidate, path));

/** Le registre et le dossier d'état ne doivent pas vivre dans le projet : ils ne le suivraient pas. */
function checkSupportFolders(source: string, env: Env): string[] {
  const registry = join(env.configDir, "projects.yaml");
  const registryReason = unusableReason(lstatOrUndefined(registry));
  return [
    ...(holds(env.configDir, source)
      ? [`Le dossier du projet contient le registre (${env.configDir}) : le déplacer à la main, puis mettre à jour CH_CONFIG_DIR.`]
      : []),
    ...(holds(env.stateDir, source)
      ? [`Le dossier du projet contient le dossier d'état (${env.stateDir}) : le déplacer à la main, puis mettre à jour CH_STATE_DIR.`]
      : []),
    ...(registryReason === undefined ? [] : [`Le registre (${registry}) ne peut pas être modifié : ${registryReason}.`]),
  ];
}

/** Refus liés aux autres projets du registre : imbriqués dans celui-ci, ou destination placée dans l'un d'eux. */
function checkNesting(projects: readonly Project[], project: Project, source: string, destination: string, env: Env): string[] {
  const others = projects.filter((other) => other.name !== project.name);
  return [
    ...others
      .filter((other) => isInside(other.path, source))
      .map((other) => `Le projet « ${other.name} » du registre est dans ce projet (${other.path}) : le sortir du projet, ou le déplacer d'abord.`),
    ...others
      .filter((other) => isInside(destination, other.path))
      .map((other) => `La destination est dans le projet « ${other.name} » du registre (${other.path}).`),
    ...(holds(env.configDir, destination) || isInside(destination, resolve(env.configDir))
      ? ["La destination est dans le dossier de configuration (registre)."]
      : []),
    ...(isInside(destination, resolve(env.stateDir)) ? ["La destination est dans le dossier d'état."] : []),
  ];
}

/** Problèmes liés à l'emplacement de destination : hors racine, déjà occupé, imbriqué, lien, droits, autre disque. */
function checkDestination(source: string, destination: string, root: string): string[] {
  if (!destination.startsWith(`${root}${sep}`)) {
    return [`La destination doit être sous la racine de travail (${root}) : ${destination}`];
  }
  if (destination === source) {
    return ["Le projet est déjà à cet emplacement"];
  }
  const nearest = nearestExisting(destination);
  const nearestStats = lstatOrUndefined(nearest);
  const parents = relative(root, dirname(destination)).split(sep).filter(Boolean);
  const linked = parents
    .map((_, index) => join(root, ...parents.slice(0, index + 1)))
    .find((path) => lstatOrUndefined(path)?.isSymbolicLink() === true);
  const sameDevice = (() => {
    try {
      return statSync(source).dev === statSync(nearest).dev;
    } catch {
      return true;
    }
  })();
  return [
    ...(lstatOrUndefined(destination) === undefined ? [] : [`La destination existe déjà : ${destination}`]),
    ...(isInside(destination, source) ? ["La destination est dans le projet lui-même"] : []),
    ...(isInside(source, destination) ? ["Le projet se trouve dans la destination"] : []),
    ...(linked === undefined ? [] : [`Un lien symbolique se trouve sur le chemin de destination : ${linked}`]),
    ...(nearestStats !== undefined && !nearestStats.isDirectory() ? [`${nearest} n'est pas un dossier`] : []),
    ...(notWritable(nearest) ? [`${nearest} n'est pas inscriptible : impossible de créer la destination`] : []),
    ...(sameDevice ? [] : ["La destination est sur un autre système de fichiers : un renommage atomique est impossible"]),
  ];
}

function listSubdirectories(root: string, depth = 0): string[] {
  if (depth >= SCAN_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return [path, ...listSubdirectories(path, depth + 1)];
    });
}

/**
 * Sous-dossiers existants du projet dont Claude Code a gardé un historique propre. Seuls les sous-dossiers
 * jusqu'à la profondeur 4 sont examinés : un historique plus profond n'est pas renommé.
 */
function findSubfolderKeys(source: string, destination: string, projectsDir: string): SubfolderKey[] {
  let known: Set<string>;
  try {
    known = new Set(readdirSync(projectsDir));
  } catch {
    return [];
  }
  return listSubdirectories(source).flatMap((folder) => {
    const from = projectKey(folder);
    const to = projectKey(join(destination, relative(source, folder)));
    return from.reliable && to.reliable && known.has(from.key) ? [{ from: from.key, to: to.key }] : [];
  });
}

function claudeJsonProjectPaths(home: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const projects = isRecord(parsed) ? parsed["projects"] : undefined;
    return isRecord(projects) ? Object.keys(projects).filter((path) => isAbsolute(path)) : [];
  } catch {
    return [];
  }
}

/** Les autres propriétaires de clés d'historique, pour détecter qu'un renommage prendrait l'historique d'un voisin. */
function otherOwners(env: Env, projects: readonly Project[], project: Project, source: string): KeyOwner[] {
  return [
    ...projects
      .filter((other) => other.name !== project.name)
      .map((other) => ({ key: projectKey(other.path).key, label: `le projet « ${other.name} » du registre` })),
    ...claudeJsonProjectPaths(env.home)
      .filter((path) => !isInside(path, source))
      .map((path) => ({ key: projectKey(path).key, label: `l'entrée ${singleLine(path)} de ~/.claude.json` })),
  ];
}

function keyCollisions(keys: readonly string[], owners: readonly KeyOwner[], consequence: string): string[] {
  return [
    ...new Set(
      keys.flatMap((key) =>
        owners
          .filter((owner) => owner.key === key)
          .map((owner) => `La clé d'historique ${key} est aussi celle de ${owner.label} : ${consequence}`)
      )
    ),
  ];
}

/** Dossiers d'historique qui ressemblent à des sous-dossiers du projet mais ne seront pas renommés (trop profonds, ou voisins au nom prolongé). */
function unrenamedHistory(projectsDir: string, oldKey: string, renamed: readonly SubfolderKey[]): string[] {
  try {
    const done = new Set(renamed.map((entry) => entry.from));
    return readdirSync(projectsDir).filter((name) => name.startsWith(`${oldKey}-`) && !done.has(name));
  } catch {
    return [];
  }
}

function claudeJsonStatus(path: string, source: string, destination: string): ClaudeJsonStatus {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) {
    return { status: "absent" };
  }
  const reason = unusableReason(stats);
  if (reason !== undefined) {
    return { status: "unsafe", reason };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "absent" };
  }
  const result = renameProjectKey(text, source, destination);
  return result.kind === "unsafe" ? { status: "unsafe", reason: result.reason } : { status: result.kind };
}

/** Plugins enregistrés au scope projet ou local avec l'ancien chemin : ils ne le suivront pas. */
function pluginsBoundTo(home: string, source: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8"));
    const plugins = isRecord(parsed) && isRecord(parsed["plugins"]) ? parsed["plugins"] : {};
    return Object.entries(plugins).flatMap(([id, entries]) =>
      Array.isArray(entries) && entries.some((entry: unknown) => isRecord(entry) && entry["projectPath"] === source)
        ? [id]
        : []
    );
  } catch {
    return [];
  }
}

/** Refus liés aux sessions Claude : dans le projet, ancêtre qui exécute `ch`, ou dossier de travail illisible. */
function checkSessions(processes: readonly ClaudeProcess[], source: string, realSource: string | undefined): string[] {
  const inside = (process: ClaudeProcess): boolean =>
    process.cwd !== undefined && (isInside(process.cwd, source) || (realSource !== undefined && isInside(process.cwd, realSource)));
  const pids = (list: readonly ClaudeProcess[]): string => list.map((process) => process.pid).join(", ");
  const here = processes.filter(inside);
  const runningCh = here.filter((process) => process.ancestor);
  const others = here.filter((process) => !process.ancestor);
  const unknown = processes.filter((process) => process.cwd === undefined);
  return [
    ...(runningCh.length === 0
      ? []
      : [`La session Claude qui exécute ch (pid ${pids(runningCh)}) est ouverte dans le projet : la quitter, puis lancer « ch move » depuis un terminal ordinaire, hors du projet.`]),
    ...(others.length === 0 ? [] : [`Une session Claude est ouverte dans le projet (pid ${pids(others)}) : la fermer avant de déplacer.`]),
    ...(unknown.length === 0
      ? []
      : [`Une session Claude (pid ${pids(unknown)}) a un dossier de travail illisible : impossible d'exclure qu'elle soit dans le projet.`]),
  ];
}

function collectWarnings(
  env: Env,
  source: string,
  claudeJson: ClaudeJsonStatus,
  processes: readonly ClaudeProcess[],
  realSource: string | undefined,
  unrenamed: readonly string[]
): string[] {
  const search = findReferences(source, source);
  const plugins = pluginsBoundTo(env.home, source);
  const elsewhere = processes.filter(
    (process) =>
      process.cwd !== undefined && !(isInside(process.cwd, source) || (realSource !== undefined && isInside(process.cwd, realSource)))
  );
  const runningCh = elsewhere.filter((process) => process.ancestor);
  const others = elsewhere.filter((process) => !process.ancestor);
  return [
    ...(runningCh.length === 0
      ? []
      : [`La session qui exécute ch (pid ${runningCh.map((process) => process.pid).join(", ")}) est ailleurs : cette session réécrira peut-être ~/.claude.json avec son état en mémoire ; pour un déplacement sûr, la quitter et lancer ch depuis un terminal ordinaire.`]),
    ...(others.length === 0
      ? []
      : [`${others.length} autre(s) session(s) Claude ouverte(s) ailleurs : elles peuvent réécrire ~/.claude.json pendant le déplacement.`]),
    ...(claudeJson.status === "unsafe"
      ? [`~/.claude.json ne sera pas modifié (${claudeJson.reason ?? "raison inconnue"}) : la confiance et les autorisations de ce projet resteront attachées à l'ancien chemin, et seront redemandées au prochain lancement.`]
      : []),
    ...(plugins.length === 0
      ? []
      : [`Plugin(s) enregistré(s) avec l'ancien chemin : ${plugins.join(", ")} ; relancer « ch apply » après le déplacement.`]),
    ...(search.hits.length === 0
      ? []
      : [
          `${search.hits.length}${search.truncated ? "+" : ""} référence(s) en dur à l'ancien chemin à mettre à jour après le déplacement : ${search.hits
            .slice(0, REFERENCE_PREVIEW)
            .map((hit) => `${singleLine(hit.file)}:${hit.line}`)
            .join(", ")}${search.hits.length > REFERENCE_PREVIEW ? ", …" : ""}${search.truncated ? " (recherche incomplète : limite atteinte)" : ""}`,
        ]),
    ...(search.hits.length === 0 && search.truncated
      ? ["La recherche des références en dur à l'ancien chemin est incomplète (limite atteinte) : les chercher aussi à la main."]
      : []),
    ...(unrenamed.length === 0
      ? []
      : [`${unrenamed.length} dossier(s) d'historique Claude (${unrenamed.slice(0, 3).join(", ")}${unrenamed.length > 3 ? ", …" : ""}) ressemblent à des sous-dossiers très profonds du projet (au-delà de ${SCAN_DEPTH} niveaux) ou à des voisins dont le nom prolonge le sien : ils ne seront pas renommés.`]),
    ...(lstatOrUndefined(join(source, ".git"))?.isFile() === true
      ? ["Le projet est un worktree git (.git est un fichier) : son lien vers le dépôt principal peut casser."]
      : []),
  ];
}

/**
 * Planifie `ch move` en lecture seule. Toutes les raisons de refus sont collectées d'un coup. Le projet doit
 * être désigné par son nom exact ou son chemin enregistré, jamais par un préfixe (la commande déplace des dossiers).
 */
export function planMove(
  env: Env,
  processes: readonly ClaudeProcess[],
  query: string,
  destinationArgument: string
): MovePlanResult {
  const projects = loadRegistry(env.configDir, env.workspaceRoot);
  const resolution = resolveProject(projects, query, { exactOnly: true });
  if (resolution.kind !== "found") {
    return { kind: "usage", message: `projet inconnu du registre : ${query} (nom exact ou chemin enregistré attendu).` };
  }
  const { project } = resolution;
  const root = resolve(env.workspaceRoot);
  const source = project.path;
  const destination = resolve(root, destinationArgument);
  const oldKey = projectKey(source);
  const newKey = projectKey(destination);
  const projectsDir = join(env.home, ".claude/projects");
  const subfolderKeys = findSubfolderKeys(source, destination, projectsDir);
  const realSource = realOf(source);
  const realRoot = realOf(root);
  const sameKey = oldKey.key === newKey.key;
  // Le nom suit le dossier seulement s'il reste un nom de registre valide ; sinon on garde l'ancien (comportement d'avant).
  const folderName = basename(destination);
  const newName = project.name === basename(source) && isValidProjectName(folderName) ? folderName : project.name;

  const problems = [
    ...(env.claudeConfigDir === undefined ? [] : ["CLAUDE_CONFIG_DIR est défini : l'organisation de ce dossier de configuration n'est pas vérifiée."]),
    ...checkSource(source, env),
    ...checkSupportFolders(source, env),
    ...(realRoot !== undefined && realRoot !== root
      ? [`La racine de travail traverse un lien symbolique (chemin réel : ${realRoot}) : utiliser le chemin réel.`]
      : []),
    ...checkDestination(source, destination, root),
    ...checkNesting(projects, project, source, destination, env),
    ...(oldKey.reliable && newKey.reliable ? [] : ["La clé de projet Claude ne peut pas être calculée de façon fiable (chemin trop long ou caractère non pris en charge)."]),
    ...(sameKey && oldKey.reliable
      ? ["Les deux chemins donnent la même clé Claude : rien ne serait renommé et l'historique serait ambigu."]
      : []),
    ...(sameKey ? [] : [newKey.key, ...subfolderKeys.map((entry) => entry.to)])
      .filter((key) => lstatOrUndefined(join(projectsDir, key)) !== undefined)
      .map((key) => `Un historique Claude existe déjà pour la destination : ${key}`),
    ...keyCollisions(
      [oldKey.key, ...subfolderKeys.map((entry) => entry.from)],
      otherOwners(env, projects, project, source),
      "le renommage prendrait son historique."
    ),
    ...(sameKey
      ? []
      : keyCollisions(
          [newKey.key, ...subfolderKeys.map((entry) => entry.to)],
          otherOwners(env, projects, project, source),
          "les deux projets partageraient le même historique."
        )),
    ...(newName !== project.name && projects.some((other) => other.name === newName)
      ? [`Le nom « ${newName} » est déjà pris dans le registre par un autre projet : choisir un autre dossier de destination.`]
      : []),
    ...checkSessions(processes, source, realSource),
  ];
  if (problems.length > 0) {
    return { kind: "refused", problems };
  }

  const claudeJsonPath = join(env.home, ".claude.json");
  const claudeJson = claudeJsonStatus(claudeJsonPath, source, destination);
  return {
    kind: "ok",
    claudeJson,
    historyPresent: lstatOrUndefined(join(projectsDir, oldKey.key)) !== undefined,
    warnings: collectWarnings(env, source, claudeJson, processes, realSource, unrenamedHistory(projectsDir, oldKey.key, subfolderKeys)),
    plan: {
      project,
      source,
      destination,
      oldKey: oldKey.key,
      newKey: newKey.key,
      subfolderKeys,
      projectsDir,
      claudeJsonPath,
      registryPath: join(env.configDir, "projects.yaml"),
      workspaceRoot: root,
      newRegistryPath: relative(root, destination).split(sep).join("/"),
      newName,
      backupDir: join(env.stateDir, "backups"),
    },
  };
}
