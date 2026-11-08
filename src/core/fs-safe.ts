import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { renameProjectKey } from "./claude-json.js";
import { unusableReason } from "./file-state.js";
import type { MovePlan } from "./move-plan.js";
import type { Operation, OperationResult } from "./operations.js";
import { parseRegistry } from "./registry.js";
import { setProjectPath } from "./registry-edit.js";
import { isRecord, mergeSettings, serializeSettings, type SettingsPatch } from "./settings.js";

export interface ApplyOptions {
  readonly dryRun: boolean;
  /** Racine de confinement : aucune écriture hors de ce dossier, aucun lien symbolique en dessous. */
  readonly root: string;
}

/** Refus volontaire (état inattendu du disque) : devient un statut `conflict`, pas une erreur système. */
class Refusal extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}

function errorDetail(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "erreur inconnue";
}

/** `lstat` sans suivre les liens ; un composant absent, ou sous un fichier, vaut « n'existe pas ». */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const detail = errorDetail(error);
    if (detail === "ENOENT" || detail === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Re-vérifie juste avant l'écriture, car le disque a pu changer depuis la planification :
 * le chemin reste sous la racine, et aucun composant existant entre la racine et la cible
 * (cible comprise) n'est un lien symbolique. Une fenêtre de course résiduelle très courte
 * subsiste entre cette vérification et l'écriture : Node n'offre pas d'`openat` pour la fermer.
 */
function assertConfined(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Refusal("OUTSIDE_ROOT");
  }
  let current = root;
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    const stats = lstatOrUndefined(current);
    if (stats === undefined) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Refusal("SYMLINK");
    }
  }
}

/** Crée un fichier sans jamais en écraser un : le drapeau `wx` échoue si le chemin existe. */
function createFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (error) {
    if (errorDetail(error) === "EEXIST") {
      throw new Refusal("EXISTS");
    }
    throw error;
  }
}

/**
 * Remplace un fichier de façon atomique : temporaire à nom unique dans le même dossier, puis renommage.
 * Le temporaire n'est supprimé que s'il a été créé par cet appel. Propriétaire, ACL et attributs
 * étendus ne sont pas conservés : c'est un nouveau fichier ; le mode l'est.
 */
