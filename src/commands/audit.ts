import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, type Env, type Io } from "../core/env.js";
import { loadPolicy } from "../core/policy.js";
import { runRules } from "../core/rules.js";
import { buildSnapshot } from "../core/scan.js";
import type { Finding, Severity } from "../core/types.js";

type Summary = Readonly<Record<Severity, number>>;

interface AuditOptions {
  readonly json?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly root?: string[] | undefined;
  readonly config?: string | undefined;
}

const LABELS: Readonly<Record<Severity, string>> = {
  error: "ERREUR",
  warn: "AVERT.",
  info: "INFO  ",
};
const MESSAGE_INDENT = " ".repeat(LABELS.error.length + 3);

function summarize(findings: readonly Finding[]): Summary {
  const count = (severity: Severity): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return { error: count("error"), warn: count("warn"), info: count("info") };
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count > 1 ? "s" : ""}`;
}

function formatText(findings: readonly Finding[], summary: Summary): readonly string[] {
  if (findings.length === 0) {
    return ["Aucun écart détecté."];
  }
  const lines = findings.flatMap((finding) => [
    `[${LABELS[finding.severity]}] ${finding.rule}  ${finding.subject}`,
    `${MESSAGE_INDENT}${finding.message}`,
  ]);
  const total = `Résumé : ${plural(summary.error, "erreur")}, ${plural(summary.warn, "avertissement")}, ${plural(summary.info, "info")}.`;
  return [...lines, "", total];
}

/** Une seule ligne, et seulement s'il y a une erreur ou un avertissement : pensé pour un hook de démarrage. */
function formatQuiet(summary: Summary): readonly string[] {
  return summary.error + summary.warn === 0
    ? []
    : [`ch audit : ${plural(summary.error, "erreur")}, ${plural(summary.warn, "avertissement")}. Détails : ch audit`];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOptions(argv: readonly string[]): AuditOptions {
  return parseArgs({
    args: [...argv],
    options: {
      json: { type: "boolean" },
      quiet: { type: "boolean" },
      root: { type: "string", multiple: true },
      config: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  }).values;
}

/** `ch audit` : détecte les écarts à la politique, en lecture seule. Retourne le code de sortie. */
export function auditCommand(argv: readonly string[], env: Env, io: Io): number {
  let options: AuditOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.err(`ch audit : ${reason(error)}`);
    return EXIT_USAGE;
  }

  if (options.json === true && options.quiet === true) {
    io.err("ch audit : --json et --quiet sont incompatibles.");
    return EXIT_USAGE;
  }

  if (env.claudeConfigDir !== undefined) {
    io.err(
      "ch audit : CLAUDE_CONFIG_DIR est défini ; l'organisation du dossier de configuration qu'il désigne n'est pas vérifiée, l'audit refuse de tourner pour ne pas rapporter un état faux."
    );
    return EXIT_ERROR;
  }

  try {
    const policy = loadPolicy(options.config ?? env.configDir);
    const roots = (options.root ?? env.defaultRoots).map((root) => resolve(root));
    const findings = runRules(buildSnapshot({ home: env.home, roots }), policy);
    const summary = summarize(findings);

    const lines =
      options.json === true
        ? [JSON.stringify({ findings, summary }, null, 2)]
        : options.quiet === true
          ? formatQuiet(summary)
          : formatText(findings, summary);
    lines.forEach((line) => io.out(line));
    return summary.error > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (error) {
    io.err(`ch audit : ${reason(error)}`);
    return EXIT_ERROR;
  }
}
