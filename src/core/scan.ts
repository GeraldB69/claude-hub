import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type { AgentsSkill, PluginEntry, PluginScope, Snapshot, StrayDir } from "./types.js";

export interface ScanOptions {
  readonly home: string;
  /** Racines de travail à inspecter pour trouver des dépôts git et des dossiers non versionnés. */
  readonly roots: readonly string[];
}

/** Profondeur maximale (racine = 0) des dossiers inspectés sous chaque racine ; en dessous, rien n'est lu. */
const MAX_SCAN_DEPTH = 3;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);
/** Erreurs de lecture qui n'arrêtent pas l'audit : le chemin est signalé comme ignoré. */
const TOLERATED_ERRORS: ReadonlySet<string> = new Set(["ENOTDIR", "EISDIR", "EACCES", "EPERM", "ELOOP"]);
const KNOWN_SCOPES: readonly Exclude<PluginScope, "unknown">[] = ["user", "project", "local", "managed"];
const NON_TEXT_SCOPE = "(absent ou non textuel)";

const installedPluginsSchema = z.looseObject({
  plugins: z.record(z.string(), z.unknown()).optional(),
});

const claudeJsonSchema = z.looseObject({
  projects: z.record(z.string(), z.unknown()).optional(),
});

const settingsSchema = z.looseObject({
  syncClaudeAiPlugins: z.unknown().optional(),
  syncClaudeAiSkills: z.unknown().optional(),
});

const unique = <Item>(items: readonly Item[], keyOf: (item: Item) => string): Item[] => [
  ...new Map(items.map((item) => [keyOf(item), item] as const)).values(),
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

interface JsonRead<Data> {
  readonly data: Data | undefined;
  /** Le fichier existe mais n'a pas pu être lu : à signaler plutôt qu'à faire échouer l'audit. */
  readonly skipped: readonly string[];
}

/**
 * Lit et valide un fichier JSON. Absent : rien, sans bruit ; illisible ou de mauvais type :
 * ignoré et signalé ; invalide : erreur. Les messages ne reprennent jamais le contenu du fichier
 * (jetons de `~/.claude.json`) : uniquement le chemin, la nature de l'erreur et les chemins de champs.
 */
function readJson<Schema extends z.ZodType>(file: string, schema: Schema): JsonRead<z.infer<Schema>> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { data: undefined, skipped: [] };
    }
    if (code !== undefined && TOLERATED_ERRORS.has(code)) {
      return { data: undefined, skipped: [file] };
    }
    throw new Error(`${file} : lecture impossible (${code ?? "erreur inconnue"})`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} : JSON invalide`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.code}`)
      .join(", ");
    throw new Error(`${file} : structure inattendue (${fields})`);
  }
  return { data: result.data, skipped: [] };
}

interface Listing {
  readonly entries: readonly Dirent[];
  readonly skipped: readonly string[];
}

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Liste un dossier. Absent : vide sans bruit ; illisible ou de mauvais type : vide et signalé. */
function listDirectory(directory: string): Listing {
  try {
    return { entries: readdirSync(directory, { withFileTypes: true }).toSorted(byName), skipped: [] };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { entries: [], skipped: [] };
    }
    if (code !== undefined && TOLERATED_ERRORS.has(code)) {
      return { entries: [], skipped: [directory] };
    }
    throw error;
  }
}

const isKnownScope = (scope: string): scope is Exclude<PluginScope, "unknown"> =>
  (KNOWN_SCOPES as readonly string[]).includes(scope);

/** Normalise une entrée de `installed_plugins.json` sans jamais échouer : le format n'est pas garanti par la doc. */
function toPluginEntry(id: string, item: unknown): PluginEntry {
  const record = isRecord(item) ? item : {};
  const scope = record["scope"];
  const projectPath = typeof record["projectPath"] === "string" ? record["projectPath"] : undefined;

  if (typeof scope !== "string") {
    return { id, scope: "unknown", rawScope: NON_TEXT_SCOPE };
  }
  if (!isKnownScope(scope)) {
    return { id, scope: "unknown", rawScope: scope };
  }
  if (scope === "local" && projectPath !== undefined) {
    // Un chemin relatif serait résolu depuis le cwd : on ne juge pas son existence.
    return isAbsolute(projectPath)
      ? { id, scope, projectPath, projectPathExists: existsSync(projectPath) }
      : { id, scope, projectPath };
  }
  return { id, scope };
}

