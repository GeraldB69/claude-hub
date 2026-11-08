import { join } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Env, type Io, type Runtime } from "../core/env.js";
import { applyOperations } from "../core/fs-safe.js";
import { describeDetail } from "../core/operations.js";
import { assertWritableForApply, inspectSettings, type SettingsState } from "../core/plan.js";
import type { Profile } from "../core/profile.js";
import { settingsPatchOf, type SettingsPatch } from "../core/settings.js";
import { resolveTarget, UsageError } from "../core/target.js";

interface ApplyArgs {
  readonly profile?: string | undefined;
  readonly "dry-run"?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly positionals: readonly string[];
}

/** Tout ce que les étapes d'`apply` partagent. */
interface Plan {
  readonly projectDir: string;
  readonly profile: Profile;
  readonly patch: SettingsPatch;
  readonly settings: SettingsState;
  readonly yes: boolean;
  readonly backupDir: string;
}

/** Ce qui a déjà été fait, pour que chaque message d'échec dise l'état réel du projet. */
interface Progress {
  readonly installed: string[];
  readonly backups: string[];
}

function parseArguments(argv: readonly string[]): ApplyArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { profile: { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  return { ...values, positionals };
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const installArguments = (id: string, yes: boolean): string[] => [
  "plugin",
  "install",
  id,
  "--scope",
  "project",
  ...(yes ? ["-y"] : []),
];

const drivesSettings = (plan: Plan): boolean => Object.keys(plan.patch).length > 0;

function printPlan(io: Io, plan: Plan, dryRun: boolean): void {
  io.out(
    `${dryRun ? "[simulation] Rien ne sera exécuté ni écrit. " : ""}Projet : ${plan.projectDir} (profil ${plan.profile.name})`
  );
  if (plan.profile.plugins.length > 0) {
    io.out("Note : claude installe au scope projet la version courante de la marketplace ; elle peut différer de la version installée au scope user.");
  }
  if (plan.yes && plan.profile.plugins.length > 0) {
    io.out("--yes : claude acceptera sans demander les commandes déclarées par les marketplaces.");
  }
  plan.profile.plugins.forEach((id) =>
    io.out(`+ installer ${id} : claude ${installArguments(id, plan.yes).join(" ")}`)
  );
  if (!drivesSettings(plan)) {
    io.out("= .claude/settings.json : le profil ne pilote aucune clé");
  } else if (plan.settings.summary.length === 0) {
    io.out("= .claude/settings.json : réglages déjà alignés");
  } else {
    const verb = plan.settings.existing === undefined ? "+ créer" : "~ aligner";
    io.out(`${verb} .claude/settings.json : ${plan.settings.summary.join(" ; ")}`);
  }
}

/** Copie l'original avant que `claude` n'y touche, dès qu'il existe et que des plugins vont être installés. */
function backUpBeforeInstall(io: Io, plan: Plan, progress: Progress): number | undefined {
  if (plan.settings.existing === undefined || plan.profile.plugins.length === 0) {
    return undefined;
  }
  const [saved] = applyOperations([{ kind: "backup", path: plan.settings.path, backupDir: plan.backupDir }], {
    dryRun: false,
    root: plan.projectDir,
  });
  if (saved?.status !== "done") {
    io.err(`ch apply : sauvegarde impossible (${describeDetail(saved?.detail ?? saved?.status)}) ; rien n'a été installé.`);
    return EXIT_ERROR;
  }
  if (saved.backup !== undefined) {
    progress.backups.push(saved.backup);
    io.out(`Sauvegarde avant installation : ${saved.backup}`);
  }
  return undefined;
}

function reportState(io: Io, progress: Progress): void {
  io.err(`  plugins déjà installés : ${progress.installed.join(", ") || "aucun"} (ils le restent).`);
  if (progress.backups.length > 0) {
    io.err(`  sauvegarde de l'original : ${progress.backups.join(", ")}`);
  }
}

function installPlugins(io: Io, runtime: Runtime, plan: Plan, progress: Progress): number | undefined {
  for (const id of plan.profile.plugins) {
    io.out(`→ claude ${installArguments(id, plan.yes).join(" ")}`);
    const code = runtime.launchClaude(plan.projectDir, installArguments(id, plan.yes));
    if (code !== 0) {
      io.err(`ch apply : l'installation de ${id} a échoué (code ${code}) ; arrêt, rien n'a été fusionné par ch.`);
      reportState(io, progress);
      io.err("  claude a pu modifier .claude/settings.json lui-même.");
      return EXIT_ERROR;
    }
    progress.installed.push(id);
  }
  return undefined;
}

function mergeSettingsStep(io: Io, plan: Plan, progress: Progress): number | undefined {
  if (!drivesSettings(plan)) {
    return undefined;
  }
  const [result] = applyOperations(
    [{ kind: "merge-json", path: plan.settings.path, patch: plan.patch, backupDir: plan.backupDir }],
    { dryRun: false, root: plan.projectDir }
  );
  if (result?.status !== "done") {
    io.err(`ch apply : fusion impossible sur ${plan.settings.path} (${describeDetail(result?.detail ?? result?.status)}).`);
    reportState(io, progress);
    return EXIT_ERROR;
  }
  if (result.backup !== undefined) {
    io.out(`Sauvegarde de l'ancien .claude/settings.json : ${result.backup}`);
  }
  return undefined;
}

/**
 * `ch apply <projet|chemin> [--profile <nom>] [--dry-run] [--yes]` : aligne un projet sur son profil.
 * Ordre : vérifications en lecture seule, sauvegarde de l'original, installation des plugins avec
 * `claude plugin install --scope project` (interactif ; `-y` seulement avec `--yes`), puis fusion des
 * clés du profil dans `.claude/settings.json`. Écrit dans le dossier du projet, là où `claude` écrit aussi.
 */
export function applyCommand(argv: readonly string[], env: Env, io: Io, runtime: Runtime): number {
  let args: ApplyArgs;
  try {
    args = parseArguments(argv);
  } catch (error) {
    io.err(`ch apply : ${reason(error)}`);
    return EXIT_USAGE;
  }
  const [query, ...extra] = args.positionals;
  if (query === undefined || extra.length > 0) {
    io.err("ch apply : un seul projet attendu. Usage : ch apply <projet|chemin> [--profile <nom>] [--dry-run] [--yes]");
    return EXIT_USAGE;
  }

  try {
    const { projectDir, profile } = resolveTarget(env, query, args.profile);
    const patch = settingsPatchOf(profile);
    const settings = inspectSettings(projectDir, patch);
    if (profile.plugins.length > 0 || settings.summary.length > 0) {
      assertWritableForApply(settings.path, projectDir);
    }
    const plan: Plan = { projectDir, profile, patch, settings, yes: args.yes === true, backupDir: join(env.stateDir, "backups") };
    const dryRun = args["dry-run"] === true;
    printPlan(io, plan, dryRun);
    if (dryRun) {
      return EXIT_OK;
    }

    const progress: Progress = { installed: [], backups: [] };
    return (
      backUpBeforeInstall(io, plan, progress) ??
      installPlugins(io, runtime, plan, progress) ??
      mergeSettingsStep(io, plan, progress) ??
      EXIT_OK
    );
  } catch (error) {
    io.err(`ch apply : ${reason(error)}`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}
