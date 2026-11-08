# CLAUDE.md

`ch` : CLI TypeScript qui audite et organise la configuration de Claude Code d'un poste (plugins, projets, profils). Voir `README.md`.

## Commandes

- `pnpm check:all` : typecheck et tests ; `pnpm test:run` : Vitest une fois ; `pnpm ch <commande>` : lance les sources avec `tsx`.
- Test seul : `pnpm vitest run tests/<fichier>.test.ts`.

## Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) : pas de `any` ni de `@ts-expect-error` pour faire passer un contrôle.
- Les commandes passent par `Env`, `Io` et `Runtime` (injectés) : pas d'accès direct à `process` ni au disque réel dans les tests, utiliser les helpers de `tests/helpers/`.
- Toute commande qui écrit propose `--dry-run` et sauvegarde ce qu'elle modifie avant.
- Un comportement de Claude Code n'est supposé que s'il est documenté dans `docs/claude-behavior.md` et figé par un test.

## Dépôt public

Aucun chemin personnel, nom de client, secret ni configuration d'utilisateur dans les fichiers versionnés, exemples et tests compris (utiliser `/home/user/...`). Les plans de travail vont dans `docs/ai/`, ignoré par git. Hook `.githooks/pre-commit` : `gitleaks` sur les fichiers indexés.
