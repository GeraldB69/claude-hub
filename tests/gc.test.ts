import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { gcCommand } from "../src/commands/gc.js";
import { applyOperations } from "../src/core/fs-safe.js";
import type { ClaudeProcess, Env, Runtime } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("gcCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let processes: ClaudeProcess[];
  let stdout: string[];
  let stderr: string[];

  const runtime = (): Runtime => ({ claudeProcesses: () => processes, launchClaude: () => 0 });
  const run = (argv: readonly string[], overrides: Partial<Env> = {}) => {
    const code = gcCommand(argv, { ...env, ...overrides }, { out: (l) => stdout.push(l), err: (l) => stderr.push(l) }, runtime());
    return { code, text: stdout.join("\n"), errors: stderr.join("\n") };
  };
  const cache = (relative: string) => join(fake.home, ".claude/plugins/cache", relative);
  const register = (installPath: string) =>
    fake.writeFile(
      ".claude/plugins/installed_plugins.json",
      JSON.stringify({ version: 2, plugins: { "a@m": [{ scope: "user", installPath }] } })
    );

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    processes = [];
    stdout = [];
    stderr = [];
    fake.writeFile(".claude/plugins/cache/m/a/1.0.0/x.txt", "used");
    fake.writeFile(".claude/plugins/cache/m/a/0.9.0/x.txt", "old");
    fake.writeFile(".claude/plugins/cache/gone/b/2.0.0/x.txt", "orphan marketplace");
    register(cache("m/a/1.0.0"));
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("lists unused versions and deletes nothing by default", () => {
    const { code, text } = run([]);

    expect(code).toBe(0);
    expect(text).toContain("m/a/0.9.0");
    expect(text).toContain("gone/b/2.0.0");
    expect(text).not.toContain("m/a/1.0.0");
    expect(text).toContain("2 version(s) inutilisée(s)");
    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
    expect(existsSync(cache("gone/b/2.0.0"))).toBe(true);
  });

  test("with --yes deletes only the unused versions", () => {
    const { code } = run(["--yes"]);

    expect(code).toBe(0);
    expect(existsSync(cache("m/a/0.9.0"))).toBe(false);
    expect(existsSync(cache("gone/b/2.0.0"))).toBe(false);
    expect(existsSync(cache("m/a/1.0.0/x.txt"))).toBe(true);
  });

  test("refuses to delete while another Claude session is open, but the session running ch is fine", () => {
    processes = [{ pid: 4242, cwd: "/home/user/x", ancestor: false }];
    const refused = run(["--yes"]);
    expect(refused.code).toBe(3);
    expect(refused.errors).toContain("4242");
    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);

    processes = [{ pid: 1, cwd: "/home/user/x", ancestor: true }];
    expect(run(["--yes"]).code).toBe(0);
    expect(existsSync(cache("m/a/0.9.0"))).toBe(false);
  });

  test("deletes nothing when it cannot tell what is installed", () => {
    fake.writeFile(".claude/plugins/installed_plugins.json", "pas du json");

    const { code, errors } = run(["--yes"]);

    expect(code).toBe(3);
    expect(errors).toContain("rien n'est supprimé");
    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
  });

  test("keeps a version when an install path points inside it", () => {
    register(cache("m/a/0.9.0/sub"));
    fake.makeDir(".claude/plugins/cache/m/a/0.9.0/sub");

    run(["--yes"]);

    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
    expect(existsSync(cache("m/a/1.0.0"))).toBe(false);
  });

  test("never follows a symbolic link out of the cache", () => {
    const outside = fake.makeDir("precious");
    fake.writeFile("precious/keep.txt", "keep");
    fake.symlink(".claude/plugins/cache/m/a/linked", outside);

    run(["--yes"]);

    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  test("refuses when CLAUDE_CONFIG_DIR is set, and rejects bad arguments", () => {
    expect(run(["--yes"], { claudeConfigDir: "/home/user/cfg" }).code).toBe(3);
    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
    expect(run(["--yes", "--dry-run"]).code).toBe(2);
    expect(run(["extra"]).code).toBe(2);
  });

  describe("fails closed when it cannot be sure what is in use", () => {
    const refuses = (content: string) => {
      fake.writeFile(".claude/plugins/installed_plugins.json", content);
      const { code, errors } = run(["--yes"]);
      expect(code).toBe(3);
      expect(errors).toContain("rien n'est supprimé");
      expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
      expect(existsSync(cache("m/a/1.0.0"))).toBe(true);
    };

    test("relative installPath", () => {
      refuses(JSON.stringify({ version: 2, plugins: { "a@m": [{ scope: "user", installPath: "cache/m/a/1.0.0" }] } }));
    });
    test("entry without installPath", () => {
      refuses(JSON.stringify({ version: 2, plugins: { "a@m": [{ scope: "user" }] } }));
    });
    test("plugin value that is not an array", () => {
      refuses(JSON.stringify({ version: 2, plugins: { "a@m": { scope: "user", installPath: cache("m/a/1.0.0") } } }));
    });
    test("another file version", () => {
      refuses(JSON.stringify({ version: 3, plugins: { "a@m": [{ scope: "user", installPath: cache("m/a/1.0.0") }] } }));
    });
    test("no plugin declared while the cache is full", () => {
      refuses(JSON.stringify({ version: 2, plugins: {} }));
    });
    test("unreadable installed_plugins.json", () => {
      refuses("pas du json");
    });
  });

  test("an install path outside the cache protects nothing there and does not stop the clean-up", () => {
    fake.writeFile(
      ".claude/plugins/installed_plugins.json",
      JSON.stringify({
        version: 2,
        plugins: {
          "a@m": [{ scope: "user", installPath: cache("m/a/1.0.0/") }],
          "h@skills-dir": [{ scope: "user", installPath: join(fake.home, ".claude/skills/h") }],
        },
      })
    );

    expect(run(["--yes"]).code).toBe(0);
    expect(existsSync(cache("m/a/1.0.0"))).toBe(true);
    expect(existsSync(cache("m/a/0.9.0"))).toBe(false);
  });

  test("does nothing when there is no cache, and refuses a cache that is itself a link", () => {
    fake.cleanup();
    fake = createFakeHome();
    env = testEnv(fake);
    expect(run(["--yes"]).text).toContain("0 version(s)");

    const outside = fake.makeDir("elsewhere/cache");
    fake.writeFile("elsewhere/cache/m/a/0.9.0/x.txt", "x");
    fake.symlink(".claude/plugins/cache", outside);
    register(cache("m/a/1.0.0"));
    const { code, errors } = run(["--yes"]);
    expect(code).toBe(3);
    expect(errors).toContain("lien symbolique");
    expect(existsSync(join(outside, "m/a/0.9.0/x.txt"))).toBe(true);
  });

  test("ignores links at marketplace and plugin level and never follows them", () => {
    const outside = fake.makeDir("precious");
    fake.writeFile("precious/p/1.0.0/keep.txt", "keep");
    fake.symlink(".claude/plugins/cache/linked-market", outside);
    fake.symlink(".claude/plugins/cache/m/linked-plugin", join(outside, "p"));

    expect(run(["--yes"]).code).toBe(0);
    expect(existsSync(join(outside, "p/1.0.0/keep.txt"))).toBe(true);
  });

  test("deletes nothing when the list of Claude sessions cannot be read", () => {
    const throwing: Runtime = {
      claudeProcesses: () => {
        throw new Error("/proc illisible");
      },
      launchClaude: () => 0,
    };
    const code = gcCommand(["--yes"], env, { out: () => undefined, err: (l) => stderr.push(l) }, throwing);

    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("/proc illisible");
    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)("stops on the first failure and says how many versions were left alone", () => {
    chmodSync(cache("gone/b"), 0o500);
    try {
      const { code, errors, text } = run(["--yes"]);

      expect(code).toBe(3);
      expect(errors).toContain("1 version(s) non traitée(s)");
      expect(text).toContain("0 version(s) supprimée(s)");
      expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
    } finally {
      chmodSync(cache("gone/b"), 0o700);
    }
  });

  test("remove-tree refuses the root itself, paths outside it, links and plain files", () => {
    const root = cache("");
    const outside = fake.makeDir("precious");
    fake.writeFile("precious/keep.txt", "keep");
    fake.symlink(".claude/plugins/cache/m/lnk", outside);
    const attempt = (path: string) =>
      applyOperations([{ kind: "remove-tree", path }], { dryRun: false, root })[0]?.detail;

    expect(attempt(root)).toBe("OUTSIDE_ROOT");
    expect(attempt(join(root, "..", "plugins"))).toBe("OUTSIDE_ROOT");
    expect(attempt(outside)).toBe("OUTSIDE_ROOT");
    expect(attempt(join(root, "m/lnk"))).toBe("SYMLINK");
    expect(attempt(cache("m/a/1.0.0/x.txt"))).toBe("NOT_A_DIRECTORY");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(cache("m/a/1.0.0/x.txt"))).toBe(true);
  });

  test("protects a version reached through a symbolic link, or one declared by a parent folder", () => {
    fake.symlink("alias", cache("m/a/1.0.0"));
    register(join(fake.home, "alias"));
    expect(run(["--yes"]).code).toBe(0);
    expect(existsSync(cache("m/a/1.0.0"))).toBe(true);
    expect(existsSync(cache("m/a/0.9.0"))).toBe(false);

    fake.writeFile(".claude/plugins/cache/n/p/1.0.0/x.txt", "x");
    fake.writeFile(".claude/plugins/cache/n/p/2.0.0/x.txt", "x");
    register(cache("n/p"));
    run(["--yes"]);
    expect(existsSync(cache("n/p/1.0.0"))).toBe(true);
    expect(existsSync(cache("n/p/2.0.0"))).toBe(true);
  });

  test("keeps a version whose install path does not exist on disk yet", () => {
    register(cache("m/a/0.9.0/not-created-yet"));

    run(["--yes"]);

    expect(existsSync(cache("m/a/0.9.0"))).toBe(true);
  });
});
