# Comportement de Claude Code vérifié (jalon E0)

Date de vérification : 2026-11-07. Version observée localement : Claude Code 2.1.319.

Sources : documentation officielle `code.claude.com/docs` (lecture partielle, voir « Limites »), plus des observations locales en lecture seule.

Niveaux de confiance :
- **documenté** : énoncé explicite dans une page officielle.
- **déduit** : conclusion logique à partir de la doc, à confirmer par un test.
- **observé** : constaté sur le poste de référence, non garanti par la doc.
- **introuvable** : absent des parties lues.

Règle d'usage : tout comportement marqué « déduit » ou « observé » doit être figé par un test dans une arborescence jetable avant que `ch` en dépende.

## 1. Plugins : commandes et scopes

| Sujet | Constat | Confiance | Source |
|---|---|---|---|
| Sous-commandes | `init`, `install`, `uninstall` (alias `remove`, `rm`), `enable`, `disable` (`-a`), `update`, `list`, `details`, `configure`, `prune`, `eval`, `tag`, `test`, `validate` ; `marketplace add/list/remove/update` ; alias `claude plugins` | documenté | `/docs/en/plugins/cli-reference.md` (lancer `claude plugin --help` pour la version installée) |
| `--scope` | `user`, `project`, `local` ; `update` accepte aussi `managed` | documenté | idem |
| Scope par défaut | `install`, `uninstall`, `prune`, `marketplace add` = `user` ; `enable`/`disable` = auto-détecté (local, puis project, puis user) ; `update` = scope le plus spécifique | documenté | `cli-reference.md`, `install.md` |
| Fichiers écrits | user = `~/.claude/settings.json` ; project = `.claude/settings.json` ; local = `.claude/settings.local.json` ; état des marketplaces dans `~/.claude/plugins/known_marketplaces.json` | documenté | `install.md`, `loading.md` |
| Fusion de `enabledPlugins` | clé par clé ; priorité décroissante : managed > `--settings` > local > project > user ; `--add-dir` le plus faible ; un `false` managed bloque partout | documenté | `loading.md` |
| `install` en shell | peut déclarer la marketplace dans les réglages **user** même avec `--scope project` | documenté | `install.md` |
| `enabledPlugins` versionné | n'installe pas le plugin chez les autres : chacun doit lancer `claude plugin install <nom>@<marketplace> --scope project` | documenté | doc plugins |

## 2. Réglages managés

- Clés : `strictKnownMarketplaces` (alias `allowedMarketplaces`), `blockedMarketplaces`, `extraKnownMarketplaces`, `enabledPlugins`, `disableSideloadFlags`, `syncClaudeAiPlugins`, `strictPluginOnlyCustomization`, `pluginSuggestionMarketplaces` (documenté, `/docs/en/plugins/org.md`).
- `strictKnownMarketplaces = []` bloque toutes les sources, y compris la marketplace officielle (documenté).
- MCP : `allowedMcpServers`, `deniedMcpServers`, `managedMcpServers`, `managed-mcp.json` (documenté, `managed-settings.md`, `mcp.md`).
- Emplacement Linux/WSL : `/etc/claude-code/managed-settings.json` (documenté).
- `strictKnownMarketplaces` et `blockedMarketplaces` ne s'appliquent que depuis managed (documenté).
- Disponibilité : les réglages **serveur** exigent Teams ou Enterprise (documenté). Pour le fichier système, aucune condition de plan n'est citée, mais il faut les droits administrateur : utilisable à titre individuel, **déduit**.

## 3. Héritage depuis les dossiers parents

| Élément | Comportement | Confiance |
|---|---|---|
| `CLAUDE.md`, `CLAUDE.local.md` | chargés depuis le dossier de lancement **et tous ses parents**, sans limite au dépôt git | documenté (`memory.md`) |
| `.claude/skills/` | dossier de lancement et parents **jusqu'à la racine du dépôt** ; les skills de sous-dossiers ne se chargent qu'à la lecture d'un fichier de ce sous-dossier | documenté (`skills.md`) ; comportement hors dépôt git : introuvable |
| `.claude/settings.json`, hooks, autres clés | uniquement le `.claude/` du dossier de lancement, « no parent-directory fallback » | documenté (`permissions.md`) |
| `.claude/settings.local.json` | lu depuis la **racine du dépôt git**, même si on lance dans un sous-dossier | documenté (`permissions.md`) |
| `.claude/rules/` | comportement des parents non précisé | introuvable |
| « Racine du projet » | dossier de lancement tant que `/cd` n'est pas utilisé ; la racine git sert à `settings.local.json`, approbations, confiance, mémoire auto ; hors git, le dossier de lancement | documenté (`permissions.md`) |

