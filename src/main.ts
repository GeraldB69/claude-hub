import { applyCommand } from "./commands/apply.js";
import { auditCommand } from "./commands/audit.js";
import { gcCommand } from "./commands/gc.js";
import { initCommand } from "./commands/init.js";
import { lsCommand } from "./commands/ls.js";
import { moveCommand } from "./commands/move.js";
import { openCommand } from "./commands/open.js";
import { EXIT_OK, EXIT_USAGE, type Env, type Io, type Runtime } from "./core/env.js";

const USAGE = [
  "Usage : ch <commande> [options]",
  "",
  "Commandes :",
  "  ch audit [--json | --quiet] [--root <dossier>]... [--config <dossier>]",
  "      Détecte les écarts à la politique de configuration Claude (lecture seule).",
  "      Codes de sortie : 0 aucun écart bloquant, 1 erreur détectée, 2 usage, 3 échec d'exécution.",
  "  ch ls [--json]",
  "      Liste les projets du registre classés par dossier ; signale les dossiers introuvables et les dépôts git",
  "      de ~/workspace absents du registre (lecture seule).",
  "  ch init <projet|chemin> [--profile <nom>] [--dry-run]",
  "      Prépare .claude/settings.json, CLAUDE.md, docs/ai et .gitignore d'un projet,",
  "      sans jamais écraser un fichier existant.",
  "  ch apply <projet|chemin> [--profile <nom>] [--dry-run] [--yes]",
  "      Sauvegarde .claude/settings.json, installe les plugins du profil au scope projet (claude plugin",
  "      install, interactif), puis fusionne les clés du profil dans le fichier. Le profil l'emporte sur",
  "      une valeur contraire (signalée par ~). --yes passe -y à claude : il accepte alors sans demander",
  "      les commandes déclarées par les marketplaces.",
  "  ch move <projet> <destination> [--dry-run] [--yes]",
  "      Déplace un projet du registre sous la racine de travail en conservant la mémoire et l'historique de",
  "      Claude Code. Affiche toujours le plan ; ne déplace qu'avec --yes. Refuse si une session Claude est",
  "      ouverte dans le projet. Tout est annulé en cas d'échec. Si le projet portait le nom de son dossier,",
  "      l'entrée du registre prend le nom du dossier de destination.",
  "  ch gc [--yes]",
  "      Liste les versions de plugins du cache (~/.claude/plugins/cache) qu'aucun plugin installé n'utilise.",
  "      Ne supprime qu'avec --yes ; refuse si une autre session Claude est ouverte. Le cache se régénère à",
  "      l'installation, donc aucune sauvegarde n'est faite.",
  "  ch open <projet> [--add-dir <projet>]... [--force] [-- <arguments de claude>]",
  "      Lance claude dans le dossier du projet (nom exact ou préfixe unique du registre).",
  "      Code de sortie : celui de claude (qui peut recouper 1 à 3) ; 126 ou 127 si claude ne peut pas être lancé.",
].join("\n");

/** Point d'entrée testable du CLI : retourne le code de sortie, n'écrit que via `io` et `runtime`. */
export function main(argv: readonly string[], env: Env, io: Io, runtime: Runtime): number {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (command === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  switch (command) {
    case "audit":
      return auditCommand(rest, env, io);
    case "ls":
      return lsCommand(rest, env, io);
    case "init":
      return initCommand(rest, env, io);
    case "apply":
      return applyCommand(rest, env, io, runtime);
    case "move":
      return moveCommand(rest, env, io, runtime);
    case "gc":
      return gcCommand(rest, env, io, runtime);
    case "open":
      return openCommand(rest, env, io, runtime);
    default:
      io.err(`Commande inconnue : ${command}`);
      io.err(USAGE);
      return EXIT_USAGE;
  }
}
