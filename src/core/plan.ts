import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Operation } from "./operations.js";
import type { Profile } from "./profile.js";
import {
  isRecord,
  mergeSettings,
  serializeSettings,
  settingsPatchOf,
  summarizeMerge,
  type SettingsPatch,
} from "./settings.js";

export const GITIGNORE_ENTRY = ".claude/settings.local.json";

export const DEFAULT_CLAUDE_MD = [
  "# CLAUDE.md",
  "",
  "Instructions pour Claude Code dans ce projet. Rester court : commandes, architecture, conventions.",
  "",
  "## Commandes",
  "",
  "## Architecture",
  "",
  "## Conventions",
  "",
].join("\n");

export interface PlanEntry {
  /** `+` créé, `~` modifié, `=` laissé tel quel. */
  readonly symbol: "+" | "~" | "=";
  readonly label: string;
  readonly operations: readonly Operation[];
}

type Kind = "absent" | "file" | "directory" | "symlink" | "other";

function inspect(path: string): Kind {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
}

const unchanged = (label: string): PlanEntry => ({ symbol: "=", label, operations: [] });

/** Contenu de `.claude/settings.json` d'un nouveau projet : le patch du profil fusionné dans un fichier vide. */
export function buildSettings(profile: Profile): string {
  const result = mergeSettings({}, settingsPatchOf(profile));
  if (result === undefined) {
    throw new Error("Profil incohérent : fusion impossible dans un fichier vide.");
  }
  return serializeSettings(result.merged);
}

function planSettings(projectDir: string, profile: Profile): PlanEntry {
  const claudeDir = join(projectDir, ".claude");
  const settings = join(claudeDir, "settings.json");
  const label = ".claude/settings.json";
  const claude = inspect(claudeDir);
  if (claude === "symlink") {
    return unchanged(`${label} : .claude est un lien symbolique, ignoré`);
  }
  if (claude === "file" || claude === "other") {
    return unchanged(`${label} : .claude n'est pas un dossier, ignoré`);
  }
  if (inspect(settings) !== "absent") {
    return unchanged(`${label} : existe déjà (laissé tel quel)`);
  }
  return {
    symbol: "+",
    label: `créer ${label}`,
    operations: [
      { kind: "mkdir", path: claudeDir },
      { kind: "create", path: settings, content: buildSettings(profile) },
    ],
  };
}

function planClaudeMd(projectDir: string, profile: Profile): PlanEntry {
  const path = join(projectDir, "CLAUDE.md");
  const state = inspect(path);
  if (state === "absent") {
    return {
      symbol: "+",
      label: "créer CLAUDE.md",
      operations: [{ kind: "create", path, content: profile.claudeMd ?? DEFAULT_CLAUDE_MD }],
    };
  }
  return unchanged(`CLAUDE.md : ${state === "symlink" ? "lien symbolique" : "existe déjà"} (laissé tel quel)`);
}

function planDocsAi(projectDir: string): PlanEntry {
  const docs = join(projectDir, "docs");
  const target = join(docs, "ai");
  const docsState = inspect(docs);
  if (docsState === "symlink" || docsState === "file" || docsState === "other") {
    return unchanged(`docs/ai : docs est ${docsState === "symlink" ? "un lien symbolique" : "un fichier"}, ignoré`);
  }
  if (inspect(target) !== "absent") {
    return unchanged("docs/ai : existe déjà (laissé tel quel)");
  }
  return {
    symbol: "+",
    label: "créer dossier docs/ai (avec .gitkeep)",
    operations: [
      { kind: "mkdir", path: target },
      { kind: "create", path: join(target, ".gitkeep"), content: "" },
    ],
  };
}