À retenir : lancer Claude Code à la racine du projet pour que son `.claude/settings.json` soit lu.

## 4. Skills

- Emplacements lus : enterprise (managed), personnel `~/.claude/skills/`, projet `.claude/skills/`, imbriqués, `--add-dir`, plugins, skills synchronisés du compte claude.ai (documenté). Priorité en cas de conflit : enterprise > personnel > projet.
- `~/.agents/skills` et `.agents/skills` : **introuvable** dans les parties lues. Observé localement : seuls les skills de `~/.agents` pointés par un symlink depuis `~/.claude/skills` sont visibles de Claude ; le reste est inerte.
- `skillOverrides` : valeurs `on` (défaut), `name-only`, `user-invocable-only`, `off` ; ne peut que restreindre ; **ne concerne pas** les skills de plugin (désactiver le plugin via `enabledPlugins`). Précédence entre scopes : non documentée (documenté, `skills.md`).
- Synchronisation du compte : `syncClaudeAiPlugins` et `syncClaudeAiSkills` à `false` la coupent (documenté).

## 5. Règles `.claude/rules/` et `~/.claude/rules/`

- Projet : tous les `.md`, récursivement ; personnel : `~/.claude/rules/` pour tous les projets (documenté).
- Sans `paths:` : chargé au lancement.
- Avec `paths:` (liste de globs) : chargé quand `Read`, `Write` ou `Edit` touche un fichier correspondant, ou quand Bash lit un fichier correspondant (documenté).
- Symlink vers l'extérieur du dossier de travail : approbation demandée, sauf dans `~/.claude/rules/` (documenté). Conséquence : des symlinks vers `_config/global/rules/` sont acceptables.
- Limites : `claudeMdExcludes` peut exclure ; un `CLAUDE.md` de plus de 4 MiB n'est pas chargé ; les règles sont ignorées si `project` est exclu de `--setting-sources` (documenté).

## 6. Options de lancement

- Binaire : `claude` (documenté ; observé : `~/.local/bin/claude`).
- `--add-dir` : accès aux fichiers, **pas** une racine de configuration. Chargés depuis ce dossier : skills, commandes, subagents, et dans les réglages seulement `enabledPlugins` et `extraKnownMarketplaces`. `CLAUDE.md`, `rules/` et `CLAUDE.local.md` seulement avec `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. Hooks et permissions non chargés (documenté).
- `--settings <fichier|json>` : surcharge de session, au-dessus de user/project/local, sous managed ; fichier de 2 MiB maximum (documenté).
- `--setting-sources user,project,local` (documenté).
- `--plugin-dir` (répétable, session seulement) ; `--plugin-url` (documenté).
- `--mcp-config` et `--strict-mcp-config` (documenté).
- `--permission-mode` : `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, `manual` (documenté).
- Désactiver pour une session : `--disable-slash-commands` (skills et commandes) ; `--safe-mode` (CLAUDE.md, skills, plugins, hooks, MCP, commandes, mémoire auto) ; `--bare` ; un plugin précis via `--settings '{"enabledPlugins":{"<nom>@<marketplace>":false}}'` (déduit).

## 7. Stockage

