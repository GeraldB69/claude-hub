import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Env, type Io, type Runtime } from "../core/env.js";
import { executeMove, type MoveResult, type MoveStepName } from "../core/fs-safe.js";
import { planMove, type MovePlan } from "../core/move-plan.js";
import { planPostMove } from "../core/post-move.js";
import { describeDetail } from "../core/operations.js";

interface MoveArgs {
  readonly "dry-run"?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly positionals: readonly string[];
}

const STEP_LABELS: Readonly<Record<MoveStepName, string>> = {
  backup: "sauvegarde de ~/.claude.json et du registre",
  parents: "création des dossiers parents",
  directory: "déplacement du dossier du projet",
  history: "historique et mémoire de Claude Code",
  "claude-json": "~/.claude.json",
  registry: "registre des projets",
};

const STATUS_LABELS: Readonly<Record<MoveResult["steps"][number]["status"], string>> = {
  done: "fait",
  skipped: "ignoré",
  failed: "échec",
  "dry-run": "simulé",
  "rolled-back": "annulé",
  "rollback-failed": "annulation échouée",
};

function parseArguments(argv: readonly string[]): MoveArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "dry-run": { type: "boolean" }, yes: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  return { ...values, positionals };
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function printPlan(
  io: Io,
  plan: MovePlan,
  details: { readonly claudeJson: string; readonly historyPresent: boolean },
  warnings: readonly string[],
  dryRun: boolean
): void {
  const extra = plan.subfolderKeys.length > 0 ? ` (+ ${plan.subfolderKeys.length} sous-dossier(s))` : "";
  io.out(dryRun ? "[simulation] Rien ne sera déplacé." : "Plan de déplacement :");
  io.out(`Projet : ${plan.project.name}`);
  io.out(`  de   : ${plan.source}`);
  io.out(`  vers : ${plan.destination}`);
  const history = details.historyPresent ? "dossier présent" : "aucun dossier d'historique à renommer";
  io.out(`~ historique et mémoire : ${plan.oldKey} → ${plan.newKey}${extra} (${history})`);
  io.out(`~ ~/.claude.json : ${details.claudeJson}`);
  io.out(`~ registre : path → ${plan.newRegistryPath}`);
  if (plan.newName !== plan.project.name) {
    io.out(`~ registre : nom ${plan.project.name} → ${plan.newName}`);
  }
  if (warnings.length > 0) {
    io.out("Avertissements :");
    warnings.forEach((warning) => io.out(`  - ${warning}`));
  }
}

/** Commandes à lancer après le déplacement, déduites de ce qui mentionne encore l'ancien chemin. */
function printFollowUp(io: Io, plan: MovePlan): void {
  let guide: ReturnType<typeof planPostMove>;
  try {
    guide = planPostMove(plan.destination, plan.source);
  } catch (error) {
    io.out(`Note : la recherche des références à l'ancien chemin a échoué (${reason(error)}) ; la faire à la main (par exemple avec grep -rIF).`);
    return;
  }
  if (guide.commands.length > 0) {
    io.out("Pour finir le déplacement, lancer ces commandes (ch ne les exécute pas) :");
    guide.commands.forEach((command) => io.out(command));
  } else if (guide.notes.length === 0) {
    io.out("Aucune référence à l'ancien chemin trouvée dans les fichiers texte examinés (hors dossiers ignorés comme node_modules, fichiers de plus de 1 Mo, hooks en lien et dépôts hors du projet).");
  }
  guide.notes.forEach((note) => io.out(`Note : ${note}`));
}

function printOutcome(io: Io, plan: MovePlan, result: MoveResult): number {
  result.steps.forEach((step) => {
    const detail = step.detail === undefined ? "" : ` (${describeDetail(step.detail)})`;
    io.out(`[${STATUS_LABELS[step.status]}] ${STEP_LABELS[step.name]}${detail}`);
  });
  if (!result.ok) {
    const failed = result.steps.find((step) => step.status === "failed");
    io.err(
      `ch move : échec à l'étape « ${failed === undefined ? "?" : STEP_LABELS[failed.name]} » (${describeDetail(failed?.detail)}) ; ${
        result.rolledBack ? "tout a été annulé, le projet est à sa place d'origine." : "l'annulation est incomplète."
      }`
    );
    result.manual.forEach((line) => io.err(`  ${line}`));
    io.err(`  Sauvegardes : ${plan.backupDir}`);
    return EXIT_ERROR;
  }
  const claudeJson = result.steps.find((step) => step.name === "claude-json");
  if (claudeJson?.status === "skipped" && claudeJson.detail !== "entrée absente" && claudeJson.detail !== "fichier absent") {
    io.out(
      `ATTENTION : ~/.claude.json n'a pas été modifié (${claudeJson.detail ?? "raison inconnue"}) : les autorisations et la confiance de ce projet restent attachées à l'ancien chemin et seront redemandées.`
    );
  }
  io.out(`Projet déplacé. Le rouvrir avec : ch open ${plan.newName}`);
  io.out("Vérifier que la mémoire est retrouvée.");
  printFollowUp(io, plan);
  return EXIT_OK;
}

/**
 * `ch move <projet> <destination> [--dry-run] [--yes]` : déplace un projet sous la racine de travail en
 * conservant la mémoire et l'historique de Claude Code. Le plan est toujours affiché ; le déplacement n'a
 * lieu qu'avec `--yes`. Refuse tant qu'une session Claude est ouverte dans le projet.
 */
export function moveCommand(argv: readonly string[], env: Env, io: Io, runtime: Runtime): number {
  let args: MoveArgs;
  try {
    args = parseArguments(argv);
  } catch (error) {
    io.err(`ch move : ${reason(error)}`);
    return EXIT_USAGE;
  }
  const [project, destination, ...extra] = args.positionals;
  if (project === undefined || destination === undefined || extra.length > 0) {
    io.err("ch move : un projet et une destination attendus. Usage : ch move <projet> <destination> [--dry-run] [--yes]");
    return EXIT_USAGE;
  }

  try {
    const planned = planMove(env, runtime.claudeProcesses(), project, destination);
    if (planned.kind === "usage") {
      io.err(`ch move : ${planned.message}`);
      return EXIT_USAGE;
    }
    if (planned.kind === "refused") {
      io.err("ch move : déplacement refusé :");
      planned.problems.forEach((problem) => io.err(`  - ${problem}`));
      return EXIT_ERROR;
    }
    const dryRun = args["dry-run"] === true;
    const claudeJson =
      planned.claudeJson.status === "renamed"
        ? "l'entrée du projet sera renommée"
        : planned.claudeJson.status === "absent"
          ? "aucune entrée pour ce projet"
          : "non modifié";
    printPlan(io, planned.plan, { claudeJson, historyPresent: planned.historyPresent }, planned.warnings, dryRun);
    if (dryRun) {
      return EXIT_OK;
    }
    if (args.yes !== true) {
      io.err("ch move : rien n'a été déplacé. Relancer avec --yes pour exécuter ce plan.");
      return EXIT_USAGE;
    }
    return printOutcome(io, planned.plan, executeMove(planned.plan, { dryRun: false }));
  } catch (error) {
    io.err(`ch move : ${reason(error)}`);
    return EXIT_ERROR;
  }
}
