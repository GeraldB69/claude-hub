import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { initCommand } from "../src/commands/init.js";
import type { Env, Io } from "../src/core/env.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

function fingerprint(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      return [`${path} -> ${readlinkSync(path)}`];
    }
    if (entry.isDirectory()) {
      return [`${path}/`, ...fingerprint(path)];
    }
    return [`${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
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

describe("initCommand", () => {
  let fake: FakeHome;
  let env: Env;
  let project: string;

  const run = (argv: readonly string[]) => {
    const io = captureIo();
    const code = initCommand(argv, env, io);
    return { code, io, text: io.stdout.join("\n"), errors: io.stderr.join("\n") };
  };

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    project = fake.makeDir("ws/site");
    fake.writeFile(
      "config/profiles/web.yaml",
      "plugins:\n  - ctx@market\nskillsOff:\n  - noisy\nconnectors: disabled\n"
    );
    fake.writeFile("config/profiles/empty.yaml", "");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("creates the project settings, CLAUDE.md, docs/ai and the gitignore entry", () => {
    const { code, text } = run([project, "--profile", "web"]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(project, ".claude/settings.json"), "utf8"))).toEqual({
      enabledPlugins: { "ctx@market": true },
      skillOverrides: { noisy: "off" },
      disableClaudeAiConnectors: true,
    });
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(project, "docs/ai/.gitkeep"))).toBe(true);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe(".claude/settings.local.json\n");
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("docs/ai");
    expect(text).toContain(".gitignore");
  });

  test("writes an empty settings object for a profile that configures nothing", () => {
    run([project, "--profile", "empty"]);

    expect(JSON.parse(readFileSync(join(project, ".claude/settings.json"), "utf8"))).toEqual({});
  });

  test("uses the CLAUDE.md template of the profile when it has one", () => {
    fake.writeFile("config/profiles/tpl.yaml", "claudeMd: |\n  # Mon projet\n");

    run([project, "--profile", "tpl"]);

    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("# Mon projet\n");
  });

  test("is idempotent: a second run changes nothing and reports everything as already there", () => {
    run([project, "--profile", "web"]);
    const before = fingerprint(project);

    const { code, text } = run([project, "--profile", "web"]);

    expect(code).toBe(0);
    expect(fingerprint(project)).toEqual(before);
    expect(text).not.toMatch(/^\+ /m);
  });

  test("never overwrites an existing settings.json or CLAUDE.md", () => {
    fake.writeFile("ws/site/.claude/settings.json", '{"custom":true}');
    fake.writeFile("ws/site/CLAUDE.md", "mine");

    const { text } = run([project, "--profile", "web"]);

    expect(readFileSync(join(project, ".claude/settings.json"), "utf8")).toBe('{"custom":true}');
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("mine");
    expect(text).toContain("existe déjà");
  });

  test("appends the entry to an existing .gitignore, keeping its content", () => {
    fake.writeFile("ws/site/.gitignore", "node_modules");

    run([project, "--profile", "empty"]);

    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe(
      "node_modules\n.claude/settings.local.json\n"
    );
  });

  test("does not duplicate the entry when the .gitignore already has it", () => {
    fake.writeFile("ws/site/.gitignore", "a\n.claude/settings.local.json\nb\n");

    run([project, "--profile", "empty"]);

    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("a\n.claude/settings.local.json\nb\n");
  });

  test("--dry-run prints the plan and writes nothing", () => {
    const before = fingerprint(fake.home);

    const { code, text } = run([project, "--profile", "web", "--dry-run"]);

    expect(code).toBe(0);
    expect(fingerprint(fake.home)).toEqual(before);
    expect(text).toContain("simulation");
    expect(text).toContain(".claude/settings.json");
  });

  test("takes the profile from the registry when the project is registered", () => {
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: web }\n");

    const { code } = run(["site"]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(project, ".claude/settings.json"), "utf8"))).toHaveProperty(
      "enabledPlugins"
    );
  });

  test("lets --profile override the registry profile", () => {
    fake.writeFile("config/projects.yaml", "projects:\n  - { name: site, path: site, profile: web }\n");

    run(["site", "--profile", "empty"]);

    expect(JSON.parse(readFileSync(join(project, ".claude/settings.json"), "utf8"))).toEqual({});
  });

  test("asks for a profile when the project is not registered and none is given", () => {
    const { code, errors } = run([project]);

    expect(code).toBe(2);
    expect(errors).toContain("--profile");
  });

  test("exits 3 and names an unknown profile", () => {
    const { code, errors } = run([project, "--profile", "ghost"]);

    expect(code).toBe(3);
    expect(errors).toContain("ghost");
  });

  test("exits 3 when the target is not a directory", () => {
    const { code, errors } = run([`${project}/missing`, "--profile", "empty"]);

    expect(code).toBe(3);
    expect(errors).toContain("missing");
  });

  test.each([[[]], [["a", "b", "--profile", "web"]]])("exits 2 when the target is missing or doubled: %j", (argv) => {
    expect(run(argv).code).toBe(2);
  });

  test("exits 2 on an unknown option", () => {
    const { code, errors } = run([project, "--bogus"]);

    expect(code).toBe(2);
    expect(errors).toContain("--bogus");
  });

  test("does not write through a .claude that is a symbolic link", () => {
    const outside = fake.makeDir("outside");
    symlinkSync(outside, join(project, ".claude"));

    const { code, text } = run([project, "--profile", "web"]);

    expect(code).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(project, ".claude")).isSymbolicLink()).toBe(true);
    expect(text).toContain("lien symbolique");
  });

  test("resolves a relative target against the current directory", () => {
    env = testEnv(fake, { cwd: join(fake.home, "ws") });

    const { code } = run(["site", "--profile", "empty"]);

    expect(code).toBe(0);
    expect(existsSync(join(project, ".claude/settings.json"))).toBe(true);
  });

  test("lists the plugins to enable, because init does not install them", () => {
    const { text } = run([project, "--profile", "web"]);

    expect(text).toContain("ctx@market");
    expect(text).toContain("claude plugin install");
  });

  test.each([
    ["the home folder", (home: string) => home],
    ["the workspace root", (home: string) => `${home}/ws`],
    ["the Claude user configuration folder", (home: string) => `${home}/.claude`],
  ])("refuses to initialise %s", (_label, pick) => {
    fake.makeDir(".claude");
    const before = fingerprint(fake.home);

    const { code, errors } = run([pick(fake.home), "--profile", "web"]);

    expect(code).toBe(3);
    expect(errors).toContain("Refus");
    expect(fingerprint(fake.home)).toEqual(before);
  });

  test("refuses the folder CLAUDE_CONFIG_DIR points to", () => {
    const cfg = fake.makeDir("cfg");
    env = testEnv(fake, { claudeConfigDir: cfg });

    expect(run([cfg, "--profile", "web"]).code).toBe(3);
  });

  test("writes a hostile skill name as plain data, without touching prototypes", () => {
    fake.writeFile("config/profiles/evil.yaml", 'skillsOff:\n  - "__proto__"\n  - "a\\"b"\n');

    run([project, "--profile", "evil"]);

    const text = readFileSync(join(project, ".claude/settings.json"), "utf8");
    const parsed = JSON.parse(text) as { skillOverrides: Record<string, string> };
    expect(Object.keys(parsed.skillOverrides).sort()).toEqual(['a"b', "__proto__"].sort());
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(parsed.skillOverrides)).toBe(Object.prototype);
  });

  test.skipIf(process.getuid?.() === 0)("tells what was done and what was not when a write fails midway", () => {
    chmodSync(project, 0o555);

    try {
      const { code, errors, text } = run([project, "--profile", "web"]);

      expect(code).toBe(3);
      expect(errors).toContain(".claude");
      expect(errors).toContain("non exécuté");
      expect(text).toContain("+ créer .claude/settings.json");
    } finally {
      chmodSync(project, 0o755);
    }
  });

  test("keeps going when docs/ai already exists", () => {
    mkdirSync(join(project, "docs/ai"), { recursive: true });
    writeFileSync(join(project, "docs/ai/plan.md"), "x");

    const { code } = run([project, "--profile", "empty"]);

    expect(code).toBe(0);
    expect(existsSync(join(project, "docs/ai/.gitkeep"))).toBe(false);
  });
});
