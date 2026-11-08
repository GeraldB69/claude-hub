import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { findReferences, IGNORED_DIRECTORIES } from "./references.js";

/** Ce que l'utilisateur doit faire après un déplacement : des commandes à copier telles quelles, et des remarques. */
export interface PostMoveGuide {
  readonly commands: readonly string[];
  readonly notes: readonly string[];
}

const MAX_REPO_DEPTH = 5;
const MAX_HITS = 2000;
/** Caractères admis dans un chemin inséré dans une expression `perl` : tout autre est laissé à l'utilisateur. */
const SAFE_PATH = /^[A-Za-z0-9_./+-]+$/;
const WORKTREE_MARKER = `${sep}.git${sep}worktrees${sep}`;

/** Guillemets simples : le contenu est littéral pour le shell. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

function readText(path: string): string | undefined {
  try {
    const content = readFileSync(path);
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Dossiers contenant un dépôt git (un dossier `.git`), sans entrer dans `.git` ni dans les dossiers ignorés. */
function findRepositories(directory: string, depth: number): string[] {
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch {
    return [];
  }
  const own = entries.some((entry) => entry.name === ".git" && entry.isDirectory) ? [directory] : [];
  if (depth >= MAX_REPO_DEPTH) {
    return own;
  }
  const nested = entries
    .filter((entry) => entry.isDirectory && !IGNORED_DIRECTORIES.has(entry.name))
    .flatMap((entry) => findRepositories(join(directory, entry.name), depth + 1));
  return [...own, ...nested];
}

/** Hooks git (scripts non `.sample`) qui mentionnent encore l'ancien chemin. */
function hooksMentioning(repository: string, oldPath: string): string[] {
  const hooksDir = join(repository, ".git", "hooks");
  let names: string[];
  try {
    names = readdirSync(hooksDir).filter((name) => !name.endsWith(".sample")).toSorted();
  } catch {
    return [];
  }
  return names.map((name) => join(hooksDir, name)).filter((path) => statSync(path).isFile() && readText(path)?.includes(oldPath) === true);
}

/** Commande de réparation d'un worktree lié, déduite du fichier `.git` qui en garde l'ancien chemin. */
function worktreeCommand(linkFile: string, destination: string, source: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(linkFile) ?? "");
  const gitdir = match?.[1];
  const marker = gitdir?.indexOf(WORKTREE_MARKER) ?? -1;
  if (gitdir === undefined || marker < 0) {
    return undefined;
  }
  const repository = gitdir.slice(0, marker);
  const moved = repository === source || repository.startsWith(`${source}${sep}`) ? `${destination}${repository.slice(source.length)}` : repository;
  return `git -C ${shellQuote(moved)} worktree repair ${shellQuote(dirname(linkFile))}`;
}

function replaceCommand(files: readonly string[], source: string, destination: string): string | undefined {
  if (files.length === 0 || !SAFE_PATH.test(source) || !SAFE_PATH.test(destination)) {
    return undefined;
  }
  const expression = `s#\\Q${source}\\E(?![A-Za-z0-9_.-])#${destination}#g`;
  return [`perl -pi -e ${shellQuote(expression)}`, ...files.map((file) => `  ${shellQuote(file)}`)].join(" \\\n");
}

/**
 * Lecture seule, à appeler une fois le projet déplacé : cherche ce qui mentionne encore l'ancien chemin et
 * en déduit les commandes à lancer (réparation des worktrees git, remplacement du chemin dans les fichiers et
 * dans les hooks git). Rien n'est exécuté par `ch`.
 */
export function planPostMove(destination: string, source: string): PostMoveGuide {
  const references = findReferences(destination, source, { maxFiles: 20_000, maxFileBytes: 1_000_000, maxHits: MAX_HITS });
  const absolute = (relative: string): string => join(destination, ...relative.split("/"));
  const files = [...new Set(references.hits.map((hit) => hit.file))];
  const links = files.filter((file) => file === ".git" || file.endsWith("/.git"));
  const plain = files.filter((file) => !links.includes(file)).map(absolute);
  const hooks = findRepositories(destination, 0).flatMap((repository) => hooksMentioning(repository, source));

  const worktrees = links.map((link) => worktreeCommand(absolute(link), destination, source));
  const unresolved = links.filter((_, index) => worktrees[index] === undefined).map(absolute);
  const replace = replaceCommand([...plain, ...hooks], source, destination);

  return {
    commands: [...worktrees.filter((command): command is string => command !== undefined), ...(replace === undefined ? [] : [replace])],
    notes: [
      ...(plain.length + hooks.length > 0 && replace === undefined
        ? ["Le chemin contient des caractères spéciaux : remplacer l'ancien chemin à la main dans les fichiers et hooks qui le mentionnent."]
        : []),
      ...(plain.length > 0 ? ["Si certains de ces fichiers sont versionnés, relire le diff avant de commiter."] : []),
      ...(unresolved.length > 0 ? [`Worktrees non reconnus, à réparer à la main : ${unresolved.join(", ")}`] : []),
      ...(references.truncated ? ["La recherche des références s'est arrêtée avant la fin : chercher aussi l'ancien chemin à la main (par exemple avec grep -rIF)."] : []),
    ],
  };
}
