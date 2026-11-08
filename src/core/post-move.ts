import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { findReferences, IGNORED_DIRECTORIES, mentionPattern } from "./references.js";

/** Ce que l'utilisateur doit faire après un déplacement : des commandes à copier telles quelles, et des remarques. */
export interface PostMoveGuide {
  readonly commands: readonly string[];
  readonly notes: readonly string[];
}

const MAX_DEPTH = 12;
const MAX_DIRECTORIES = 20_000;
const MAX_HITS = 2000;
const MAX_FILE_BYTES = 1_000_000;
/** Caractères admis dans un chemin inséré dans une expression `perl` : tout autre est laissé à l'utilisateur. */
const SAFE_PATH = /^[A-Za-z0-9_./+-]+$/;
/** Contrôles C0 et C1, et marques de direction du texte (U+202A-202E, U+2066-2069) : ils réécriraient l'affichage. */
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const WORKTREE_MARKER = `${sep}.git${sep}worktrees${sep}`;

/** Guillemets simples : le contenu est littéral pour le shell. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** Rend un chemin affichable sans que ses caractères de contrôle ne réécrivent le terminal. */
const printable = (text: string): string => (CONTROL.test(text) ? JSON.stringify(text) : text);

/** Contenu texte d'un fichier ordinaire (jamais un lien symbolique), borné en taille ; sinon `undefined`. */
function readText(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const content = readFileSync(path);
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch {
    return undefined;
  }
}

interface Layout {
  /** Dossiers contenant un dépôt git (un dossier `.git`). */
  readonly repositories: readonly string[];
  /** Fichiers `.git` (liens de worktree). */
  readonly links: readonly string[];
  readonly truncated: boolean;
}

