import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ClaudeProcess, Env } from "../src/core/env.js";
import { planMove, type MovePlanResult } from "../src/core/move-plan.js";
import { projectKey } from "../src/core/project-key.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const key = (path: string): string => projectKey(path).key;
const isRoot = process.getuid?.() === 0;

describe("planMove", () => {
  let fake: FakeHome;
  let env: Env;
  let source: string;
  let destination: string;

  const plan = (query = "site", destinationArg = "perso/site", processes: readonly ClaudeProcess[] = []): MovePlanResult =>
    planMove(env, processes, query, destinationArg);
  const problemsOf = (result: MovePlanResult): readonly string[] => (result.kind === "refused" ? result.problems : []);
  const warningsOf = (result: MovePlanResult): readonly string[] => (result.kind === "ok" ? result.warnings : []);

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    source = fake.makeDir("ws/site");
    destination = join(fake.home, "ws/perso/site");
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: base }\n");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("builds the plan: keys, registry path relative to the workspace root, backup folder", () => {
    const result = plan();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.plan).toMatchObject({
      source,
      destination,
      oldKey: key(source),
      newKey: key(destination),
      newRegistryPath: "perso/site",
      newName: "site",
      projectsDir: join(fake.home, ".claude/projects"),
      claudeJsonPath: join(fake.home, ".claude.json"),
      registryPath: join(fake.home, "config/projects.yaml"),
      backupDir: join(fake.home, "state/backups"),
      subfolderKeys: [],
    });
  });

  test("accepts an absolute destination under the workspace root", () => {
    expect(plan("site", destination).kind).toBe("ok");
  });

  test("finds the history of sub-folders that really exist, and ignores unrelated keys", () => {
    fake.makeDir("ws/site/sub/deeper");
    fake.makeDir(`.claude/projects/${key(join(source, "sub/deeper"))}`);
    fake.makeDir(`.claude/projects/${key(source)}-ghost`);
    fake.makeDir(`.claude/projects/${key(source)}-nothing-here`);

    const result = plan();

    expect(result.kind === "ok" ? result.plan.subfolderKeys : []).toEqual([
      { from: key(join(source, "sub/deeper")), to: key(join(destination, "sub/deeper")) },
    ]);
  });

  test("reports an unknown project as a usage error, and never resolves a prefix", () => {
    expect(plan("ghost").kind).toBe("usage");
    expect(plan("si").kind).toBe("usage");
  });

  test("collects every problem at once instead of stopping at the first", () => {
    fake.makeDir("ws/perso/site");

    const problems = problemsOf(plan("site", "perso/site", [{ pid: 7, cwd: source, ancestor: false }]));

    expect(problems.some((problem) => problem.includes("existe déjà"))).toBe(true);
    expect(problems.some((problem) => problem.includes("7"))).toBe(true);
  });

  test.each([
    ["outside the workspace root", () => "/elsewhere/site"],
    ["the workspace root itself", () => "."],
    ["a path that climbs out of the root", () => "../escape"],
  ])("refuses a destination that is %s", (_label, pick) => {
    expect(problemsOf(plan("site", pick())).some((problem) => problem.includes("racine de travail"))).toBe(true);
  });

  test("refuses a destination that already exists, or that is the source itself", () => {
    fake.makeDir("ws/perso/site");

    expect(problemsOf(plan()).some((problem) => problem.includes("existe déjà"))).toBe(true);
    expect(problemsOf(plan("site", "site")).some((problem) => problem.includes("déjà"))).toBe(true);
  });

  test("refuses a destination inside the source", () => {
    expect(problemsOf(plan("site", "site/inner")).some((problem) => problem.includes("dans le projet"))).toBe(true);
  });

  test("refuses a source that is missing, a symbolic link or not a folder", () => {
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: base }\n");
    expect(problemsOf(plan()).some((problem) => problem.includes("introuvable"))).toBe(true);

    const real = fake.makeDir("real");
    fake.makeDir("ws");
    symlinkSync(real, join(fake.home, "ws/site"));
    expect(problemsOf(plan()).some((problem) => problem.includes("lien symbolique"))).toBe(true);
  });

  test("refuses a destination whose existing parent is a symbolic link", () => {
    const outside = fake.makeDir("outside");
    symlinkSync(outside, join(fake.home, "ws/perso"));

    expect(problemsOf(plan()).some((problem) => problem.includes("lien symbolique"))).toBe(true);
  });

  test.skipIf(isRoot)("refuses a destination whose parent cannot be written to", () => {
    fake.makeDir("ws/perso");
    chmodSync(join(fake.home, "ws/perso"), 0o555);

    try {
      expect(problemsOf(plan()).some((problem) => problem.includes("inscriptible"))).toBe(true);
    } finally {
      chmodSync(join(fake.home, "ws/perso"), 0o755);
    }
  });

  test("refuses when the history key of the destination already exists", () => {
    fake.makeDir(`.claude/projects/${key(destination)}`);

    expect(problemsOf(plan()).some((problem) => problem.includes("historique"))).toBe(true);
  });

  test("refuses a path whose Claude key cannot be computed reliably", () => {
    env = testEnv(fake, { workspaceRoot: `${fake.home}/ws` });

    const problems = problemsOf(plan("site", `perso/${"x".repeat(250)}`));

    expect(problems.some((problem) => problem.includes("clé"))).toBe(true);
  });

  test("refuses while CLAUDE_CONFIG_DIR is set", () => {
    env = testEnv(fake, { claudeConfigDir: "/cfg" });

    expect(problemsOf(plan()).some((problem) => problem.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
  });

  describe("registry and state inside the project", () => {
    test("refuses to move the folder that holds the registry, which would be left pointing nowhere", () => {
      env = testEnv(fake, { configDir: join(source, "cfg") });
      fake.writeFile("ws/site/cfg/projects.yaml", `projects:\n  - { name: site, path: ${source}, profile: base }\n`);

      expect(problemsOf(plan()).some((problem) => problem.includes("registre"))).toBe(true);
    });

    test("refuses to move the folder that holds the state folder", () => {
      env = testEnv(fake, { stateDir: join(source, "state") });

      expect(problemsOf(plan()).some((problem) => problem.includes("état"))).toBe(true);
    });
  });

  describe("registry that cannot be rewritten", () => {
    test("refuses a registry that is a symbolic link, which the move would silently leave stale", () => {
      const real = fake.writeFile("dotfiles/projects.yaml", "projects:\n  - { name: site, path: site, profile: base }\n");
      rmSync(join(fake.home, "config/projects.yaml"));
      symlinkSync(real, join(fake.home, "config/projects.yaml"));

      expect(problemsOf(plan()).some((problem) => problem.includes("registre"))).toBe(true);
    });
  });

  describe("projects registered inside or around the moved one", () => {
    test("refuses a project that contains another registered project, which would be left with a stale path", () => {
      fake.makeDir("ws/site/admin");
      fake.writeFile(
        "config/projects.yaml",
        `projects:\n  - { name: site, path: site, profile: base }\n  - { name: admin, path: ${join(source, "admin")}, profile: base }\n`
      );

      const problems = problemsOf(plan());

      expect(problems.some((problem) => problem.includes("admin") && problem.includes("dans ce projet"))).toBe(true);
    });

    test("refuses a destination that lies inside another registered project", () => {
      fake.makeDir("ws/other");
      fake.writeFile(
        "config/projects.yaml",
        "projects:\n  - { name: site, path: site, profile: base }\n  - { name: other, path: other, profile: base }\n"
      );

      expect(problemsOf(plan("site", "other/site")).some((problem) => problem.includes("other"))).toBe(true);
    });

    test("refuses a destination inside the configuration or the state folder", () => {
      expect(problemsOf(plan("site", join(fake.home, "config/site"))).length).toBeGreaterThan(0);
    });

    test("refuses a destination whose Claude key is the key of a neighbouring project that has no history yet", () => {
      fake.makeDir("ws/perso/a.b");
      fake.writeFile(
        "config/projects.yaml",
        "projects:\n  - { name: site, path: site, profile: base }\n  - { name: dotted, path: perso/a.b, profile: base }\n"
      );

      const problems = problemsOf(plan("site", "perso/a-b"));

      expect(problems.some((problem) => problem.includes("dotted"))).toBe(true);
    });
  });

  describe("history that will not follow", () => {
    test("warns about history folders that look like deeper sub-folders and will not be renamed", () => {
      fake.makeDir(`.claude/projects/${key(source)}-very-deep-nested-folder`);

      const warnings = warningsOf(plan()).join(" ");

      expect(warnings).toContain("très profond");
      expect(warnings).toContain("1");
    });

    test("does not warn about history it does rename", () => {
      fake.makeDir("ws/site/admin");
      fake.makeDir(`.claude/projects/${key(join(source, "admin"))}`);

      expect(warningsOf(plan()).join(" ")).not.toContain("très profond");
    });
  });

  describe("history keys shared with another project", () => {
    const registerNeighbour = (name: string, path: string) =>
      fake.writeFile(
        "config/projects.yaml",
        `projects:\n  - { name: site, path: site, profile: base }\n  - { name: ${name}, path: ${path}, profile: base }\n`
      );

    test("refuses a sub-folder whose history key is also the key of a neighbouring registered project", () => {
      fake.makeDir("ws/site/admin");
      fake.makeDir("ws/site-admin");
      registerNeighbour("site-admin", "site-admin");
      fake.makeDir(`.claude/projects/${key(join(fake.home, "ws/site-admin"))}`);

      const problems = problemsOf(plan());

      expect(problems.some((problem) => problem.includes("site-admin"))).toBe(true);
    });

    test("refuses when the project's own key is shared with another registered project", () => {
      fake.cleanup();
      fake = createFakeHome();
      env = testEnv(fake);
      fake.makeDir("ws/a.b");
      fake.makeDir("ws/a-b");
      fake.writeFile(
        "config/projects.yaml",
        "projects:\n  - { name: dotted, path: a.b, profile: base }\n  - { name: dashed, path: a-b, profile: base }\n"
      );

      const result = plan("dotted", "perso/dotted");

      expect(problemsOf(result).some((problem) => problem.includes("dashed"))).toBe(true);
    });

    test("refuses a sub-folder whose key is the key of another project known to ~/.claude.json", () => {
      fake.makeDir("ws/site/admin");
      fake.makeDir(`.claude/projects/${key(join(fake.home, "ws/site-admin"))}`);
      fake.writeFile(".claude.json", JSON.stringify({ projects: { [join(fake.home, "ws/site-admin")]: {} } }, null, 2));

      expect(problemsOf(plan()).some((problem) => problem.includes("claude.json"))).toBe(true);
    });

    test("still accepts a sub-folder whose key is unique", () => {
      fake.makeDir("ws/site/admin");
      fake.makeDir(`.claude/projects/${key(join(source, "admin"))}`);

      expect(plan().kind).toBe("ok");
    });
  });

  describe("paths that are not canonical", () => {
    test("refuses a project whose registered path goes through a symbolic link, because Claude may key its history on the real path", () => {
      fake.cleanup();
      fake = createFakeHome();
      env = testEnv(fake);
      fake.makeDir("real/site");
      fake.symlink("link", "real");
      fake.writeFile("config/projects.yaml", `projects:\n  - { name: site, path: ${join(fake.home, "link/site")}, profile: base }\n`);

      expect(problemsOf(plan()).some((problem) => problem.includes("lien symbolique"))).toBe(true);
    });
  });

  describe("destination checks", () => {
    test("refuses a destination whose nearest existing parent is a file", () => {
      fake.writeFile("ws/perso", "a file");

      expect(problemsOf(plan()).some((problem) => problem.includes("pas un dossier"))).toBe(true);
    });

    test.skipIf(isRoot)("refuses a project whose own folder cannot be removed from its parent", () => {
      chmodSync(join(fake.home, "ws"), 0o555);

      try {
        expect(problemsOf(plan()).some((problem) => problem.includes("inscriptible"))).toBe(true);
      } finally {
        chmodSync(join(fake.home, "ws"), 0o755);
      }
    });

    test.skipIf(isRoot)("refuses a project folder that cannot itself be written to, which a move to another parent needs", () => {
      chmodSync(source, 0o555);

      try {
        expect(problemsOf(plan()).some((problem) => problem.includes("inscriptible"))).toBe(true);
      } finally {
        chmodSync(source, 0o755);
      }
    });

    test("refuses two paths that give the same Claude key, since nothing would be renamed", () => {
      fake.cleanup();
      fake = createFakeHome();
      env = testEnv(fake);
      fake.makeDir("ws/a.b");
      fake.writeFile("config/projects.yaml", "projects:\n  - { name: dotted, path: a.b, profile: base }\n");

      expect(problemsOf(plan("dotted", "a-b")).some((problem) => problem.includes("même clé"))).toBe(true);
    });

    test("tells whether there is a history folder to rename", () => {
      fake.makeDir(`.claude/projects/${key(source)}`);

      const withHistory = plan();
      fake.cleanup();
      fake = createFakeHome();
      env = testEnv(fake);
      fake.makeDir("ws/site");
      fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: base }\n");
      const without = plan();

      expect(withHistory.kind === "ok" && withHistory.historyPresent).toBe(true);
      expect(without.kind === "ok" && without.historyPresent).toBe(false);
    });
  });

  describe("Claude sessions", () => {
    test("treats a session whose folder cannot be read as a refusal: it may well be in the project", () => {
      const problems = problemsOf(plan("site", "perso/site", [{ pid: 55, cwd: undefined, ancestor: false }]));

      expect(problems.join(" ")).toContain("55");
      expect(problems.join(" ")).toContain("illisible");
    });

    test("tells that the session which runs ch is the one to quit, and how to proceed", () => {
      const problems = problemsOf(plan("site", "perso/site", [{ pid: 66, cwd: source, ancestor: true }]));

      expect(problems.join(" ")).toContain("terminal");
      expect(problems.join(" ")).toContain("66");
    });

    test("warns that the session which runs ch, when it is elsewhere, will rewrite ~/.claude.json", () => {
      const result = plan("site", "perso/site", [{ pid: 77, cwd: "/elsewhere", ancestor: true }]);

      expect(result.kind).toBe("ok");
      expect(warningsOf(result).join(" ")).toContain("cette session");
    });


    test("refuses while a session runs in the project or in one of its sub-folders", () => {
      const inside = problemsOf(plan("site", "perso/site", [{ pid: 1, cwd: source, ancestor: false }]));
      const nested = problemsOf(plan("site", "perso/site", [{ pid: 2, cwd: join(source, "sub"), ancestor: false }]));

      expect(inside.join(" ")).toContain("1");
      expect(nested.join(" ")).toContain("2");
    });

    test("does not mistake a sibling folder that shares the name prefix for the project", () => {
      expect(plan("site", "perso/site", [{ pid: 3, cwd: `${source}-admin`, ancestor: false }]).kind).toBe("ok");
    });

    test("only warns about sessions whose folder is known and elsewhere", () => {
      const result = plan("site", "perso/site", [
        { pid: 4, cwd: "/elsewhere", ancestor: false },
        { pid: 5, cwd: "/also/elsewhere", ancestor: false },
      ]);

      expect(result.kind).toBe("ok");
      expect(warningsOf(result).join(" ")).toContain("session");
    });
  });

  describe("warnings", () => {
    test("says when ~/.claude.json will not be rewritten, and why", () => {
      fake.writeFile(".claude.json", JSON.stringify({ projects: { [source]: {} } }));

      const result = plan();

      expect(result.kind === "ok" ? result.claudeJson : undefined).toMatchObject({ status: "unsafe" });
      expect(warningsOf(result).join(" ")).toContain(".claude.json");
    });

    test("reports the entry that will be renamed, or its absence", () => {
      fake.writeFile(".claude.json", JSON.stringify({ projects: { [source]: {} } }, null, 2));
      const renamed = plan();
      expect(renamed.kind === "ok" ? renamed.claudeJson.status : "").toBe("renamed");

      fake.writeFile(".claude.json", JSON.stringify({ projects: {} }, null, 2));
      const absent = plan();
      expect(absent.kind === "ok" ? absent.claudeJson.status : "").toBe("absent");
    });

    test("warns about project- and local-scope plugins recorded with the old path", () => {
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({ plugins: { "a@m": [{ scope: "project", projectPath: source }, { scope: "user" }] } })
      );

      expect(warningsOf(plan()).join(" ")).toContain("a@m");
    });

    test("neutralises control characters in the names of files that mention the old path", () => {
      fake.writeFile("ws/site/evil\nAVERTISSEMENT.sh", `cd ${source}\n`);

      const warnings = warningsOf(plan()).join("\n");

      expect(warnings).toContain("evil?AVERTISSEMENT.sh");
      expect(warnings).not.toContain("evil\n");
    });

    test("lists hard-coded references to the old path found in the project files", () => {
      fake.writeFile("ws/site/run.sh", `cd ${source}\n`);

      const warnings = warningsOf(plan()).join("\n");

      expect(warnings).toContain("run.sh");
    });

    test("warns about a git worktree, whose link back to the main repository would break", () => {
      writeFileSync(join(source, ".git"), "gitdir: /elsewhere");

      expect(warningsOf(plan()).join(" ")).toContain("worktree");
    });

    test("has no warning for a clean project", () => {
      mkdirSync(join(fake.home, "ws/perso"), { recursive: true });

      expect(warningsOf(plan())).toEqual([]);
    });
  });
});
