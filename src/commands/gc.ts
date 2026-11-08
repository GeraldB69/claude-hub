import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Env, type Io, type Runtime } from "../core/env.js";
import { applyOperations } from "../core/fs-safe.js";
import { planGc, type OrphanVersion } from "../core/gc-plan.js";
import { describeDetail } from "../core/operations.js";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

function parseArguments(argv: readonly string[]): { readonly yes: boolean } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { yes: { type: "boolean" }, "dry-run": { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) {
    throw new Error("aucun argument attendu");
  }
  if (values.yes === true && values["dry-run"] === true) {
    throw new Error("--yes et --dry-run s'excluent");
  }
  return { yes: values.yes === true };
}

function describe(io: Io, orphans: readonly OrphanVersion[], kept: number): void {
  for (const orphan of orphans) {
    io.out(`- ${orphan.label}  ${megabytes(orphan.bytes)}`);
  }
  const total = orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);
  io.out(`${orphans.length} version(s) inutilisée(s), ${megabytes(total)} ; ${kept} version(s) en usage conservée(s).`);
}

/**
 * `ch gc [--yes]` : supprime du cache des plugins les versions qu'aucune entrée de `installed_plugins.json`
 * n'utilise. Simulation par défaut ; la suppression exige `--yes` et l'absence de toute autre session Claude.
 * Pas de sauvegarde (exception voulue à la règle du dépôt) : le cache se régénère à l'installation. Les
 * marketplaces et `plugins/data` ne sont pas touchés. Limite : la session qui exécute `ch` n'est pas comptée
 * comme « autre » ; après un `claude plugin update` dans cette session, la redémarrer avant `--yes`.
 */
export function gcCommand(argv: readonly string[], env: Env, io: Io, runtime: Runtime): number {
  let yes: boolean;
  try {
    ({ yes } = parseArguments(argv));
  } catch (error) {
    io.err(`ch gc : ${reason(error)}. Usage : ch gc [--yes]`);
    return EXIT_USAGE;
  }
  if (env.claudeConfigDir !== undefined) {
    io.err("ch gc : CLAUDE_CONFIG_DIR est défini ; l'organisation de ce dossier n'est pas vérifiée, rien n'est fait.");
    return EXIT_ERROR;
  }

  try {
    const plan = planGc(env.home);
    if (plan.status === "unknown") {
      io.err(`ch gc : ${plan.reason} ; rien n'est supprimé.`);
      return EXIT_ERROR;
    }
    io.out(`${yes ? "" : "[simulation] Rien ne sera supprimé. "}Cache : ${plan.cacheRoot}`);
    describe(io, plan.orphans, plan.kept);
    if (!yes || plan.orphans.length === 0) {
      if (!yes && plan.orphans.length > 0) {
        io.out("Relancer avec --yes pour supprimer.");
      }
      return EXIT_OK;
    }

    const others = runtime.claudeProcesses().filter((process) => !process.ancestor);
    if (others.length > 0) {
      io.err(
        `ch gc : ${others.length} autre(s) session(s) Claude ouverte(s) (pid ${others.map((p) => p.pid).join(", ")}) ; elles peuvent utiliser ces versions. Les fermer puis relancer.`
      );
      return EXIT_ERROR;
    }

    // Le plan a été calculé avant le contrôle des sessions : on le refait et on ne garde que les orphelins des deux.
    const fresh = planGc(env.home);
    if (fresh.status !== "ok") {
      io.err("ch gc : l'état des plugins a changé pendant la vérification ; rien n'est supprimé.");
      return EXIT_ERROR;
    }
    const stillOrphans = plan.orphans.filter((orphan) => fresh.orphans.some((other) => other.path === orphan.path));
    const results = applyOperations(
      stillOrphans.map((orphan) => ({ kind: "remove-tree" as const, path: orphan.path })),
      { dryRun: false, root: plan.cacheRoot }
    );
    const skipped = results.filter((result) => result.status === "skipped").length;
    const failed = results.find((result) => result.status !== "done");
    const removed = results.filter((result) => result.status === "done").length;
    io.out(`${removed} version(s) supprimée(s).`);
    if (failed !== undefined) {
      io.err(`ch gc : arrêt sur ${failed.operation.path} (${describeDetail(failed.detail ?? failed.status)}) ; ${skipped} version(s) non traitée(s).`);
      return EXIT_ERROR;
    }
    return EXIT_OK;
  } catch (error) {
    io.err(`ch gc : ${reason(error)}`);
    return EXIT_ERROR;
  }
}
