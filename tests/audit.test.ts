import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { auditCommand } from "../src/commands/audit.js";
import type { Env, Io } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

/** Empreinte de tout le contenu d'un dossier (liens inclus, sans les suivre), pour détecter toute écriture. */
function fingerprint(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      return [`${path} -> ${readlinkSync(path)}`];
    }
    if (entry.isDirectory()) {
      return [`${path}/`, ...fingerprint(path)];
    }
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const { size, mtimeMs } = lstatSync(path);
    return [`${path} ${size} ${mtimeMs} ${hash}`];
  });
}

interface CapturedIo extends Io {
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

const USER_PLUGIN = JSON.stringify({ plugins: { "foo@market": [{ scope: "user" }] } });

describe("auditCommand", () => {
  let fake: FakeHome;
  let env: Env;

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("reports no deviation and exits 0 on a clean home", () => {
    const io = captureIo();

    const code = auditCommand([], env, io);

    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Aucun écart");
  });

  test("lists a warning with its rule and subject but still exits 0", () => {
    fake.writeFile(".claude/plugins/installed_plugins.json", USER_PLUGIN);
    const io = captureIo();

    const code = auditCommand([], env, io);

    const output = io.stdout.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("plugin-user-scope");
    expect(output).toContain("foo@market");
    expect(output).toContain("1 avertissement");
  });

  test("exits 1 when an error is found", () => {
    const segments = ["a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(60)];
    const longProject = fake.makeDir(`projects/${segments.join("/")}`);
    fake.writeFile(".claude.json", JSON.stringify({ projects: { [longProject]: {} } }));
    const io = captureIo();

    const code = auditCommand([], env, io);

    expect(code).toBe(1);
    expect(io.stdout.join("\n")).toContain("project-key-too-long");
  });

  test("prints a machine-readable report with --json", () => {
    fake.writeFile(".claude/plugins/installed_plugins.json", USER_PLUGIN);
    const io = captureIo();

    const code = auditCommand(["--json"], env, io);

    const report = JSON.parse(io.stdout.join("\n")) as {
      findings: { rule: string }[];
      summary: Record<string, number>;
    };
    expect(code).toBe(0);
    expect(report.findings.map((finding) => finding.rule)).toEqual(["plugin-user-scope"]);
    expect(report.summary).toEqual({ error: 0, warn: 1, info: 0 });
  });

  test("exits 2 when --json and --quiet are combined", () => {
    const io = captureIo();

    const code = auditCommand(["--json", "--quiet"], env, io);

    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("--json");
    expect(io.stdout).toEqual([]);
  });

  describe("--quiet", () => {
    test("prints nothing when there is no error or warning", () => {
      fake.makeDir(".claude/projects/-orphan");
      const io = captureIo();

      const code = auditCommand(["--quiet"], env, io);

      expect(code).toBe(0);
      expect(io.stdout).toEqual([]);
    });

    test("prints a single summary line when there is a warning", () => {
      fake.writeFile(".claude/plugins/installed_plugins.json", USER_PLUGIN);
      const io = captureIo();

      auditCommand(["--quiet"], env, io);

      expect(io.stdout).toHaveLength(1);
      expect(io.stdout[0]).toContain("1 avertissement");
    });
  });

  test("scans the roots given with --root", () => {
    const root = fake.makeDir("ws");
    fake.writeFile("ws/CLAUDE.md", "x");
    fake.makeDir("ws/child/.git");
    const io = captureIo();

    auditCommand(["--root", root], env, io);

    expect(io.stdout.join("\n")).toContain("stray-parent-claude-md");
  });

  test("does not fail when a --root does not exist", () => {
    const io = captureIo();

    const code = auditCommand(["--root", `${fake.home}/missing`], env, io);

    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Aucun écart");
  });

  test("reads the policy from the --config directory", () => {
    fake.writeFile(".claude/plugins/installed_plugins.json", USER_PLUGIN);
    fake.writeFile("alt/policy.yaml", "userPluginAllowlist:\n  - foo@market\n");
    const io = captureIo();

    auditCommand(["--config", `${fake.home}/alt`], env, io);

    expect(io.stdout.join("\n")).toContain("Aucun écart");
  });

  test("never modifies the files it inspects, content included", () => {
    fake.writeFile(".claude/plugins/installed_plugins.json", USER_PLUGIN);
    fake.writeFile(".claude.json", JSON.stringify({ projects: {} }));
    fake.makeDir(".agents/skills/alpha");
    fake.symlink(".claude/skills/ghost", "../../.agents/skills/ghost");
    fake.makeDir(".claude/projects/-orphan");
    fake.writeFile("ws/CLAUDE.md", "x");
    fake.makeDir("ws/repo/.git");
    fake.makeDir("ws/leaf/.claude");
    fake.writeFile("config/policy.yaml", "agentsSkillsMustBeEmpty: true\n");
    const before = fingerprint(fake.home);

    auditCommand(["--root", `${fake.home}/ws`], env, captureIo());

    expect(fingerprint(fake.home)).toEqual(before);
  });

  test("exits 2 and explains on an unknown option", () => {
    const io = captureIo();

    const code = auditCommand(["--bogus"], env, io);

    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("--bogus");
  });

  test("exits 3 and names the file when policy.yaml is invalid", () => {
    fake.writeFile("config/policy.yaml", "bogus: 1\n");
    const io = captureIo();

    const code = auditCommand([], env, io);

    expect(code).toBe(3);
    expect(io.stderr.join("\n")).toContain("policy.yaml");
  });

  test("exits 3 without echoing secrets when ~/.claude.json is truncated", () => {
    fake.writeFile(".claude.json", '{"token":"SECRET-789');
    const io = captureIo();

    const code = auditCommand([], env, io);

    expect(code).toBe(3);
    expect(io.stderr.join("\n")).toContain(".claude.json");
    expect(io.stderr.join("\n")).not.toContain("SECRET");
  });

  test("refuses to run when CLAUDE_CONFIG_DIR is set, because its layout is not verified", () => {
    const io = captureIo();

    const code = auditCommand([], { ...env, claudeConfigDir: "/somewhere" }, io);

    expect(code).toBe(3);
    expect(io.stderr.join("\n")).toContain("CLAUDE_CONFIG_DIR");
  });
});