function replaceAtomically(path: string, content: string | Buffer, mode: number): void {
  const temporary = `${path}.ch-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let created = false;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    created = true;
    renameSync(temporary, path);
  } catch (error) {
    if (created) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nettoyage au mieux : l'erreur d'origine est la seule utile.
      }
    }
    throw error;
  }
}

/** Fichier ordinaire, non lié, modifiable : sinon refus. Retourne ses métadonnées. */
function requireWritableFile(path: string): Stats {
  const stats = lstatOrUndefined(path);
  if (stats === undefined || !stats.isFile()) {
    throw new Refusal("NOT_A_FILE");
  }
  try {
    accessSync(path, constants.W_OK);
  } catch {
    throw new Refusal("READ_ONLY");
  }
  return stats;
}

/** Ajoute une ligne à un fichier texte existant, sans doublon. */
function appendLine(path: string, line: string): void {
  const stats = requireWritableFile(path);
  const existing = readFileSync(path, "utf8");
  if (existing.split("\n").some((candidate) => candidate.trim() === line)) {
    return;
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  replaceAtomically(path, `${existing}${separator}${line}\n`, stats.mode & 0o777);
}

const hasByteOrderMark = (bytes: Buffer): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

/** Cherche, parmi les sauvegardes déjà faites du même fichier, une copie au contenu strictement identique. */
function findIdenticalBackup(backupDir: string, name: string, content: Buffer): string | undefined {
  let folders: string[];
  try {
    folders = readdirSync(backupDir).toSorted().toReversed();
  } catch {
    return undefined;
  }
  return folders
    .map((folder) => join(backupDir, folder, name))
    .find((candidate) => {
      try {
        return readFileSync(candidate).equals(content);
      } catch {
        return false;
      }
    });
}

/**
 * Copie l'original, lisible par le seul propriétaire, dans un sous-dossier horodaté du dossier de sauvegarde.
 * Une copie existante au contenu identique est réutilisée : réappliquer sans changement ne multiplie pas les copies.
 */
function backUp(original: Buffer, source: string, backupDir: string): string {
  const name = source.split(sep).filter(Boolean).join("__");
  const existing = findIdenticalBackup(backupDir, name, original);
  if (existing !== undefined) {
    return existing;
  }
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const folder = join(backupDir, stamp);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, name);
  writeFileSync(target, original, { flag: "wx", mode: 0o600 });
  return target;
}

/**
 * Fusionne un patch dans un JSON de réglages : créé s'il est absent, sinon sauvegardé puis remplacé, et
 * laissé intact s'il est déjà aligné. Un fichier illisible ou à la structure inattendue est refusé sans
 * jamais reprendre son contenu dans l'erreur. Retourne le chemin de la sauvegarde, s'il y en a eu une.
 */
function mergeJson(path: string, patch: SettingsPatch, backupDir: string): string | undefined {
  if (lstatOrUndefined(path) === undefined) {
    mkdirSync(dirname(path), { recursive: true });
    const created = mergeSettings({}, patch);
    if (created === undefined) {
      throw new Refusal("INVALID_STRUCTURE");
    }
    createFile(path, serializeSettings(created.merged));
    return undefined;
  }
  const stats = requireWritableFile(path);
  const raw = readFileSync(path);
  if (hasByteOrderMark(raw)) {
    throw new Refusal("BOM");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Refusal("INVALID_JSON");
  }
  if (!isRecord(parsed)) {
    throw new Refusal("INVALID_JSON");
  }
  const result = mergeSettings(parsed, patch);
  if (result === undefined) {
    throw new Refusal("INVALID_STRUCTURE");
  }
  if (!result.changed) {
    return undefined;
  }
  const backup = backUp(raw, path, backupDir);
  replaceAtomically(path, serializeSettings(result.merged), stats.mode & 0o777);
  return backup;
}

function applyOne(operation: Operation, root: string): OperationResult {
  try {
    assertConfined(root, operation.path);
    switch (operation.kind) {
      case "mkdir":
        mkdirSync(operation.path, { recursive: true });
        break;
      case "create":
        createFile(operation.path, operation.content);
        break;
      case "append-line":
        appendLine(operation.path, operation.line);
        break;
      case "backup": {
        const stats = lstatOrUndefined(operation.path);
        if (stats === undefined) {
          break;
        }
        if (!stats.isFile()) {
          throw new Refusal("NOT_A_FILE");
        }
        const copy = backUp(readFileSync(operation.path), operation.path, operation.backupDir);
        return { operation, status: "done", backup: copy };
      }
      case "remove-tree": {
        const stats = lstatOrUndefined(operation.path);
        if (stats === undefined) {
          break;
        }
        if (!stats.isDirectory()) {
          throw new Refusal("NOT_A_DIRECTORY");
        }
        rmSync(operation.path, { recursive: true });
        break;
      }
      case "merge-json": {
        const backup = mergeJson(operation.path, operation.patch, operation.backupDir);
        return backup === undefined ? { operation, status: "done" } : { operation, status: "done", backup };
      }
    }
    return { operation, status: "done" };
  } catch (error) {
    return error instanceof Refusal
      ? { operation, status: "conflict", detail: error.detail }
      : { operation, status: "error", detail: errorDetail(error) };
  }
}

/**
 * Exécute les opérations dans l'ordre et s'arrête à la première qui n'aboutit pas ; les suivantes
 * sont rapportées `skipped`. En simulation, rien n'est écrit ni vérifié.
 */
export function applyOperations(
  operations: readonly Operation[],
  options: ApplyOptions
): readonly OperationResult[] {
  if (options.dryRun) {
    return operations.map((operation) => ({ operation, status: "dry-run" }));
  }
  const attempted: OperationResult[] = [];
  for (const operation of operations) {
    const result = applyOne(operation, options.root);
    attempted.push(result);
    if (result.status !== "done") {
      break;
    }
  }
  const notAttempted = operations.slice(attempted.length).map((operation): OperationResult => ({
    operation,
    status: "skipped",
  }));
  return [...attempted, ...notAttempted];
}

// ---------------------------------------------------------------------------------------------
// Déplacement d'un projet : étapes réversibles, exécutées dans l'ordre, annulées en ordre inverse.
// ---------------------------------------------------------------------------------------------

export type MoveStepName = "backup" | "parents" | "directory" | "history" | "claude-json" | "registry";

export interface MoveStepResult {
  readonly name: MoveStepName;
  readonly status: "done" | "skipped" | "failed" | "dry-run" | "rolled-back" | "rollback-failed";
  readonly detail?: string;
}

export interface MoveResult {
  readonly ok: boolean;
  /** true si tout ce qui avait été fait a été défait (vrai aussi quand rien n'avait été fait). */
  readonly rolledBack: boolean;
  readonly steps: readonly MoveStepResult[];
  /** Ce qu'il faut faire à la main, étape par étape, si un retour arrière n'a pas pu aboutir. */
  readonly manual: readonly string[];
}

export interface StepOutcome {
  readonly skipped?: string;
  readonly undo?: () => void;
}

export type MoveActions = Readonly<Record<MoveStepName, (plan: MovePlan) => StepOutcome>>;

/** Échec d'une étape qui avait déjà modifié des choses : porte l'annulation de ce qui a été fait avant l'échec. */
class StepError extends Error {
  readonly detail: string;
  readonly undo: (() => void) | undefined;

  constructor(detail: string, undo: (() => void) | undefined) {
    super(detail);
    this.detail = detail;
    this.undo = undo;
  }
}

const MOVE_STEPS: readonly MoveStepName[] = ["backup", "parents", "directory", "history", "claude-json", "registry"];
const INTERRUPTION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const ignoreSignal = (): void => undefined;
const REWRITE_ATTEMPTS = 3;

function describeFailure(error: unknown): string {
  return error instanceof Refusal || error instanceof StepError ? error.detail : errorDetail(error);
}

/** Tente chaque annulation, même si une autre échoue, puis signale l'échec global : rien n'est laissé à moitié défait par abandon. */
const undoAll =
  (tasks: readonly (() => void)[]): (() => void) =>
  () => {
    const failures = tasks.toReversed().flatMap((task) => {
      try {
        task();
        return [];
      } catch (error) {
        return [describeFailure(error)];
      }
    });
    if (failures.length > 0) {
      throw new Refusal("UNDO_INCOMPLETE");
    }
  };

const isRegularFile = (path: string): boolean => lstatOrUndefined(path)?.isFile() === true;

function backUpBeforeMove(plan: MovePlan): StepOutcome {
  [plan.claudeJsonPath, plan.registryPath]
    .filter(isRegularFile)
    .forEach((path) => backUp(readFileSync(path), path, plan.backupDir));
  return {};
}

function createParents(plan: MovePlan): StepOutcome {
  const missing: string[] = [];
  for (let current = dirname(plan.destination); lstatOrUndefined(current) === undefined; current = dirname(current)) {
    missing.push(current);
  }
  if (missing.length === 0) {
    return { skipped: "dossiers parents déjà présents" };
  }
  const tasks: (() => void)[] = [];
  try {
    for (const folder of missing.toReversed()) {
      mkdirSync(folder);
      tasks.push(() => rmdirSync(folder));
    }
  } catch (error) {
    throw new StepError(describeFailure(error), undoAll(tasks));
  }
  return { undo: undoAll(tasks) };
}

/**
 * Déplace le dossier : `mkdir` exclusif de la destination (échoue si quelqu'un l'a créée entre-temps), puis
 * renommage du projet sur ce dossier vide. Le renommage est atomique sur un même système de fichiers.
 */
function moveDirectory(plan: MovePlan): StepOutcome {
  const stats = lstatOrUndefined(plan.source);
  if (stats === undefined) {
    throw new Refusal("SOURCE_MISSING");
  }
  if (stats.isSymbolicLink()) {
    throw new Refusal("SYMLINK");
  }
  if (!stats.isDirectory()) {
    throw new Refusal("NOT_A_DIRECTORY");
  }
  try {
    mkdirSync(plan.destination);
  } catch (error) {
    throw errorDetail(error) === "EEXIST" ? new Refusal("DEST_EXISTS") : error;
  }
  try {
    renameSync(plan.source, plan.destination);
  } catch (error) {
    try {
      rmdirSync(plan.destination);
    } catch {
      // Le dossier vide que nous venons de créer : le laisser est sans conséquence, l'erreur d'origine prime.
    }
    throw error;
  }
  return {
    undo: () => {
      if (lstatOrUndefined(plan.source) !== undefined) {
        throw new Refusal("SOURCE_OCCUPIED");
      }
      renameSync(plan.destination, plan.source);
    },
  };
}

function renameHistory(plan: MovePlan): StepOutcome {
  const tasks: (() => void)[] = [];
  try {
    for (const pair of [{ from: plan.oldKey, to: plan.newKey }, ...plan.subfolderKeys]) {
      const from = join(plan.projectsDir, pair.from);
      const to = join(plan.projectsDir, pair.to);
      if (lstatOrUndefined(from) === undefined) {
        continue;
      }
      if (lstatOrUndefined(to) !== undefined) {
        throw new Refusal("KEY_CONFLICT");
      }
      renameSync(from, to);
      tasks.push(() => renameSync(to, from));
    }
  } catch (error) {
    throw new StepError(describeFailure(error), undoAll(tasks));
  }
  return tasks.length === 0 ? { skipped: "aucun historique à renommer" } : { undo: undoAll(tasks) };
}

/**
 * Remplace le contenu d'un fichier par `next`, et sait le restaurer à `original` seulement si personne
 * d'autre ne l'a modifié entre-temps (sinon, il faut corriger à la main : restaurer la sauvegarde
 * effacerait les modifications des autres).
 */
function rewriteReversibly(path: string, original: Buffer, next: string, mode: number): StepOutcome {
  replaceAtomically(path, next, mode);
  return {
    undo: () => {
      if (readFileSync(path, "utf8") !== next) {
        throw new Refusal("MODIFIED_BY_OTHER");
      }
      replaceAtomically(path, original, mode);
    },
  };
}

/**
 * Renomme l'entrée du projet (et celles de ses sous-dossiers). Le fichier est relu juste avant l'écriture :
 * s'il a changé entre-temps (Claude l'écrit souvent), on recalcule, quelques fois, avant d'abandonner.
 * Une fenêtre subsiste entre cette relecture et le renommage du fichier temporaire : de l'ordre de la milliseconde,
 * car l'écriture du temporaire (118 Ko) est comprise. Une écriture de Claude dans ce laps de temps est perdue.
 */
function rewriteClaudeJson(plan: MovePlan): StepOutcome {
  const stats = lstatOrUndefined(plan.claudeJsonPath);
  const reason = unusableReason(stats);
  if (stats === undefined || reason !== undefined) {
    return { skipped: reason ?? "fichier absent" };
  }
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt += 1) {
    const original = readFileSync(plan.claudeJsonPath);
    const result = renameProjectKey(original.toString("utf8"), plan.source, plan.destination);
    if (result.kind === "absent") {
      return { skipped: "entrée absente" };
    }
    if (result.kind === "unsafe") {
      return { skipped: result.reason };
    }
    if (readFileSync(plan.claudeJsonPath).equals(original)) {
      return rewriteReversibly(plan.claudeJsonPath, original, result.text, stats.mode & 0o777);
    }
  }
  throw new Refusal("CLAUDE_JSON_BUSY");
}

/** Vérifie que l'édition du registre n'a changé que le chemin du projet déplacé. */
function verifyRegistryEdit(before: string, after: string, plan: MovePlan): void {
  try {
    const others = (text: string) =>
      JSON.stringify(parseRegistry(text, plan.workspaceRoot).filter((project) => project.name !== plan.project.name));
    const moved = parseRegistry(after, plan.workspaceRoot).find((project) => project.name === plan.project.name);
    if (moved?.path === plan.destination && others(before) === others(after)) {
      return;
    }
  } catch {
    // Un registre illisible avant ou après l'édition vaut un résultat inattendu.
  }
  throw new Refusal("REGISTRY_MISMATCH");
}

function rewriteRegistry(plan: MovePlan): StepOutcome {
  const stats = lstatOrUndefined(plan.registryPath);
  if (stats === undefined) {
    return { skipped: "registre absent" };
  }
  if (unusableReason(stats) !== undefined) {
    throw new Refusal("REGISTRY_UNUSABLE");
  }
  const original = readFileSync(plan.registryPath);
  const before = original.toString("utf8");
  let next: string;
  try {
    next = setProjectPath(before, plan.project.name, plan.newRegistryPath);
  } catch {
    throw new Refusal("REGISTRY_INVALID");
  }
  if (next === before) {
    return { skipped: "chemin déjà à jour" };
  }
  verifyRegistryEdit(before, next, plan);
  return rewriteReversibly(plan.registryPath, original, next, stats.mode & 0o777);
}

export const MOVE_ACTIONS: MoveActions = {
  backup: backUpBeforeMove,
  parents: createParents,
  directory: moveDirectory,
  history: renameHistory,
  "claude-json": rewriteClaudeJson,
  registry: rewriteRegistry,
};

/** Consigne à suivre à la main quand l'annulation d'une étape a échoué : précise, et jamais « restaurer la sauvegarde » à l'aveugle. */
function manualHint(name: MoveStepName, plan: MovePlan, detail: string | undefined): string {
  switch (name) {
    case "parents":
      return `Supprimer à la main les dossiers vides créés pour la destination, sous ${dirname(plan.destination)}.`;
    case "directory":
      return detail === "SOURCE_OCCUPIED"
        ? `${plan.source} est de nouveau occupé : le déplacer ailleurs, puis remettre le projet à sa place avec : mv "${plan.destination}" "${plan.source}".`
        : `Remettre le dossier à sa place : mv "${plan.destination}" "${plan.source}".`;
    case "history":
      return `Dans ${plan.projectsDir}, renommer « ${plan.newKey} » en « ${plan.oldKey} » (et l'historique des sous-dossiers renommés).`;
    case "claude-json":
      return detail === "MODIFIED_BY_OTHER"
        ? `Dans ${plan.claudeJsonPath}, renommer à la main la clé « ${plan.destination} » en « ${plan.source} » (ne PAS restaurer la sauvegarde : elle effacerait les modifications faites entre-temps par Claude).`
        : `Vérifier ${plan.claudeJsonPath} ; au besoin, le restaurer depuis la sauvegarde dans ${plan.backupDir}.`;
    case "registry":
      return `Dans ${plan.registryPath}, remettre le chemin du projet « ${plan.project.name} » à sa valeur d'origine (sauvegarde dans ${plan.backupDir}).`;
    case "backup":
      return "Aucune action.";
  }
}