| Élément | Constat | Confiance |
|---|---|---|
| `~/.claude.json` | compte, configuration MCP, état par projet (confiance…), clés de `/config` ; `projects` indexé par **chemin absolu** | documenté (`settings.md`, `claude-directory.md`, `sessions.md`) ; observé : 14 entrées, chemin réel en clé (non encodé), champs dont `allowedTools`, `hasTrustDialogAccepted`, `mcpServers` |
| `~/.claude/projects/<clé>/` | transcriptions `.jsonl`, `memory/`, `subagents/`, `tool-results/` | documenté ; observé : 8 dossiers, tous avec `memory/` |
| Encodage de la clé (transcriptions) | tout caractère non alphanumérique remplacé par `-` ; au-delà de 200 caractères, troncature et hash du chemin complet ; définition exacte d'« alphanumérique » non documentée | documenté (`sessions.md`) ; observé : `CLAUDE_CODE` → `CLAUDE-CODE` |
| Clé de la mémoire auto | « derived from the git repository » ; règle d'encodage non documentée ; observé : le dossier `memory/` se trouve dans le dossier de clé du même chemin | documenté (partiel) / observé |
| `installed_plugins.json`, `known_marketplaces.json` | champs documentés (scope, installPath, version ; source, installLocation, lastUpdated, autoUpdate) ; structure complète non documentée ; observé : `installed_plugins.json` version 2, `scope`, `installPath`, `version`, `gitCommitSha`, et `projectPath` pour le scope local | documenté (partiel) / observé |
| `CLAUDE_CONFIG_DIR` | remplace `~/.claude` et `~/.claude.json` ; ne peut pas être défini dans les réglages projet ou local ; `CLAUDE_CODE_PLUGIN_CACHE_DIR` change le cache des plugins | documenté (`claude-directory.md`, `env-vars.md`, `loading.md`) ; observé : non défini |

## 8. Mémoire auto

- Dossier : `~/.claude/projects/<projet>/memory/` ; `MEMORY.md` est l'index, avec ses 200 premières lignes ou 25 Ko chargées (documenté).
- Rattachement : dérivé du dépôt git ; worktrees et sous-dossiers d'un même dépôt partagent le même dossier (documenté). Hors dépôt git, la racine du projet sert.
- **Déplacement ou renommage du projet : non documenté, testé (§17, observé).** La clé suit le chemin, y compris pour un dépôt git avec remote : après un `mv`, la mémoire n'est pas reprise. Renommer le dossier de clé après le déplacement la restitue ; fixer `autoMemoryDirectory` la conserve aussi.
- Réglages : `autoMemoryDirectory` (lu depuis user, project, local, managed ou `--settings`), `autoMemoryEnabled`, variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (documenté). Note : `autoMemoryDirectory` peut venir d'un fichier projet versionné.
- Piste à évaluer pour `ch move` : fixer `autoMemoryDirectory` plutôt que renommer des dossiers (non vérifié, à étudier).

## 9. Hooks

- `SessionStart` : le stdout brut est ajouté au **contexte de Claude**, pas affiché à l'utilisateur ; le code de sortie 2 affiche le stderr à l'utilisateur seulement. Pour un message visible : champ `systemMessage` du JSON de sortie (documenté ; rendu exact au démarrage : déduit, à vérifier).
- `PreToolUse` : `"matcher": "Bash"` (correspondance exacte pour lettres, chiffres, `_`, `-`, espaces, virgules, `|` ; tout autre caractère donne une regex JavaScript non ancrée ; vide ou `*` = tout). Sortie : `hookSpecificOutput` avec `permissionDecision` parmi `allow`, `deny`, `ask`, `defer` (`defer` seulement en `-p`) ; priorité `deny` > `defer` > `ask` > `allow` ; champs `decision` et `reason` de premier niveau dépréciés (documenté, `hooks.md`).

## 10. Permissions

- Règles fichiers : `Read(./.env)`, `Read(./.env.*)`, `Read(./secrets/**)` (documenté). Motifs de type gitignore : `//chemin absolu`, `~/chemin`, `/chemin` relatif à la source des réglages, `./chemin`.
- Couverture de `Read(...)` : `Read`, `Grep` et `Glob` (au mieux), `@fichier` dans le prompt, `Edit` et `Write`, commandes Bash reconnues (`cat`, `head`, `tail`, `sed`, `tee`) et redirections. Non couvert : `grep -r` lancé dans le dossier, scripts qui ouvrent eux-mêmes les fichiers. Blocage au niveau OS : sandbox. Les règles `Grep(path)` et `Glob(path)` ne correspondent à rien. `.claudeignore` n'a aucun effet (documenté, `permissions.md`).
- Bash : `Bash(git push *)` ; l'espace avant `*` est requis ; la règle porte sur le texte tapé par Claude, donc `git -C . push` ou `/usr/bin/curl` y échappent : **pas une frontière de sécurité** (documenté).
- Ordre : `deny`, puis `ask`, puis `allow` ; un `deny` utilisateur bloque un `allow` projet (documenté).
- Mode `auto` : documenté (`permission-modes.md`, `auto-mode-config.md`) ; `permissions.disableAutoMode` le désactive.
- `autoMode.environment` : prose lue par le classificateur ; `"$defaults"` conserve les valeurs par défaut ; **lu seulement depuis `~/.claude/settings.json`, managed ou `--settings`, jamais depuis `.claude/settings.json` ni `.claude/settings.local.json`** ; sous-commandes `claude auto-mode defaults | config | critique | reset` (documenté).

