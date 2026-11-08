import { join } from "node:path";

import type { MovePlan } from "../../src/core/move-plan.js";
import { projectKey } from "../../src/core/project-key.js";
import { testEnv } from "./env.js";
import type { FakeHome } from "./fake-home.js";

const key = (path: string): string => projectKey(path).key;

export interface MoveFixture {
  readonly plan: MovePlan;
  readonly source: string;
  readonly destination: string;
  readonly claudeJson: string;
  readonly registry: string;
  readonly projectsDir: string;
  readonly originalClaudeJson: string;
  readonly originalRegistry: string;
}

/** Un projet `site` sous la racine de travail, avec historique, ~/.claude.json, registre et dossier d'état. */
export function createMoveFixture(fake: FakeHome): MoveFixture {
  const source = fake.makeDir("ws/site");
  fake.writeFile("ws/site/file.txt", "content");
  fake.makeDir("ws/site/sub/deeper");
  const destination = join(fake.home, "ws/perso/site");
  const projectsDir = join(fake.home, ".claude/projects");
  fake.writeFile(`.claude/projects/${key(source)}/memory/MEMORY.md`, "memory");
  fake.writeFile(`.claude/projects/${key(join(source, "sub/deeper"))}/session.jsonl`, "{}");
  const originalClaudeJson = JSON.stringify(
    { userID: "u", projects: { [source]: { allowedTools: [], n: 1 }, "/other": {} } },
    null,
    2
  );
  const claudeJson = fake.writeFile(".claude.json", originalClaudeJson);
  const originalRegistry = `# registre\nprojects:\n  - { name: site, path: site, profile: base } # le site\n`;
  const registry = fake.writeFile("config/projects.yaml", originalRegistry);
  fake.makeDir("state");

  const plan: MovePlan = {
    project: { name: "site", path: source, profile: "base" },
    source,
    destination,
    oldKey: key(source),
    newKey: key(destination),
    subfolderKeys: [{ from: key(join(source, "sub/deeper")), to: key(join(destination, "sub/deeper")) }],
    projectsDir,
    claudeJsonPath: claudeJson,
    registryPath: registry,
    workspaceRoot: join(fake.home, "ws"),
    newRegistryPath: "perso/site",
    backupDir: join(fake.home, "state/backups"),
  };
  return { plan, source, destination, claudeJson, registry, projectsDir, originalClaudeJson, originalRegistry };
}

export { testEnv };