function scanPlugins(home: string): { readonly plugins: readonly PluginEntry[]; readonly skipped: readonly string[] } {
  const { data, skipped } = readJson(join(home, ".claude/plugins/installed_plugins.json"), installedPluginsSchema);
  const plugins = Object.entries(data?.plugins ?? {}).flatMap(([id, entries]) =>
    Array.isArray(entries) ? entries.map((entry: unknown) => toPluginEntry(id, entry)) : []
  );
  return { plugins, skipped };
}

function scanLiveProjects(home: string): { readonly liveProjects: readonly string[]; readonly skipped: readonly string[] } {
  const { data, skipped } = readJson(join(home, ".claude.json"), claudeJsonSchema);
  const liveProjects = Object.keys(data?.projects ?? {}).filter((path) => isAbsolute(path) && existsSync(path));
  return { liveProjects, skipped };
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

interface SkillsScan {
  readonly agentsSkills: readonly AgentsSkill[];
  readonly brokenSkillLinks: readonly string[];
  readonly skipped: readonly string[];
}

/** Compare les chemins réels (chaînes de liens, dossier parent lui-même lié) et non les chemins écrits. */
function scanSkills(home: string): SkillsScan {
  const agentsDir = join(home, ".agents/skills");
  const claudeDir = join(home, ".claude/skills");
  const agents = listDirectory(agentsDir);
  const claude = listDirectory(claudeDir);

  const agentsRealDir = safeRealpath(agentsDir);
  const wholeFolderLinked = agentsRealDir !== undefined && agentsRealDir === safeRealpath(claudeDir);

  const links = claude.entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => {
      const path = join(claudeDir, entry.name);
      return { path, real: safeRealpath(path) };
    });
  const linkedTargets = new Set(links.flatMap((link) => (link.real === undefined ? [] : [link.real])));

  return {
    agentsSkills: agents.entries.map((entry) => {
      const real = safeRealpath(join(agentsDir, entry.name));
      return { name: entry.name, linked: wholeFolderLinked || (real !== undefined && linkedTargets.has(real)) };
    }),
    brokenSkillLinks: links.filter((link) => link.real === undefined).map((link) => link.path),
    skipped: [...agents.skipped, ...claude.skipped],
  };
}

function scanProjectKeys(home: string): { readonly names: readonly string[]; readonly skipped: readonly string[] } {
  const listing = listDirectory(join(home, ".claude/projects"));
  return {
    names: listing.entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    skipped: listing.skipped,
  };
}

interface SyncScan {
  readonly syncedPlugins: readonly string[];
  readonly syncedSkills: readonly string[];
  readonly syncSettings: Snapshot["syncSettings"];
  readonly skipped: readonly string[];
}

const META_SUFFIX = ".meta.json";