function planGitignore(projectDir: string): PlanEntry {
  const path = join(projectDir, ".gitignore");
  const state = inspect(path);
  if (state === "absent") {
    return {
      symbol: "+",
      label: `créer .gitignore (${GITIGNORE_ENTRY})`,
      operations: [{ kind: "create", path, content: `${GITIGNORE_ENTRY}\n` }],
    };
  }
  if (state !== "file") {
    return unchanged(`.gitignore : ${state === "symlink" ? "lien symbolique" : "n'est pas un fichier"}, ignoré`);
  }
  const hasEntry = readFileSync(path, "utf8")
    .split("\n")
    .some((line) => line.trim() === GITIGNORE_ENTRY);
  return hasEntry
    ? unchanged(`.gitignore : ${GITIGNORE_ENTRY} déjà présent`)
    : {
        symbol: "~",
        label: `ajouter à .gitignore : ${GITIGNORE_ENTRY}`,
        operations: [{ kind: "append-line", path, line: GITIGNORE_ENTRY }],
      };
}

/**
 * Planifie `ch init` en lecture seule : ne planifie jamais d'écrasement et ignore tout lien symbolique rencontré.
 * Le disque peut changer avant l'exécution : `fs-safe` re-vérifie les liens juste avant chaque écriture.
 */
export function planInit(projectDir: string, profile: Profile): readonly PlanEntry[] {
  return [
    planSettings(projectDir, profile),
    planClaudeMd(projectDir, profile),
    planDocsAi(projectDir),
    planGitignore(projectDir),
  ];
}

export interface SettingsState {
  readonly path: string;
  /** Contenu actuel ; `undefined` si le fichier n'existe pas encore. */
  readonly existing: Readonly<Record<string, unknown>> | undefined;
  /** Ce que la fusion du patch ajouterait ; vide si le fichier est déjà aligné. */
  readonly summary: readonly string[];
}

/**
 * Lit en lecture seule le `settings.json` d'un projet avant `ch apply`. Refuse (erreur) tout ce qui ferait
 * écrire hors du projet ou sur un fichier illisible : lien symbolique sur `.claude` ou sur le fichier,
 * JSON invalide, clé gérée de forme inattendue. Les messages ne reprennent jamais le contenu du fichier.
 */
export function inspectSettings(projectDir: string, patch: SettingsPatch): SettingsState {
  const claudeDir = join(projectDir, ".claude");
  const path = join(claudeDir, "settings.json");
  const claude = inspect(claudeDir);
  if (claude === "symlink") {
    throw new Error("Refus : .claude est un lien symbolique, ch apply écrirait hors du projet.");
  }
  if (claude === "file" || claude === "other") {
    throw new Error("Refus : .claude n'est pas un dossier.");
  }
  const file = inspect(path);
  if (file === "symlink") {
    throw new Error(`Refus : ${path} est un lien symbolique.`);
  }
  if (file === "directory" || file === "other") {
    throw new Error(`Refus : ${path} n'est pas un fichier.`);
  }
  if (file === "absent") {
    return { path, existing: undefined, summary: summarizeMerge({}, patch) };
  }
  const raw = readFileSync(path);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new Error(`${path} : le fichier commence par un BOM UTF-8, à retirer.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`${path} : JSON invalide.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} : JSON invalide (un objet est attendu).`);
  }
  if (mergeSettings(parsed, patch) === undefined) {
    throw new Error(`${path} : structure inattendue (enabledPlugins ou skillOverrides n'est pas un objet).`);
  }
  return { path, existing: parsed, summary: summarizeMerge(parsed, patch) };
}

/**
 * Vérifie, avant toute installation, que `ch apply` pourra écrire : le fichier de réglages s'il existe, et le
 * dossier où il vit (`.claude`, sinon le projet) pour le fichier temporaire. Évite un état à moitié aligné.
 */
export function assertWritableForApply(settingsPath: string, projectDir: string): void {
  const claudeDir = join(projectDir, ".claude");
  const folder = inspect(claudeDir) === "directory" ? claudeDir : projectDir;
  const targets = inspect(settingsPath) === "file" ? [settingsPath, folder] : [folder];
  for (const target of targets) {
    try {
      accessSync(target, constants.W_OK);
    } catch {
      throw new Error(`Refus : ${target} n'est pas inscriptible, rien n'a été installé.`);
    }
  }
}