interface Undo {
  readonly name: MoveStepName;
  readonly undo: () => void;
}

function rollBack(plan: MovePlan, steps: readonly MoveStepResult[], undos: readonly Undo[]): MoveResult {
  const outcomes = undos.toReversed().map(({ name, undo }) => {
    try {
      undo();
      return { name, failure: undefined };
    } catch (error) {
      return { name, failure: describeFailure(error) };
    }
  });
  const updated = steps.map((step): MoveStepResult => {
    const outcome = outcomes.find((candidate) => candidate.name === step.name);
    if (outcome === undefined || step.status === "failed") {
      return step;
    }
    return outcome.failure === undefined
      ? { name: step.name, status: "rolled-back" }
      : { name: step.name, status: "rollback-failed", detail: outcome.failure };
  });
  const manual = outcomes
    .filter((outcome) => outcome.failure !== undefined)
    .map((outcome) => manualHint(outcome.name, plan, outcome.failure));
  return { ok: false, rolledBack: manual.length === 0, steps: updated, manual };
}

function runMoveSteps(plan: MovePlan, actions: MoveActions): MoveResult {
  const steps: MoveStepResult[] = [];
  const undos: Undo[] = [];
  for (const name of MOVE_STEPS) {
    try {
      const outcome = actions[name](plan);
      steps.push(
        outcome.skipped === undefined ? { name, status: "done" } : { name, status: "skipped", detail: outcome.skipped }
      );
      if (outcome.undo !== undefined) {
        undos.push({ name, undo: outcome.undo });
      }
    } catch (error) {
      steps.push({ name, status: "failed", detail: describeFailure(error) });
      if (error instanceof StepError && error.undo !== undefined) {
        undos.push({ name, undo: error.undo });
      }
      return rollBack(plan, steps, undos);
    }
  }
  return { ok: true, rolledBack: false, steps, manual: [] };
}

