# Claude Hub

`ch` est un outil en ligne de commande qui garde propre et reproductible l'organisation de Claude Code sur un poste : quels plugins sont chargés et à quel niveau, quels projets existent et où ils sont rangés, quelle configuration chacun reçoit.

Il répond à un problème simple : avec le temps, les plugins s'installent « pour tous les projets », les skills se dupliquent, les projets se dispersent dans le disque, et chaque session Claude Code paie le coût de tout cela en contexte. `ch` détecte ces dérives, applique une configuration déclarée et déplace les projets sans perdre leur mémoire ni leur historique.

Le dépôt est générique : il ne contient aucune configuration personnelle. Votre configuration vit dans un dossier séparé, de préférence un dépôt privé, que `ch` lit.

## Principes

- **Lecture seule par défaut.** Toute commande qui écrit propose `--dry-run` et affiche ce qu'elle va faire.
- **Rien d'irréversible sans sauvegarde.** Les fichiers modifiés sont copiés au préalable dans le dossier d'état.
- **Rien n'est écrasé.** `ch init` ne remplace jamais un fichier existant.
- **Comportements de Claude Code vérifiés.** Chaque comportement externe dont dépend l'outil est vérifié puis figé par un test. Les constats sont dans [`docs/claude-behavior.md`](docs/claude-behavior.md).

## Installation

Prérequis : Node.js LTS et pnpm.

```bash
git clone https://github.com/GeraldB69/claude-hub.git
cd claude-hub
pnpm install
pnpm build
```

Pour utiliser `ch` depuis n'importe où, créez un alias dans votre shell :

```bash
alias ch='node /chemin/vers/claude-hub/dist/cli.js'
```

Sans compilation, `pnpm ch <commande>` lance directement les sources avec `tsx`.

## Commandes

| Commande                                    | Effet                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ch audit`                                  | Détecte les écarts à la politique de configuration (lecture seule). `--json`, `--quiet`, `--root <dossier>`, `--config <dossier>`.                                                  |
| `ch ls`                                     | Liste les projets du registre classés par dossier. Signale les dossiers introuvables et les dépôts git de la racine de travail absents du registre. `--json` pour un format machine. |
| `ch init <projet>`                          | Prépare `.claude/settings.json`, `CLAUDE.md`, `docs/ai` et `.gitignore` d'un projet, sans écraser l'existant.                                                                      |
| `ch apply <projet>`                         | Sauvegarde `.claude/settings.json`, installe les plugins du profil au niveau projet, puis fusionne les clés du profil dans le fichier. Le profil l'emporte sur une valeur contraire. |
| `ch move <projet> <destination>`            | Déplace un projet en conservant la mémoire et l'historique de Claude Code. Affiche le plan, ne déplace qu'avec `--yes`, annule tout en cas d'échec.                                  |
| `ch open <projet> [-- <arguments claude>]`  | Lance `claude` dans le dossier du projet (nom exact ou préfixe unique du registre). `--add-dir <projet>` ajoute un autre projet.                                                   |

Codes de sortie : `0` succès, `1` écart détecté (`audit`), `2` erreur d'usage, `3` échec d'exécution. `ch open` retourne le code de `claude`, ou `126` / `127` si `claude` ne peut pas être lancé.

`ch move` doit être lancé depuis un terminal ordinaire, jamais depuis une session Claude ouverte dans le projet : il refuse dans ce cas, car une session ouverte peut réécrire `~/.claude.json`.

## Configuration

`ch` lit un dossier de configuration, dont l'emplacement par défaut est indiqué plus bas. Il contient :

```
<config>/
├── policy.yaml     politique lue par `ch audit`
├── projects.yaml   registre des projets
└── profiles/       profils appliqués par `ch init` et `ch apply`
```

Le dossier `examples/profiles/` de ce dépôt fournit des profils génériques (`base`, `nextjs`) à copier. Un profil du dossier privé prend le pas sur un profil d'exemple du même nom.

### `policy.yaml`

```yaml
# Plugins autorisés au niveau utilisateur (chargés dans tous les projets).
userPluginAllowlist:
  - mon-plugin@ma-marketplace

# ~/.agents/skills n'est pas lu par Claude Code : le signaler s'il n'est pas vide.
agentsSkillsMustBeEmpty: true

# false : signaler les plugins et skills synchronisés depuis le compte claude.ai.
allowAccountSync: false
```

Tous les champs sont facultatifs ; sans fichier, ces valeurs par défaut s'appliquent.

### `projects.yaml`

```yaml
projects:
  - name: mon-site
    path: perso/mon-site # relatif à la racine de travail, ou absolu
    profile: nextjs
    remote: git@github.com:moi/mon-site.git # facultatif
```

### Profils

Un profil est un fichier YAML de `profiles/`. Il peut en étendre un autre (`extends`) et déclare, entre autres, `plugins`, `connectors` et le contenu initial de `claudeMd`. Voir les exemples.

### Variables d'environnement

| Variable        | Rôle                                                  | Défaut                         |
| --------------- | ----------------------------------------------------- | ------------------------------ |
| `CH_HOME`       | Dossier personnel utilisé à la place de `$HOME`       | `$HOME`                        |
| `CH_CONFIG_DIR` | Dossier de configuration                              | `<racine de travail>/_config`  |
| `CH_STATE_DIR`  | État de l'outil ; les sauvegardes vont dans `backups/` | `~/.local/state/claude-hub`    |

La racine de travail est le dossier `workspace` de `CH_HOME`. Si `CLAUDE_CONFIG_DIR` est défini, `ch audit` refuse de tourner : cette organisation n'est pas vérifiée.

## Développement

```bash
pnpm check:all   # typecheck + tests
pnpm coverage    # tests avec couverture
```

TypeScript strict, Vitest. Un hook `.githooks/pre-commit` lance `gitleaks` sur les fichiers indexés.

## Statut

Projet jeune, version `0.0.0`. `audit`, `ls`, `init`, `apply`, `move` et `open` sont disponibles. Les sauvegardes et restaurations (`backup`, `bootstrap`) et le nettoyage (`gc`) ne sont pas encore écrits.

## Licence

MIT, voir [`LICENSE`](LICENSE).