## 11. Connecteurs claude.ai

- Global : `"disableClaudeAiConnectors": true` dans un fichier de réglages (documenté pour ce nom de clé ; usage dans n'importe quel fichier : déduit, à tester). Variable : `ENABLE_CLAUDEAI_MCP_SERVERS=false` (documenté, `mcp.md`).
- Par projet : `/mcp` puis toggle ; enregistré dans `disabledMcpServers` de `~/.claude.json` sous le nom affiché (documenté).
- Un connecteur précis : `deniedMcpServers` (managed), par nom ou motif d'URL (documenté).
- Plugins et skills synchronisés : `syncClaudeAiPlugins`, `syncClaudeAiSkills` (documenté).
- Effet de `--strict-mcp-config` sur les connecteurs claude.ai : non documenté.

## 12. Worktrees, déplacement, plugins locaux

- Partagé avec le checkout principal : dossier `.git`, plugins du scope project, approbations « don't ask again » (dans `.claude/settings.local.json` du checkout principal), mémoire auto (documenté, `worktrees.md`).
- Dépôt copié ou déplacé : erreurs possibles « belongs to a different repository » ou « is a leftover worktree » (documenté).
- Marketplace locale (`directory` ou `file`) : `installLocation` garde le chemin donné ; **déplacer le dossier casse la marketplace** (documenté, `loading.md`). À gérer dans `ch move` si un projet sert de marketplace (`sandbox/ecc` ?).
- `--plugin-dir` : le chemin doit être redonné à chaque lancement ou reprise (documenté).
- Après un déplacement physique, l'état par chemin (`~/.claude.json`, transcriptions) ne suit pas automatiquement ; `/cd` relocalise la transcription (documenté) ; le cas du déplacement physique est déduit.

## 13. Hypothèses du plan : verdict

| Hypothèse | Verdict |
|---|---|
| (a) `claude plugin install` installe en scope `user` par défaut | confirmée (avec nuances : `enable`/`disable` auto-détectent le scope ; `marketplace add` = user) |
| (b) un `.claude/settings.json` de dossier parent n'est pas lu | confirmée, la règle tient à l'emplacement (versionné ou non) ; mais `CLAUDE.md` et skills des parents **sont** chargés ; `settings.local.json` est lu depuis la racine git |
| (c) clé de projet : `/` et `_` remplacés par `-` | incomplète : **tout** caractère non alphanumérique ; troncature à 200 caractères avec hash ; clé de la mémoire dérivée du dépôt git, règle non documentée |

## 14. Surprises à intégrer au plan

1. `autoMode.environment` n'est lu que depuis les réglages utilisateur (ou managed) : il ne peut pas vivre dans le projet.
2. `enabledPlugins` versionné n'installe rien : `ch apply` doit lancer `claude plugin install --scope project`.
3. `--add-dir` ne charge ni hooks, ni permissions, ni `CLAUDE.md` (sauf variable d'environnement).
4. `.claudeignore` est sans effet ; les règles `deny` `Read(...)` ne sont pas une frontière de sécurité.
5. Le stdout d'un hook `SessionStart` va dans le contexte de Claude ; pour alerter l'utilisateur, utiliser `systemMessage`.
6. Les skills de plugin ne sont pas concernés par `skillOverrides`.
7. `autoMemoryDirectory` peut être lu depuis les réglages projet (risque si un fichier versionné le modifie).
8. Des plugins et skills peuvent venir du compte claude.ai (`synced`), coupables via `syncClaudeAiPlugins` et `syncClaudeAiSkills`.

## 15. Reste à tester

Les tests des §17 couvrent l'encodage de clé, la mémoire après déplacement, `settings.local.json`, l'héritage de skills et de `CLAUDE.md`, `.agents/skills`, `disableClaudeAiConnectors` et l'émission des hooks. Il reste :

- Rendu **interactif** d'un `systemMessage` de hook `SessionStart` (non visible en mode `-p`).
- Interaction entre `disableClaudeAiConnectors` projet et le toggle `/mcp`.
- `claude plugin --help`, `enable` et `disable` sur la version installée (2.1.319), avant que `ch apply` ne les appelle.
- `autoMemoryDirectory` posé dans `settings.local.json` (testé seulement dans `settings.json` de projet).
- Algorithme du hash de troncature des clés de plus de 200 caractères (contourné par une règle de chemins courts).
- Caractères hors du plan de base Unicode (emoji) dans un chemin.
- Entrées de `~/.claude.json` : mise à jour à faire à la main lors d'un déplacement (la confiance accordée au dossier suit-elle ?).

## 16. Limites de la vérification

Pages non lues ou partiellement lues : `managed-mcp.md`, `marketplace-reference.md`, `env-vars.md` (liste complète), détails de `settings-reference.md` (précédence de `skillOverrides`, `autoMemoryDirectory`), fin de `hooks.md` et de `skills.md`. Index complet : `https://code.claude.com/docs/llms.txt`.

## 17. Tests d'observation (E0b, 2026-11-07, Claude Code 2.1.319)

Méthode : sessions `claude -p` (modèle haiku, outils limités) lancées dans des dossiers jetables sous le scratchpad de la session, puis supprimés. Les réponses sur le contenu du contexte (skills visibles, mémoire connue) sont **rapportées par le modèle**, les chemins et fichiers créés sont vérifiés sur disque. Statut : **observé**.

| Test | Résultat |
|---|---|
| Encodage de la clé de `~/.claude/projects` | `/tmp/.../a b.c-é_d` → `-tmp-...-a-b-c---d` : espace, point, tiret, `é` et `_` donnent **un** `-` chacun (par caractère, pas par octet) ; `/-` initial donne `--` |
| Clé de plus de 200 caractères | clé de 207 caractères : 200 premiers caractères du chemin encodé, puis `-`, puis un hash de 6 caractères (ex. `1opm9g`) ; algorithme non déterminé |
| Mémoire auto : dépôt git sans remote, puis déplacé | dossier mémoire créé sous la clé du **chemin** ; après `mv`, nouvelle clé, mémoire non reprise (réponse « INCONNUE ») |
| Mémoire auto : dossier non git, puis déplacé | idem |
| Mémoire auto : dépôt git **avec** remote, puis déplacé | idem : la clé suit le chemin, pas le remote |
| `autoMemoryDirectory` absolu dans `.claude/settings.json` du projet, projet déplacé | mémoire écrite dans le dossier fixé ; après déplacement, couleur retrouvée (« Violet ») |
| Déplacement puis renommage du dossier de clé (stratégie de `ch move`) | mémoire retrouvée (« violet ») avec la nouvelle clé |
| `settings.json` / `settings.local.json` depuis un sous-dossier d'un dépôt git | `settings.local.json` lu (`E0_L=local`), `settings.json` **non** lu (`E0_P` vide) ; depuis la racine, les deux sont lus |
| Skills d'un dossier parent, projet **hors** git | skills du parent **chargés** (`e0-parent-skill`) en plus de ceux du projet |
| Skills d'un dossier parent, projet qui est un dépôt git | skills du parent **non chargés** (liste vide) : limite à la racine git |
| `CLAUDE.md` d'un dossier parent | chargé dans les deux cas, y compris au-delà de la racine git |
| `.agents/skills/` au niveau du projet | **non lu** (skill absent de la liste) |
| `disableClaudeAiConnectors: true` dans `.claude/settings.json` du projet | connecteur Gmail visible sans le réglage (OUI), invisible avec (NON) |
| `disableClaudeAiConnectors: true` dans `~/.claude/settings.json`, puis `false` dans `.claude/settings.json` ou `settings.local.json` du projet, ou `ENABLE_CLAUDEAI_MCP_SERVERS=true` | connecteurs toujours absents : le réglage utilisateur l'emporte (`claude mcp list`) |
| `disableClaudeAiConnectors: false` au niveau utilisateur, `true` dans le projet | connecteurs absents dans le projet : la désactivation par projet fonctionne |
| Serveur HTTP déclaré avec `claude mcp add --scope project` alors que les connecteurs sont coupés | serveur visible dans le projet, « Pending approval » jusqu'à l'approbation dans `claude` (authentification non testée) |
| Hook `SessionStart` en `-p` avec `stream-json` et `--include-hook-events` | les deux sorties (JSON `systemMessage` et texte brut) arrivent comme événements `hook_response` ; le rendu à l'utilisateur en mode interactif n'est pas observable en `-p` |

Note annexe : en mode `-p`, un avertissement indique que la connexion du compte expire entre le 2026-11-12 et le 2026-11-15 (relancer `claude auth login`).

Conséquences pour `ch` :
1. `ch move` : après le `mv`, renommer `~/.claude/projects/<ancienne clé>` en `<nouvelle clé>` suffit pour conserver mémoire et historique. La clé se calcule en remplaçant chaque caractère non alphanumérique ASCII par `-` (pour les chemins de moins de 200 caractères encodés).
2. Politique : les chemins de projet doivent rester assez courts pour que la clé tienne sous 200 caractères ; `ch audit` signale tout dépassement. Cela évite de dépendre du hash de troncature.
3. `autoMemoryDirectory` est une alternative (mémoire stockée à un emplacement choisi, plus simple à sauvegarder), mais exige un chemin absolu propre à la machine : à poser dans `settings.local.json`, jamais dans un fichier versionné. Décision reportée.
4. Parents hors git : leurs skills et `CLAUDE.md` descendent dans les projets non git ; seul le `CLAUDE.md` descend dans les dépôts git. Le dossier parent `CLAUDE_CODE/` est donc concerné pour ses projets non git.

### 17 bis. Plugins et skills synchronisés depuis le compte claude.ai (observé, 2026-11-07)

- `claude plugin list --json` renvoie, en plus des plugins de `installed_plugins.json`, des entrées de scope **`synced`** (ex. `grafana-mcp@synced`, `instagram-skills@synced`, `linkedin-skills@synced`, `social-media-skills@synced`). Elles ne figurent pas dans `installed_plugins.json` : un audit qui ne lit que ce fichier ne les voit pas.
- Sur disque : `~/.claude/plugins/synced/<compte>/` (un `<id>.meta.json` et un dossier par plugin, plus `manifest.json`) et `~/.claude/skills/synced/<compte>/` (un dossier par skill, plus `manifest.json`).
- Ils se chargent dans **tous** les projets tant que la synchronisation n'est pas coupée.
- Test : une session `claude -p` voit les skills `instagram`, `pdf` et `linkedin` sans réglage ; avec `--settings '{"syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}'` elle n'en voit plus aucun. Les deux clés sont documentées (`settings-reference.md`, `loading.md`).
- Forme de `claude plugin list --json` : tableau d'objets `{ id, scope, enabled, projectEnabled, installPath, version, installedAt, lastUpdated }`.
- `claude plugin install <plugin>[@<marketplace>] [-s user|project|local] [-y] [--json]` : `-y` est obligatoire hors terminal ; `--marketplace <source>` ajoute la marketplace **dans les réglages user** si elle n'existe pas encore. `claude plugin enable|disable [-s <scope>] [--json]` détecte le scope par défaut.

### 17 ter. `claude plugin install --scope project` : dossier d'écriture et effets de bord (observé, 2026-11-07)

- Lancé depuis un **sous-dossier** d'un dépôt git, il écrit `.claude/settings.json` dans ce sous-dossier (pas à la racine git) et enregistre ce sous-dossier comme `projectPath`.
- Réinstaller un plugin déjà installé au même scope répond « already installed » avec le code 0 et `outcome: "ok"`.
- Il installe la version courante de la marketplace dans le cache (`plugins/cache/<marketplace>/<plugin>/<version>`), qui peut différer de la version installée au scope user, et met à jour la date `lastUpdated` de la marketplace dans `known_marketplaces.json`.
- `claude plugin uninstall <id> --scope project` retire l'entrée de `installed_plugins.json` et laisse `enabledPlugins: {}` dans le `settings.json` du projet, mais **ne supprime pas** le dossier de cache de la version installée.
- Sans `-y`, l'installation d'un plugin sans commande déclarée aboutit en non interactif ; `-y` est requis hors terminal seulement quand la marketplace déclare une commande, qu'il faut alors accepter explicitement.
