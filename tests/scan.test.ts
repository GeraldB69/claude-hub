import { chmodSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildSnapshot } from "../src/core/scan.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const isRoot = process.getuid?.() === 0;

describe("buildSnapshot", () => {
  let fake: FakeHome;

  beforeEach(() => {
    fake = createFakeHome();
  });

  afterEach(() => {
    fake.cleanup();
  });

  const scan = (roots: readonly string[] = []) => buildSnapshot({ home: fake.home, roots });

  test("returns an empty snapshot for a home without any Claude data", () => {
    expect(scan()).toEqual({
      home: fake.home,
      plugins: [],
      agentsSkills: [],
      brokenSkillLinks: [],
      projectKeys: [],
      liveProjects: [],
      repoPaths: [],
      strayDirs: [],
      skipped: [],
      syncedPlugins: [],
      syncedSkills: [],
      syncSettings: {},
    });
  });

  describe("account synchronisation", () => {
    test("lists the plugins and skills synchronised from the account", () => {
      fake.writeFile(".claude/plugins/synced/acct/manifest.json", "{}");
      fake.writeFile(".claude/plugins/synced/acct/aaa.meta.json", "{}");
      fake.writeFile(".claude/plugins/synced/acct/bbb~g2.meta.json", "{}");
      fake.writeFile(".claude/skills/synced/acct/manifest.json", "{}");
      fake.writeFile(".claude/skills/synced/acct/pdf/SKILL.md", "x");
      fake.writeFile(".claude/skills/synced/acct/docx/SKILL.md", "x");

      const snapshot = scan();

      expect([...snapshot.syncedPlugins].sort()).toEqual(["aaa", "bbb~g2"]);
      expect([...snapshot.syncedSkills].sort()).toEqual(["docx", "pdf"]);
    });

    test("reads only the two sync switches of ~/.claude/settings.json and nothing else", () => {
      fake.writeFile(
        ".claude/settings.json",
        JSON.stringify({
          syncClaudeAiPlugins: false,
          syncClaudeAiSkills: "yes",
          env: { API_TOKEN: "SECRET-SETTINGS" },
        })
      );

      expect(scan().syncSettings).toEqual({ plugins: false });
    });

    test("names the file but never echoes content when settings.json is truncated", () => {
      fake.writeFile(".claude/settings.json", '{"env":{"API_TOKEN":"SECRET-SET');

      const attempt = () => scan();

      expect(attempt).toThrow(/settings\.json/);
      expect(attempt).not.toThrow(/SECRET/);
    });
  });

  describe("plugins", () => {
    test("reads installed plugins with their scope and flags a local plugin whose project is gone", () => {
      const existing = fake.makeDir("work/existing");
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({
          version: 2,
          plugins: {
            "a@m": [{ scope: "user", installPath: "/x", version: "1" }],
            "b@m": [{ scope: "local", projectPath: existing }],
            "c@m": [{ scope: "local", projectPath: `${existing}-gone` }],
          },
        })
      );

      expect(scan().plugins).toEqual([
        { id: "a@m", scope: "user" },
        { id: "b@m", scope: "local", projectPath: existing, projectPathExists: true },
        { id: "c@m", scope: "local", projectPath: `${existing}-gone`, projectPathExists: false },
      ]);
    });

    test("keeps a scope it does not know instead of failing", () => {
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({ plugins: { "z@m": [{ scope: "flag" }] } })
      );

      expect(scan().plugins).toEqual([{ id: "z@m", scope: "unknown", rawScope: "flag" }]);
    });

    test("accepts a document without a plugins key", () => {
      fake.writeFile(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 3 }));

      expect(scan().plugins).toEqual([]);
    });

    test("treats an entry without a usable scope as unknown instead of failing", () => {
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({ plugins: { "a@m": [{}], "b@m": [{ scope: 42 }], "c@m": "oops" } })
      );

      expect(scan().plugins).toEqual([
        { id: "a@m", scope: "unknown", rawScope: "(absent ou non textuel)" },
        { id: "b@m", scope: "unknown", rawScope: "(absent ou non textuel)" },
      ]);
    });

    test("does not judge a local plugin whose project path is relative", () => {
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({ plugins: { "r@m": [{ scope: "local", projectPath: "tests" }] } })
      );

      expect(scan().plugins).toEqual([{ id: "r@m", scope: "local", projectPath: "tests" }]);
    });

    test("names the file but never echoes file content when the JSON is truncated", () => {
      fake.writeFile(".claude/plugins/installed_plugins.json", '{"token":"SECRET-123');

      const attempt = () => scan();

      expect(attempt).toThrow(/installed_plugins\.json/);
      expect(attempt).not.toThrow(/SECRET/);
    });

    test("names the file but never echoes values when the structure is wrong", () => {
      fake.writeFile(
        ".claude/plugins/installed_plugins.json",
        JSON.stringify({ plugins: "SUPERSECRET" })
      );

      const attempt = () => scan();

      expect(attempt).toThrow(/installed_plugins\.json/);
      expect(attempt).not.toThrow(/SUPERSECRET/);
    });
  });

  describe("unreadable JSON files", () => {
    test("skips ~/.claude.json when it is a folder and still scans everything else", () => {
      fake.makeDir(".claude.json");
      fake.makeDir(".agents/skills/alpha");

      const snapshot = scan();

      expect(snapshot.skipped).toEqual([`${fake.home}/.claude.json`]);
      expect(snapshot.liveProjects).toEqual([]);
      expect(snapshot.agentsSkills).toEqual([{ name: "alpha", linked: false }]);
    });

    test("skips installed_plugins.json when ~/.claude/plugins is a file", () => {
      fake.writeFile(".claude/plugins", "not a folder");

      const snapshot = scan();

      expect(snapshot.skipped).toEqual([
        `${fake.home}/.claude/plugins/installed_plugins.json`,
        `${fake.home}/.claude/plugins/synced`,
      ]);
      expect(snapshot.plugins).toEqual([]);
    });

    test.skipIf(isRoot)("skips ~/.claude.json when it is not readable", () => {
      const file = fake.writeFile(".claude.json", "{}");
      chmodSync(file, 0o000);

      try {
        expect(scan().skipped).toEqual([file]);
      } finally {
        chmodSync(file, 0o600);
      }
    });
  });

  describe("skills", () => {
    test("follows a chain of links down to the entry of ~/.agents/skills", () => {
      fake.makeDir(".agents/skills/alpha");
      fake.symlink(".claude/mid", "../.agents/skills/alpha");
      fake.symlink(".claude/skills/alpha", "../mid");

      expect(scan().agentsSkills).toEqual([{ name: "alpha", linked: true }]);
    });

    test("treats every entry as linked when ~/.claude/skills is itself a link to ~/.agents/skills", () => {
      fake.makeDir(".agents/skills/alpha");
      fake.makeDir(".agents/skills/beta");
      fake.symlink(".claude/skills", "../.agents/skills");

      expect(scan().agentsSkills).toEqual([
        { name: "alpha", linked: true },
        { name: "beta", linked: true },
      ]);
    });

    test("marks the entries of ~/.agents/skills linked from ~/.claude/skills and reports broken links", () => {
      fake.makeDir(".agents/skills/alpha");
      fake.makeDir(".agents/skills/beta");
      fake.symlink(".claude/skills/alpha", "../../.agents/skills/alpha");
      fake.symlink(".claude/skills/ghost", "../../.agents/skills/ghost");

      const { agentsSkills, brokenSkillLinks } = scan();

      expect(agentsSkills).toEqual([
        { name: "alpha", linked: true },
        { name: "beta", linked: false },
      ]);
      expect(brokenSkillLinks).toEqual([`${fake.home}/.claude/skills/ghost`]);
    });

    test("skips ~/.agents/skills instead of failing when it is a file", () => {
      fake.writeFile(".agents/skills", "not a folder");

      const snapshot = scan();

      expect(snapshot.agentsSkills).toEqual([]);
      expect(snapshot.skipped).toEqual([`${fake.home}/.agents/skills`]);
    });
  });

  test("lists only directories of ~/.claude/projects as project keys", () => {
    fake.makeDir(".claude/projects/-ws-one");
    fake.writeFile(".claude/projects/stray-file.txt", "x");

    expect(scan().projectKeys).toEqual(["-ws-one"]);
  });

  describe("live projects", () => {
    test("keeps only the absolute project paths of ~/.claude.json that still exist", () => {
      const alive = fake.makeDir("work/alive");
      fake.writeFile(
        ".claude.json",
        JSON.stringify({
          oauthAccount: { secret: "do-not-read" },
          projects: { [alive]: {}, [`${alive}-gone`]: {}, tests: {} },
        })
      );

      expect(scan().liveProjects).toEqual([alive]);
    });

    test("names the file but never echoes file content when ~/.claude.json is truncated", () => {
      fake.writeFile(".claude.json", '{"oauthAccount":{"token":"SECRET-456');

      const attempt = () => scan();

      expect(attempt).toThrow(/\.claude\.json/);
      expect(attempt).not.toThrow(/SECRET/);
    });
  });

  describe("walk under the roots", () => {
    test("flags a non-git folder holding .claude, .agents or CLAUDE.md, root included", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/.claude");
      fake.writeFile("ws/gbwc/CLAUDE.md", "x");
      fake.makeDir("ws/gbwc/.agents");

      expect(scan([root]).strayDirs).toEqual([
        { path: root, entries: [".claude"], hasChildProjects: true },
        { path: `${root}/gbwc`, entries: [".agents", "CLAUDE.md"], hasChildProjects: false },
      ]);
    });

    test("does not treat plain sub-folders as child projects", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/leaf/.claude");
      fake.makeDir("ws/leaf/src");
      fake.makeDir("ws/leaf/docs");

      expect(scan([root]).strayDirs).toEqual([
        { path: `${root}/leaf`, entries: [".claude"], hasChildProjects: false },
      ]);
    });

    test("treats a child git repository as a child project", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/parent/.claude");
      fake.makeDir("ws/parent/repo/.git");

      expect(scan([root]).strayDirs).toEqual([
        { path: `${root}/parent`, entries: [".claude"], hasChildProjects: true },
      ]);
    });

    test("records git repositories without descending into them", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/repo/.git");
      fake.makeDir("ws/repo/.claude");
      fake.writeFile("ws/repo/nested/CLAUDE.md", "x");

      const snapshot = scan([root]);

      expect(snapshot.strayDirs).toEqual([]);
      expect(snapshot.repoPaths).toEqual([`${root}/repo`]);
    });

    test("reports a folder once when roots overlap", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/sub/.claude");
      fake.makeDir("ws/sub/repo/.git");

      const snapshot = scan([root, `${root}/sub`]);

      expect(snapshot.strayDirs.map((dir) => dir.path)).toEqual([`${root}/sub`]);
      expect(snapshot.repoPaths).toEqual([`${root}/sub/repo`]);
    });

    test("does not look for child projects below the depth limit", () => {
      const root = fake.makeDir("ws");
      fake.makeDir("ws/a/b/c/.claude");
      fake.makeDir("ws/a/b/c/repo/.git");

      const snapshot = scan([root]);

      expect(snapshot.strayDirs).toEqual([
        { path: `${root}/a/b/c`, entries: [".claude"], hasChildProjects: false },
      ]);
      expect(snapshot.repoPaths).toEqual([]);
    });

    test("recognises a worktree whose .git is a file", () => {
      const root = fake.makeDir("ws");
      fake.writeFile("ws/wt/.git", "gitdir: /elsewhere");

      expect(scan([root]).repoPaths).toEqual([`${root}/wt`]);
    });

    test("inspects folders down to depth 3 and no further", () => {
      const root = fake.makeDir("ws");
      fake.writeFile("ws/a/b/c/CLAUDE.md", "x");
      fake.writeFile("ws/a/b/c/d/CLAUDE.md", "x");

      expect(scan([root]).strayDirs.map((dir) => dir.path)).toEqual([`${root}/a/b/c`]);
    });

    test("skips node_modules", () => {
      const root = fake.makeDir("ws");
      fake.writeFile("ws/node_modules/pkg/CLAUDE.md", "x");

      expect(scan([root]).strayDirs).toEqual([]);
    });

    test("does not follow a symlink to a folder, even a looping one", () => {
      const root = fake.makeDir("ws");
      fake.writeFile("real/CLAUDE.md", "x");
      fake.symlink("ws/link", "../real");
      fake.symlink("ws/loop", "../ws");

      expect(scan([root]).strayDirs).toEqual([]);
    });

    test("ignores a .claude that is a file, not a folder", () => {
      const root = fake.makeDir("ws");
      fake.writeFile("ws/.claude", "x");

      expect(scan([root]).strayDirs).toEqual([]);
    });

    test("ignores a root that does not exist without reporting it as skipped", () => {
      const snapshot = scan([`${fake.home}/missing`]);

      expect(snapshot.strayDirs).toEqual([]);
      expect(snapshot.skipped).toEqual([]);
    });

    test.skipIf(isRoot)("reports an unreadable folder as skipped and keeps scanning", () => {
      const root = fake.makeDir("ws");
      const locked = fake.makeDir("ws/locked");
      fake.writeFile("ws/other/CLAUDE.md", "x");
      chmodSync(locked, 0o000);

      try {
        const snapshot = scan([root]);

        expect(snapshot.skipped).toEqual([locked]);
        expect(snapshot.strayDirs.map((dir) => dir.path)).toEqual([`${root}/other`]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  });
});