/** Parcours borné, sans lien symbolique ni dossier ignoré, des dépôts et des liens de worktree du projet. */
function scanLayout(root: string): Layout {
  const repositories: string[] = [];
  const links: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (directory: string, depth: number): void => {
    visited += 1;
    if (visited > MAX_DIRECTORIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
      repositories.push(directory);
    }
    if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
      links.push(join(directory, ".git"));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (depth >= MAX_DEPTH) {
        truncated = true;
        continue;
      }
      walk(join(directory, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return { repositories, links, truncated };
}

/** Chemin tel qu'il est après le déplacement : le préfixe de l'ancien emplacement est remplacé. */
const relocate = (path: string, source: string, destination: string): string =>
  path === source || path.startsWith(`${source}${sep}`) ? `${destination}${path.slice(source.length)}` : path;

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Cible d'un fichier `.git` (`gitdir: …`), normalisée ; un chemin relatif est résolu depuis le dossier du fichier. */
const gitdirOf = (linkFile: string): string | undefined => {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(linkFile) ?? "");
  const value = match?.[1];
  return value === undefined ? undefined : resolve(dirname(linkFile), value);
};

/** Un worktree est à réparer si le dépôt ne connaît pas son emplacement actuel, ou si son lien vise un dépôt absent. */
function isStale(repository: string, worktree: string, id: string): boolean {
  const recorded = readText(join(repository, ".git", "worktrees", id, "gitdir"))?.trim();
  const linkTarget = gitdirOf(join(worktree, ".git"));
  const linkBroken = linkTarget === undefined || !isDirectory(linkTarget);
  return recorded !== join(worktree, ".git") || linkBroken;
}

interface WorktreePair {
  readonly repository: string;
  readonly worktree: string;
}

/** Worktrees à réparer, vus depuis les fichiers `.git` du projet (dépôt propriétaire dehors ou dedans). */
function worktreesFromLinks(layout: Layout, source: string, destination: string): { pairs: WorktreePair[]; unresolved: string[] } {
  const pairs: WorktreePair[] = [];
  const unresolved: string[] = [];
  for (const link of layout.links) {
    const gitdir = gitdirOf(link);
    const marker = gitdir?.lastIndexOf(WORKTREE_MARKER) ?? -1;
    if (gitdir === undefined) {
      unresolved.push(link);
      continue;
    }
    if (marker < 0) {
      // Sous-module ou autre dépôt lié : rien à réparer tant que sa cible existe.
      if (!isDirectory(gitdir)) {
        unresolved.push(link);
      }
      continue;
    }
    const repository = relocate(gitdir.slice(0, marker), source, destination);
    const id = gitdir.slice(marker + WORKTREE_MARKER.length);
    const worktree = dirname(link);
    if (repository === "" || !isDirectory(join(repository, ".git", "worktrees", id)) || id === "" || id.includes(sep)) {
      unresolved.push(link);
      continue;
    }
    if (isStale(repository, worktree, id)) {
      pairs.push({ repository, worktree });
    }
  }
  return { pairs, unresolved };
}

/** Worktrees à réparer, vus depuis les dépôts du projet (worktrees restés hors du projet compris). */
function worktreesFromRepositories(layout: Layout, source: string, destination: string): WorktreePair[] {
  return layout.repositories.flatMap((repository) => {
    const root = join(repository, ".git", "worktrees");
    let ids: string[];
    try {
      ids = readdirSync(root);
    } catch {
      return [];
    }
    return ids.flatMap((id) => {
      const recorded = readText(join(root, id, "gitdir"))?.trim();
      if (recorded === undefined || !isAbsolute(recorded) || !recorded.endsWith(`${sep}.git`)) {
        return [];
      }
      const worktree = relocate(dirname(resolve(recorded)), source, destination);
      return isDirectory(worktree) && isStale(repository, worktree, id) ? [{ repository, worktree }] : [];
    });
  });
}

/** Hooks git (fichiers ordinaires non `.sample`) qui mentionnent encore l'ancien chemin. */
function hooksMentioning(repository: string, oldPath: string): string[] {
  const hooksDir = join(repository, ".git", "hooks");
  let entries;
  try {
    entries = readdirSync(hooksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".sample"))
    .map((entry) => join(hooksDir, entry.name))
    .filter((path) => mentionPattern(oldPath).test(readText(path) ?? ""))
    .toSorted();
}

function replaceCommands(files: readonly string[], source: string, destination: string): readonly string[] {
  const expression = `s#(?<![A-Za-z0-9_./-])\\Q${source}\\E(?![A-Za-z0-9_.-])#${destination}#g`;
  const list = files.map((file) => `  ${shellQuote(file)}`);
  return [
    ["perl -pi.bak -e " + shellQuote(expression), ...list].join(" \\\n"),
    ["rm -f --", ...files.map((file) => `  ${shellQuote(`${file}.bak`)}`)].join(" \\\n") + "  # une fois le résultat vérifié",
  ];
}

/**
 * Lecture seule, à appeler une fois le projet déplacé : cherche ce qui mentionne encore l'ancien chemin et
 * en déduit les commandes à lancer (réparation des worktrees git, remplacement du chemin dans les fichiers et
 * dans les hooks git). Rien n'est exécuté par `ch`. Un chemin à caractère de contrôle n'est jamais mis dans
 * une commande.
 */
export function planPostMove(destination: string, source: string): PostMoveGuide {
  const references = findReferences(destination, source, { maxFiles: 20_000, maxFileBytes: MAX_FILE_BYTES, maxHits: MAX_HITS });
  const layout = scanLayout(destination);
  const absolute = (relative: string): string => join(destination, ...relative.split("/"));
  const isLink = (file: string): boolean => file === ".git" || file.endsWith("/.git");
  const textFiles = [...new Set(references.hits.map((hit) => hit.file))].filter((file) => !isLink(file)).map(absolute);
  const hooks = layout.repositories.flatMap((repository) => hooksMentioning(repository, source));

  const fromLinks = worktreesFromLinks(layout, source, destination);
  const pairs = [...fromLinks.pairs, ...worktreesFromRepositories(layout, source, destination)];
  const seen = new Set<string>();
  const worktreeCommands = pairs.flatMap(({ repository, worktree }) => {
    const command = `git -C ${shellQuote(repository)} worktree repair ${shellQuote(worktree)}`;
    if (seen.has(command) || CONTROL.test(repository) || CONTROL.test(worktree)) {
      return [];
    }
    seen.add(command);
    return [command];
  });

  const all = [...new Set([...textFiles, ...hooks])];
  // Un `.bak` ne se traite pas, et un `<fichier>.bak` existant serait écrasé puis supprimé : on s'abstient.
  const backups = all.filter((file) => file.endsWith(".bak"));
  const clashing = all.filter((file) => !file.endsWith(".bak") && existsSync(`${file}.bak`));
  const candidates = all.filter((file) => !backups.includes(file));
  const withControl = candidates.filter((file) => CONTROL.test(file));
  const files = candidates.filter((file) => !CONTROL.test(file));
  const safe = SAFE_PATH.test(source) && SAFE_PATH.test(destination);
  const replacements = files.length > 0 && safe && clashing.length === 0 ? replaceCommands(files, source, destination) : [];
  const skippedReplacement = (files.length > 0 && !safe) || withControl.length > 0;

  const controlPairs = pairs.filter(({ repository, worktree }) => CONTROL.test(repository) || CONTROL.test(worktree));
  const notes = [
    ...(replacements.length > 0
      ? [
          "Les fichiers sont sauvegardés en .bak : supprimer les .bak (deuxième commande) une fois le résultat vérifié. Si certains fichiers sont versionnés, relire le diff avant de commiter.",
        ]
      : []),
    ...(clashing.length > 0
      ? [
          `Aucune commande de remplacement proposée : ${clashing.map(printable).join(", ")} ont déjà un fichier .bak qui serait écrasé puis supprimé. Les renommer ou les supprimer, puis relancer la recherche à la main (grep -rIF), ou remplacer l'ancien chemin à la main.`,
        ]
      : []),
    ...(backups.length > 0 ? [`Fichiers .bak qui mentionnent l'ancien chemin, laissés tels quels : ${backups.map(printable).join(", ")}`] : []),
    ...(skippedReplacement
      ? [
          `Remplacer l'ancien chemin à la main dans : ${[...withControl, ...(safe ? [] : files)].map(printable).join(", ")} (chemin à caractères spéciaux ou de contrôle : aucune commande n'est proposée).`,
        ]
      : []),
    ...(controlPairs.length > 0
      ? [`Worktrees à réparer à la main (caractère de contrôle dans le chemin) : ${controlPairs.map((pair) => printable(pair.worktree)).join(", ")}`]
      : []),
    ...(fromLinks.unresolved.length > 0
      ? [`Worktrees non reconnus, à réparer à la main : ${fromLinks.unresolved.map(printable).join(", ")}`]
      : []),
    ...(references.truncated || layout.truncated
      ? ["La recherche s'est arrêtée avant la fin (limite atteinte) : la liste est partielle ; chercher aussi l'ancien chemin à la main (par exemple avec grep -rIF)."]
      : []),
  ];
  return { commands: [...worktreeCommands, ...replacements], notes };
}