/** Plugins et skills synchronisés depuis le compte, et seuls deux interrupteurs de `settings.json` (jamais le reste). */
function scanSync(home: string): SyncScan {
  const pluginsRoot = join(home, ".claude/plugins/synced");
  const skillsRoot = join(home, ".claude/skills/synced");
  const pluginAccounts = listDirectory(pluginsRoot);
  const skillAccounts = listDirectory(skillsRoot);
  const insideAccounts = (root: string, accounts: Listing): Listing[] =>
    accounts.entries.filter((entry) => entry.isDirectory()).map((entry) => listDirectory(join(root, entry.name)));
  const pluginListings = insideAccounts(pluginsRoot, pluginAccounts);
  const skillListings = insideAccounts(skillsRoot, skillAccounts);

  const { data, skipped } = readJson(join(home, ".claude/settings.json"), settingsSchema);
  const plugins = data?.syncClaudeAiPlugins;
  const skills = data?.syncClaudeAiSkills;

  return {
    syncedPlugins: pluginListings.flatMap((listing) =>
      listing.entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(META_SUFFIX))
        .map((entry) => entry.name.slice(0, -META_SUFFIX.length))
    ),
    syncedSkills: skillListings.flatMap((listing) =>
      listing.entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    ),
    syncSettings: {
      ...(typeof plugins === "boolean" ? { plugins } : {}),
      ...(typeof skills === "boolean" ? { skills } : {}),
    },
    skipped: [
      ...pluginAccounts.skipped,
      ...skillAccounts.skipped,
      ...pluginListings.flatMap((listing) => listing.skipped),
      ...skillListings.flatMap((listing) => listing.skipped),
      ...skipped,
    ],
  };
}

interface Walk {
  readonly strayDirs: readonly StrayDir[];
  readonly repoPaths: readonly string[];
  readonly skipped: readonly string[];
}

const mergeWalks = (walks: readonly Walk[]): Walk => ({
  strayDirs: walks.flatMap((walked) => walked.strayDirs),
  repoPaths: walks.flatMap((walked) => walked.repoPaths),
  skipped: walks.flatMap((walked) => walked.skipped),
});

const isConfigEntry = (entry: Dirent): boolean =>
  ((entry.name === ".claude" || entry.name === ".agents") && entry.isDirectory()) ||
  (entry.name === "CLAUDE.md" && entry.isFile());

const isDescendable = (entry: Dirent): boolean =>
  entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name);

const isProjectRoot = (path: string, walked: Walk): boolean =>
  walked.repoPaths.includes(path) || walked.strayDirs.some((dir) => dir.path === path);

/** Parcourt un dossier : enregistre les dépôts git (sans y entrer) et les dossiers non versionnés configurés. */
function walk(directory: string, depth = 0): Walk {
  const { entries, skipped } = listDirectory(directory);
  if (entries.some((entry) => entry.name === ".git")) {
    return { strayDirs: [], repoPaths: [directory], skipped };
  }
  const found = entries.filter(isConfigEntry).map((entry) => entry.name);
  const childDirs = depth >= MAX_SCAN_DEPTH ? [] : entries.filter(isDescendable);
  const children = childDirs.map((child) => {
    const path = join(directory, child.name);
    return { path, walked: walk(path, depth + 1) };
  });
  const hasChildProjects = children.some((child) => isProjectRoot(child.path, child.walked));
  const here: Walk = {
    strayDirs: found.length > 0 ? [{ path: directory, entries: found, hasChildProjects }] : [],
    repoPaths: [],
    skipped,
  };
  return mergeWalks([here, ...children.map((child) => child.walked)]);
}

/** Photographie l'état du poste en lecture seule. */
export function buildSnapshot(options: ScanOptions): Snapshot {
  const { home, roots } = options;
  const plugins = scanPlugins(home);
  const live = scanLiveProjects(home);
  const skills = scanSkills(home);
  const projects = scanProjectKeys(home);
  const sync = scanSync(home);
  const walked = mergeWalks(roots.map((root) => walk(root)));
  return {
    home,
    plugins: plugins.plugins,
    agentsSkills: skills.agentsSkills,
    brokenSkillLinks: skills.brokenSkillLinks,
    projectKeys: projects.names,
    liveProjects: live.liveProjects,
    repoPaths: unique(walked.repoPaths, (path) => path),
    strayDirs: unique(walked.strayDirs, (dir) => dir.path),
    syncedPlugins: sync.syncedPlugins,
    syncedSkills: sync.syncedSkills,
    syncSettings: sync.syncSettings,
    skipped: unique(
      [
        ...plugins.skipped,
        ...live.skipped,
        ...skills.skipped,
        ...projects.skipped,
        ...sync.skipped,
        ...walked.skipped,
      ],
      (path) => path
    ),
  };
}