/**
 * Exécute le déplacement avec les actions données (couture d'injection pour les tests). Le processus ignore
 * Ctrl-C, SIGTERM et SIGHUP pendant toute la durée : l'exécution est synchrone, donc le signal serait traité après.
 */
export function executeMoveWith(plan: MovePlan, options: { readonly dryRun: boolean }, actions: MoveActions): MoveResult {
  if (options.dryRun) {
    return { ok: true, rolledBack: false, steps: MOVE_STEPS.map((name) => ({ name, status: "dry-run" })), manual: [] };
  }
  INTERRUPTION_SIGNALS.forEach((signal) => process.on(signal, ignoreSignal));
  try {
    return runMoveSteps(plan, actions);
  } finally {
    INTERRUPTION_SIGNALS.forEach((signal) => process.off(signal, ignoreSignal));
  }
}

/**
 * Déplace un projet de façon transactionnelle : sauvegarde de `~/.claude.json` et du registre, création des
 * dossiers parents, déplacement du dossier, renommage de l'historique et de la mémoire de Claude Code, réécriture
 * de `~/.claude.json` puis du registre. Au premier échec, les étapes faites sont annulées en ordre inverse.
 */
export function executeMove(plan: MovePlan, options: { readonly dryRun: boolean }): MoveResult {
  return executeMoveWith(plan, options, MOVE_ACTIONS);
}
